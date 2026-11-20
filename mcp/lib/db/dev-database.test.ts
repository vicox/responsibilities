import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

/**
 * The local app and the operator commands open the same development database by
 * default, so a member added with `npm run admin -- --embedded` is one
 * `npm run dev` admits. Both run here with DEV_DATABASE_DIR unset, in a scratch
 * working directory, so the default `.devdb` is exercised without touching the
 * developer's own.
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "rm-devdb-"));
const home = process.cwd();
delete process.env.DEV_DATABASE_DIR;
delete process.env.DATABASE_URL;

const { DEFAULT_DEV_DATABASE_DIR, devDatabaseDir } = await import("./dev-database.ts");

after(() => {
  process.chdir(home);
  rmSync(scratch, { recursive: true, force: true });
});

test("an unset or blank DEV_DATABASE_DIR means the durable default .devdb", () => {
  for (const unset of [undefined, "", "  "]) {
    if (unset === undefined) delete process.env.DEV_DATABASE_DIR;
    else process.env.DEV_DATABASE_DIR = unset;
    assert.equal(devDatabaseDir(), DEFAULT_DEV_DATABASE_DIR);
  }
  delete process.env.DEV_DATABASE_DIR;
  assert.equal(DEFAULT_DEV_DATABASE_DIR, ".devdb");
});

test("with no configuration, a member added by the admin CLI is admitted by the app", async () => {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: "" };
  delete env.DEV_DATABASE_DIR;
  const cli = (script: string, ...args: string[]) =>
    execFileSync(process.execPath, [join(ROOT, script), ...args], { cwd: scratch, env, encoding: "utf8" });

  assert.match(cli("lib/db/migrate-cli.ts", "--embedded"), /Applied 3 migration\(s\) \(\.devdb\)/);
  cli("scripts/admin.ts", "--embedded", "workspace:add", "devco", "Dev Co");
  cli("scripts/admin.ts", "--embedded", "member:add", "devco", "local@example.com");
  assert.ok(existsSync(join(scratch, ".devdb")), "the CLI wrote the default directory");

  process.chdir(scratch);
  const { database } = await import("../db.ts");
  const { admitMember, mcpSession } = await import("../workspace/members.ts");
  const db = await database();
  try {
    const memberId = await admitMember(db, { email: "local@example.com", subject: "sub-local" });
    const session = await mcpSession(db, memberId, "client-1");
    assert.equal(session?.workspace.slug, "devco");
    assert.equal(session?.member.email, "local@example.com");
  } finally {
    await db.close();
  }
});
