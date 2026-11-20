import type { SchemaModule } from "../db/migrate.ts";

/**
 * Module "workspace": workspaces and their members (plan §4).
 *
 * A member row never changes workspace, its `google_sub` is bound once, and
 * removal is final — re-adding a person creates a new row with a new id. The
 * member id is what codes, refresh families and access tokens name, so a
 * credential issued for one membership can never act for another.
 */
export const WORKSPACE_SCHEMA: SchemaModule = {
  module: "workspace",
  migrations: [
    {
      version: 1,
      sql: `
        CREATE TABLE workspaces (
          id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
          name        text NOT NULL,
          created_at  timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE members (
          workspace_id uuid NOT NULL REFERENCES workspaces (id),
          id           uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
          email        text NOT NULL CHECK (email = lower(btrim(email))),
          google_sub   text,
          added_at     timestamptz NOT NULL DEFAULT now(),
          removed_at   timestamptz,
          PRIMARY KEY (workspace_id, id)
        );
        -- MVP: one active membership per person, so the workspace follows from the identity.
        CREATE UNIQUE INDEX members_email_active ON members (email) WHERE removed_at IS NULL;
        CREATE UNIQUE INDEX members_sub_active   ON members (google_sub)
          WHERE removed_at IS NULL AND google_sub IS NOT NULL;
      `,
    },
  ],
};
