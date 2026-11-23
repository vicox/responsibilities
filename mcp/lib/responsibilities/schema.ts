import type { SchemaModule } from "../db/migrate.ts";

/**
 * Module "responsibilities" (plan §4; since v3 docs/core-integration-plan.md §5).
 * Every row is keyed by `workspace_id` and every foreign key carries it, so no row
 * can reference another workspace's row. The application deletes only the rows an
 * open run replaces (`record_observations` with `replace`).
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
    {
      // The run's last activity: start_run, then every accepted record_observations.
      // Null on runs started before this column existed, whose activity is unknown:
      // such a run is held for its whole lifetime until a write sets it.
      // Nullable and not backfilled, so no existing row is rewritten.
      version: 2,
      sql: `ALTER TABLE runs ADD COLUMN last_active_at timestamptz;`,
    },
    {
      // responsibilities-core becomes the only decision engine (docs/core-integration-plan.md
      // §5.2). Clean slate: every domain row of this module is discarded and the tables
      // are created anew, empty. Workspaces, members, OAuth and schema_migrations are not
      // touched; no table of another module references these six.
      version: 3,
      sql: `
        -- In foreign-key order and deliberately without CASCADE: an unexpected dependency
        -- makes the migration fail instead of silently dropping it too.
        DROP TABLE decisions;
        DROP TABLE observations;
        DROP TABLE cases;
        DROP TABLE runs;
        DROP TABLE responsibility_versions;
        DROP TABLE responsibilities;

        CREATE TABLE responsibilities (
          workspace_id uuid NOT NULL REFERENCES workspaces (id),
          id           uuid NOT NULL DEFAULT gen_random_uuid(),
          key          text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
          created_at   timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (workspace_id, id),
          UNIQUE (workspace_id, key)
        );
        -- definition: the core Definition of this version, with id = the responsibility's
        -- id and version = this version.
        CREATE TABLE responsibility_versions (
          workspace_id      uuid NOT NULL,
          id                uuid NOT NULL DEFAULT gen_random_uuid(),
          responsibility_id uuid NOT NULL,
          version           integer NOT NULL CHECK (version >= 1),
          title             text NOT NULL,
          definition        jsonb NOT NULL,
          content_hash      text NOT NULL,
          created_by        uuid NOT NULL,
          created_at        timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (workspace_id, id),
          UNIQUE (workspace_id, responsibility_id, version),
          FOREIGN KEY (workspace_id, responsibility_id) REFERENCES responsibilities (workspace_id, id),
          FOREIGN KEY (workspace_id, created_by) REFERENCES members (workspace_id, id)
        );
        -- view_now and view_basis: the snapshot of the last view_run, cleared by every
        -- recording that changes the run's observations.
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
          last_active_at    timestamptz,
          view_now          timestamptz,
          view_basis        text,
          completed_at      timestamptz,
          outcome           text CHECK (outcome IN ('completed', 'partial', 'failed', 'abandoned')),
          summary           text,
          report            text,
          completion        jsonb,
          CHECK ((completed_at IS NULL) = (outcome IS NULL)),
          CHECK ((completion IS NOT NULL) = (outcome IN ('completed', 'partial', 'failed'))),
          CHECK ((view_now IS NULL) = (view_basis IS NULL)),
          PRIMARY KEY (workspace_id, id),
          FOREIGN KEY (workspace_id, responsibility_id) REFERENCES responsibilities (workspace_id, id),
          FOREIGN KEY (workspace_id, version_id) REFERENCES responsibility_versions (workspace_id, id),
          FOREIGN KEY (workspace_id, member_id) REFERENCES members (workspace_id, id)
        );
        CREATE UNIQUE INDEX runs_one_open ON runs (workspace_id, responsibility_id)
          WHERE completed_at IS NULL;
        CREATE INDEX runs_recent ON runs (workspace_id, responsibility_id, started_at DESC);

        -- What a run recorded, per kind: rows as a set (keyed by their digest).
        CREATE TABLE run_observation_kinds (
          workspace_id uuid NOT NULL,
          run_id       uuid NOT NULL,
          kind         text NOT NULL,
          complete     boolean NOT NULL,
          recorded_at  timestamptz NOT NULL,
          PRIMARY KEY (workspace_id, run_id, kind),
          FOREIGN KEY (workspace_id, run_id) REFERENCES runs (workspace_id, id)
        );
        CREATE TABLE run_rows (
          workspace_id uuid NOT NULL,
          run_id       uuid NOT NULL,
          kind         text NOT NULL,
          row_digest   text NOT NULL,
          row          jsonb NOT NULL,
          PRIMARY KEY (workspace_id, run_id, kind, row_digest),
          FOREIGN KEY (workspace_id, run_id, kind) REFERENCES run_observation_kinds (workspace_id, run_id, kind)
        );
        -- The observations a step was given, frozen when its run completed; never changed.
        CREATE TABLE core_observations (
          workspace_id      uuid NOT NULL,
          responsibility_id uuid NOT NULL,
          id                text NOT NULL,
          kind              text NOT NULL,
          occurred_at       timestamptz NOT NULL,
          body              jsonb NOT NULL,
          digest            text NOT NULL,
          run_id            uuid NOT NULL,
          PRIMARY KEY (workspace_id, responsibility_id, id),
          FOREIGN KEY (workspace_id, responsibility_id) REFERENCES responsibilities (workspace_id, id),
          FOREIGN KEY (workspace_id, run_id) REFERENCES runs (workspace_id, id)
        );
        CREATE INDEX core_observations_kind
          ON core_observations (workspace_id, responsibility_id, kind, occurred_at DESC, id COLLATE "C" DESC);
        -- One core State per responsibility, written only by complete_run (compare and set).
        CREATE TABLE responsibility_states (
          workspace_id      uuid NOT NULL,
          responsibility_id uuid NOT NULL,
          state             jsonb NOT NULL,
          state_digest      text NOT NULL,
          updated_at        timestamptz NOT NULL,
          PRIMARY KEY (workspace_id, responsibility_id),
          FOREIGN KEY (workspace_id, responsibility_id) REFERENCES responsibilities (workspace_id, id)
        );
        -- Every step's inputs and result (without the state), for history and replay.
        CREATE TABLE core_steps (
          workspace_id        uuid NOT NULL,
          run_id              uuid NOT NULL,
          version_id          uuid NOT NULL,
          now                 timestamptz NOT NULL,
          basis               text NOT NULL,
          observation_ids     text[] NOT NULL,
          evaluation          jsonb NOT NULL,
          result              jsonb NOT NULL,
          state_digest_before text,
          state_digest_after  text NOT NULL,
          PRIMARY KEY (workspace_id, run_id),
          FOREIGN KEY (workspace_id, run_id) REFERENCES runs (workspace_id, id),
          FOREIGN KEY (workspace_id, version_id) REFERENCES responsibility_versions (workspace_id, id)
        );
        CREATE TABLE core_step_cases (
          workspace_id uuid NOT NULL,
          case_id      text NOT NULL,
          run_id       uuid NOT NULL,
          PRIMARY KEY (workspace_id, case_id, run_id),
          FOREIGN KEY (workspace_id, run_id) REFERENCES core_steps (workspace_id, run_id)
        );
      `,
    },
  ],
};
