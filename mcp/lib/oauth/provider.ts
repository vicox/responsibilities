import { database } from "../db.ts";
import type { AuthenticatedUser } from "../identity.ts";
import { admitMember } from "../workspace/members.ts";
import { google } from "./google.ts";

/**
 * The seam between this authorization server and whatever authenticates the
 * person behind it (ported from Tonight).
 *
 * This server issues its own tokens for its own MCP endpoint; who the person
 * *is* is Google's answer. The flow steps aside for one round trip and comes back
 * with a verified identity, which admission then turns into a membership.
 */

/**
 * What a provider establishes about the person who signed in: Google's stable
 * subject and the verified, normalised address. Membership is by address; the
 * subject is bound to the member row at first authorization and checked on every
 * later one.
 */
export type VerifiedIdentity = {
  subject: string;
  email: string;
};

export type IdentityProvider = {
  readonly name: string;

  /**
   * The origin `authorizationUrl` sends the browser to. Named in the consent
   * page's `form-action` policy, so it must come from the provider
   * implementation and nothing a request could influence.
   */
  readonly authorizationOrigin: string;

  /** Where to send the browser so the user can authenticate. */
  authorizationUrl(request: {
    redirectUri: string;
    state: string;
    nonce: string;
    codeChallenge: string;
  }): string;

  /** Turns the provider's authorization code into a verified identity. Throws otherwise. */
  identify(response: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    nonce: string;
  }): Promise<VerifiedIdentity>;
};

/** The provider this deployment authenticates with: Google, `openid email`. */
export function identityProvider(): IdentityProvider {
  return google();
}

/**
 * Establishes who signed in and admits them as a member (plan §7.2) — the one
 * way in. Runs before anything is issued: a non-member never reaches an
 * authorization code. Returns the member id as the `AuthenticatedUser`, so codes,
 * refresh families and access tokens all name one membership row.
 *
 * Throws `AccessDeniedError` (lib/workspace/members.ts) when admission refuses.
 */
export async function identifyUser(
  response: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    nonce: string;
  },
  provider: IdentityProvider = identityProvider(),
): Promise<AuthenticatedUser> {
  const identity = await provider.identify(response);
  const memberId = await admitMember(await database(), identity);
  return { id: memberId };
}
