import { createHash } from "node:crypto";

import type { SqlDriver } from "./db/driver.ts";
import { migrate } from "./db/migrate.ts";
import { ALL_SCHEMAS } from "./db/schemas.ts";

/**
 * Test support (not a test file): migrations, and members whose ids are known
 * before they exist, so ported Tonight tests can name a user by a word.
 */

export async function migrateAll(driver: SqlDriver): Promise<void> {
  for (const schema of ALL_SCHEMAS) await migrate(driver, schema);
}

const names = new Map<string, string>();

/** A deterministic uuid for a test member name. */
export function memberIdFor(name: string): string {
  const hex = createHash("sha256").update(`member:${name}`).digest("hex");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  names.set(id, name);
  return id;
}

export function emailFor(name: string): string {
  return `${name}@example.com`;
}

/** The verified Google identity a test provider returns for a member. */
export function identityFor(memberId: string): { subject: string; email: string } {
  const name = names.get(memberId);
  if (!name) throw new Error(`No test member with id ${memberId}`);
  return { subject: `sub-${name}`, email: emailFor(name) };
}

/** Creates a workspace (if missing) and active members with `memberIdFor` ids. */
export async function seedMembers(
  driver: SqlDriver,
  memberNames: readonly string[],
  slug = "test-workspace",
): Promise<{ workspaceId: string; members: Record<string, string> }> {
  await driver.query(
    `INSERT INTO workspaces (slug, name) VALUES ($1, $2) ON CONFLICT (slug) DO NOTHING`,
    [slug, `Workspace ${slug}`],
  );
  const [{ id: workspaceId }] = await driver.query<{ id: string }>(
    `SELECT id FROM workspaces WHERE slug = $1`,
    [slug],
  );
  const members: Record<string, string> = {};
  for (const name of memberNames) {
    const id = memberIdFor(name);
    await driver.query(
      `INSERT INTO members (workspace_id, id, email) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [workspaceId, id, emailFor(name)],
    );
    members[name] = id;
  }
  return { workspaceId, members };
}
