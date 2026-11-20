import type { SchemaModule } from "../db/migrate.ts";

/**
 * Module "responsibilities" (plan §4). Every row is keyed `(workspace_id, id)` and
 * every foreign key carries `workspace_id`, so no row can reference another
 * workspace's row. The application never deletes a row.
 */
export const RESPONSIBILITIES_SCHEMA: SchemaModule = {
  module: "responsibilities",
  migrations: [
    {
      version: 1,
      sql: `
        CREATE TABLE responsibilities (
          workspace_id uuid NOT NULL REFERENCES workspaces (id),
          id           uuid NOT NULL DEFAULT gen_random_uuid(),
          key          text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
          created_at   timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (workspace_id, id),
          UNIQUE (workspace_id, key)
        );
        CREATE TABLE responsibility_versions (
          workspace_id      uuid NOT NULL,
          id                uuid NOT NULL DEFAULT gen_random_uuid(),
          responsibility_id uuid NOT NULL,
          version           integer NOT NULL CHECK (version >= 1),
          title             text NOT NULL,
          subject_type      text NOT NULL,
          expectation       text NOT NULL,
          assessments       jsonb NOT NULL,
          content_hash      text NOT NULL,
          created_by        uuid NOT NULL,
          created_at        timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (workspace_id, id),
          UNIQUE (workspace_id, responsibility_id, version),
          FOREIGN KEY (workspace_id, responsibility_id) REFERENCES responsibilities (workspace_id, id),
          FOREIGN KEY (workspace_id, created_by) REFERENCES members (workspace_id, id)
        );
        CREATE TABLE runs (
          workspace_id      uuid NOT NULL,
          id                uuid NOT NULL DEFAULT gen_random_uuid(),
          responsibility_id uuid NOT NULL,
          version_id        uuid NOT NULL,
          member_id         uuid NOT NULL,
          client_id         text NOT NULL,
          client_name       text,
          agent             jsonb NOT NULL,
          started_at        timestamptz NOT NULL DEFAULT now(),
          sources           jsonb,
          completed_at      timestamptz,
          outcome           text CHECK (outcome IN ('completed', 'partial', 'failed', 'abandoned')),
          summary           text,
          report            text,
          completion        jsonb,
          CHECK ((completed_at IS NULL) = (outcome IS NULL)),
          CHECK ((completion IS NOT NULL) = (outcome IN ('completed', 'partial', 'failed'))),
          PRIMARY KEY (workspace_id, id),
          FOREIGN KEY (workspace_id, responsibility_id) REFERENCES responsibilities (workspace_id, id),
          FOREIGN KEY (workspace_id, version_id) REFERENCES responsibility_versions (workspace_id, id),
          FOREIGN KEY (workspace_id, member_id) REFERENCES members (workspace_id, id)
        );
        -- At most one open run per responsibility: every run has one consistent baseline.
        CREATE UNIQUE INDEX runs_one_open ON runs (workspace_id, responsibility_id)
          WHERE completed_at IS NULL;
        CREATE INDEX runs_recent ON runs (workspace_id, responsibility_id, started_at DESC);
        CREATE TABLE cases (
          workspace_id      uuid NOT NULL,
          id                uuid NOT NULL DEFAULT gen_random_uuid(),
          responsibility_id uuid NOT NULL,
          subject           text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
          status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
          opened_at         timestamptz NOT NULL DEFAULT now(),
          closed_at         timestamptz,
          close_reason      text,
          attention_since   timestamptz,
          CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
          CHECK ((status = 'closed') = (close_reason IS NOT NULL)),
          CHECK (status = 'open' OR attention_since IS NULL),
          PRIMARY KEY (workspace_id, id),
          FOREIGN KEY (workspace_id, responsibility_id) REFERENCES responsibilities (workspace_id, id)
        );
        CREATE UNIQUE INDEX cases_subject ON cases (workspace_id, responsibility_id, lower(subject));
        CREATE TABLE observations (
          workspace_id uuid NOT NULL,
          run_id       uuid NOT NULL,
          case_id      uuid NOT NULL,
          facts        jsonb NOT NULL,
          observed_at  timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (workspace_id, run_id, case_id),
          FOREIGN KEY (workspace_id, run_id)  REFERENCES runs  (workspace_id, id),
          FOREIGN KEY (workspace_id, case_id) REFERENCES cases (workspace_id, id)
        );
        CREATE INDEX observations_case ON observations (workspace_id, case_id, observed_at DESC);
        CREATE TABLE decisions (
          workspace_id uuid NOT NULL,
          run_id       uuid NOT NULL,
          case_id      uuid NOT NULL,
          assessment   text NOT NULL,
          attention    jsonb,
          basis        text NOT NULL,
          cites        text[] NOT NULL DEFAULT '{}',
          status       text NOT NULL CHECK (status IN ('open', 'closed')),
          close_reason text,
          decided_at   timestamptz NOT NULL DEFAULT now(),
          CHECK ((status = 'closed') = (close_reason IS NOT NULL)),
          CHECK (status = 'open' OR attention IS NULL),
          PRIMARY KEY (workspace_id, run_id, case_id),
          FOREIGN KEY (workspace_id, run_id, case_id)
            REFERENCES observations (workspace_id, run_id, case_id)
        );
        CREATE INDEX decisions_case ON decisions (workspace_id, case_id, decided_at DESC);
      `,
    },
  ],
};
