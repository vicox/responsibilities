import {
  bearerAuthChallengeResponse,
  createMcpHandler,
  OAuthError,
  OAuthErrorCode,
  originValidationResponse,
  requireBearerAuth,
  type AuthInfo,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";

import { database } from "../db.ts";
import { MCP_SCOPE, deployment, signingKey } from "../oauth/config.ts";
import { wrongOrigin } from "../oauth/origin.ts";
import { configurationFault } from "../oauth/responses.ts";
import { accessTokenVerifier } from "../oauth/tokens.ts";
import { responsibilityStore } from "../responsibilities/store.ts";
import { mcpSession, type McpSession } from "../workspace/members.ts";
import { limitProtocolElements } from "./limits.ts";
import { responsibilitiesMcpServer } from "./server.ts";

/**
 * The MCP endpoint: one authorization boundary, then the server (ported from
 * Tonight, plus the membership lookup of plan §7.3).
 *
 *     request
 *        ↓  canonical host?                    404 if not
 *        ↓  Bearer token valid for /mcp?       401 (+ resource_metadata) if not
 *        ↓  token subject an active member?    401 invalid_token if not
 *        ↓  Origin allowed?                    403 if not
 *        ↓  protocol part of the body bounded? 400 if not (limits.ts)
 *        ↓  MCP server built for {workspace, member, client}
 *      tool
 *
 * A tool never sees a header, a token or a claim: it is handed a server whose
 * store is already scoped to the session.
 */

let handler: McpHttpHandler | undefined;

function mcpHandler(): McpHttpHandler {
  handler ??= createMcpHandler(async (ctx) => {
    const session = sessionOf(ctx.authInfo);
    const store = responsibilityStore(await database(), {
      workspaceId: session.workspace.id,
      memberId: session.member.id,
      clientId: session.client.id,
      clientName: session.client.name,
    });
    return responsibilitiesMcpServer({ ...session, store });
  });
  return handler;
}

/**
 * Serves one MCP request. The SDK speaks the current protocol revision and falls
 * back per request to the 2025-era stateless shape for a client that still opens
 * with `initialize`.
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
  let auth: AuthInfo | Response;
  let allowedOrigins: string[];
  let resourceMetadataUrl: string;
  let session: McpSession | undefined;

  try {
    const config = deployment();
    const key = signingKey();

    const misdirected = wrongOrigin(request, config);
    if (misdirected) return misdirected;

    allowedOrigins = [config.hostname];
    resourceMetadataUrl = config.resourceMetadataUrl;

    auth = await requireBearerAuth({
      verifier: accessTokenVerifier(config, key),
      requiredScopes: [MCP_SCOPE],
      resourceMetadataUrl,
    })(request);

    if (!(auth instanceof Response)) {
      // One indexed lookup per request: a removed member is refused on the next
      // call, whatever access token it still holds.
      const memberId = typeof auth.extra?.userId === "string" ? auth.extra.userId : "";
      session = await mcpSession(await database(), memberId, auth.clientId);
    }
  } catch (error) {
    return configurationFault(error);
  }

  const rejected = originValidationResponse(request, allowedOrigins);
  if (rejected) return rejected;

  if (auth instanceof Response) return auth;

  if (!session) {
    // The client re-authorizes and is then refused at admission with a readable
    // answer; here it is only told its token no longer works.
    return bearerAuthChallengeResponse(
      new OAuthError(OAuthErrorCode.InvalidToken, "The access token is invalid or has expired."),
      { requiredScopes: [MCP_SCOPE], resourceMetadataUrl },
    );
  }

  const body = await limitProtocolElements(request);
  if (body instanceof Response) return body;

  return mcpHandler().fetch(request, { ...body, authInfo: { ...auth, extra: { ...auth.extra, session } } });
}

/** The session behind a verified token; by construction there always is one. */
function sessionOf(authInfo: AuthInfo | undefined): McpSession {
  const session = authInfo?.extra?.session as McpSession | undefined;
  if (!session?.workspace?.id || !session.member?.id || !session.client) {
    throw new Error("An MCP server was built without an authenticated session.");
  }
  return session;
}
