import assert from "node:assert/strict";
import test from "node:test";

import { ConfigurationError } from "../oauth/config.ts";
import { OAUTH_SCHEMA, sqlOAuthStore } from "../oauth/store/sql.ts";
import { AGENT_A, DEFINITION } from "../responsibilities/fixtures.ts";
import { RESPONSIBILITIES_SCHEMA } from "../responsibilities/schema.ts";
import { responsibilityStore } from "../responsibilities/store.ts";
import { seedMembers } from "../testing.ts";
import { mcpSession } from "../workspace/members.ts";
import { WORKSPACE_SCHEMA } from "../workspace/schema.ts";
import type { SqlDriver } from "./driver.ts";
import { migrate, prepareSchema, requireSchema } from "./migrate.ts";
import { embeddedDriver } from "./pglite.ts";
import { ALL_SCHEMAS } from "./schemas.ts";

const DOMAIN_TABLES = [
  "core_observations",
  "core_step_cases",
  "core_steps",
  "responsibilities",
  "responsibility_states",
  "responsibility_versions",
  "run_observation_kinds",
  "run_rows",
  "runs",
];
const KEPT_TABLES = [
  "members",
  "oauth_authorization_codes",
  "oauth_clients",
  "oauth_pending_logins",
  "oauth_rate_limits",
  "oauth_refresh_families",
  "oauth_refresh_tokens",
  "workspaces",
];

test("a fresh database migrates every module; a second run is a no-op", async () => {
  const db = await embeddedDriver();
  try {
    const first = [];
    for (const schema of ALL_SCHEMAS) first.push(await migrate(db, schema));
    assert.deepEqual(first, [1, 1, 3]);
    assert.deepEqual(
      ALL_SCHEMAS.map((schema) => schema.module),
      ["oauth", "workspace", "responsibilities"],
    );

    const second = [];
    for (const schema of ALL_SCHEMAS) second.push(await migrate(db, schema));
    assert.deepEqual(second, [0, 0, 0]);

    const tables = (
      await db.query<{ name: string }>(
        `SELECT table_name AS name FROM information_schema.tables
          WHERE table_schema = 'public' ORDER BY table_name`,
      )
    ).map((row) => row.name);
    assert.deepEqual(tables, [...DOMAIN_TABLES, ...KEPT_TABLES, "schema_migrations"].sort());
  } finally {
    await db.close();
  }
});

test("concurrent migrations apply each version once", async () => {
  const db = await embeddedDriver();
  try {
    for (const schema of ALL_SCHEMAS) {
      const applied = await Promise.all([migrate(db, schema), migrate(db, schema), migrate(db, schema)]);
      assert.equal(applied.reduce((a, b) => a + b, 0), schema.migrations.length, schema.module);
    }
  } finally {
    await db.close();
  }
});

test("production requireSchema refuses a missing version and never runs DDL", async () => {
  const db = await embeddedDriver();
  const previous = process.env.NODE_ENV;
  try {
    await assert.rejects(requireSchema(db, ALL_SCHEMAS[1]), ConfigurationError, "no tracking table at all");
    const [tracking] = await db.query<{ present: boolean }>(
      "SELECT to_regclass('schema_migrations') IS NOT NULL AS present",
    );
    assert.equal(tracking.present, false, "checking created nothing");

    await migrate(db, ALL_SCHEMAS[0]);
    await assert.rejects(requireSchema(db, ALL_SCHEMAS[1]), /workspace schema is not up to date/);

    (process.env as Record<string, string>).NODE_ENV = "production";
    await assert.rejects(prepareSchema(db, ALL_SCHEMAS[1]), ConfigurationError, "production only checks");
    const [workspaces] = await db.query<{ present: boolean }>(
      "SELECT to_regclass('workspaces') IS NOT NULL AS present",
    );
    assert.equal(workspaces.present, false, "and did not migrate");

    for (const schema of ALL_SCHEMAS) await migrate(db, schema);
    for (const schema of ALL_SCHEMAS) await prepareSchema(db, schema);
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV = previous;
    await db.close();
  }
});

// --- P2-T11 responsibilities v3: clean slate ----------------------------------------

/** Columns, constraints and indexes of every table, as the catalog describes them. */
async function schemaOf(db: SqlDriver): Promise<unknown> {
  return {
    columns: await db.query(
      `SELECT table_name, column_name, ordinal_position, data_type, is_nullable, column_default
         FROM information_schema.columns WHERE table_schema = current_schema()
        ORDER BY table_name, ordinal_position`,
    ),
    constraints: await db.query(
      `SELECT conrelid::regclass::text AS table_name, conname, contype, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint WHERE connamespace = current_schema()::regnamespace
        ORDER BY 1, 2`,
    ),
    indexes: await db.query(
      `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() ORDER BY 1, 2`,
    ),
  };
}

/** Every row of the tables v3 must not touch, and the migration history before v3. */
async function keptRows(db: SqlDriver): Promise<Record<string, unknown[]>> {
  const rows: Record<string, unknown[]> = {};
  for (const table of KEPT_TABLES) {
    rows[table] = await db.query(`SELECT to_jsonb(t)::text AS row FROM ${table} t ORDER BY 1`);
  }
  rows.schema_migrations = await db.query(
    `SELECT module, version, applied_at FROM schema_migrations WHERE NOT (module = 'responsibilities' AND version = 3)
      ORDER BY module, version`,
  );
  return rows;
}

/** A database at responsibilities v2 with rows in every table of every module. */
async function populatedAtV2() {
  const db = await embeddedDriver();
  await migrate(db, OAUTH_SCHEMA);
  await migrate(db, WORKSPACE_SCHEMA);
  await migrate(db, { ...RESPONSIBILITIES_SCHEMA, migrations: RESPONSIBILITIES_SCHEMA.migrations.slice(0, 2) });
  const { workspaceId, members } = await seedMembers(db, ["alice", "bob"], "acme");
  await db.query(`UPDATE members SET google_sub = 'sub-alice' WHERE id = $1`, [members.alice]);

  const oauth = sqlOAuthStore(db);
  const client = await oauth.registerClient({ redirectUris: ["https://client.example/cb"], clientName: "Claude Code" });
  const grant = { clientId: client.clientId, scope: "mcp", resource: "https://responsibilities.example/mcp", userId: members.alice };
  await oauth.parkLogin(
    {
      clientId: client.clientId,
      redirectUri: "https://client.example/cb",
      codeChallenge: "challenge",
      scope: "mcp",
      resource: grant.resource,
      clientState: "state",
      nonce: "nonce",
      providerCodeVerifier: "verifier",
    },
    "browser-binding",
  );
  await oauth.issueCode({ ...grant, redirectUri: "https://client.example/cb", codeChallenge: "challenge" });
  const refreshToken = await oauth.issueRefreshToken(grant);
  await oauth.consumeRateLimit("register:127.0.0.1", 10, 60_000);

  // The v1/v2 domain schema, a row in each of its six tables.
  const [{ id: responsibilityId }] = await db.query<{ id: string }>(
    `INSERT INTO responsibilities (workspace_id, key) VALUES ($1, 'bugcrowd-findings') RETURNING id`,
    [workspaceId],
  );
  const [{ id: versionId }] = await db.query<{ id: string }>(
    `INSERT INTO responsibility_versions
       (workspace_id, responsibility_id, version, title, subject_type, expectation, assessments, content_hash, created_by)
     VALUES ($1, $2, 1, 'Bugcrowd findings', 'bugcrowd_submission', 'All triaged.', '[{"label":"nothing_due","attention":false}]', 'h', $3)
     RETURNING id`,
    [workspaceId, responsibilityId, members.alice],
  );
  const [{ id: runId }] = await db.query<{ id: string }>(
    `INSERT INTO runs (workspace_id, responsibility_id, version_id, member_id, client_id, agent, sources,
                       completed_at, outcome, completion, last_active_at)
     VALUES ($1, $2, $3, $4, $5, '{"name":"claude-code"}', '[]', now(), 'completed', '{}', now())
     RETURNING id`,
    [workspaceId, responsibilityId, versionId, members.alice, client.clientId],
  );
  const [{ id: caseId }] = await db.query<{ id: string }>(
    `INSERT INTO cases (workspace_id, responsibility_id, subject) VALUES ($1, $2, 'S1') RETURNING id`,
    [workspaceId, responsibilityId],
  );
  await db.query(`INSERT INTO observations (workspace_id, run_id, case_id, facts) VALUES ($1, $2, $3, '{"a":1}')`, [
    workspaceId,
    runId,
    caseId,
  ]);
  await db.query(
    `INSERT INTO decisions (workspace_id, run_id, case_id, assessment, basis, status) VALUES ($1, $2, $3, 'nothing_due', 'b', 'open')`,
    [workspaceId, runId, caseId],
  );
  return { db, workspaceId, members, client, refreshToken };
}

test("P2-T11 v3 on a fresh database and on a populated v2 database: the same schema; only domain rows go", async () => {
  const fresh = await embeddedDriver();
  const { db, workspaceId, members, client, refreshToken } = await populatedAtV2();
  try {
    for (const schema of ALL_SCHEMAS) await migrate(fresh, schema);

    for (const table of ["responsibilities", "responsibility_versions", "runs", "cases", "observations", "decisions"]) {
      const [{ n }] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
      assert.equal(n, 1, `${table} holds a row before v3`);
    }
    for (const table of KEPT_TABLES) {
      const [{ n }] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
      assert.ok(n > 0, `${table} holds a row before v3`);
    }
    const before = await keptRows(db);

    const applied = [];
    for (const schema of ALL_SCHEMAS) applied.push(await migrate(db, schema));
    assert.deepEqual(applied, [0, 0, 1], "only responsibilities v3 runs");

    assert.deepEqual(await schemaOf(db), await schemaOf(fresh), "the same schema either way");
    for (const table of DOMAIN_TABLES) {
      const [{ n }] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
      assert.equal(n, 0, `${table} is empty`);
    }
    for (const table of ["cases", "observations", "decisions"]) {
      const [{ present }] = await db.query<{ present: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS present`, [table]);
      assert.equal(present, false, `${table} is gone`);
    }
    assert.deepEqual(await keptRows(db), before, "workspaces, members, OAuth and the migration history are unchanged");
    const versions = await db.query<{ version: number }>(
      `SELECT version FROM schema_migrations WHERE module = 'responsibilities' ORDER BY version`,
    );
    assert.deepEqual(versions.map((row) => row.version), [1, 2, 3], "v3 recorded exactly once");

    const again = [];
    for (const schema of ALL_SCHEMAS) again.push(await migrate(db, schema));
    assert.deepEqual(again, [0, 0, 0], "a second run is a no-op");
    assert.deepEqual(await keptRows(db), before);

    // The existing member is still signed in: session lookup and refresh rotation work.
    const session = await mcpSession(db, members.alice, client.clientId);
    assert.deepEqual(session?.member, { id: members.alice, email: "alice@example.com" });
    assert.deepEqual(session?.client, { id: client.clientId, name: "Claude Code" });
    const rotation = await sqlOAuthStore(db).rotateRefreshToken(refreshToken, () => undefined);
    assert.equal(rotation.outcome, "rotated");

    // And can define the responsibility anew, and run it.
    const store = responsibilityStore(db, {
      workspaceId,
      memberId: members.alice,
      clientId: client.clientId,
      clientName: "Claude Code",
    });
    assert.deepEqual(await store.putResponsibility(DEFINITION), {
      key: DEFINITION.key,
      version: 1,
      changed: true,
      previous_version: null,
    });
    const run = await store.startRun({ responsibility: DEFINITION.key, agent: AGENT_A, supersede: false });
    const { basis } = await store.viewRun({ run_id: run.run_id });
    assert.equal((await store.completeRun({ run_id: run.run_id, outcome: "completed", evaluation: { basis, proposals: [] } })).outcome, "completed");
  } finally {
    await fresh.close();
    await db.close();
  }
});

test("P2-T11 v3 refuses to drop a domain table something else depends on, and changes nothing", async () => {
  const { db } = await populatedAtV2();
  try {
    await db.exec(`CREATE VIEW unexpected AS SELECT id FROM cases`);
    await assert.rejects(migrate(db, RESPONSIBILITIES_SCHEMA), /depend/);
    const [{ n }] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM cases`);
    assert.equal(n, 1, "nothing dropped");
    const [{ v }] = await db.query<{ v: number }>(`SELECT max(version)::int AS v FROM schema_migrations WHERE module = 'responsibilities'`);
    assert.equal(v, 2, "v3 not recorded");
  } finally {
    await db.close();
  }
});
