import { ConfigurationError } from "./oauth/config.ts";
import { devDatabaseDir } from "./db/dev-database.ts";
import type { SqlDriver } from "./db/driver.ts";
import { prepareSchema } from "./db/migrate.ts";
import { ALL_SCHEMAS } from "./db/schemas.ts";

/**
 * The database this deployment uses, opened once (ported from Tonight).
 *
 * One pool for every schema module. Cached as a promise on `globalThis` so that
 * concurrent first requests and every `next dev` bundle share one pool; a rejected
 * promise is forgotten so a transient failure does not poison the instance.
 *
 * Opening also prepares every schema module: development migrates, production
 * only checks (`requireSchema`) and refuses a build whose migrations are missing.
 */
const OPENING = Symbol.for("responsibilities.database");

type Holder = { [OPENING]?: Promise<SqlDriver> };

export function database(): Promise<SqlDriver> {
  const holder = globalThis as Holder;
  holder[OPENING] ??= open().catch((error: unknown) => {
    holder[OPENING] = undefined;
    throw error;
  });
  return holder[OPENING];
}

/**
 * `DATABASE_URL` selects Postgres; without it, the embedded Postgres (PGlite) for
 * development. In production its absence is a configuration error, never a
 * fallback.
 */
async function open(): Promise<SqlDriver> {
  const driver = await connect();
  try {
    for (const schema of ALL_SCHEMAS) await prepareSchema(driver, schema);
  } catch (error) {
    await driver.close().catch(() => undefined);
    throw error;
  }
  return driver;
}

async function connect(): Promise<SqlDriver> {
  const url = process.env.DATABASE_URL?.trim();

  if (url) {
    const { postgresDriver } = await import("./db/postgres.ts");
    return postgresDriver(url);
  }

  if (process.env.NODE_ENV === "production") {
    throw new ConfigurationError(
      "DATABASE_URL is not set. Production needs durable storage (Neon pooled URL). See .env.example.",
    );
  }

  // The same directory the operator commands use (default .devdb), so members
  // added with `npm run admin -- --embedded` are the ones this app admits.
  const { embeddedDriver } = await import("./db/pglite.ts");
  return embeddedDriver(devDatabaseDir());
}
