import assert from "node:assert/strict";
import test from "node:test";

import { ConfigurationError } from "../oauth/config.ts";
import { migrate, prepareSchema, requireSchema } from "./migrate.ts";
import { embeddedDriver } from "./pglite.ts";
import { ALL_SCHEMAS } from "./schemas.ts";

test("a fresh database migrates every module; a second run is a no-op", async () => {
  const db = await embeddedDriver();
  try {
    const first = [];
    for (const schema of ALL_SCHEMAS) first.push(await migrate(db, schema));
    assert.deepEqual(first, [1, 1, 2]);
    assert.deepEqual(
      ALL_SCHEMAS.map((schema) => schema.module),
      ["oauth", "workspace", "responsibilities"],
    );

    const second = [];
    for (const schema of ALL_SCHEMAS) second.push(await migrate(db, schema));
    assert.deepEqual(second, [0, 0, 0]);

    const tables = await db.query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`,
    );
    for (const table of [
      "workspaces",
      "members",
      "responsibilities",
      "responsibility_versions",
      "runs",
      "cases",
      "observations",
      "decisions",
      "oauth_clients",
    ]) {
      assert.ok(tables.some((row) => row.name === table), table);
    }
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
