import { devDatabaseDir } from "./dev-database.ts";
import type { SqlDriver } from "./driver.ts";

/**
 * The connection rule every operator command shares (ported from Tonight's
 * migrate CLI): the target database is named explicitly — `DATABASE_URL`, or
 * `--embedded` for the local development database — never guessed. A deploy step
 * whose variable failed to reach it must fail, not change a throwaway database.
 */
export const EMBEDDED_FLAG = "--embedded";

export type CliConnection = { driver: SqlDriver; target: string };

export async function connectForCli(argv: readonly string[]): Promise<CliConnection | string> {
  const url = process.env.DATABASE_URL?.trim();
  const embedded = argv.includes(EMBEDDED_FLAG);

  if (!url && !embedded) {
    return (
      "DATABASE_URL is not set.\n\n" +
      "Operator commands must name the database they change. Set DATABASE_URL, or pass\n" +
      `${EMBEDDED_FLAG} to use the local development database (DEV_DATABASE_DIR, default .devdb).`
    );
  }
  if (url && embedded) {
    return `Both DATABASE_URL and ${EMBEDDED_FLAG} were given, and they name different databases. Pass one.`;
  }

  if (url) {
    const { postgresDriver } = await import("./postgres.ts");
    return { driver: await postgresDriver(url), target: "DATABASE_URL" };
  }
  // The same directory `npm run dev` opens (lib/db/dev-database.ts). Stop
  // `npm run dev` first — one process owns a PGlite directory at a time.
  const directory = devDatabaseDir();
  const { embeddedDriver } = await import("./pglite.ts");
  return { driver: await embeddedDriver(directory), target: directory };
}
