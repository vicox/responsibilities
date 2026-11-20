import { DEFAULT_MAX_REQUEST_BODY_SIZE, isJsonContentType, readRequestBody } from "@modelcontextprotocol/server";

/**
 * How much one `/mcp` request can make the SDK validate (GHSA-46jr-4wx8-v453).
 *
 * A schema that fails on every element of a long array costs the SDK about a
 * kilobyte of heap per element, so a request well inside the 4 MiB body limit can
 * exhaust the function's memory: half a million invalid entries — one megabyte of
 * JSON — abort a process with a 256 MiB heap. The bearer check narrows who can
 * send such a request to active members; it does not bound what they send. Two
 * bounds do:
 *
 * - Tool arguments: the SDK's `maxToolInputElements`, set to the largest
 *   arguments a tool legitimately takes (`MAX_TOOL_INPUT_ELEMENTS` in
 *   `server.ts`). Their schemas are ours and bound every array.
 * - Everything else in the request — the JSON-RPC envelope, `_meta` with the
 *   client's info and capabilities, `initialize` parameters — goes through the
 *   SDK's protocol schemas before any tool runs, and some of their arrays have
 *   no bound. `limitProtocolElements` counts that part before the SDK sees it.
 */

/**
 * Array elements and object members a request may carry outside tool-call
 * arguments. A client's envelope, info and capabilities come to a few dozen; a
 * thousand leaves ample room and keeps an invalid one near a megabyte of heap.
 */
export const MAX_PROTOCOL_ELEMENTS = 1_000;

/**
 * Reads and parses a JSON POST body once, within the SDK's own body limit, and
 * refuses it with `400` if it carries more than `MAX_PROTOCOL_ELEMENTS` outside
 * tool-call arguments. Otherwise returns the parsed body for the SDK to use
 * instead of reading it again.
 *
 * Returns nothing when the SDK should take the request as it is — not a JSON
 * POST, over the body limit, unreadable or not JSON. The body is read from a
 * clone, so the SDK then reads the request itself and answers it exactly as it
 * would without this check (405, 413, 415 or a parse error).
 */
export async function limitProtocolElements(request: Request): Promise<Response | { parsedBody?: unknown }> {
  if (request.method.toUpperCase() !== "POST" || !isJsonContentType(request.headers.get("content-type"))) {
    return {};
  }

  let text: string;
  try {
    const read = await readRequestBody(request.clone(), DEFAULT_MAX_REQUEST_BODY_SIZE);
    if (read.tooLarge) return {};
    text = read.text;
  } catch {
    return {};
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return {};
  }

  if (protocolElementCount(body, MAX_PROTOCOL_ELEMENTS) > MAX_PROTOCOL_ELEMENTS) {
    return Response.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32600,
          message: `Invalid Request: more than ${MAX_PROTOCOL_ELEMENTS} array elements and object members outside tool arguments.`,
        },
        id: requestId(body),
      },
      { status: 400 },
    );
  }
  return { parsedBody: body };
}

/**
 * Array elements and object members in a JSON-RPC message or batch, counted the
 * way the SDK counts tool arguments, leaving out the `arguments` of a
 * `tools/call` (`maxToolInputElements` bounds those). Stops once past `max`.
 */
export function protocolElementCount(body: unknown, max: number): number {
  if (Array.isArray(body) && body.length > max) return body.length;

  const toolArguments = new Set<unknown>();
  for (const message of Array.isArray(body) ? body : [body]) {
    if (isObject(message) && message.method === "tools/call" && isObject(message.params)) {
      toolArguments.add(message.params.arguments);
    }
  }

  let count = 0;
  const stack: unknown[] = [body];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object" || toolArguments.has(node)) continue;
    if (Array.isArray(node)) {
      for (const child of node) {
        if (++count > max) return count;
        stack.push(child);
      }
    } else {
      for (const key in node) {
        if (!Object.hasOwn(node, key)) continue;
        if (++count > max) return count;
        stack.push((node as Record<string, unknown>)[key]);
      }
    }
  }
  return count;
}

function requestId(body: unknown): string | number | null {
  return isObject(body) && (typeof body.id === "string" || typeof body.id === "number") ? body.id : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
