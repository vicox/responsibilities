import assert from "node:assert/strict";
import test from "node:test";

import type { SqlDriver } from "../db/driver.ts";
import { pgSchema, pgSkip } from "../pg-testing.ts";
import { migrateAll, seedMembers } from "../testing.ts";
import { AGENT_A, DEFINITION, SOURCES } from "./fixtures.ts";
import { Refusal, RUN_IDLE_MS } from "./model.ts";
import { responsibilityStore } from "./store.ts";

/**
 * The run locking on real Postgres with independent connections (plan §11):
 * two pools stand for two application instances.
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

function code(result: PromiseSettledResult<unknown>): string {
  if (result.status === "fulfilled") return "ok";
  return result.reason instanceof Refusal ? result.reason.code : `error: ${String(result.reason)}`;
}

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
  "start_run superseding a run cannot deadlock with record_observations opening a case (no 40P01)",
  { skip: pgSkip },
  async () => {
    const { drivers, drop, storeOn } = await setup();
    try {
      const alice = storeOn(0, "alice", "client-a");
      await alice.putResponsibility(DEFINITION);
      const { run_id } = await alice.startRun({ responsibility: DEFINITION.key, agent: AGENT_A, supersede: false });
      await alice.recordObservations({ run_id, sources: SOURCES, subjects: [] });
      const [{ responsibility_id, workspace_id }] = await drivers[0].query<{
        responsibility_id: string;
        workspace_id: string;
      }>(`SELECT responsibility_id, workspace_id FROM runs WHERE id = $1`, [run_id]);

      // Pinned interleaving: record_observations' statements in its own order —
      // lock the run, then insert a new case (whose foreign key locks the
      // responsibility row) — with a superseding start_run (responsibility row,
      // then the open run) arriving in between. Before the fix this was a
      // lock-order cycle and Postgres aborted one side with 40P01.
      let superseding: Promise<PromiseSettledResult<unknown>> | undefined;
      await drivers[0].transaction(async (tx) => {
        await tx.query(`SELECT id FROM runs WHERE workspace_id = $1 AND id = $2 FOR UPDATE`, [workspace_id, run_id]);
        superseding = storeOn(1, "bob", "client-b")
          .startRun({ responsibility: DEFINITION.key, agent: AGENT_A, supersede: true })
          .then(
            (value) => ({ status: "fulfilled" as const, value }),
            (reason: unknown) => ({ status: "rejected" as const, reason }),
          );
        await untilSomeoneWaitsOnALock(drivers[2]);
        await tx.query(
          `INSERT INTO cases (workspace_id, responsibility_id, subject) VALUES ($1, $2, 'pinned-subject')`,
          [workspace_id, responsibility_id],
        );
      });
      assert.equal(code(await superseding!), "ok", "the superseding start_run went through after the write");

      // And the real functions, raced: every round ends in a write landing before
      // the supersede or being refused as abandoned — never a deadlock.
      const bob = storeOn(1, "bob", "client-b");
      for (let round = 0; round < ROUNDS; round++) {
        const own = await alice.startRun({ responsibility: DEFINITION.key, agent: AGENT_A, supersede: true });
        await alice.recordObservations({ run_id: own.run_id, sources: SOURCES, subjects: [] });
        const [recorded, started] = await Promise.allSettled([
          alice.recordObservations({
            run_id: own.run_id,
            subjects: Array.from({ length: 20 }, (_, i) => ({
              subject: `R${round}-${i}`,
              facts: { "bugcrowd.state": "NEW" },
            })),
          }),
          bob.startRun({ responsibility: DEFINITION.key, agent: AGENT_A, supersede: true }),
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
      const start = (key: string) => bob.startRun({ responsibility: key, agent: AGENT_A, supersede: false });

      // Pinned interleaving: the owner's write holds the run lock and renews
      // last_active_at as record_observations does; a takeover arriving in
      // between waits for the lock and must judge the renewed row, not the idle one.
      await alice.putResponsibility({ ...DEFINITION, key: "idle-pinned" });
      const pinned = await alice.startRun({ responsibility: "idle-pinned", agent: AGENT_A, supersede: false });
      current = new Date(current.getTime() + RUN_IDLE_MS);
      let taking: Promise<PromiseSettledResult<unknown>> | undefined;
      await drivers[0].transaction(async (tx) => {
        await tx.query(`SELECT id FROM runs WHERE workspace_id = $1 AND id = $2 FOR UPDATE`, [
          workspaceId,
          pinned.run_id,
        ]);
        taking = start("idle-pinned").then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        );
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
        const { run_id } = await alice.startRun({ responsibility: key, agent: AGENT_A, supersede: false });
        await alice.recordObservations({ run_id, sources: SOURCES, subjects: [] });
        current = new Date(current.getTime() + RUN_IDLE_MS);

        const subject = `I${round}`;
        const [recorded, started] = await Promise.allSettled([
          alice.recordObservations({ run_id, subjects: [{ subject, facts: { "bugcrowd.state": "NEW" } }] }),
          start(key),
        ]);
        const outcome = `${code(recorded)} / ${code(started)}`;
        assert.ok(
          ["ok / run_in_progress", "run_abandoned / ok"].includes(outcome),
          `round ${round}: ${outcome}`,
        );
        const [run] = await drivers[0].query<{ outcome: string | null }>(`SELECT outcome FROM runs WHERE id = $1`, [
          run_id,
        ]);
        const observed = await drivers[0].query(
          `SELECT 1 FROM observations o JOIN cases c ON c.id = o.case_id WHERE o.run_id = $1 AND c.subject = $2`,
          [run_id, subject],
        );
        if (recorded.status === "fulfilled") {
          assert.equal(run.outcome, null, "the write renewed it: still open");
          assert.equal(observed.length, 1);
        } else {
          assert.equal(run.outcome, "abandoned");
          assert.equal(observed.length, 0, "refused writes nothing");
        }
      }
    } finally {
      await drop();
    }
  },
);

test("a write or a start that waited for a lock holds the run from when it lands", { skip: pgSkip }, async () => {
  const { drivers, drop, storeOn, workspaceId } = await setup();
  const settle = <T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> =>
    promise.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
  try {
    let current = new Date("2026-11-19T09:00:00.000Z");
    const now = () => new Date(current);
    const wait = () => {
      current = new Date(current.getTime() + RUN_IDLE_MS);
    };
    const alice = storeOn(1, "alice", "client-a", now);
    const bob = storeOn(1, "bob", "client-b", now);
    const start = (store: typeof alice) =>
      settle(store.startRun({ responsibility: DEFINITION.key, agent: AGENT_A, supersede: false }));
    await alice.putResponsibility(DEFINITION);
    const { run_id } = await alice.startRun({ responsibility: DEFINITION.key, agent: AGENT_A, supersede: false });
    await alice.recordObservations({ run_id, sources: SOURCES, subjects: [] });

    // The owner's write waits RUN_IDLE_MS for the run's lock, then lands.
    let recording: Promise<PromiseSettledResult<unknown>> | undefined;
    await drivers[0].transaction(async (tx) => {
      await tx.query(`SELECT id FROM runs WHERE workspace_id = $1 AND id = $2 FOR UPDATE`, [workspaceId, run_id]);
      recording = settle(
        alice.recordObservations({ run_id, subjects: [{ subject: "S1", facts: { "bugcrowd.state": "NEW" } }] }),
      );
      await untilSomeoneWaitsOnALock(drivers[2]);
      wait();
    });
    assert.equal(code(await recording!), "ok");
    assert.equal(code(await start(bob)), "run_in_progress", "the write that landed holds the run");

    // A start waits RUN_IDLE_MS for the responsibility's lock, then takes over the idle run.
    wait();
    let starting: Promise<PromiseSettledResult<Awaited<ReturnType<typeof bob.startRun>>>> | undefined;
    await drivers[0].transaction(async (tx) => {
      await tx.query(`SELECT id FROM responsibilities WHERE workspace_id = $1 AND key = $2 FOR UPDATE`, [
        workspaceId,
        DEFINITION.key,
      ]);
      starting = start(bob);
      await untilSomeoneWaitsOnALock(drivers[2]);
      wait();
    });
    const started = await starting!;
    assert.equal(code(started), "ok");
    assert.equal(started.status === "fulfilled" && started.value.started_at, now().toISOString());
    assert.equal(code(await start(alice)), "run_in_progress", "the run it began is not idle at once");
  } finally {
    await drop();
  }
});

test(
  "a write or a start that stalled after taking its locks holds the run from when it lands",
  { skip: pgSkip },
  async () => {
    const { drivers, drop, storeOn } = await setup();
    const settle = <T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> =>
      promise.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
    try {
      let current = new Date("2026-11-19T09:00:00.000Z");
      const now = () => new Date(current);
      const wait = () => {
        current = new Date(current.getTime() + RUN_IDLE_MS);
      };
      const alice = storeOn(1, "alice", "client-a", now);
      const bob = storeOn(0, "bob", "client-b", now);
      const start = (store: typeof alice) =>
        settle(store.startRun({ responsibility: DEFINITION.key, agent: AGENT_A, supersede: false }));
      await alice.putResponsibility(DEFINITION);
      const { run_id } = await alice.startRun({ responsibility: DEFINITION.key, agent: AGENT_A, supersede: false });
      await alice.recordObservations({ run_id, sources: SOURCES, subjects: [] });

      // The owner's write takes the run's lock, then waits RUN_IDLE_MS at its
      // observations INSERT; a takeover arrives and waits for the run.
      let recording: Promise<PromiseSettledResult<unknown>> | undefined;
      let taking: Promise<PromiseSettledResult<unknown>> | undefined;
      await drivers[2].transaction(async (tx) => {
        await tx.exec(`LOCK TABLE observations IN SHARE MODE`);
        recording = settle(
          alice.recordObservations({ run_id, subjects: [{ subject: "S1", facts: { "bugcrowd.state": "NEW" } }] }),
        );
        await untilSomeoneWaitsOnALock(drivers[2], 1);
        taking = start(bob);
        await untilSomeoneWaitsOnALock(drivers[2], 2);
        wait();
      });
      assert.equal(code(await recording!), "ok");
      assert.equal(code(await taking!), "run_in_progress", "the write that landed holds the run");
      const [run] = await drivers[0].query<{ outcome: string | null }>(`SELECT outcome FROM runs WHERE id = $1`, [
        run_id,
      ]);
      assert.equal(run.outcome, null);

      // A start that judges the run idle once it holds the locks, then waits
      // RUN_IDLE_MS at its first write to runs before taking it over.
      wait();
      let starting: Promise<PromiseSettledResult<unknown>> | undefined;
      await drivers[2].transaction(async (tx) => {
        await tx.exec(`LOCK TABLE runs IN SHARE MODE`);
        starting = start(bob);
        await untilSomeoneWaitsOnALock(drivers[2], 1);
        wait();
      });
      assert.equal(code(await starting!), "ok");
      assert.equal(code(await start(alice)), "run_in_progress", "the run it began is not idle at once");
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
      const results = await Promise.allSettled([
        a.startRun({ responsibility: key, agent: AGENT_A, supersede: false }),
        b.startRun({ responsibility: key, agent: AGENT_A, supersede: false }),
      ]);
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

test("record_observations racing complete_run lands before completion or is refused", { skip: pgSkip }, async () => {
  const { drivers, drop, storeOn } = await setup();
  try {
    const first = storeOn(0, "alice", "client-a");
    const second = storeOn(1, "alice", "client-a");
    await first.putResponsibility(DEFINITION);
    const outcomes = new Set<string>();

    for (let round = 0; round < ROUNDS; round++) {
      const { run_id } = await first.startRun({ responsibility: DEFINITION.key, agent: AGENT_A, supersede: false });
      await first.recordObservations({
        run_id,
        sources: SOURCES,
        subjects: [{ subject: `A${round}`, facts: { "bugcrowd.state": "NEW" } }],
      });

      const late = `B${round}`;
      const [completed, recorded] = await Promise.allSettled([
        first.completeRun({
          run_id,
          outcome: "completed",
          decisions: [{ subject: `A${round}`, assessment: "nothing_due", attention: null, basis: "b" }],
        }),
        second.recordObservations({ run_id, subjects: [{ subject: late, facts: { "bugcrowd.state": "NEW" } }] }),
      ]);
      assert.equal(code(completed), "ok");
      outcomes.add(code(recorded));

      const [run] = await drivers[0].query<{ completion: { not_decided: string[] } }>(
        `SELECT completion FROM runs WHERE id = $1`,
        [run_id],
      );
      const observed = await drivers[0].query(
        `SELECT 1 FROM observations o JOIN cases c ON c.id = o.case_id WHERE o.run_id = $1 AND c.subject = $2`,
        [run_id, late],
      );
      if (recorded.status === "fulfilled") {
        assert.equal(observed.length, 1);
        assert.ok(run.completion.not_decided.includes(late), "it landed before completion: completion saw it");
      } else {
        assert.equal(code(recorded), "run_completed");
        assert.equal(observed.length, 0, "refused writes nothing");
      }
    }
    for (const outcome of outcomes) assert.ok(["ok", "run_completed"].includes(outcome), outcome);
  } finally {
    await drop();
  }
});
