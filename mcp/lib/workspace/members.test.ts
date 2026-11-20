import assert from "node:assert/strict";
import test from "node:test";

/**
 * Membership (plan §7.2–7.3): admission at the Google callback, and the
 * in-transaction checks at code redemption and refresh rotation.
 */
process.env.PUBLIC_ORIGIN = "http://localhost:3000";
process.env.OAUTH_SIGNING_SECRET = "test-signing-secret-of-at-least-32-bytes";
process.env.DEV_DATABASE_DIR = "memory://"; // never the developer's .devdb

const { database } = await import("../db.ts");
const { AccessDeniedError, addMember, addWorkspace, admitMember, listMembers, removeMember, AdminError } =
  await import("./members.ts");
const { identifyUser } = await import("../oauth/provider.ts");
const { oauthStore } = await import("../oauth/store.ts");
const { handleToken } = await import("../oauth/exchange.ts");
const { createPkce } = await import("../oauth/pkce.ts");
const { accessTokenVerifier } = await import("../oauth/tokens.ts");
const { deployment, signingKey } = await import("../oauth/config.ts");

type IdentityProvider = import("../oauth/provider.ts").IdentityProvider;

const db = await database();
await addWorkspace(db, "acme", "Acme");
await addWorkspace(db, "beta", "Beta");

const allow = () => undefined;
const RESOURCE = "http://localhost:3000/mcp";

function google(subject: string, email: string): IdentityProvider {
  return {
    name: "stub",
    authorizationOrigin: "https://accounts.google.example",
    authorizationUrl: () => "https://accounts.google.example/authorize",
    identify: async () => ({ subject, email }),
  };
}

const RESPONSE = { code: "c", redirectUri: "r", codeVerifier: "v", nonce: "n" };

test("a non-member is refused and nothing is issued", async () => {
  await assert.rejects(
    admitMember(db, { email: "nobody@example.com", subject: "sub-nobody" }),
    AccessDeniedError,
  );
  await assert.rejects(identifyUser(RESPONSE, google("sub-x", "x@example.com")), AccessDeniedError);
});

test("the first login binds google_sub; the user id is the member id", async () => {
  const member = await addMember(db, "acme", " Ann@Example.com ");
  assert.equal(member.email, "ann@example.com", "stored normalised");

  const user = await identifyUser(RESPONSE, google("sub-ann", "ANN@example.com"));
  assert.equal(user.id, member.id);

  const [row] = await db.query<{ google_sub: string }>(`SELECT google_sub FROM members WHERE id = $1`, [member.id]);
  assert.equal(row.google_sub, "sub-ann");

  assert.equal((await identifyUser(RESPONSE, google("sub-ann", "ann@example.com"))).id, member.id, "again");
});

test("the same address from another Google account is refused", async () => {
  await addMember(db, "acme", "ben@example.com");
  await admitMember(db, { email: "ben@example.com", subject: "sub-ben" });
  await assert.rejects(
    admitMember(db, { email: "ben@example.com", subject: "sub-impostor" }),
    (error: unknown) => error instanceof AccessDeniedError && /different Google account/.test(error.message),
  );
});

test("a Google account already bound to another active membership cannot bind a second", async () => {
  await addMember(db, "acme", "cat@example.com");
  await admitMember(db, { email: "cat@example.com", subject: "sub-cat" });
  await addMember(db, "beta", "cat.alias@example.com");
  await assert.rejects(
    admitMember(db, { email: "cat.alias@example.com", subject: "sub-cat" }),
    AccessDeniedError,
  );
});

test("one active membership per person; removal is final and re-adding creates a new member", async () => {
  const first = await addMember(db, "acme", "dan@example.com");
  await assert.rejects(addMember(db, "beta", "dan@example.com"), AdminError);

  await removeMember(db, "dan@example.com");
  await assert.rejects(admitMember(db, { email: "dan@example.com", subject: "sub-dan" }), AccessDeniedError);
  await assert.rejects(removeMember(db, "dan@example.com"), AdminError);

  const second = await addMember(db, "beta", "dan@example.com");
  assert.notEqual(second.id, first.id);
  assert.equal(await admitMember(db, { email: "dan@example.com", subject: "sub-dan" }), second.id);

  const listed = await listMembers(db, "acme");
  assert.ok(listed.some((m) => m.email === "dan@example.com" && m.removed_at !== null));
});

test("a removed member's authorization code is refused and deleted", async () => {
  const member = await addMember(db, "acme", "eve@example.com");
  const store = await oauthStore();
  const code = await store.issueCode({
    clientId: "client-1",
    redirectUri: "http://localhost/cb",
    codeChallenge: "challenge",
    scope: "mcp",
    resource: RESOURCE,
    userId: member.id,
  });

  await removeMember(db, "eve@example.com");

  assert.deepEqual(await store.redeemCode(code, allow), { outcome: "unknown" });
  const rows = await db.query(`SELECT 1 FROM oauth_authorization_codes WHERE user_id = $1`, [member.id]);
  assert.equal(rows.length, 0, "the code is gone");
});

test("a removed member's refresh token is refused and its family revoked", async () => {
  const member = await addMember(db, "acme", "fay@example.com");
  const store = await oauthStore();
  const grant = { clientId: "client-1", scope: "mcp", resource: RESOURCE, userId: member.id };
  const refresh = await store.issueRefreshToken(grant);
  const rotated = await store.rotateRefreshToken(refresh, allow);
  assert.equal(rotated.outcome, "rotated");
  const current = rotated.outcome === "rotated" ? rotated.refreshToken : "";

  await removeMember(db, "fay@example.com");

  assert.deepEqual(await store.rotateRefreshToken(current, allow), { outcome: "unknown" });
  const [family] = await db.query<{ revoked_at: Date | null }>(
    `SELECT revoked_at FROM oauth_refresh_families WHERE user_id = $1`,
    [member.id],
  );
  assert.ok(family.revoked_at, "the family is revoked");
  const tokens = await db.query(
    `SELECT 1 FROM oauth_refresh_tokens t JOIN oauth_refresh_families f USING (family_id) WHERE f.user_id = $1`,
    [member.id],
  );
  assert.equal(tokens.length, 0, "and its tokens deleted");

  // Re-admitting the person does not revive the old family.
  await addMember(db, "acme", "fay@example.com");
  assert.deepEqual(await store.rotateRefreshToken(current, allow), { outcome: "unknown" });
});

test("the access token's sub is the member id", async () => {
  const member = await addMember(db, "acme", "gus@example.com");
  const pkce = createPkce();
  const code = await (await oauthStore()).issueCode({
    clientId: "client-1",
    redirectUri: "http://localhost/cb",
    codeChallenge: pkce.challenge,
    scope: "mcp",
    resource: RESOURCE,
    userId: member.id,
  });
  const response = await handleToken(
    new Request("http://localhost:3000/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "client-1",
        code,
        code_verifier: pkce.verifier,
        redirect_uri: "http://localhost/cb",
      }),
    }),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  const info = await accessTokenVerifier(deployment(), signingKey()).verifyAccessToken(body.access_token);
  assert.equal(info.extra?.userId, member.id);

  // And after removal, the refresh grant at the token endpoint is invalid_grant.
  await removeMember(db, "gus@example.com");
  const refreshed = await handleToken(
    new Request("http://localhost:3000/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "client-1",
        refresh_token: body.refresh_token,
      }),
    }),
  );
  assert.equal(refreshed.status, 400);
  assert.equal((await refreshed.json()).error, "invalid_grant");
});
