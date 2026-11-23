import assert from "node:assert/strict";
import test from "node:test";

import { digest, step, type Definition, type Evaluation, type Observation, type State } from "../core.ts";
import { seedMembers } from "../testing.ts";
import {
  AGENT_A,
  AGENT_B,
  BUGCROWD,
  DEFINITION,
  EMPTY,
  judge,
  listed,
  refusal,
  refusalDetail,
  submission,
  world,
  type World,
} from "./fixtures.ts";
import { RUN_IDLE_MS, RUN_LIFETIME_MS, RUN_LIMIT } from "./model.ts";
import { responsibilityStore, type Agent, type ResponsibilityStore } from "./store.ts";

/** The store as the host of responsibilities-core (docs/core-integration-plan.md §3, §4, §8 P2). */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const start = (store: ResponsibilityStore, key = DEFINITION.key, agent: Agent = AGENT_A, supersede = false) =>
  store.startRun({ responsibility: key, agent, supersede });
const record = (store: ResponsibilityStore, run_id: string, observations = EMPTY) =>
  store.recordObservations({ run_id, observations });

async function count(w: World, sql: string, params: unknown[] = []): Promise<number> {
  const [{ n }] = await w.db.query<{ n: number }>(`SELECT (${sql})::int AS n`, params);
  return n;
}

async function runRow(w: World, runId: string) {
  const [row] = await w.db.query<{ view_now: Date | null; view_basis: string | null; outcome: string | null; summary: string | null }>(
    `SELECT view_now, view_basis, outcome, summary FROM runs WHERE id = $1`,
    [runId],
  );
  return row;
}

// --- P2-T1 put_responsibility ----------------------------------------------------

test("P2-T1 versioning: same content is a no-op, a title or definition change adds a version, identity is fixed", async () => {
  const w = await world();
  try {
    const store = w.storeFor("alice");
    assert.deepEqual(await store.putResponsibility(DEFINITION), {
      key: DEFINITION.key,
      version: 1,
      changed: true,
      previous_version: null,
    });
    assert.deepEqual(await store.putResponsibility(structuredClone(DEFINITION)), {
      key: DEFINITION.key,
      version: 1,
      changed: false,
      previous_version: 1,
    });
    assert.equal(await count(w, `SELECT count(*) FROM responsibility_versions`), 1, "nothing written for the same content");

    assert.deepEqual(await store.putResponsibility({ ...DEFINITION, title: "Bugcrowd submissions" }), {
      key: DEFINITION.key,
      version: 2,
      changed: true,
      previous_version: 1,
    });
    const bob = w.storeFor("bob");
    assert.deepEqual(
      await bob.putResponsibility({ ...DEFINITION, definition: { ...BUGCROWD, expectations: "Changed." } }),
      { key: DEFINITION.key, version: 3, changed: true, previous_version: 2 },
    );
    const ctx = await store.getResponsibility(DEFINITION.key);
    const [{ id }] = await w.db.query<{ id: string }>(`SELECT id FROM responsibilities WHERE key = $1`, [DEFINITION.key]);
    assert.equal(ctx.responsibility.version, 3);
    assert.deepEqual(ctx.responsibility.definition, { ...BUGCROWD, expectations: "Changed.", id, version: 3 });

    const identity = (change: Partial<Definition["identity"]>) => ({
      ...DEFINITION,
      definition: { ...BUGCROWD, identity: { ...BUGCROWD.identity, ...change } },
    });
    assert.equal(await refusal(store.putResponsibility(identity({ subject_type: "other" }))), "identity_change");
    assert.equal(await refusal(store.putResponsibility(identity({ subject_keys: ["submission", "program"] }))), "identity_change");

    const badMatch = { ...BUGCROWD, closing: [{ description: "x", rules: [{ kind: "review", match: { s: "nope" } }] }] };
    assert.equal(await refusal(store.putResponsibility({ ...DEFINITION, definition: badMatch })), "invalid_definition");
    const routed = { ...BUGCROWD, attention_types: [{ key: "x", description: "x", delivery: { route: "#sec" } }] };
    assert.equal(await refusal(store.putResponsibility({ ...DEFINITION, definition: routed })), "delivery_unsupported");
    assert.equal(await refusal(store.putResponsibility({ ...DEFINITION, title: "a\u0000b" })), "invalid_text");
    assert.equal(await refusal(store.putResponsibility({ ...DEFINITION, key: "fresh", definition: badMatch })), "invalid_definition");
    assert.equal(await count(w, `SELECT count(*) FROM responsibilities WHERE key = 'fresh'`), 0, "a refusal writes nothing");
    assert.equal(await refusal(store.getResponsibility("no-such-key")), "unknown_responsibility");
  } finally {
    await w.close();
  }
});

// --- P2-T2 run lifecycle (unchanged) -----------------------------------------------

test("P2-T2 one open run per responsibility: run_in_progress, expiry abandons, supersede abandons", async () => {
  const w = await world();
  try {
    const alice = w.storeFor("alice");
    const bob = w.storeFor("bob", "client-b");
    await alice.putResponsibility(DEFINITION);

    const first = await start(alice);
    assert.equal(first.run_limit, RUN_LIMIT);
    assert.equal(first.expires_at, new Date(w.now().getTime() + RUN_LIFETIME_MS).toISOString());
    assert.deepEqual(first.include, BUGCROWD.include);
    assert.deepEqual(first.attention_types.map((t) => [t.key, t.checked]), [
      ["needs_work", false],
      ["review", true],
      ["verify", false],
      ["ready_to_close", false],
    ]);
    assert.deepEqual(first.cases, []);
    assert.equal((await alice.getResponsibility(DEFINITION.key)).in_progress?.run_id, first.run_id);

    assert.equal(await refusal(start(bob, DEFINITION.key, AGENT_B)), "run_in_progress");

    // Superseded while still held: the old run is abandoned and cannot be written to.
    w.advance(5 * MINUTE);
    const second = await start(bob, DEFINITION.key, AGENT_B, true);
    assert.deepEqual(await runRow(w, first.run_id), {
      view_now: null,
      view_basis: null,
      outcome: "abandoned",
      summary: `superseded by run ${second.run_id}`,
    });
    assert.equal(await refusal(record(alice, first.run_id)), "run_abandoned");
    assert.equal(await refusal(alice.viewRun({ run_id: first.run_id })), "run_abandoned");

    // Past its lifetime, the open run is refused for writes and abandoned by the next start.
    w.advance(RUN_LIFETIME_MS);
    assert.equal(await refusal(record(bob, second.run_id)), "run_expired");
    assert.equal(await refusal(bob.viewRun({ run_id: second.run_id })), "run_expired");
    assert.equal((await alice.getResponsibility(DEFINITION.key)).in_progress, null, "an expired run is not in progress");
    await start(alice);
    assert.equal((await runRow(w, second.run_id)).outcome, "abandoned");
    assert.equal(await refusal(start(alice, "unknown-key")), "unknown_responsibility");
  } finally {
    await w.close();
  }
});

test("P2-T2 an open run is held while active — record_observations and view_run renew it — and taken over once idle", async () => {
  const w = await world();
  try {
    const alice = w.storeFor("alice", "client-a");
    // Another session of the same member on the same OAuth client.
    const aliceElsewhere = w.storeFor("alice", "client-a");
    const bob = w.storeFor("bob", "client-b");
    await alice.putResponsibility(DEFINITION);

    const done = await start(alice);
    await record(alice, done.run_id, [listed("bugcrowd", [{ submission: "S1" }])]);
    await judge(alice, done.run_id, [{ subject: submission("S1"), status: "open", cites: [`${done.run_id}:bugcrowd`] }]);
    w.advance(HOUR);

    // Held for RUN_IDLE_MS from start_run, for the same member and client as for anyone else.
    const run = await start(alice, DEFINITION.key, AGENT_B);
    assert.deepEqual(run.cases.map((c) => c.subject.keys.submission), ["S1"]);
    const startedAt = w.now().getTime();
    w.advance(RUN_IDLE_MS - 1);
    for (const other of [aliceElsewhere, bob]) {
      const refused = await refusalDetail(start(other));
      assert.equal(refused.error, "run_in_progress");
      assert.equal(refused.reclaimable_at, new Date(startedAt + RUN_IDLE_MS).toISOString());
      assert.equal(refused.expires_at, run.expires_at);
    }

    // Every accepted record_observations renews the hold, an unchanged retry too.
    await record(alice, run.run_id, [listed("bugcrowd", [{ submission: "S2" }])]);
    const renewedAt = w.now().getTime();
    w.advance(RUN_IDLE_MS - 1);
    assert.equal((await refusalDetail(start(bob))).reclaimable_at, new Date(renewedAt + RUN_IDLE_MS).toISOString());
    await record(alice, run.run_id, [listed("bugcrowd", [{ submission: "S2" }])]);
    w.advance(RUN_IDLE_MS - 1);
    assert.equal(await refusal(start(bob)), "run_in_progress");

    // view_run renews it as well.
    await alice.viewRun({ run_id: run.run_id });
    const viewedAt = w.now().getTime();
    w.advance(RUN_IDLE_MS - 1);
    assert.equal((await refusalDetail(start(bob))).reclaimable_at, new Date(viewedAt + RUN_IDLE_MS).toISOString());

    // Idle, but nobody started: it is still open, and its owner goes on writing.
    w.advance(2 * RUN_IDLE_MS);
    assert.equal((await alice.getResponsibility(DEFINITION.key)).in_progress?.run_id, run.run_id);
    await record(alice, run.run_id, [listed("bugcrowd", [{ submission: "S3" }])]);
    assert.equal(await refusal(start(bob)), "run_in_progress", "and that write holds it again");

    // A refused write is no activity: it writes nothing.
    w.advance(RUN_IDLE_MS - 1);
    assert.equal(await refusal(record(alice, run.run_id, [listed("bugcrowd", [{ "Bad Key": 1 }])])), "invalid_row");
    w.advance(1);

    // Idle for RUN_IDLE_MS: the next start_run takes it over without supersede.
    const next = await start(bob);
    const old = await runRow(w, run.run_id);
    assert.equal(old.outcome, "abandoned");
    assert.equal(old.summary, `idle: no activity for 10 min; taken over by run ${next.run_id}`);
    assert.deepEqual(next.cases.map((c) => c.subject.keys.submission), ["S1"], "nothing of the taken-over run");

    // Its owner learns why on the next write; what it recorded is kept.
    const abandoned = await refusalDetail(record(alice, run.run_id));
    assert.equal(abandoned.error, "run_abandoned");
    assert.equal(abandoned.summary, old.summary);
    assert.equal(await refusal(alice.completeRun({ run_id: run.run_id, outcome: "failed", summary: "x" })), "run_abandoned");
    assert.equal(await count(w, `SELECT count(*) FROM run_rows WHERE run_id = $1`, [run.run_id]), 2, "S2 (twice) and S3");
  } finally {
    await w.close();
  }
});

test("P2-T2 an idle run nobody took over still completes", async () => {
  const w = await world();
  try {
    const alice = w.storeFor("alice");
    await alice.putResponsibility(DEFINITION);
    const run = await start(alice);
    await record(alice, run.run_id);
    w.advance(3 * RUN_IDLE_MS);
    assert.equal((await judge(alice, run.run_id)).outcome, "completed");
    assert.equal((await alice.getResponsibility(DEFINITION.key)).last_run?.run_id, run.run_id);
  } finally {
    await w.close();
  }
});

test("P2-T2 activity never extends the 2 h lifetime", async () => {
  const w = await world();
  try {
    const alice = w.storeFor("alice");
    const bob = w.storeFor("bob", "client-b");
    await alice.putResponsibility(DEFINITION);
    const run = await start(alice);
    await record(alice, run.run_id);
    for (let elapsed = 5 * MINUTE; elapsed < RUN_LIFETIME_MS; elapsed += 5 * MINUTE) {
      w.advance(5 * MINUTE);
      await alice.viewRun({ run_id: run.run_id });
    }

    const refused = await refusalDetail(start(bob, DEFINITION.key, AGENT_B));
    assert.equal(refused.error, "run_in_progress");
    assert.equal(refused.reclaimable_at, run.expires_at, "held at most until its lifetime ends");

    w.advance(5 * MINUTE);
    assert.equal(await refusal(record(alice, run.run_id)), "run_expired");
    assert.equal(await refusal(judge(alice, run.run_id)), "run_expired");
    await start(bob, DEFINITION.key, AGENT_B);
    assert.equal((await runRow(w, run.run_id)).summary, "expired: not completed within its 2 h lifetime");
  } finally {
    await w.close();
  }
});

test("P2-T2 a run without last_active_at is held for its lifetime, until a write gives it activity", async () => {
  const w = await world();
  try {
    const alice = w.storeFor("alice");
    const bob = w.storeFor("bob", "client-b");
    const takeOver = (key: string) => start(bob, key, AGENT_B);
    const runs = [];
    for (const key of ["quiet", "renewed"]) {
      await alice.putResponsibility({ ...DEFINITION, key });
      runs.push(await start(alice, key));
    }
    const [quiet, renewed] = runs;
    w.advance(25 * MINUTE);
    for (const run of runs) {
      await record(alice, run.run_id);
      await w.db.query(`UPDATE runs SET last_active_at = NULL WHERE id = $1`, [run.run_id]);
    }

    w.advance(5 * MINUTE);
    for (const [key, run] of [["quiet", quiet], ["renewed", renewed]] as const) {
      const refused = await refusalDetail(takeOver(key));
      assert.equal(refused.error, "run_in_progress");
      assert.equal(refused.reclaimable_at, run.expires_at);
    }

    await record(alice, renewed.run_id);
    w.advance(RUN_IDLE_MS - 1);
    assert.equal(await refusal(takeOver("renewed")), "run_in_progress");
    w.advance(1);
    const next = await takeOver("renewed");
    assert.equal((await runRow(w, renewed.run_id)).summary, `idle: no activity for 10 min; taken over by run ${next.run_id}`);

    w.advance(new Date(quiet.expires_at).getTime() - w.now().getTime() - 1);
    assert.equal(await refusal(takeOver("quiet")), "run_in_progress");
    w.advance(1);
    await takeOver("quiet");
    assert.equal((await runRow(w, quiet.run_id)).summary, "expired: not completed within its 2 h lifetime");
  } finally {
    await w.close();
  }
});

test("P2-T2 a write or a start that waited for its transaction holds the run from when it lands", async () => {
  const w = await world();
  try {
    const alice = w.storeFor("alice");
    const aliceElsewhere = w.storeFor("alice");
    const bob = w.storeFor("bob", "client-b");
    await alice.putResponsibility(DEFINITION);
    const run = await start(alice);
    await record(alice, run.run_id);

    // The embedded database runs one transaction at a time: a call made while one
    // is open waits for it, here for as long as the run may stay idle.
    let recording: Promise<unknown> | undefined;
    await w.db.transaction(async () => {
      recording = record(alice, run.run_id, [listed("bugcrowd", [{ submission: "S1" }])]);
      w.advance(RUN_IDLE_MS);
    });
    await recording;
    assert.equal(await refusal(start(bob, DEFINITION.key, AGENT_B)), "run_in_progress", "the write that landed holds the run");

    w.advance(RUN_IDLE_MS);
    let starting: Promise<Awaited<ReturnType<typeof bob.startRun>>> | undefined;
    await w.db.transaction(async () => {
      starting = start(bob, DEFINITION.key, AGENT_B);
      w.advance(RUN_IDLE_MS);
    });
    const started = await starting!;
    assert.equal(started.started_at, w.now().toISOString());
    assert.equal(await refusal(start(aliceElsewhere)), "run_in_progress");
  } finally {
    await w.close();
  }
});

test("P2-T2 a run belongs to the member and the client that started it", async () => {
  const w = await world();
  try {
    const alice = w.storeFor("alice", "client-a");
    await alice.putResponsibility(DEFINITION);
    const run = await start(alice);

    for (const other of [w.storeFor("bob", "client-a"), w.storeFor("alice", "client-other")]) {
      assert.equal(await refusal(record(other, run.run_id)), "run_not_yours");
      assert.equal(await refusal(other.viewRun({ run_id: run.run_id })), "run_not_yours");
      assert.equal(await refusal(other.completeRun({ run_id: run.run_id, outcome: "failed", summary: "x" })), "run_not_yours");
    }
    for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      assert.equal(await refusal(record(alice, id)), "unknown_run");
      assert.equal(await refusal(alice.viewRun({ run_id: id })), "unknown_run");
    }
  } finally {
    await w.close();
  }
});

// --- P2-T3 record_observations ------------------------------------------------------

test("P2-T3 record_observations: kinds, completeness, rows as a set, replace, limits, NFC", async () => {
  const w = await world();
  try {
    const store = w.storeFor("alice");
    await store.putResponsibility(DEFINITION);
    const { run_id } = await start(store);
    const rows = async (kind: string) =>
      (await w.db.query<{ row: unknown }>(`SELECT row FROM run_rows WHERE run_id = $1 AND kind = $2 ORDER BY row_digest`, [
        run_id,
        kind,
      ])).map((r) => r.row);
    const recordedAt = async (kind: string) =>
      (await w.db.query<{ at: Date }>(`SELECT recorded_at AS at FROM run_observation_kinds WHERE run_id = $1 AND kind = $2`, [
        run_id,
        kind,
      ]))[0].at.toISOString();

    const first = await record(store, run_id, [
      listed("bugcrowd", [{ submission: "7f3c", state: "TRIAGED" }, { submission: "7f3c", state: "TRIAGED" }]),
      listed("implement", [], false),
    ]);
    assert.deepEqual(first, {
      run_id,
      observations: [
        { kind: "bugcrowd", id: `${run_id}:bugcrowd`, rows: 1, complete: true },
        { kind: "implement", id: `${run_id}:implement`, rows: 0, complete: false },
      ],
    });
    const firstAt = await recordedAt("bugcrowd");

    // A retry changes nothing, not even recorded_at.
    w.advance(MINUTE);
    await record(store, run_id, [listed("bugcrowd", [{ state: "TRIAGED", submission: "7f3c" }])]);
    assert.equal(await recordedAt("bugcrowd"), firstAt);
    assert.equal((await rows("bugcrowd")).length, 1);

    // A new row adds to the set and moves recorded_at.
    const added = await record(store, run_id, [listed("bugcrowd", [{ submission: "91aa", state: "NEW" }])]);
    assert.equal(added.observations[0].rows, 2);
    assert.equal(await recordedAt("bugcrowd"), w.now().toISOString());

    // replace empties the kind first; replacing with the same rows changes nothing.
    w.advance(MINUTE);
    await store.recordObservations({
      run_id,
      observations: [{ kind: "bugcrowd", complete: true, replace: true, rows: [{ submission: "91aa", state: "NEW" }] }],
    });
    assert.deepEqual(await rows("bugcrowd"), [{ submission: "91aa", state: "NEW" }]);
    const replacedAt = await recordedAt("bugcrowd");
    assert.equal(replacedAt, w.now().toISOString());
    w.advance(MINUTE);
    await store.recordObservations({
      run_id,
      observations: [{ kind: "bugcrowd", complete: true, replace: true, rows: [{ submission: "91aa", state: "NEW" }] }],
    });
    assert.equal(await recordedAt("bugcrowd"), replacedAt);

    const conflict = await refusalDetail(record(store, run_id, [listed("implement", [], true)]));
    assert.deepEqual([conflict.error, conflict.kind, conflict.complete], ["observation_conflict", "implement", false]);
    const unknown = await refusalDetail(record(store, run_id, [listed("weather")]));
    assert.equal(unknown.error, "unknown_kind");
    assert.deepEqual(unknown.kinds, ["bugcrowd", "implement", "recently_closed", "review"]);
    assert.equal(await refusal(record(store, run_id, [listed("review", [{ title: "é" }])])), "not_nfc");
    assert.equal(await refusal(record(store, run_id, [listed("review", [{ "Bad Key": 1 }])])), "invalid_row");
    const many = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ submission: `${prefix}${i}` }));
    assert.equal(
      await refusal(record(store, run_id, [listed("review", many(150, "a")), listed("recently_closed", many(51, "b"))])),
      "call_too_large",
    );
    // A refused call writes nothing, even in a kind it listed before the refused one.
    assert.equal(
      await refusal(record(store, run_id, [listed("review", [{ submission: "x" }]), listed("weather")])),
      "unknown_kind",
    );
    assert.equal(await count(w, `SELECT count(*) FROM run_observation_kinds WHERE run_id = $1 AND kind = 'review'`, [run_id]), 0);

    // 1000 rows per kind and run.
    for (let batch = 0; batch < RUN_LIMIT / 200; batch++) {
      await record(store, run_id, [listed("review", many(200, `r${batch}-`))]);
    }
    await record(store, run_id, [listed("review", [{ submission: "r0-0" }])]);
    assert.equal(await refusal(record(store, run_id, [listed("review", [{ submission: "extra" }])])), "run_too_large");

    // Completed runs are immutable.
    await judge(store, run_id);
    assert.equal(await refusal(record(store, run_id)), "run_completed");
    assert.equal(await refusal(store.viewRun({ run_id })), "run_completed");
  } finally {
    await w.close();
  }
});

test("P2-T3 a run records at most 10 kinds, rule kinds outside include among them", async () => {
  const w = await world();
  try {
    const store = w.storeFor("alice");
    const kinds = Array.from({ length: 11 }, (_, i) => `k${i}`);
    await store.putResponsibility({
      key: "many-kinds",
      title: "Many kinds",
      definition: {
        ...BUGCROWD,
        include: kinds.slice(0, 10),
        closing: [{ description: "k10 says done", rules: [{ kind: "k10", match: { submission: "submission" }, where: { done: true } }] }],
        attention_types: [],
      },
    });
    const { run_id } = await start(store, "many-kinds");
    await record(store, run_id, [listed("k10")]);
    await record(store, run_id, kinds.slice(0, 9).map((kind) => listed(kind)));
    assert.equal(await refusal(record(store, run_id, [listed("k9")])), "run_too_large");
  } finally {
    await w.close();
  }
});

// --- P2-T4 the view snapshot --------------------------------------------------------

test("P2-T4 snapshot: a stable view, invalidated by a changing recording; basis_mismatch and view_stale before step", async () => {
  const w = await world();
  try {
    const store = w.storeFor("alice");
    await store.putResponsibility(DEFINITION);
    const { run_id } = await start(store);
    await record(store, run_id, [...EMPTY.slice(1), listed("bugcrowd", [{ submission: "7f3c" }])]);

    const v1 = await store.viewRun({ run_id });
    const snapshot = await runRow(w, run_id);
    assert.equal(snapshot.view_basis, v1.basis);
    w.advance(MINUTE);
    assert.deepEqual(await store.viewRun({ run_id }), v1, "the same view again");
    assert.deepEqual(await runRow(w, run_id), snapshot, "without a new view_now");

    await record(store, run_id, [listed("bugcrowd", [{ submission: "7f3c" }])]);
    assert.equal((await runRow(w, run_id)).view_basis, v1.basis, "an unchanged retry keeps the snapshot");

    await record(store, run_id, [listed("bugcrowd", [{ submission: "91aa" }])]);
    assert.deepEqual(await runRow(w, run_id), { view_now: null, view_basis: null, outcome: null, summary: null });
    const evaluation = (basis: string) => ({ basis, proposals: [{ subject: submission("7f3c"), status: "open" as const, cites: [`${run_id}:bugcrowd`] }] });
    assert.equal(await refusal(store.completeRun({ run_id, outcome: "completed", evaluation: evaluation(v1.basis) })), "view_required");

    w.advance(MINUTE);
    const v2 = await store.viewRun({ run_id });
    assert.notEqual(v2.basis, v1.basis);
    assert.ok((await runRow(w, run_id)).view_now! > snapshot.view_now!, "a new view_now");
    assert.deepEqual(await refusalDetail(store.completeRun({ run_id, outcome: "completed", evaluation: evaluation(v1.basis) })), {
      error: "basis_mismatch",
      reason: "evaluation.basis is not the basis of the last view_run of this run; copy it from that view.",
      expected: v2.basis,
      received: v1.basis,
    });
    assert.equal((await runRow(w, run_id)).outcome, null, "the run stays open");

    // A stored input changed behind the snapshot's back (here: directly in the table).
    await w.db.query(`UPDATE run_rows SET row = '{"submission": "zzzz"}'::jsonb WHERE run_id = $1 AND row->>'submission' = '91aa'`, [run_id]);
    assert.equal(await refusal(store.completeRun({ run_id, outcome: "completed", evaluation: evaluation(v2.basis) })), "view_stale");
    assert.equal((await runRow(w, run_id)).outcome, null, "the run stays open");
    await w.db.query(`UPDATE run_rows SET row = '{"submission": "91aa"}'::jsonb WHERE run_id = $1 AND row->>'submission' = 'zzzz'`, [run_id]);

    const done = await store.completeRun({ run_id, outcome: "completed", evaluation: evaluation(v2.basis) });
    assert.equal(done.basis, v2.basis);
    assert.deepEqual(done.transitions.map((t) => [t.kind, t.to]), [["opened", "open"]]);
  } finally {
    await w.close();
  }
});

// --- P2-T5 an empty evaluation --------------------------------------------------------

test("P2-T5 an empty proposal list: a wrong basis is refused; the right one stores exactly the state step returns", async () => {
  const w = await world();
  try {
    const store = w.storeFor("alice");
    await store.putResponsibility(DEFINITION);
    const [{ id: responsibilityId }] = await w.db.query<{ id: string }>(`SELECT id FROM responsibilities`);
    const stored = async () =>
      (await w.db.query<{ state: State; state_digest: string }>(`SELECT state, state_digest FROM responsibility_states`))[0];
    const steps = async (runId: string) =>
      (await w.db.query<{ before: string | null; after: string }>(
        `SELECT state_digest_before AS before, state_digest_after AS after FROM core_steps WHERE run_id = $1`,
        [runId],
      ))[0];

    // First step: no state yet.
    const one = await start(store);
    await record(store, one.run_id);
    const v1 = await store.viewRun({ run_id: one.run_id });
    const wrong = "0".repeat(64);
    assert.equal(await refusal(store.completeRun({ run_id: one.run_id, outcome: "completed", evaluation: { basis: wrong, proposals: [] } })), "basis_mismatch");
    assert.equal(await stored(), undefined, "nothing stored");
    const first = await store.completeRun({ run_id: one.run_id, outcome: "completed", evaluation: { basis: v1.basis, proposals: [] } });
    assert.deepEqual([first.transitions, first.attention_events, first.rejections], [[], [], []]);
    const [{ view_now: now1 }] = await w.db.query<{ view_now: Date }>(`SELECT view_now FROM runs WHERE id = $1`, [one.run_id]);
    const after1 = await stored();
    assert.deepEqual(after1.state.cases, {});
    assert.equal(after1.state.now, now1.toISOString(), "state.now is the step's now");
    assert.equal(after1.state.definition_id, responsibilityId);
    assert.equal(after1.state_digest, first.state_digest);
    assert.equal(digest(after1.state), first.state_digest);
    assert.deepEqual(await steps(one.run_id), { before: null, after: first.state_digest });

    // A later step with an empty list moves state.now on and leaves the cases as they are.
    w.advance(HOUR);
    const two = await start(store);
    await record(store, two.run_id, [listed("bugcrowd", [{ submission: "7f3c" }])]);
    await judge(store, two.run_id, [{ subject: submission("7f3c"), status: "open", cites: [`${two.run_id}:bugcrowd`] }]);
    const casesBefore = (await stored()).state.cases;
    w.advance(HOUR);
    const three = await start(store);
    await record(store, three.run_id);
    const v3 = await store.viewRun({ run_id: three.run_id });
    assert.equal(await refusal(store.completeRun({ run_id: three.run_id, outcome: "partial", evaluation: { basis: v1.basis, proposals: [] } })), "basis_mismatch");
    const before3 = (await stored()).state_digest;
    const third = await store.completeRun({ run_id: three.run_id, outcome: "partial", evaluation: { basis: v3.basis, proposals: [] } });
    assert.deepEqual([third.transitions, third.attention_events, third.rejections], [[], [], []]);
    const after3 = await stored();
    assert.deepEqual(after3.state.cases, casesBefore);
    assert.equal(after3.state.now, (await runRow(w, three.run_id)).view_now!.toISOString());
    assert.notEqual(third.state_digest, before3);
    assert.deepEqual(await steps(three.run_id), { before: before3, after: third.state_digest });
    assert.equal(after3.state_digest, digest(after3.state));
  } finally {
    await w.close();
  }
});

// --- P2-T13 the clock -----------------------------------------------------------------

test("P2-T13 a host clock that goes back behind state.now breaks nothing: view_now ≥ state.now and every occurred_at", async () => {
  const w = await world();
  try {
    const store = w.storeFor("alice");
    await store.putResponsibility(DEFINITION);
    const one = await start(store);
    await record(store, one.run_id, [listed("bugcrowd", [{ submission: "7f3c" }])]);
    await judge(store, one.run_id, [{ subject: submission("7f3c"), status: "open", cites: [`${one.run_id}:bugcrowd`] }]);
    const [{ state }] = await w.db.query<{ state: State }>(`SELECT state FROM responsibility_states`);

    w.advance(HOUR);
    const two = await start(store);
    w.set("2026-11-19T08:00:00.000Z"); // before run one and before state.now
    await record(store, two.run_id, [listed("bugcrowd", [{ submission: "7f3c" }, { submission: "91aa" }])]);
    const v = await store.viewRun({ run_id: two.run_id });
    const viewNow = (await runRow(w, two.run_id)).view_now!.toISOString();
    assert.ok(viewNow >= state.now, `${viewNow} ≥ state.now ${state.now}`);
    for (const o of v.observations) assert.ok(viewNow >= o.occurred_at, o.id);
    const own = v.observations.find((o) => o.id === `${two.run_id}:bugcrowd`)!;
    const earlier = v.observations.find((o) => o.id === `${one.run_id}:bugcrowd`)!;
    assert.ok(own.occurred_at > earlier.occurred_at, "the run's own observation is still the newest of its kind");

    const done = await judge(store, two.run_id, [{ subject: submission("91aa"), status: "open", cites: [own.id] }]);
    assert.deepEqual(done.transitions.map((t) => t.kind), ["opened"]);
  } finally {
    await w.close();
  }
});

// --- P2-T6 rejections are data --------------------------------------------------------

test("P2-T6 the core's rejections come back as data; the run completes", async () => {
  const w = await world();
  try {
    const store = w.storeFor("alice");
    await store.putResponsibility(DEFINITION);
    const one = await start(store);
    await record(store, one.run_id, [...EMPTY.slice(1), listed("bugcrowd", [{ submission: "a1" }])]);
    const first = await judge(store, one.run_id, [
      {
        subject: submission("a1"),
        status: "open",
        cites: [`${one.run_id}:bugcrowd`],
        attentions: [{ type: "review", intent: "open", reason: "in Review?" }],
      },
      { subject: submission("b2"), status: "open", cites: [] },
      { subject: submission("c3"), status: "open", cites: ["elsewhere:bugcrowd"] },
    ]);
    assert.equal(first.outcome, "completed");
    assert.deepEqual(first.rejections.map((r) => r.code).sort(), ["ATTENTION_GATE_NOT_MET", "NO_EVIDENCE", "UNKNOWN_EVIDENCE"]);
    assert.deepEqual(first.transitions.map((t) => t.kind), ["opened"], "a1 opened without its Attention");
    assert.deepEqual(first.attention_events, []);

    w.advance(HOUR);
    const two = await start(store);
    await record(store, two.run_id, [...EMPTY.slice(1), listed("bugcrowd", [{ submission: "a1" }])]);
    const second = await judge(store, two.run_id, [{ subject: submission("a1"), status: "resolved", cites: [`${two.run_id}:bugcrowd`] }], "partial");
    assert.equal(second.outcome, "partial");
    assert.deepEqual(second.rejections.map((r) => [r.code, r.ref.part]), [["CLOSING_NOT_MET", "status"]]);
    assert.equal(second.rejections[0].detail.closing_check?.result, "not_met");
    assert.equal((await store.getResponsibility(DEFINITION.key)).last_run?.outcome, "partial");
  } finally {
    await w.close();
  }
});

// --- outcomes, read models -------------------------------------------------------------

test("complete_run outcomes: failed takes a summary and no evaluation; completed needs one; replay returns the stored result", async () => {
  const w = await world();
  try {
    const store = w.storeFor("alice");
    await store.putResponsibility(DEFINITION);
    const run = await start(store);
    await record(store, run.run_id);
    assert.equal(await refusal(store.completeRun({ run_id: run.run_id, outcome: "completed" })), "evaluation_required");
    const { basis } = await store.viewRun({ run_id: run.run_id });
    assert.equal(await refusal(store.completeRun({ run_id: run.run_id, outcome: "failed" })), "summary_required");
    assert.equal(
      await refusal(store.completeRun({ run_id: run.run_id, outcome: "failed", summary: "x", evaluation: { basis, proposals: [] } })),
      "evaluation_forbidden",
    );
    assert.equal(
      await refusal(store.completeRun({ run_id: run.run_id, outcome: "failed", summary: "a\u0000" })),
      "invalid_text",
    );
    const failed = await store.completeRun({ run_id: run.run_id, outcome: "failed", summary: "Bugcrowd was down" });
    assert.deepEqual(failed, {
      run_id: run.run_id,
      outcome: "failed",
      completed_at: w.now().toISOString(),
      basis: null,
      transitions: [],
      attention_events: [],
      rejections: [],
      state_digest: null,
    });
    assert.equal(await count(w, `SELECT count(*) FROM core_steps`), 0, "nothing stepped");
    assert.equal(await count(w, `SELECT count(*) FROM core_observations`), 0, "nothing frozen");
    w.advance(3 * HOUR);
    assert.deepEqual(await store.completeRun({ run_id: run.run_id, outcome: "completed" }), { ...failed, already_completed: true });
    assert.equal(
      await refusal(w.storeFor("bob").completeRun({ run_id: run.run_id, outcome: "completed" })),
      "run_not_yours",
      "replay is only for the member and client that completed it",
    );
    const last = (await store.getResponsibility(DEFINITION.key)).last_run;
    assert.deepEqual([last?.outcome, last?.summary, last?.by], ["failed", "Bugcrowd was down", "alice@example.com"]);
  } finally {
    await w.close();
  }
});

test("get_responsibility and get_case read the core's state; a proposal the core does not know as a case is refused", async () => {
  const w = await world();
  try {
    const store = w.storeFor("alice");
    await store.putResponsibility(DEFINITION);
    const one = await start(store);
    await record(store, one.run_id, [
      ...EMPTY.slice(0, 1),
      listed("review", [{ submission: "7f3c" }]),
      ...EMPTY.slice(2),
      listed("bugcrowd", [{ submission: "7f3c" }, { submission: "91aa" }, { submission: "0b0b" }]),
    ]);
    const cite = [`${one.run_id}:bugcrowd`];
    await judge(store, one.run_id, [
      { subject: submission("0b0b"), status: "open", cites: cite, title: "Quiet" },
      { subject: submission("91aa"), status: "open", cites: cite, attentions: [{ type: "needs_work", intent: "open", reason: "Triage 91aa" }] },
      {
        subject: submission("7f3c"),
        status: "open",
        cites: [...cite, `${one.run_id}:review`],
        summary: "In Review",
        attentions: [{ type: "review", intent: "open", reason: "FIND-12 waits" }],
      },
    ]);

    const ctx = await store.getResponsibility(DEFINITION.key);
    assert.deepEqual(ctx.cases.map((c) => c.subject.keys.submission), ["7f3c", "91aa", "0b0b"], "Attention first, then by keys");
    assert.equal(ctx.open_case_count, 3);
    assert.equal(ctx.truncated, false);
    const [seven] = ctx.cases;
    assert.deepEqual(seven.attentions.map((a) => [a.type, a.activation]), [["review", 1]]);
    assert.deepEqual(seven.evidence, [`${one.run_id}:bugcrowd`, `${one.run_id}:review`].sort());
    assert.equal(seven.summary, "In Review");
    assert.equal(ctx.last_run?.run_id, one.run_id);

    const history = await store.getCase({ responsibility: DEFINITION.key, keys: { submission: "7f3c" }, limit: 10 });
    assert.equal(history.case_id, seven.case_id);
    assert.equal(history.history.length, 1);
    assert.equal(history.history[0].run.by, "alice@example.com");
    assert.deepEqual(history.history[0].transitions.map((t) => t.kind), ["opened"]);
    assert.deepEqual(history.history[0].attention_events.map((e) => [e.type, e.event]), [["review", "opened"]]);
    assert.deepEqual(history.history[0].cited, [`${one.run_id}:bugcrowd`, `${one.run_id}:review`].sort());
    assert.equal(history.history[0].proposal?.summary, "In Review");
    assert.equal(await refusal(store.getCase({ responsibility: DEFINITION.key, keys: { submission: "nope" }, limit: 10 })), "unknown_case");
    assert.equal(await refusal(store.getCase({ responsibility: DEFINITION.key, keys: { submission: 7 }, limit: 10 })), "unknown_case", "exact keys");
  } finally {
    await w.close();
  }
});

// --- P2-T7 jsonb round trip, P2-T8 replay ------------------------------------------------

test("P2-T7/P2-T8 stored observations and states keep their digests; every step replays to the same state_digest", async () => {
  const w = await world();
  try {
    const alice = w.storeFor("alice");
    const bob = w.storeFor("bob", "client-b");
    await alice.putResponsibility(DEFINITION);
    const values = { submission: "7f3c", ratio: 0.1, big: 1e21, tiny: 5e-324, negative: -7, unicode: "Grüße ✓ 😀", none: null, flag: false, list: ["b", "a"] };

    const one = await start(alice);
    await record(alice, one.run_id, [...EMPTY.slice(1), listed("bugcrowd", [values, { submission: "91aa" }])]);
    await judge(alice, one.run_id, [
      { subject: submission("7f3c"), status: "open", cites: [`${one.run_id}:bugcrowd`], attentions: [{ type: "needs_work", intent: "open", reason: "fix" }] },
      { subject: submission("91aa"), status: "open", cites: [`${one.run_id}:bugcrowd`] },
    ]);

    // A new version between runs, a failed run, then two more steps by another member.
    w.advance(HOUR);
    await alice.putResponsibility({ ...DEFINITION, title: "Bugcrowd findings, v2" });
    const failed = await start(alice);
    await alice.completeRun({ run_id: failed.run_id, outcome: "failed", summary: "source down" });
    w.advance(HOUR);
    const two = await start(bob, DEFINITION.key, AGENT_B);
    await record(bob, two.run_id, [...EMPTY.slice(1), listed("bugcrowd", [{ submission: "7f3c" }])]);
    await judge(bob, two.run_id, [
      { subject: submission("91aa"), status: "resolved", cites: [`${two.run_id}:bugcrowd`] },
      { subject: submission("7f3c"), status: "open", cites: [`${two.run_id}:bugcrowd`], attentions: [{ type: "needs_work", intent: "close", reason: "done" }] },
    ]);
    w.advance(HOUR);
    const three = await start(bob, DEFINITION.key, AGENT_B);
    await record(bob, three.run_id, [listed("review", [{ submission: "7f3c" }])]);
    await judge(bob, three.run_id, [
      { subject: submission("7f3c"), status: "open", cites: [`${three.run_id}:review`], attentions: [{ type: "review", intent: "open", reason: "now in Review" }] },
    ]);

    // P2-T7: what jsonb gives back hashes to what was stored.
    for (const row of await w.db.query<{ body: Observation; digest: string }>(`SELECT body, digest FROM core_observations`)) {
      assert.equal(digest(row.body), row.digest, row.body.id);
    }
    for (const row of await w.db.query<{ row: unknown; row_digest: string }>(`SELECT row, row_digest FROM run_rows`)) {
      assert.equal(digest(row.row), row.row_digest);
    }
    const [current] = await w.db.query<{ state: State; state_digest: string }>(`SELECT state, state_digest FROM responsibility_states`);
    assert.equal(digest(current.state), current.state_digest);
    const [body] = await w.db.query<{ body: Observation }>(`SELECT body FROM core_observations WHERE id = $1`, [`${one.run_id}:bugcrowd`]);
    assert.deepEqual(body.body.rows.find((r) => r.submission === "7f3c"), values);

    // P2-T8: replay every step from its stored inputs, in order.
    const steps = await w.db.query<{
      run_id: string;
      definition: Definition;
      now: Date;
      basis: string;
      observation_ids: string[];
      evaluation: Evaluation;
      before: string | null;
      after: string;
    }>(
      `SELECT s.run_id, v.definition, s.now, s.basis, s.observation_ids, s.evaluation,
              s.state_digest_before AS before, s.state_digest_after AS after
         FROM core_steps s JOIN responsibility_versions v ON v.workspace_id = s.workspace_id AND v.id = s.version_id
        ORDER BY s.now`,
    );
    assert.deepEqual(steps.map((s) => s.run_id), [one.run_id, two.run_id, three.run_id]);
    assert.deepEqual(steps.map((s) => s.definition.version), [1, 2, 2]);
    let state: State | null = null;
    for (const s of steps) {
      const bodies = await w.db.query<{ body: Observation }>(`SELECT body FROM core_observations WHERE id = ANY($1::text[])`, [s.observation_ids]);
      assert.equal(bodies.length, s.observation_ids.length, "every observation a step was given is stored");
      assert.equal(s.before, state === null ? null : digest(state));
      const result = step(s.definition, state, bodies.map((b) => b.body), s.evaluation, s.now.toISOString());
      assert.deepEqual(result.rejections.filter((r) => r.code === "BASIS_MISMATCH"), [], "the stored basis binds the stored inputs");
      assert.equal(result.state_digest, s.after, `step of run ${s.run_id}`);
      state = result.state;
    }
    assert.equal(digest(state), current.state_digest, "the replay ends in the stored state");
    assert.ok(
      steps[2].observation_ids.includes(`${two.run_id}:bugcrowd`),
      "lookback (c): run three recorded no bugcrowd, so run two's is passed",
    );
  } finally {
    await w.close();
  }
});

// --- P2-T9 workspace isolation ----------------------------------------------------------

test("P2-T9 two workspaces with identical keys and subjects see nothing of each other", async () => {
  const w = await world();
  try {
    const { workspaceId: otherId, members } = await seedMembers(w.db, ["zoe"], "other-co");
    const acme = w.storeFor("alice");
    const other = responsibilityStore(
      w.db,
      { workspaceId: otherId, memberId: members.zoe, clientId: "client-z", clientName: null },
      { now: w.now },
    );

    for (const [store, state] of [[acme, "NEW"], [other, "TRIAGED"]] as const) {
      await store.putResponsibility(DEFINITION);
      const { run_id } = await start(store);
      await record(store, run_id, [listed("bugcrowd", [{ submission: "S1", state }])]);
      await judge(store, run_id, [{ subject: submission("S1"), status: "open", cites: [`${run_id}:bugcrowd`], summary: state }]);
    }

    const acmeCase = await acme.getCase({ responsibility: DEFINITION.key, keys: { submission: "S1" }, limit: 10 });
    const otherCase = await other.getCase({ responsibility: DEFINITION.key, keys: { submission: "S1" }, limit: 10 });
    assert.notEqual(acmeCase.case_id, otherCase.case_id, "the definition id is the responsibility's, per workspace");
    assert.deepEqual([acmeCase.summary, otherCase.summary], ["NEW", "TRIAGED"]);
    assert.equal(acmeCase.history.length, 1);
    assert.equal(acmeCase.history[0].run.by, "alice@example.com");
    assert.equal(otherCase.history[0].run.by, "zoe@example.com");

    const { run_id: foreign } = await start(other);
    assert.equal(await refusal(record(acme, foreign)), "unknown_run");
    assert.equal(await refusal(acme.viewRun({ run_id: foreign })), "unknown_run");
    assert.equal((await acme.getResponsibility(DEFINITION.key)).in_progress, null, "the other workspace's open run is not ours");
  } finally {
    await w.close();
  }
});
