import { randomBytes } from "node:crypto";

import type { SqlDriver } from "./db/driver.ts";
import { postgresDriver } from "./db/postgres.ts";

/**
 * Support for `*.pg.test.ts` (not a test file): real Postgres at
 * `TEST_DATABASE_URL`, each suite in its own throwaway schema so suites never see
 * each other's rows. `npm run test:pg` requires the variable; a plain `npm test`
 * reports these suites as skipped without it.
 */

const url = process.env.TEST_DATABASE_URL?.trim();

if (!url && process.env.RM_REQUIRE_TEST_DATABASE === "1") {
  throw new Error(
    "npm run test:pg needs TEST_DATABASE_URL (a throwaway Postgres, e.g. a Neon branch's direct URL).",
  );
}

export const pgSkip: string | false = url ? false : "TEST_DATABASE_URL is not set (run npm run test:pg)";

/**
 * A fresh schema and `count` independent pools on it (each pool is what one
 * application instance holds). `drop` removes the schema and closes everything.
 */
export async function pgSchema(count: number): Promise<{ drivers: SqlDriver[]; drop: () => Promise<void> }> {
  if (!url) throw new Error("TEST_DATABASE_URL is not set");
  const schema = `rm_pgtest_${randomBytes(6).toString("hex")}`;
  const admin = await postgresDriver(url);
  await admin.exec(`CREATE SCHEMA ${schema}`);

  const scoped = new URL(url);
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  const drivers = await Promise.all(Array.from({ length: count }, () => postgresDriver(scoped.toString())));

  return {
    drivers,
    drop: async () => {
      for (const driver of drivers) await driver.close().catch(() => undefined);
      await admin.exec(`DROP SCHEMA ${schema} CASCADE`).catch(() => undefined);
      await admin.close();
    },
  };
}
