import { OAUTH_SCHEMA } from "../oauth/store/sql.ts";
import { RESPONSIBILITIES_SCHEMA } from "../responsibilities/schema.ts";
import { WORKSPACE_SCHEMA } from "../workspace/schema.ts";
import type { SchemaModule } from "./migrate.ts";

/**
 * Every schema module in the database, in dependency order: `workspace` before
 * `responsibilities` (foreign keys), `oauth` independent.
 *
 * This is the list `npm run db:migrate` runs and the list the application
 * prepares when it opens the database, so a module cannot be opened without
 * also being migrated.
 */
export const ALL_SCHEMAS: readonly SchemaModule[] = [
  OAUTH_SCHEMA,
  WORKSPACE_SCHEMA,
  RESPONSIBILITIES_SCHEMA,
];
