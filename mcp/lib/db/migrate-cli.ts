/**
 * `npm run db:migrate` — brings every schema module up to date.
 *
 * In production this is the only thing that migrates: instances only check
 * (`requireSchema`). Order: migrate (direct Neon URL), then deploy.
 * Idempotent and safe to run concurrently.
 */
import { connectForCli } from "./connect-cli.ts";
import { migrate } from "./migrate.ts";
import { ALL_SCHEMAS } from "./schemas.ts";

async function main(): Promise<void> {
  const connection = await connectForCli(process.argv);
  if (typeof connection === "string") {
    console.error(connection);
    process.exitCode = 1;
    return;
  }

  const { driver, target } = connection;
  try {
    let total = 0;
    for (const schema of ALL_SCHEMAS) {
      const applied = await migrate(driver, schema);
      total += applied;
      if (applied > 0) console.log(`  ${schema.module}: applied ${applied} migration(s)`);
    }
    console.log(
      total === 0 ? `Schema is up to date (${target}).` : `Applied ${total} migration(s) (${target}).`,
    );
  } finally {
    await driver.close();
  }
}

await main();
