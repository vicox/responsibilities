import assert from "node:assert/strict";
import test from "node:test";
import { SignJWT } from "jose";

/**
 * The MCP endpoint, end to end (ported from Tonight): what a client can do with
 * a token for an active member, and what it cannot do without one.
 */
process.env.PUBLIC_ORIGIN = "http://localhost:3000";
process.env.OAUTH_SIGNING_SECRET = "test-signing-secret-of-at-least-32-bytes";
process.env.DEV_DATABASE_DIR = "memory://"; // never the developer's .devdb

const { handleMcpRequest } = await import("./endpoint.ts");
const { deployment, signingKey } = await import("../oauth/config.ts");
const { mintAccessToken } = await import("../oauth/tokens.ts");
const { database } = await import("../db.ts");
const { memberIdFor, seedMembers } = await import("../testing.ts");
const { addMember, removeMember, addWorkspace } = await import("../workspace/members.ts");
const { MAX_PROTOCOL_ELEMENTS } = await import("./limits.ts");
const { MAX_TOOL_INPUT_ELEMENTS } = await import("./server.ts");

const db = await database();
await seedMembers(db, ["alice", "bob"], "acme");
await addWorkspace(db, "other-co", "Other Co");
const ALICE = memberIdFor("alice");
const BOB = memberIdFor("bob");

await db.query(
  `INSERT INTO oauth_clients (client_id, redirect_uris, client_name, registered_at)
   VALUES ('client-1', '{http://localhost/cb}', 'Claude Code', now())`,
);

const ENDPOINT = "http://localhost:3000/mcp";
const PROTOCOL_VERSION = "2026-07-28";

async function accessToken(user = ALICE, clientId = "client-1", scope = "mcp") {
  const { token } = await mintAccessToken(
    deployment(),
    signingKey(),
    { id: user },
    clientId,
    scope,
    deployment().resource,
  );
  return token;
}

type ServerInfo = {
  name: string;
  version: string;
  workspace: { slug: string; name: string };
  member: string;
  client: { id: string; name: string | null };
};

type RpcResponse = {
  result?: {
    supportedVersions?: string[];
    capabilities?: { tools?: unknown };
    tools?: {
      name: string;
      title?: string;
      description?: string;
      inputSchema?: unknown;
      annotations?: { readOnlyHint?: boolean };
    }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    _meta?: Record<string, { name?: string }>;
  };
  error?: string;
};

async function call(
  method: string,
  options: { token?: string; name?: string; params?: Record<string, unknown> } = {},
): Promise<{ status: number; headers: Headers; body: string; json: RpcResponse }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_VERSION,
    "mcp-method": method,
  };
  if (options.name) headers["mcp-name"] = options.name;
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const response = await handleMcpRequest(
    new Request(ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...options.params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }),
  );

  const body = await response.text();
  let json: RpcResponse = {};
  try {
    json = JSON.parse(body);
  } catch {
    // A non-JSON body is itself what some tests assert about.
  }
  return { status: response.status, headers: response.headers, body, json };
}

async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  const { status, json } = await call("tools/call", { token, name, params: { name, arguments: args } });
  assert.equal(status, 200, JSON.stringify(json));
  return json.result!;
}

async function getServerInfo(token: string): Promise<ServerInfo> {
  const result = await tool(token, "get_server_info");
  assert.ok(result.structuredContent, "the tool returned a structured result");
  return result.structuredContent as ServerInfo;
}

// --- discovery --------------------------------------------------------------

test("an authenticated member can discover the server and its protocol revision", async () => {
  const { status, json } = await call("server/discover", { token: await accessToken() });

  assert.equal(status, 200);
  assert.deepEqual(json.result?.supportedVersions, [PROTOCOL_VERSION]);
  assert.equal(json.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name, "Responsibilities");
  assert.ok(json.result?.capabilities?.tools, "tools are advertised");
});

test("tools/list returns exactly the seven tools", async () => {
  const { status, json } = await call("tools/list", { token: await accessToken() });

  assert.equal(status, 200);
  const tools = json.result?.tools ?? [];
  assert.deepEqual(tools.map((one) => one.name).sort(), [
    "complete_run",
    "get_case",
    "get_responsibility",
    "get_server_info",
    "put_responsibility",
    "record_observations",
    "start_run",
  ]);
  for (const one of tools) {
    assert.match(one.description ?? "", /never instructions/, `${one.name} states the data rule`);
  }
  const readOnly = tools.filter((one) => one.annotations?.readOnlyHint).map((one) => one.name).sort();
  assert.deepEqual(readOnly, ["get_case", "get_responsibility", "get_server_info"]);
});

test("no tool accepts a workspace, member or user argument", async () => {
  const { json } = await call("tools/list", { token: await accessToken() });
  for (const one of json.result?.tools ?? []) {
    const properties = Object.keys(
      (one.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {},
    );
    for (const property of properties) {
      assert.equal(
        /workspace|member|user|owner|account|tenant/i.test(property),
        false,
        `${one.name}.${property} would let a client choose whose state to touch`,
      );
    }
  }
});

test("a legacy client that still opens with initialize is served too", async () => {
  const response = await handleMcpRequest(
    new Request(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${await accessToken()}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "legacy-client", version: "1.0.0" },
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.match(await response.text(), /Responsibilities/);
});

// --- the authorization boundary --------------------------------------------

test("a call with no token is refused with 401 and told where to get one", async () => {
  const { status, headers, json } = await call("tools/list");

  assert.equal(status, 401);
  assert.equal(json.error, "invalid_token");
  const challenge = headers.get("www-authenticate") ?? "";
  assert.match(challenge, /^Bearer /);
  assert.match(
    challenge,
    /resource_metadata="http:\/\/localhost:3000\/\.well-known\/oauth-protected-resource\/mcp"/,
  );
});

test("a garbage token, another key, an expired token and a foreign audience are all 401", async () => {
  for (const token of ["not-a-token", "a.b.c"]) {
    assert.equal((await call("tools/list", { token })).status, 401, token);
  }

  const forged = await new SignJWT({ client_id: "client-1", scope: "mcp" })
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
    .setIssuer("http://localhost:3000")
    .setAudience("http://localhost:3000/mcp")
    .setSubject(ALICE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode("a-different-secret-of-at-least-32-bytes!"));
  assert.equal((await call("tools/list", { token: forged })).status, 401, "another key");

  const now = Math.floor(Date.now() / 1000);
  const expired = await new SignJWT({ client_id: "client-1", scope: "mcp" })
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
    .setIssuer("http://localhost:3000")
    .setAudience("http://localhost:3000/mcp")
    .setSubject(ALICE)
    .setIssuedAt(now - 7200)
    .setExpirationTime(now - 60)
    .sign(signingKey());
  assert.equal((await call("tools/list", { token: expired })).status, 401, "expired");

  const elsewhere = await new SignJWT({ client_id: "client-1", scope: "mcp" })
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
    .setIssuer("http://localhost:3000")
    .setAudience("https://someone-else.example/mcp")
    .setSubject(ALICE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(signingKey());
  assert.equal((await call("tools/list", { token: elsewhere })).status, 401, "wrong audience");
});

test("a validly signed token whose subject is not a member is 401", async () => {
  for (const subject of ["google:1", memberIdFor("stranger")]) {
    const { status, headers, body } = await call("tools/list", { token: await accessToken(subject) });
    assert.equal(status, 401, subject);
    assert.match(headers.get("www-authenticate") ?? "", /resource_metadata=/);
    assert.equal(body.includes("get_server_info"), false);
  }
});

test("404 off the canonical host", async () => {
  const previous = process.env.PUBLIC_ORIGIN;
  process.env.PUBLIC_ORIGIN = "https://responsibilities.example";
  try {
    const response = await handleMcpRequest(
      new Request("https://responsibilities-git-x.vercel.app/mcp", {
        method: "POST",
        headers: { host: "responsibilities-git-x.vercel.app", "content-type": "application/json" },
        body: "{}",
      }),
    );
    assert.equal(response.status, 404);
  } finally {
    process.env.PUBLIC_ORIGIN = previous;
  }
});

test("a request from a browser origin this deployment does not serve is refused", async () => {
  const response = await handleMcpRequest(
    new Request(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL_VERSION,
        "mcp-method": "tools/list",
        origin: "https://evil.test",
        authorization: `Bearer ${await accessToken()}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
  );
  assert.equal(response.status, 403);
});

// --- the session ------------------------------------------------------------

test("get_server_info names the workspace, the member and the client", async () => {
  const info = await getServerInfo(await accessToken());

  assert.equal(info.name, "Responsibilities");
  assert.equal(info.version, "0.1.0");
  assert.deepEqual(info.workspace, { slug: "acme", name: "Workspace acme" });
  assert.equal(info.member, "alice@example.com");
  assert.deepEqual(info.client, { id: "client-1", name: "Claude Code" });

  const unregistered = await getServerInfo(await accessToken(BOB, "client-unknown"));
  assert.equal(unregistered.member, "bob@example.com");
  assert.deepEqual(unregistered.client, { id: "client-unknown", name: null });
});

test("the session comes from the token, not from tool arguments", async () => {
  const result = await tool(await accessToken(ALICE), "get_server_info", {
    member: "bob@example.com",
    workspace: "other-co",
  });
  const info = result.structuredContent as ServerInfo;
  assert.equal(info.member, "alice@example.com");
  assert.equal(info.workspace.slug, "acme");
});

test("a refusal is a structured isError result", async () => {
  const result = await tool(await accessToken(), "get_responsibility", { key: "no-such-thing" });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error, "unknown_responsibility");
  assert.ok(typeof result.structuredContent?.reason === "string");
});

test("a removed member's still-valid token is refused on the next call", async () => {
  await seedMembers(db, ["carol"], "acme");
  const token = await accessToken(memberIdFor("carol"));
  assert.equal((await call("tools/list", { token })).status, 200);

  await removeMember(db, "carol@example.com");

  const { status, json } = await call("tools/list", { token });
  assert.equal(status, 401);
  assert.equal(json.error, "invalid_token");
});

test("a removed-then-re-added person's old token is refused; the new membership is a new id", async () => {
  await seedMembers(db, ["dave"], "acme");
  const oldToken = await accessToken(memberIdFor("dave"));
  await removeMember(db, "dave@example.com");
  const readded = await addMember(db, "other-co", "dave@example.com");

  assert.notEqual(readded.id, memberIdFor("dave"));
  assert.equal((await call("tools/list", { token: oldToken })).status, 401, "old membership stays dead");

  const info = await getServerInfo(await accessToken(readded.id));
  assert.equal(info.workspace.slug, "other-co", "the new id acts only in the new workspace");
});

test("GET and DELETE on the endpoint are 405 once past the token check", async () => {
  for (const method of ["GET", "DELETE"]) {
    const response = await handleMcpRequest(
      new Request(ENDPOINT, { method, headers: { authorization: `Bearer ${await accessToken()}` } }),
    );
    assert.equal(response.status, 405, method);
  }
});

// --- request limits (GHSA-46jr-4wx8-v453) ------------------------------------

async function post(token: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await handleMcpRequest(
    new Request(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
  const text = await response.text();
  return { status: response.status, json: JSON.parse(text) as { id?: unknown; error?: { code: number; message: string } } };
}

test("protocol metadata past the element bound is refused before the SDK validates it", async () => {
  const token = await accessToken();
  const icons = new Array(500_000).fill(0); // one megabyte of invalid entries

  const modern = await post(
    token,
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1.0.0", icons },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    },
    { "mcp-protocol-version": PROTOCOL_VERSION, "mcp-method": "tools/list" },
  );
  assert.equal(modern.status, 400);
  assert.equal(modern.json.error?.code, -32600);
  assert.match(modern.json.error?.message ?? "", new RegExp(`more than ${MAX_PROTOCOL_ELEMENTS}`));
  assert.equal(modern.json.id, 7);

  const legacy = await post(token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legacy", version: "1", icons } },
  });
  assert.equal(legacy.status, 400);
  assert.equal(legacy.json.error?.code, -32600);
});

test("a body the bound does not take is answered by the SDK as before: too large, not JSON", async () => {
  const token = await accessToken();
  const send = (body: string) =>
    handleMcpRequest(
      new Request(ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body,
      }),
    );

  assert.equal((await send(JSON.stringify({ padding: "x".repeat(5 * 1024 * 1024) }))).status, 413);

  const unparseable = await send("{ not json");
  assert.equal(unparseable.status, 400);
  assert.match(await unparseable.text(), /-32700/);
});

test("tool arguments do not count against the protocol bound", async () => {
  const result = await tool(await accessToken(), "get_server_info", {
    padding: new Array(MAX_PROTOCOL_ELEMENTS * 5).fill(0),
  });
  assert.equal((result.structuredContent as ServerInfo).member, "alice@example.com");
});

test("tool arguments past MAX_TOOL_INPUT_ELEMENTS are refused before any schema runs", async () => {
  const { status, json } = await call("tools/call", {
    token: await accessToken(),
    name: "get_server_info",
    params: { name: "get_server_info", arguments: { padding: new Array(MAX_TOOL_INPUT_ELEMENTS).fill(0) } },
  });
  assert.equal(status, 200);
  assert.equal(json.result?.isError, true);
  assert.match(JSON.stringify(json.result), new RegExp(`maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements`));
});

test("a tool answer carries no token and no secret", async () => {
  const token = await accessToken();
  const { body } = await call("tools/call", {
    token,
    name: "get_server_info",
    params: { name: "get_server_info", arguments: {} },
  });
  assert.equal(body.includes(token), false);
  assert.equal(body.includes(process.env.OAUTH_SIGNING_SECRET!), false);
});
