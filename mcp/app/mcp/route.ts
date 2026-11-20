import { handleMcpRequest } from "@/lib/mcp/endpoint";

/**
 * The remote MCP endpoint. Route plumbing only: the boundary, the protocol and
 * the tools live in lib/mcp so they can be tested without Next.js.
 *
 * POST carries every MCP message; GET and DELETE are answered 405 by the SDK
 * once past the token check.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleMcpRequest(request);
}

export async function GET(request: Request): Promise<Response> {
  return handleMcpRequest(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return handleMcpRequest(request);
}
