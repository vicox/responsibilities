/**
 * `npm run admin -- <command>` — the operator CLI (plan §7.6). No HTTP surface.
 *
 *   workspace:add <slug> "<name>"
 *   member:add <slug> <email>
 *   member:remove <email>        # sets removed_at; final
 *   member:list <slug>
 *
 * Same connection rule as `npm run db:migrate`: DATABASE_URL, or `--embedded`
 * for the local development database. The schema must already be migrated.
 */
import { connectForCli, EMBEDDED_FLAG } from "../lib/db/connect-cli.ts";
import { requireSchema } from "../lib/db/migrate.ts";
import { ALL_SCHEMAS } from "../lib/db/schemas.ts";
import {
  AdminError,
  addMember,
  addWorkspace,
  listMembers,
  removeMember,
} from "../lib/workspace/members.ts";

const USAGE = `Usage: npm run admin -- <command> [${EMBEDDED_FLAG}]

  workspace:add <slug> "<name>"
  member:add <slug> <email>
  member:remove <email>        sets removed_at; final (re-adding creates a new membership)
  member:list <slug>

The database is DATABASE_URL, or the local development database with ${EMBEDDED_FLAG}.`;

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== EMBEDDED_FLAG);
  const [command, ...rest] = args;
  const arity: Record<string, number> = {
    "workspace:add": 2,
    "member:add": 2,
    "member:remove": 1,
    "member:list": 1,
  };
  if (!command || !Object.hasOwn(arity, command) || rest.length !== arity[command]) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const connection = await connectForCli(process.argv);
  if (typeof connection === "string") {
    console.error(connection);
    process.exitCode = 1;
    return;
  }
  const { driver } = connection;
  try {
    for (const schema of ALL_SCHEMAS) await requireSchema(driver, schema);

    switch (command) {
      case "workspace:add": {
        const workspace = await addWorkspace(driver, rest[0], rest[1]);
        console.log(`Added workspace ${workspace.slug} (${workspace.name}).`);
        break;
      }
      case "member:add": {
        const member = await addMember(driver, rest[0], rest[1]);
        console.log(`Added ${member.email} to ${member.workspace}.`);
        break;
      }
      case "member:remove": {
        const member = await removeMember(driver, rest[0]);
        console.log(
          `Removed ${member.email}. Its next /mcp call is refused; its refresh tokens stop working.`,
        );
        break;
      }
      case "member:list": {
        const members = await listMembers(driver, rest[0]);
        if (!members.length) console.log("(no members)");
        for (const member of members) {
          const state = member.removed_at
            ? `removed ${member.removed_at.toISOString()}`
            : member.bound
              ? "active, Google account bound"
              : "active, not yet signed in";
          console.log(`${member.email}\t${state}\tadded ${member.added_at.toISOString()}`);
        }
        break;
      }
    }
  } catch (error) {
    if (error instanceof AdminError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    await driver.close();
  }
}

await main();
