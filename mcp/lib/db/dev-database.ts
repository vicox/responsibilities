/**
 * Where the embedded development database lives — one answer for the app
 * (`lib/db.ts`, i.e. `npm run dev`) and the operator commands (`npm run
 * db:migrate -- --embedded`, `npm run admin -- --embedded`), so a member added
 * with the CLI is the member the local app admits.
 *
 * Durable by default (`.devdb`, gitignored). `memory://` is PGlite's in-memory
 * database: what the tests use, and only when asked for.
 *
 * One PGlite directory is owned by one process at a time: stop `npm run dev`
 * before running an operator command against it.
 */
export const DEFAULT_DEV_DATABASE_DIR = ".devdb";
export const IN_MEMORY_DATABASE = "memory://";

export function devDatabaseDir(): string {
  return process.env.DEV_DATABASE_DIR?.trim() || DEFAULT_DEV_DATABASE_DIR;
}
