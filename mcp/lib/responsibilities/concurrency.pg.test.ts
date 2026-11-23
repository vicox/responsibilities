import assert from "node:assert/strict";
import test from "node:test";

import { digest } from "../core.ts";
import type { SqlDriver } from "../db/driver.ts";
import { pgSchema, pgSkip } from "../pg-testing.ts";
import { migrateAll, seedMembers } from "../testing.ts";
import { AGENT_A, DEFINITION, EMPTY, listed, submission } from "./fixtures.ts";
import { Refusal, RUN_IDLE_MS } from "./model.ts";
import { responsibilityStore, type ResponsibilityStore } from "./store.ts";

/**
 * The run locking on real Postgres with independent connections
 * (docs/core-integration-plan.md P3-T1): two pools stand for two application
 * instances. Only ever against a throwaway database (TEST_DATABASE_URL).
 */

const ROUNDS = 15;

async function setup() {
  // Two instances, plus one connection that only watches pg_stat_activity.
  const { drivers, drop } = await pgSchema(3);
  await migrateAll(drivers[0]);
  const { workspaceId, members } = await seedMembers(drivers[0], ["alice", "bob"], "acme");
  const storeOn = (index: number, member: string, client: string, now?: () => Date) =>
    responsibilityStore(
      drivers[index],
      {
        workspaceId,
        memberId: members[member],
        clientId: client,
        clientName: client,
      },
      { now },
    );
  return { drivers, drop, storeOn, workspaceId };
}

const start = (store: ResponsibilityStore, key = DEFINITION.key, supersede = false) =>
  store.startRun({ responsibility: key, agent: AGENT_A, supersede });
const rows = (prefix: string, n = 1) => [listed("bugcrowd", Array.from({ length: n }, (_, i) => ({ submission: `${prefix}-${i}` })))];

function code(result: PromiseSettledResult<unknown>): string {
  if (result.status === "fulfilled") return "ok";
  return result.reason instanceof Refusal ? result.reason.code : `error: ${String(result.reason)}`;
}

const settle = <T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> =>
  promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );

/** Resolves once `sessions` sessions in this database are waiting on a lock. */
async function untilSomeoneWaitsOnALock(watcher: SqlDriver, sessions = 1): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const [{ waiting }] = await watcher.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if (waiting >= sessions) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fewer than ${sessions} sessions started waiting on a lock`);
}

test(
  "start_run superseding a run cannot deadlock with record_observations writing its kinds and rows (no 40P01)",
  { skip: pgSkip },
  async () => {
    const { drivers, drop, storeOn, workspaceId } = await setup();
    try {
      const alice = storeOn(0, "alice", "client-a");
      await alice.putResponsibility(DEFINITION);
      const { run_id } = await start(alice);

      // Pinned interleaving: record_observations' statements in its own order —
      // lock the run, then insert a kind (foreign key on the run) and its rows —
      // with a superseding start_run (responsibility row, then the open run)
      // arriving in between.
      let superseding: Promise<PromiseSettledResult<unknown>> | undefined;
      await drivers[0].transaction(async (tx) => {
        await tx.query(`SELECT id FROM runs WHERE workspace_id = $1 AND id = $2 FOR UPDATE`, [workspaceId, run_id]);
        superseding = settle(start(storeOn(1, "bob", "client-b"), DEFINITION.key, true));
        await untilSomeoneWaitsOnALock(drivers[2]);
        const row = { submission: "pinned" };
        await tx.query(
          `INSERT INTO run_observation_kinds (workspace_id, run_id, kind, complete, recorded_at) VALUES ($1, $2, 'bugcrowd', true, now())`,
          [workspaceId, run_id],
        );
        await tx.query(
          `INSERT INTO run_rows (workspace_id, run_id, kind, row_digest, row) VALUES ($1, $2, 'bugcrowd', $3, $4::jsonb)`,
          [workspaceId, run_id, digest(row), JSON.stringify(row)],
        );
        await tx.query(`UPDATE runs SET view_now = NULL, view_basis = NULL WHERE workspace_id = $1 AND id = $2`, [workspaceId, run_id]);
      });
      assert.equal(code(await superseding!), "ok", "the superseding start_run went through after the write");

      // And the real functions, raced: every round ends in a write landing before
      // the supersede or being refused as abandoned — never a deadlock.
      const bob = storeOn(1, "bob", "client-b");
      for (let round = 0; round < ROUNDS; round++) {
        const own = await start(alice, DEFINITION.key, true);
        await alice.recordObservations({ run_id: own.run_id, observations: EMPTY });
        const [recorded, started] = await Promise.allSettled([
          alice.recordObservations({ run_id: own.run_id, observations: rows(`R${round}`, 20) }),
          start(bob, DEFINITION.key, true),
        ]);
        assert.equal(code(started), "ok", `round ${round}: ${code(started)}`);
        assert.ok(["ok", "run_abandoned"].includes(code(recorded)), `round ${round}: ${code(recorded)}`);
      }
    } finally {
      await drop();
    }
  },
);

test(
  "start_run taking over an idle run and its owner's renewing write: exactly one of them lands",
  { skip: pgSkip },
  async () => {
    const { drivers, drop, storeOn, workspaceId } = await setup();
    try {
      let current = new Date("2026-11-19T09:00:00.000Z");
      const now = () => new Date(current);
      const alice = storeOn(0, "alice", "client-a", now);
      const bob = storeOn(1, "bob", "client-b", now);

      // Pinned interleaving: the owner's write holds the run lock and renews
      // last_active_at as record_observations does; a takeover arriving in
      // between waits for the lock and must judge the renewed row, not the idle one.
      await alice.putResponsibility({ ...DEFINITION, key: "idle-pinned" });
      const pinned = await start(alice, "idle-pinned");
      current = new Date(current.getTime() + RUN_IDLE_MS);
      let taking: Promise<PromiseSettledResult<unknown>> | undefined;
      await drivers[0].transaction(async (tx) => {
        await tx.query(`SELECT id FROM runs WHERE workspace_id = $1 AND id = $2 FOR UPDATE`, [workspaceId, pinned.run_id]);
        taking = settle(start(bob, "idle-pinned"));
        await untilSomeoneWaitsOnALock(drivers[2]);
        await tx.query(
          `UPDATE runs SET last_active_at = GREATEST(last_active_at, $3) WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, pinned.run_id, now()],
        );
      });
      assert.equal(code(await taking!), "run_in_progress", "the takeover saw the renewal it waited for");

      // And the real functions, raced on a run idle for exactly RUN_IDLE_MS.
      for (let round = 0; round < ROUNDS; round++) {
        const key = `idle-${round}`;
        await alice.putResponsibility({ ...DEFINITION, key });
        const { run_id } = await start(alice, key);
        await alice.recordObservations({ run_id, observations: EMPTY });
        current = new Date(current.getTime() + RUN_IDLE_MS);

        const [recorded, started] = await Promise.allSettled([
          alice.recordObservations({ run_id, observations: rows(`I${round}`) }),
          start(bob, key),
        ]);
        const outcome = `${code(recorded)} / ${code(started)}`;
        assert.ok(["ok / run_in_progress", "run_abandoned / ok"].includes(outcome), `round ${round}: ${outcome}`);
        const [run] = await drivers[0].query<{ outcome: string | null }>(`SELECT outcome FROM runs WHERE id = $1`, [run_id]);
        const written = await drivers[0].query(`SELECT 1 FROM run_rows WHERE run_id = $1`, [run_id]);
        if (recorded.status === "fulfilled") {
          assert.equal(run.outcome, null, "the write renewed it: still open");
          assert.equal(written.length, 1);
        } else {
          assert.equal(run.outcome, "abandoned");
          assert.equal(written.length, 0, "refused writes nothing");
        }
      }
    } finally {
      await drop();
    }
  },
);

test("a write or a start that waited for a lock holds the run from when it lands", { skip: pgSkip }, async () => {
  const { drivers, drop, storeOn, workspaceId } = await setup();
  try {
    let current = new Date("2026-11-19T09:00:00.000Z");
    const now = () => new Date(current);
    const wait = () => {
      current = new Date(current.getTime() + RUN_IDLE_MS);
    };
    const alice = storeOn(1, "alice", "client-a", now);
    const bob = storeOn(1, "bob", "client-b", now);
    await alice.putResponsibility(DEFINITION);
    const { run_id } = await start(alice);
    await alice.recordObservations({ run_id, observations: EMPTY });

    // The owner's write waits RUN_IDLE_MS for the run's lock, then lands.
    let recording: Promise<PromiseSettledResult<unknown>> | undefined;
    await drivers[0].transaction(async (tx) => {
      await tx.query(`SELECT id FROM runs WHERE workspace_id = $1 AND id = $2 FOR UPDATE`, [workspaceId, run_id]);
      recording = settle(alice.recordObservations({ run_id, observations: rows("S") }));
      await untilSomeoneWaitsOnALock(drivers[2]);
      wait();
    });
    assert.equal(code(await recording!), "ok");
    assert.equal(code(await settle(start(bob))), "run_in_progress", "the write that landed holds the run");

    // A start waits RUN_IDLE_MS for the responsibility's lock, then takes over the idle run.
    wait();
    let starting: Promise<PromiseSettledResult<Awaited<ReturnType<typeof bob.startRun>>>> | undefined;
    await drivers[0].transaction(async (tx) => {
      await tx.query(`SELECT id FROM responsibilities WHERE workspace_id = $1 AND key = $2 FOR UPDATE`, [workspaceId, DEFINITION.key]);
      starting = settle(start(bob));
      await untilSomeoneWaitsOnALock(drivers[2]);
      wait();
    });
    const started = await starting!;
    assert.equal(code(started), "ok");
    assert.equal(started.status === "fulfilled" && started.value.started_at, now().toISOString());
    assert.equal(code(await settle(start(alice))), "run_in_progress", "the run it began is not idle at once");
  } finally {
    await drop();
  }
});

test(
  "a write or a start that stalled after taking its locks holds the run from when it lands",
  { skip: pgSkip },
  async () => {
    const { drivers, drop, storeOn } = await setup();
    try {
      let current = new Date("2026-11-19T09:00:00.000Z");
      const now = () => new Date(current);
      const wait = () => {
        current = new Date(current.getTime() + RUN_IDLE_MS);
      };
      const alice = storeOn(1, "alice", "client-a", now);
      const bob = storeOn(0, "bob", "client-b", now);
      await alice.putResponsibility(DEFINITION);
      const { run_id } = await start(alice);
      await alice.recordObservations({ run_id, observations: EMPTY });

      // The owner's write takes the run's lock, then waits RUN_IDLE_MS at its
      // run_rows INSERT; a takeover arrives and waits for the run.
      let recording: Promise<PromiseSettledResult<unknown>> | undefined;
      let taking: Promise<PromiseSettledResult<unknown>> | undefined;
      await drivers[2].transaction(async (tx) => {
        await tx.exec(`LOCK TABLE run_rows IN SHARE MODE`);
        recording = settle(alice.recordObservations({ run_id, observations: rows("S") }));
        await untilSomeoneWaitsOnALock(drivers[2], 1);
        taking = settle(start(bob));
        await untilSomeoneWaitsOnALock(drivers[2], 2);
        wait();
      });
      assert.equal(code(await recording!), "ok");
      assert.equal(code(await taking!), "run_in_progress", "the write that landed holds the run");
      const [run] = await drivers[0].query<{ outcome: string | null }>(`SELECT outcome FROM runs WHERE id = $1`, [run_id]);
      assert.equal(run.outcome, null);

      // A start that judges the run idle once it holds the locks, then waits
      // RUN_IDLE_MS at its first write to runs before taking it over.
      wait();
      let starting: Promise<PromiseSettledResult<unknown>> | undefined;
      await drivers[2].transaction(async (tx) => {
        await tx.exec(`LOCK TABLE runs IN SHARE MODE`);
        starting = settle(start(bob));
        await untilSomeoneWaitsOnALock(drivers[2], 1);
        wait();
      });
      assert.equal(code(await starting!), "ok");
      assert.equal(code(await settle(start(alice))), "run_in_progress", "the run it began is not idle at once");
    } finally {
      await drop();
    }
  },
);

test("two concurrent start_run calls produce exactly one run", { skip: pgSkip }, async () => {
  const { drivers, drop, storeOn } = await setup();
  try {
    const a = storeOn(0, "alice", "client-a");
    const b = storeOn(1, "bob", "client-b");
    for (let round = 0; round < ROUNDS; round++) {
      const key = `race-${round}`;
      await a.putResponsibility({ ...DEFINITION, key });
      const results = await Promise.allSettled([start(a, key), start(b, key)]);
      assert.deepEqual(results.map(code).sort(), ["ok", "run_in_progress"], `round ${round}`);
    }
    const [{ count }] = await drivers[0].query<{ count: number }>(
      `SELECT count(*)::int AS count FROM runs WHERE completed_at IS NULL`,
    );
    assert.equal(count, ROUNDS);
  } finally {
    await drop();
  }
});

test("record_observations racing complete_run: the recording invalidates the view, or is refused after completion", { skip: pgSkip }, async () => {
  const { drivers, drop, storeOn } = await setup();
  try {
    const first = storeOn(0, "alice", "client-a");
    const second = storeOn(1, "alice", "client-a");
    await first.putResponsibility(DEFINITION);
    const outcomes = new Set<string>();

    for (let round = 0; round < ROUNDS; round++) {
      const { run_id } = await start(first);
      await first.recordObservations({ run_id, observations: [...EMPTY.slice(1), ...rows(`A${round}`)] });
      const { basis } = await first.viewRun({ run_id });

      const [completed, recorded] = await Promise.allSettled([
        first.completeRun({
          run_id,
          outcome: "completed",
          evaluation: { basis, proposals: [{ subject: submission(`A${round}-0`), status: "open", cites: [`${run_id}:bugcrowd`] }] },
        }),
        second.recordObservations({ run_id, observations: rows(`B${round}`) }),
      ]);
      const outcome = `${code(completed)} / ${code(recorded)}`;
      outcomes.add(outcome);
      assert.ok(["ok / run_completed", "view_required / ok"].includes(outcome), `round ${round}: ${outcome}`);

      const [run] = await drivers[0].query<{ outcome: string | null }>(`SELECT outcome FROM runs WHERE id = $1`, [run_id]);
      const late = await drivers[0].query(`SELECT 1 FROM run_rows WHERE run_id = $1 AND row->>'submission' = $2`, [run_id, `B${round}-0`]);
      const steps = await drivers[0].query(`SELECT 1 FROM core_steps WHERE run_id = $1`, [run_id]);
      if (recorded.status === "fulfilled") {
        assert.deepEqual([run.outcome, late.length, steps.length], [null, 1, 0], "landed first: the run stays open, unstepped");
        const again = await first.viewRun({ run_id });
        await first.completeRun({ run_id, outcome: "completed", evaluation: { basis: again.basis, proposals: [] } });
      } else {
        assert.deepEqual([run.outcome, late.length, steps.length], ["completed", 0, 1], "refused writes nothing");
      }
    }
    for (const outcome of outcomes) assert.ok(["ok / run_completed", "view_required / ok"].includes(outcome), outcome);
  } finally {
    await drop();
  }
});

test("two complete_run calls for one run: one result and one replay of it", { skip: pgSkip }, async () => {
  const { drivers, drop, storeOn } = await setup();
  try {
    const first = storeOn(0, "alice", "client-a");
    const second = storeOn(1, "alice", "client-a");
    await first.putResponsibility(DEFINITION);

    for (let round = 0; round < ROUNDS; round++) {
      const { run_id } = await start(first);
      await first.recordObservations({ run_id, observations: [...EMPTY.slice(1), ...rows(`C${round}`)] });
      const { basis } = await first.viewRun({ run_id });
      const input = {
        run_id,
        outcome: "completed" as const,
        evaluation: { basis, proposals: [{ subject: submission(`C${round}-0`), status: "open" as const, cites: [`${run_id}:bugcrowd`] }] },
      };
      const [a, b] = await Promise.allSettled([first.completeRun(input), second.completeRun(input)]);
      assert.deepEqual([code(a), code(b)], ["ok", "ok"], `round ${round}`);
      const results = [a, b].map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof first.completeRun>>>).value);
      assert.deepEqual(results.map((r) => r.already_completed ?? false).sort(), [false, true]);
      const original = results.find((r) => !r.already_completed)!;
      assert.deepEqual(results.find((r) => r.already_completed), { ...original, already_completed: true });
      const [{ steps }] = await drivers[0].query<{ steps: number }>(`SELECT count(*)::int AS steps FROM core_steps WHERE run_id = $1`, [run_id]);
      assert.equal(steps, 1);
    }
    const [{ cases }] = await drivers[0].query<{ cases: number }>(
      `SELECT count(*)::int AS cases FROM responsibility_states, jsonb_object_keys(state->'cases')`,
    );
    assert.equal(cases, ROUNDS, "every round opened its case once");
  } finally {
    await drop();
  }
});
