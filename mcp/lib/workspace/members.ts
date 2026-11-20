import type { SqlDriver, Transaction } from "../db/driver.ts";
import { isSqlState, UNIQUE_VIOLATION } from "../db/driver.ts";

/**
 * Membership: who may use this deployment, and in which workspace (plan §7.2–7.3).
 *
 * Replaces Tonight's `ALLOWED_EMAILS`. Checked at the Google callback (admission),
 * inside code redemption and refresh rotation (`memberActiveInTransaction`), and
 * on every `/mcp` request (`mcpSession`). An empty `members` table admits nobody.
 */

/**
 * Somebody who authenticated with Google and still may not come in. Shown to the
 * person in the browser; it gives nothing away they do not already know.
 */
export class AccessDeniedError extends Error {
  override readonly name = "AccessDeniedError";
}

export type Workspace = { id: string; slug: string; name: string };
export type Member = { id: string; email: string };

/** The session `/mcp` builds its server for. */
export type McpSession = {
  workspace: Workspace;
  member: Member;
  client: { id: string; name: string | null };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a value can be compared with a uuid column without a type error. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** An address in the one form membership is stored and compared in. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Admits a verified Google identity as a member, binding `google_sub` on the
 * first authorization. Returns the member id, which becomes the
 * `AuthenticatedUser.id` and therefore the subject of every credential.
 *
 * Throws `AccessDeniedError` for a non-member, for an address now bound to a
 * different Google account, and when the Google account is already bound to a
 * different active member.
 */
export async function admitMember(
  driver: SqlDriver,
  identity: { email: string; subject: string },
): Promise<string> {
  const email = normaliseEmail(identity.email);
  const sub = identity.subject;

  const found = await activeMemberByEmail(driver, email);
  if (!found) {
    throw new AccessDeniedError("This Google account is not a member of any workspace.");
  }

  if (found.google_sub === null) {
    try {
      await driver.query(
        `UPDATE members SET google_sub = $2
          WHERE id = $1 AND google_sub IS NULL AND removed_at IS NULL
          RETURNING id`,
        [found.id, sub],
      );
    } catch (error) {
      // The members_sub_active index: this Google account is already bound to
      // another active membership. A refusal, never a second binding.
      if (isSqlState(error, UNIQUE_VIOLATION)) {
        throw new AccessDeniedError(
          "This Google account is already bound to another membership.",
        );
      }
      throw error;
    }
  }

  // Whatever the update did, the row as it is now decides: a concurrent bind by
  // another Google account, or a removal, wins over this request.
  const [now] = await driver.query<{ removed_at: Date | null; google_sub: string | null }>(
    `SELECT removed_at, google_sub FROM members WHERE id = $1`,
    [found.id],
  );
  if (!now || now.removed_at !== null) {
    throw new AccessDeniedError("This Google account is not a member of any workspace.");
  }
  if (now.google_sub !== sub) {
    throw new AccessDeniedError(
      "This address is a member, but bound to a different Google account.",
    );
  }
  return found.id;
}

async function activeMemberByEmail(
  driver: SqlDriver | Transaction,
  email: string,
): Promise<{ id: string; workspace_id: string; google_sub: string | null } | undefined> {
  const [row] = await driver.query<{ id: string; workspace_id: string; google_sub: string | null }>(
    `SELECT id, workspace_id, google_sub FROM members WHERE email = $1 AND removed_at IS NULL`,
    [email],
  );
  return row;
}

/**
 * The in-transaction membership check for code redemption and refresh rotation.
 *
 * `FOR SHARE` serialises against `removeMember`'s update: a removal is either
 * seen here (refused) or happens after the credential is minted (then `/mcp`
 * refuses on the next call).
 */
export async function memberActiveInTransaction(tx: Transaction, memberId: string): Promise<boolean> {
  if (!isUuid(memberId)) return false;
  const rows = await tx.query(
    `SELECT 1 FROM members WHERE id = $1 AND removed_at IS NULL FOR SHARE`,
    [memberId],
  );
  return rows.length > 0;
}

/**
 * The per-request lookup behind `/mcp`: the verified token's subject (a member
 * id) to an active membership and its workspace, plus the client's self-declared
 * registration name. One indexed lookup; a removal is effective on the next call.
 */
export async function mcpSession(
  driver: SqlDriver,
  memberId: string,
  clientId: string,
): Promise<McpSession | undefined> {
  if (!isUuid(memberId)) return undefined;
  const [row] = await driver.query<{
    workspace_id: string;
    slug: string;
    name: string;
    member_id: string;
    email: string;
    client_name: string | null;
  }>(
    `SELECT w.id AS workspace_id, w.slug, w.name, m.id AS member_id, m.email,
            (SELECT c.client_name FROM oauth_clients c WHERE c.client_id = $2) AS client_name
       FROM members m
       JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.id = $1 AND m.removed_at IS NULL`,
    [memberId, clientId],
  );
  if (!row) return undefined;
  return {
    workspace: { id: row.workspace_id, slug: row.slug, name: row.name },
    member: { id: row.member_id, email: row.email },
    client: { id: clientId, name: row.client_name },
  };
}

// --- operator commands (scripts/admin.ts) -----------------------------------

export class AdminError extends Error {
  override readonly name = "AdminError";
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,39}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function addWorkspace(driver: SqlDriver, slug: string, name: string): Promise<Workspace> {
  if (!SLUG.test(slug)) {
    throw new AdminError(`Invalid slug ${JSON.stringify(slug)}: use ^[a-z0-9][a-z0-9-]{1,39}$.`);
  }
  if (!name.trim()) throw new AdminError("A workspace needs a name.");
  try {
    const [row] = await driver.query<Workspace>(
      `INSERT INTO workspaces (slug, name) VALUES ($1, $2) RETURNING id, slug, name`,
      [slug, name.trim()],
    );
    return row;
  } catch (error) {
    if (isSqlState(error, UNIQUE_VIOLATION)) throw new AdminError(`Workspace ${slug} already exists.`);
    throw error;
  }
}

export async function addMember(
  driver: SqlDriver,
  slug: string,
  email: string,
): Promise<Member & { workspace: string }> {
  const address = normaliseEmail(email);
  if (!EMAIL.test(address)) throw new AdminError(`Not an email address: ${JSON.stringify(email)}.`);
  const [workspace] = await driver.query<{ id: string }>(`SELECT id FROM workspaces WHERE slug = $1`, [
    slug,
  ]);
  if (!workspace) throw new AdminError(`No workspace ${JSON.stringify(slug)}.`);
  try {
    const [row] = await driver.query<Member>(
      `INSERT INTO members (workspace_id, email) VALUES ($1, $2) RETURNING id, email`,
      [workspace.id, address],
    );
    return { ...row, workspace: slug };
  } catch (error) {
    if (isSqlState(error, UNIQUE_VIOLATION)) {
      throw new AdminError(
        `${address} is already an active member of a workspace (one active membership per person).`,
      );
    }
    throw error;
  }
}

/** Sets `removed_at` on the active membership. Final: re-adding creates a new row. */
export async function removeMember(driver: SqlDriver, email: string): Promise<Member> {
  const address = normaliseEmail(email);
  const [row] = await driver.query<Member>(
    `UPDATE members SET removed_at = now()
      WHERE email = $1 AND removed_at IS NULL
      RETURNING id, email`,
    [address],
  );
  if (!row) throw new AdminError(`${address} is not an active member.`);
  return row;
}

export type MemberListing = {
  id: string;
  email: string;
  bound: boolean;
  added_at: Date;
  removed_at: Date | null;
};

export async function listMembers(driver: SqlDriver, slug: string): Promise<MemberListing[]> {
  const [workspace] = await driver.query<{ id: string }>(`SELECT id FROM workspaces WHERE slug = $1`, [
    slug,
  ]);
  if (!workspace) throw new AdminError(`No workspace ${JSON.stringify(slug)}.`);
  return driver.query<MemberListing>(
    `SELECT id, email, google_sub IS NOT NULL AS bound, added_at, removed_at
       FROM members WHERE workspace_id = $1
      ORDER BY removed_at IS NOT NULL, email, added_at`,
    [workspace.id],
  );
}
