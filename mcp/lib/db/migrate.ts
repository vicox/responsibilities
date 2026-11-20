import { ConfigurationError } from "../oauth/config.ts";
import type { SqlDriver } from "./driver.ts";

/**
 * One migration mechanism for every schema module in the database (ported from
 * Tonight, without cross-module needs or code steps).
 *
 * A migration is identified by a module and a version; each module counts from
 * one. The guard against two processes migrating at once is the tracking table's
 * primary key: each step claims its row and runs its DDL in one transaction, so a
 * concurrent claimant blocks until the winner commits, then finds the row taken
 * and does nothing.
 */

/** One step, and the SQL that takes it. */
export type Migration = { version: number; sql: string };

/**
 * A named schema and its ordered steps.
 *
 * Append to `migrations`; never edit an entry that has shipped.
 */
export type SchemaModule = { module: string; migrations: readonly Migration[] };

/**
 * Makes a module's schema ready to use, in the way this environment allows:
 * development migrates; production only checks and refuses. A request from the
 * internet never runs DDL in production — `npm run db:migrate` does.
 */
export async function prepareSchema(driver: SqlDriver, schema: SchemaModule): Promise<void> {
  if (process.env.NODE_ENV !== "production") {
    await migrate(driver, schema);
    return;
  }
  await requireSchema(driver, schema);
}

/**
 * Refuses unless every migration this code needs has already been applied.
 *
 * Named versions rather than a count, so a database migrated by a newer deploy
 * still satisfies an older instance (a rollback is not an outage). Reads only;
 * a missing tracking table is itself the answer.
 */
export async function requireSchema(driver: SqlDriver, schema: SchemaModule): Promise<void> {
  const wanted = schema.migrations.map((migration) => migration.version);
  if (!wanted.length) return;

  const [tracking] = await driver.query<{ present: boolean }>(
    "SELECT to_regclass('schema_migrations') IS NOT NULL AS present",
  );

  const applied = tracking?.present
    ? (
        await driver.query<{ version: number }>(
          "SELECT version FROM schema_migrations WHERE module = $1",
          [schema.module],
        )
      ).map((row) => row.version)
    : [];

  const missing = wanted.filter((version) => !applied.includes(version));
  if (missing.length) {
    throw new ConfigurationError(
      `The ${schema.module} schema is not up to date: migration(s) ` +
        `${missing.join(", ")} have not been applied. Run \`npm run db:migrate\` against ` +
        `this deployment's database before the new code serves traffic. ` +
        `Production never migrates from a request.`,
    );
  }
}

/**
 * Brings one module's schema up to date, returning how many steps ran.
 * Idempotent and safe to run concurrently.
 */
export async function migrate(driver: SqlDriver, schema: SchemaModule): Promise<number> {
  await ensureTrackingTable(driver);

  let applied = 0;
  for (const migration of schema.migrations) {
    const ran = await driver.transaction(async (tx) => {
      // Claimed rather than inserted-and-caught: a unique violation raised by the
      // migration's own SQL must stay a failure, never a silently skipped step.
      const claimed = await tx.query<{ version: number }>(
        `INSERT INTO schema_migrations (module, version) VALUES ($1, $2)
         ON CONFLICT DO NOTHING
         RETURNING version`,
        [schema.module, migration.version],
      );
      if (!claimed.length) return false;
      await tx.exec(migration.sql);
      return true;
    });
    if (ran) applied += 1;
  }
  return applied;
}

const BOOTSTRAP_ATTEMPTS = 3;

/**
 * Creates the tracking table if this database has never been migrated.
 *
 * `CREATE TABLE IF NOT EXISTS` is not atomic against another session doing the
 * same, so a failure is forgiven only when the table exists afterwards.
 */
async function ensureTrackingTable(driver: SqlDriver): Promise<void> {
  const create = `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      module     text NOT NULL,
      version    integer NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (module, version)
    );
  `;

  for (let attempt = 1; ; attempt++) {
    try {
      await driver.exec(create);
      return;
    } catch (error) {
      if (await trackingTableExists(driver)) return;
      if (attempt === BOOTSTRAP_ATTEMPTS) throw error;
    }
  }
}

async function trackingTableExists(driver: SqlDriver): Promise<boolean> {
  const [row] = await driver.query<{ present: boolean }>(
    "SELECT to_regclass('schema_migrations') IS NOT NULL AS present",
  );
  return row?.present ?? false;
}
