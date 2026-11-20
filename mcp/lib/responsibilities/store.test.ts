import assert from "node:assert/strict";
import test from "node:test";

import { seedMembers } from "../testing.ts";
import { AGENT_A, AGENT_B, DEFINITION, refusal, SOURCES, VOCABULARY, world } from "./fixtures.ts";
import { RUN_LIFETIME_MS, RUN_LIMIT } from "./model.ts";
import { responsibilityStore } from "./store.ts";

const HOUR = 60 * 60 * 1000;

test("versioning: same content is a no-op, a change adds a version", async () => {
  const w = await world();
  try {
    const store = w.storeFor("alice");
    assert.deepEqual(await store.putResponsibility(DEFINITION), {
      key: DEFINITION.key,
      version: 1,
      changed: true,
      previous_version: null,
    });
    assert.deepEqual(await store.putResponsibility({ ...DEFINITION, assessments: [...VOCABULARY] }), {
      key: DEFINITION.key,
      version: 1,
      changed: false,
      previous_version: 1,
    });
    const [{ count }] = await w.db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM responsibility_versions`,
    );
    assert.equal(count, 1, "nothing written for the same content");

    assert.deepEqual(await w.storeFor("bob").putResponsibility({ ...DEFINITION, expectation: "Changed." }), {
      key: DEFINITION.key,
      version: 2,
      changed: true,
      previous_version: 1,
    });
    assert.equal((await store.getResponsibility(DEFINITION.key, false)).responsibility.expectation, "Changed.");
    assert.equal(
      await refusal(
        store.putResponsibility({ ...DEFINITION, assessments: [...VOCABULARY, VOCABULARY[0]] }),
      ),
      "invalid_assessments",
    );
    assert.equal(await refusal(store.getResponsibility("no-such-key", false)), "unknown_responsibility");
  } finally {
    await w.close();
  }
});

test("one open run per responsibility: run_in_progress, expiry abandons, supersede abandons", async () => {
  const w = await world();
  try {
    const alice = w.storeFor("alice");
    const bob = w.storeFor("bob", "client-b");
    await alice.putResponsibility(DEFINITION);

    const first = await alice.startRun({ responsibility: DEFINITION.key, agent: AGENT_A, supersede: false });
    assert.equal(first.run_limit, RUN_LIMIT);
    assert.equal(first.expires_at, new Date(w.now().getTime() + RUN_LIFETIME_MS).toISOString());
    assert.equal(first.last_run, null);
    assert.equal(first.in_progress?.run_id, first.run_id);

    assert.equal(
      await refusal(bob.startRun({ responsibility: DEFINITION.key, agent: AGENT_B, supersede: false })),
      "run_in_progress",
    );

    // Superseded: the old run is abandoned and cannot be written to.
    w.advance(10 * 60 * 1000);
    const second = await bob.startRun({ responsibility: DEFINITION.key, agent: AGENT_B, supersede: true });
    const [old] = await w.db.query<{ outcome: string; summary: string }>(
      `SELECT outcome, summary FROM runs WHERE id = $1`,
      [first.run_id],
    );
    assert.deepEqual(old, { outcome: "abandoned", summary: `superseded by run ${second.run_id}` });
    assert.equal(
      await refusal(alice.recordObservations({ run_id: first.run_id, sources: SOURCES, subjects: [] })),
      "run_abandoned",
    );

    // Past its lifetime, the open run is refused for writes and abandoned by the next start.
    w.advance(RUN_LIFETIME_MS);
    assert.equal(
      await refusal(bob.recordObservations({ run_id: second.run_id, sources: SOURCES, subjects: [] })),
      "run_expired",
    );
    assert.equal(
      (await alice.getResponsibility(DEFINITION.key, false)).in_progress,
      null,
      "an expired run is not shown as in progress",
    );
    await alice.startRun({ responsibility: DEFINITION.key, agent: AGENT_A, supersede: false });
    const [expired] = await w.db.query<{ outcome: string }>(`SELECT outcome FROM runs WHERE id = $1`, [
      second.run_id,
    ]);
    assert.equal(expired.outcome, "abandoned");
    assert.equal(
      await refusal(alice.startRun({ responsibility: "unknown-key", agent: AGENT_A, supersede: false })),
      "unknown_responsibility",
    );
  } finally {
    await w.close();
  }
});

test("a run belongs to the member and the client that started it", async () => {
  const w = await world();
  try {
    const alice = w.storeFor("alice", "client-a");
    await alice.putResponsibility(DEFINITION);
    const run = await alice.startRun({ responsibility: DEFINITION.key, agent: AGENT_A, supersede: false });

    for (const other of [w.storeFor("bob", "client-a"), w.storeFor("alice", "client-other")]) {
      assert.equal(
        await refusal(other.recordObservations({ run_id: run.run_id, sources: SOURCES, subjects: [] })),
        "run_not_yours",
      );
      assert.equal(
        await refusal(other.completeRun({ run_id: run.run_id, outcome: "completed", decisions: [] })),
        "run_not_yours",
      );
    }
    assert.equal(
      await refusal(
        alice.recordObservations({ run_id: "00000000-0000-4000-8000-000000000000", sources: SOURCES, subjects: [] }),
      ),
      "unknown_run",
    );
  } finally {
    await w.close();
  }
});

test("sources: required first, identical repeat is a no-op, a different one conflicts", async () => {
  const w = await world();
  try {
    const store = w.storeFor("alice");
    await store.putResponsibility(DEFINITION);
    const { run_id } = await store.startRun({ responsibility: DEFINITION.key, agent: AGENT_A, supersede: false });

    assert.equal(
      await refusal(store.recordObservations({ run_id, subjects: [{ subject: "S1", facts: {} }] })),
      "sources_required",
    );
    assert.equal(
      await refusal(store.completeRun({ run_id, outcome: "completed", decisions: [] })),
      "sources_required",
    );

    // Source-only call: valid, records coverage.
    const empty = await store.recordObservations({ run_id, sources: SOURCES, subjects: [] });
    assert.deepEqual(empty.subjects, []);

    // A retried first call — same sources in another order, with and without subjects.
    await store.recordObservations({ run_id, sources: [...SOURCES].reverse(), subjects: [] });
    await store.recordObservations({
      run_id,
      sources: SOURCES,
      subjects: [{ subject: "S1", facts: { "bugcrowd.state": "NEW" } }],
    });
    await store.recordObservations({ run_id, subjects: [{ subject: "S2", facts: { "bugcrowd.state": "NEW" } }] });

    assert.equal(
      await refusal(
        store.recordObservations({
          run_id,
          sources: [{ ...SOURCES[0], complete: false }, ...SOURCES.slice(1)],
          subjects: [{ subject: "S3", facts: {} }],
        }),
      ),
      "sources_conflict",
    );
    const [{ count }] = await w.db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM cases WHERE lower(subject) = 's3'`,
    );
    assert.equal(count, 0, "a refused call writes nothing");
  } finally {
    await w.close();
  }
});

test("recording a subject again in the same run replaces its facts; duplicates and bad facts are refused", async () => {
  const w = await world();
  try {
    const store = w.storeFor("alice");
    await store.putResponsibility(DEFINITION);
    const { run_id } = await store.startRun({ responsibility: DEFINITION.key, agent: AGENT_A, supersede: false });

    const first = await store.recordObservations({
      run_id,
      sources: SOURCES,
      subjects: [{ subject: "S1", facts: { "bugcrowd.state": "NEW" } }],
    });
    const retry = await store.recordObservations({
      run_id,
      subjects: [{ subject: "s1", facts: { "bugcrowd.state": "TRIAGED" } }],
    });
    assert.deepEqual(first.subjects[0].case, "new");
    assert.deepEqual(retry.subjects[0].case, "new", "a retry in the same run reads the same");

    const rows = await w.db.query<{ facts: unknown }>(`SELECT facts FROM observations WHERE run_id = $1`, [run_id]);
    assert.deepEqual(rows, [{ facts: { "bugcrowd.state": "TRIAGED" } }]);

    assert.equal(
      await refusal(
        store.recordObservations({
          run_id,
          subjects: [
            { subject: "S9", facts: {} },
            { subject: "s9", facts: {} },
          ],
        }),
      ),
      "duplicate_subject",
    );
    assert.equal(
      await refusal(store.recordObservations({ run_id, subjects: [{ subject: "S9", facts: { "Bad Key": 1 } }] })),
      "invalid_fact",
    );
  } finally {
    await w.close();
  }
});

test("the 1001st distinct subject is run_too_large, and a failed completion without decisions still succeeds", async () => {
  const w = await world();
  try {
    const store = w.storeFor("alice");
    await store.putResponsibility(DEFINITION);
    const { run_id } = await store.startRun({ responsibility: DEFINITION.key, agent: AGENT_A, supersede: false });
    await store.recordObservations({ run_id, sources: SOURCES, subjects: [] });
    for (let batch = 0; batch < RUN_LIMIT / 200; batch++) {
      await store.recordObservations({
        run_id,
        subjects: Array.from({ length: 200 }, (_, i) => ({
          subject: `S${batch * 200 + i}`,
          facts: { "bugcrowd.state": "NEW" },
        })),
      });
    }
    // Re-recording an existing subject is not a new one.
    await store.recordObservations({ run_id, subjects: [{ subject: "S0", facts: { "bugcrowd.state": "TRIAGED" } }] });
    assert.equal(
      await refusal(store.recordObservations({ run_id, subjects: [{ subject: "S-extra", facts: {} }] })),
      "run_too_large",
    );

    assert.equal(
      await refusal(store.completeRun({ run_id, outcome: "failed", decisions: [] })),
      "summary_required",
    );
    const done = await store.completeRun({
      run_id,
      outcome: "failed",
      summary: `capacity: 1001 subjects exceed ${RUN_LIMIT}`,
      decisions: [],
    });
    assert.equal(done.outcome, "failed");
    assert.equal(done.not_decided.length, RUN_LIMIT);
  } finally {
    await w.close();
  }
});

test("completion: immutability, unobserved_subject, vocabulary of the run's version, atomicity and replay", async () => {
  const w = await world();
  try {
    const store = w.storeFor("alice");
    await store.putResponsibility(DEFINITION);
    const { run_id } = await store.startRun({ responsibility: DEFINITION.key, agent: AGENT_A, supersede: false });
    await store.recordObservations({
      run_id,
      sources: SOURCES,
      subjects: [
        { subject: "S1", facts: { "bugcrowd.state": "NEW" } },
        { subject: "S2", facts: { "bugcrowd.state": "TRIAGED" } },
      ],
    });

    // The vocabulary changes mid-run: the run is still judged against its own version.
    await w.storeFor("bob").putResponsibility({
      ...DEFINITION,
      assessments: [{ label: "brand_new", attention: false }],
    });
    assert.equal(
      await refusal(
        store.completeRun({
          run_id,
          outcome: "completed",
          decisions: [{ subject: "S1", assessment: "brand_new", attention: null, basis: "b" }],
        }),
      ),
      "unknown_assessment",
    );

    assert.equal(
      await refusal(
        store.completeRun({
          run_id,
          outcome: "completed",
          decisions: [{ subject: "S7", assessment: "nothing_due", attention: null, basis: "b" }],
        }),
      ),
      "unobserved_subject",
    );

    // Atomic: a refusal on the second decision leaves the first unwritten.
    assert.equal(
      await refusal(
        store.completeRun({
          run_id,
          outcome: "completed",
          decisions: [
            { subject: "S1", assessment: "nothing_due", attention: null, basis: "b" },
            { subject: "S2", assessment: "needs_work", attention: null, basis: "b" },
          ],
        }),
      ),
      "attention_mismatch",
    );
    const [{ count: decided }] = await w.db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM decisions`,
    );
    assert.equal(decided, 0);

    const result = await store.completeRun({
      run_id,
      outcome: "completed",
      report: "# report",
      decisions: [
        {
          subject: "S1",
          assessment: "needs_work",
          attention: { action: "fix", target: "ABC-1", assignee: "Ann" },
          basis: "overdue",
          cites: ["bugcrowd.state"],
        },
      ],
    });
    assert.deepEqual(result.cases.map((one) => [one.subject, one.status, one.attention]), [["S1", "open", "opened"]]);
    assert.deepEqual(result.not_decided, ["S2"]);
    assert.deepEqual(result.not_observed, []);

    // Immutable after completion.
    assert.equal(
      await refusal(store.recordObservations({ run_id, subjects: [{ subject: "S3", facts: {} }] })),
      "run_completed",
    );

    // Replayed from `completion`: right away, after a later run, after the lifetime.
    assert.deepEqual(await store.completeRun({ run_id, outcome: "partial", decisions: [] }), {
      ...result,
      already_completed: true,
    });
    const later = await store.startRun({ responsibility: DEFINITION.key, agent: AGENT_A, supersede: false });
    await store.recordObservations({ run_id: later.run_id, sources: SOURCES, subjects: [] });
    await store.completeRun({ run_id: later.run_id, outcome: "completed", decisions: [] });
    w.advance(3 * HOUR);
    assert.deepEqual(await store.completeRun({ run_id, outcome: "completed", decisions: [] }), {
      ...result,
      already_completed: true,
    });
    assert.equal(
      await refusal(w.storeFor("bob").completeRun({ run_id, outcome: "completed", decisions: [] })),
      "run_not_yours",
      "replay is only for the member and client that completed it",
    );

    const history = await store.getCase({ responsibility: DEFINITION.key, subject: "s1", limit: 10 });
    assert.equal(history.history.length, 1);
    assert.deepEqual(history.history[0].decision, {
      assessment: "needs_work",
      attention: { action: "fix", target: "ABC-1", assignee: "Ann" },
      basis: "overdue",
      cites: ["bugcrowd.state"],
      status: "open",
      close_reason: null,
    });
    assert.equal(history.history[0].run.by, "alice@example.com");
    assert.equal(
      await refusal(store.getCase({ responsibility: DEFINITION.key, subject: "nope", limit: 10 })),
      "unknown_case",
    );
  } finally {
    await w.close();
  }
});

test("open cases are ordered attention first, oldest streak first, then by subject; facts on request", async () => {
  const w = await world();
  try {
    const store = w.storeFor("alice");
    await store.putResponsibility(DEFINITION);
    const runOnce = async (decisions: Parameters<typeof store.completeRun>[0]["decisions"], subjects: string[]) => {
      const { run_id } = await store.startRun({ responsibility: DEFINITION.key, agent: AGENT_A, supersede: false });
      await store.recordObservations({
        run_id,
        sources: SOURCES,
        subjects: subjects.map((subject) => ({ subject, facts: { "bugcrowd.state": "NEW" } })),
      });
      await store.completeRun({ run_id, outcome: "completed", decisions });
      w.advance(HOUR);
    };
    const attention = (target: string) => ({ action: "act", target });
    await runOnce([{ subject: "B", assessment: "review", attention: attention("B"), basis: "x" }], ["B"]);
    await runOnce(
      [
        { subject: "B", assessment: "review", attention: attention("B"), basis: "x" },
        { subject: "A", assessment: "verify", attention: attention("A"), basis: "x" },
        { subject: "D", assessment: "undetermined", attention: null, basis: "x" },
        { subject: "C", assessment: "undetermined", attention: null, basis: "x" },
      ],
      ["A", "B", "C", "D"],
    );

    const ctx = await store.getResponsibility(DEFINITION.key, false);
    assert.deepEqual(ctx.open_cases.map((one) => one.subject), ["B", "A", "C", "D"]);
    assert.equal(ctx.open_case_count, 4);
    assert.equal(ctx.truncated, false);
    assert.equal(ctx.open_cases[0].facts, undefined);

    const withFacts = await store.getResponsibility(DEFINITION.key, true);
    assert.deepEqual(withFacts.open_cases[0].facts, { "bugcrowd.state": "NEW" });
  } finally {
    await w.close();
  }
});

test("cases seen only by an abandoned run stay out of the baseline, counts and listings, but are kept", async () => {
  const w = await world();
  try {
    const alice = w.storeFor("alice");
    const bob = w.storeFor("bob", "client-b");
    await alice.putResponsibility(DEFINITION);

    const first = await alice.startRun({ responsibility: DEFINITION.key, agent: AGENT_A, supersede: false });
    await alice.recordObservations({
      run_id: first.run_id,
      sources: SOURCES,
      subjects: [
        { subject: "S1", facts: { "bugcrowd.state": "NEW" } },
        { subject: "S2", facts: { "bugcrowd.state": "NEW" } },
      ],
    });
    await alice.completeRun({
      run_id: first.run_id,
      outcome: "completed",
      decisions: [{ subject: "S1", assessment: "nothing_due", attention: null, basis: "b" }],
    });
    w.advance(HOUR);

    // Run 2 opens S3 and S4, then is superseded before completing.
    const second = await alice.startRun({ responsibility: DEFINITION.key, agent: AGENT_A, supersede: false });
    await alice.recordObservations({
      run_id: second.run_id,
      sources: SOURCES,
      subjects: [
        { subject: "S1", facts: { "bugcrowd.state": "TRIAGED" } },
        { subject: "S3", facts: { "bugcrowd.state": "NEW" } },
        { subject: "S4", facts: { "bugcrowd.state": "NEW" } },
      ],
    });
    const third = await bob.startRun({ responsibility: DEFINITION.key, agent: AGENT_B, supersede: true });

    // The baseline the new run starts from knows nothing of S3 or S4.
    assert.deepEqual(third.open_cases.map((c) => c.subject), ["S1", "S2"]);
    assert.equal(third.open_case_count, 2);
    const context = await alice.getResponsibility(DEFINITION.key, true);
    assert.deepEqual(context.open_cases.map((c) => c.subject), ["S1", "S2"]);
    assert.equal(context.open_case_count, 2);
    assert.deepEqual(context.open_cases[0].facts, { "bugcrowd.state": "NEW" }, "S1's facts are run 1's");
    assert.equal(
      await refusal(alice.getCase({ responsibility: DEFINITION.key, subject: "S3", limit: 10 })),
      "unknown_case",
    );

    // Nor do the missing-observation listings, and S3 reads as new when observed.
    const recorded = await bob.recordObservations({
      run_id: third.run_id,
      sources: SOURCES,
      subjects: [{ subject: "S3", facts: { "bugcrowd.state": "TRIAGED" } }],
    });
    assert.deepEqual(recorded.not_observed_so_far, ["S1", "S2"]);
    assert.equal(recorded.subjects[0].case, "new");
    assert.equal(recorded.subjects[0].previous, null);
    assert.deepEqual(recorded.subjects[0].changes.added, ["bugcrowd.state"]);

    const done = await bob.completeRun({ run_id: third.run_id, outcome: "completed", decisions: [] });
    assert.deepEqual(done.not_observed, ["S1", "S2"]);
    assert.deepEqual(done.not_decided, ["S3"]);

    // S3 is in the baseline now that a completed run observed it; S4 still is not.
    const after = await alice.getResponsibility(DEFINITION.key, false);
    assert.deepEqual(after.open_cases.map((c) => c.subject), ["S1", "S2", "S3"]);
    assert.equal(after.open_case_count, 3);
    const s3 = await alice.getCase({ responsibility: DEFINITION.key, subject: "S3", limit: 10 });
    assert.deepEqual(s3.history.map((h) => h.run.run_id), [third.run_id]);

    // The abandoned run's records are preserved.
    const [{ count }] = await w.db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM observations WHERE run_id = $1`,
      [second.run_id],
    );
    assert.equal(count, 3);
    const s4 = await w.db.query(`SELECT 1 FROM cases WHERE subject = 'S4'`);
    assert.equal(s4.length, 1);
  } finally {
    await w.close();
  }
});

test("a fact key named like an Object.prototype member diffs and carries like any other", async () => {
  const w = await world();
  try {
    const store = w.storeFor("alice");
    await store.putResponsibility(DEFINITION);
    const sources = [{ name: "meta", complete: false, covers: ["constructor"] }, ...SOURCES];

    const one = await store.startRun({ responsibility: DEFINITION.key, agent: AGENT_A, supersede: false });
    const first = await store.recordObservations({
      run_id: one.run_id,
      sources,
      subjects: [{ subject: "S1", facts: { constructor: "v1", "bugcrowd.state": "NEW" } }],
    });
    assert.deepEqual(first.subjects[0].changes.added, ["bugcrowd.state", "constructor"]);
    await store.completeRun({ run_id: one.run_id, outcome: "completed", decisions: [] });

    const two = await store.startRun({ responsibility: DEFINITION.key, agent: AGENT_A, supersede: false });
    const second = await store.recordObservations({
      run_id: two.run_id,
      sources,
      subjects: [{ subject: "S1", facts: { "bugcrowd.state": "NEW" } }],
    });
    assert.deepEqual(second.subjects[0].changes, {
      added: [],
      removed: [],
      became_unknown: ["constructor"],
      changed: [],
    });
    const [{ facts }] = await w.db.query<{ facts: Record<string, unknown> }>(
      `SELECT facts FROM observations WHERE run_id = $1`,
      [two.run_id],
    );
    assert.deepEqual(facts, { constructor: null, "bugcrowd.state": "NEW" });
  } finally {
    await w.close();
  }
});

test("two workspaces with identical keys and subjects see nothing of each other", async () => {
  const w = await world();
  try {
    const { workspaceId: otherId, members } = await seedMembers(w.db, ["zoe"], "other-co");
    const acme = w.storeFor("alice");
    const other = responsibilityStore(
      w.db,
      { workspaceId: otherId, memberId: members.zoe, clientId: "client-z", clientName: null },
      { now: w.now },
    );

    for (const store of [acme, other]) {
      await store.putResponsibility(DEFINITION);
      const { run_id } = await store.startRun({ responsibility: DEFINITION.key, agent: AGENT_A, supersede: false });
      await store.recordObservations({
        run_id,
        sources: SOURCES,
        subjects: [{ subject: "S1", facts: { "bugcrowd.state": store === acme ? "NEW" : "TRIAGED" } }],
      });
      await store.completeRun({
        run_id,
        outcome: "completed",
        decisions: [{ subject: "S1", assessment: "nothing_due", attention: null, basis: "b" }],
      });
    }

    const acmeCase = await acme.getCase({ responsibility: DEFINITION.key, subject: "S1", limit: 10 });
    const otherCase = await other.getCase({ responsibility: DEFINITION.key, subject: "S1", limit: 10 });
    assert.deepEqual(acmeCase.history.map((one) => one.facts["bugcrowd.state"]), ["NEW"]);
    assert.deepEqual(otherCase.history.map((one) => one.facts["bugcrowd.state"]), ["TRIAGED"]);
    assert.equal(acmeCase.history[0].run.by, "alice@example.com");
    assert.equal(otherCase.history[0].run.by, "zoe@example.com");

    // A run id from the other workspace is unknown here.
    const { run_id: foreign } = await other.startRun({
      responsibility: DEFINITION.key,
      agent: AGENT_A,
      supersede: false,
    });
    assert.equal(
      await refusal(acme.recordObservations({ run_id: foreign, sources: SOURCES, subjects: [] })),
      "unknown_run",
    );
    assert.equal(
      (await acme.getResponsibility(DEFINITION.key, false)).in_progress,
      null,
      "the other workspace's open run is not ours",
    );
  } finally {
    await w.close();
  }
});
