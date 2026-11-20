/**
 * `/` answers one line of text. There is no website (plan §3); the service is
 * the MCP endpoint at /mcp.
 */
export const dynamic = "force-static";

export function GET(): Response {
  return new Response("Responsibilities MCP server. Connect an MCP client to /mcp.\n", {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
