import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_A, AGENT_B, DEFINITION, SOURCES, world, type World } from "./fixtures.ts";
import type { Source } from "./model.ts";
import type { ObservedSubject } from "./store.ts";

/**
 * Store-level two-run scenario (plan §11): run 1 by agent A (alice, client-a);
 * run 2 by a different member and client (bob, client-b, agent B) whose only
 * memory is the service. Two variants, as in §12.A: every source complete in
 * run 2 (A1), and the Implement search incomplete in run 2 (A2). Both
 * `implement` and `recently_closed` cover the `ticket` group, so an incomplete
 * Implement search makes every absent `ticket.*` key unknown rather than removed.
 */

const HOUR = 60 * 60 * 1000;

const ticket = (key: string, search: string, status: string, extra: Record<string, unknown> = {}) => ({
  [`ticket.${key}.search`]: search,
  [`ticket.${key}.status`]: status,
  [`ticket.${key}.type`]: "Bug",
  [`ticket.${key}.assignee`]: "Ann",
  [`ticket.${key}.created`]: "2026-10-01",
  [`ticket.${key}.category_since`]: "2026-10-02",
  [`ticket.${key}.fix_versions`]: [],
  [`ticket.${key}.reports`]: [`FIND-${key.split("-")[1]}:Accepted`],
  ...extra,
});

const READ1: Record<string, Record<string, unknown>> = {
  S100: { "bugcrowd.state": "TRIAGED", "bugcrowd.priority": 2, ...ticket("ABC-1", "implement", "In Progress") },
  S200: { "bugcrowd.state": "TRIAGED", ...ticket("ABC-2", "implement", "Open") },
  S300: { "bugcrowd.state": "TRIAGED", ...ticket("ABC-3", "implement", "Open") },
  S310: { "bugcrowd.state": "TRIAGED", ...ticket("ABC-31", "implement", "Open") },
  S320: { "bugcrowd.state": "TRIAGED", ...ticket("ABC-32", "implement", "Open") },
  S330: { "bugcrowd.state": "TRIAGED", ...ticket("ABC-33", "implement", "Open") },
  S400: { "bugcrowd.state": "UNRESOLVED", ...ticket("ABC-4", "implement", "In Progress") },
  S500: { "bugcrowd.state": "not_active", "review.FIND-5.status": "Review" },
  S700: { "bugcrowd.state": "NEW", "review.FIND-7.status": "Review" },
};

const attention = (target: string, action = "move it on") => ({ action, target });

/** Run 1 by alice/client-a, all sources complete. Returns its run id and the clock at decision time. */
async function runOne(w: World) {
  const store = w.storeFor("alice", "client-a");
  await store.putResponsibility(DEFINITION);
  const { run_id } = await store.startRun({ responsibility: DEFINITION.key, agent: AGENT_A, supersede: false });
  await store.recordObservations({
    run_id,
    sources: SOURCES,
    subjects: Object.entries(READ1).map(([subject, facts]) => ({ subject, facts })),
  });
  const decidedAt = w.now().toISOString();
  await store.completeRun({
    run_id,
    outcome: "completed",
    report: "run 1 report",
    decisions: [
      { subject: "S100", assessment: "needs_work", attention: attention("ABC-1", "nudge Ann"), basis: "overdue" },
      { subject: "S200", assessment: "needs_work", attention: attention("ABC-2"), basis: "open too long" },
      { subject: "S300", assessment: "nothing_due", attention: null, basis: "on track" },
      { subject: "S310", assessment: "nothing_due", attention: null, basis: "on track" },
      { subject: "S320", assessment: "nothing_due", attention: null, basis: "on track" },
      { subject: "S330", assessment: "nothing_due", attention: null, basis: "on track" },
      { subject: "S400", assessment: "verify", attention: attention("ABC-4"), basis: "fixed, unverified" },
      { subject: "S500", assessment: "nothing_due", attention: null, basis: "not active" },
      { subject: "S700", assessment: "review", attention: attention("FIND-7"), basis: "in Review" },
    ],
  });
  w.advance(24 * HOUR);
  return { run_id, decidedAt };
}

function bySubject(subjects: ObservedSubject[]) {
  return Object.fromEntries(subjects.map((one) => [one.subject, one]));
}

test("A1: run 2 by another member and client, every source complete", async () => {
  const w = await world();
  try {
    const one = await runOne(w);
    const store = w.storeFor("bob", "client-b");

    const start = await store.startRun({ responsibility: DEFINITION.key, agent: AGENT_B, supersede: false });
    assert.equal(start.last_run?.run_id, one.run_id);
    assert.equal(start.last_run?.by, "alice@example.com");
    assert.equal(start.last_run?.client_name, "name of client-a");
    assert.deepEqual(start.last_run?.agent, AGENT_A);
    assert.equal(start.last_run?.outcome, "completed");
    assert.equal(start.expectation_changed_since_last_run, false);
    assert.deepEqual(
      start.open_cases.slice(0, 4).map((c) => c.subject),
      ["S100", "S200", "S400", "S700"],
      "attention first (all opened by run 1 at one instant), then by subject",
    );
    assert.deepEqual(start.open_cases.find((c) => c.subject === "S100")?.facts, {
      ...READ1.S100,
      "ticket.ABC-1.fix_versions": [],
      "ticket.ABC-1.reports": ["FIND-1:Accepted"],
    });

    const read2: Record<string, Record<string, unknown>> = {
      S100: READ1.S100,
      S200: { ...READ1.S200, "ticket.ABC-2.status": "In Review" },
      S300: { ...READ1.S300, "ticket.ABC-3.category_since": null },
      S310: { ...READ1.S310, "ticket.ABC-31.reports": null },
      S320: { ...READ1.S320, "ticket.ABC-32.reports": [] },
      S330: { ...READ1.S330, "ticket.ABC-33.reports": ["FIND-1:?"] },
      S400: { "bugcrowd.state": "UNRESOLVED" },
      S500: { "bugcrowd.state": "not_active" },
      S600: { "bugcrowd.state": "NEW" },
      S700: { "bugcrowd.state": "NEW" },
    };
    const recorded = await store.recordObservations({
      run_id: start.run_id,
      sources: SOURCES,
      subjects: Object.entries(read2).map(([subject, facts]) => ({ subject, facts })),
    });
    const seen = bySubject(recorded.subjects);

    assert.deepEqual(seen.S100.changes, { added: [], removed: [], became_unknown: [], changed: [] });
    assert.equal(seen.S100.previous?.run_id, one.run_id);
    assert.deepEqual(seen.S100.previous?.agent, AGENT_A);
    assert.equal(seen.S100.case, "existing");

    assert.deepEqual(seen.S200.changes.changed, [{ key: "ticket.ABC-2.status", from: "Open", to: "In Review" }]);
    assert.deepEqual(seen.S300.changes.became_unknown, ["ticket.ABC-3.category_since"]);
    assert.deepEqual(seen.S310.changes.became_unknown, ["ticket.ABC-31.reports"], "omitted issuelinks: unknown");
    assert.deepEqual(seen.S310.changes.removed, [], "and never read as removed links");
    assert.deepEqual(seen.S320.changes.changed, [
      { key: "ticket.ABC-32.reports", from: ["FIND-32:Accepted"], to: [] },
    ]);
    assert.deepEqual(seen.S330.changes.changed, [
      { key: "ticket.ABC-33.reports", from: ["FIND-33:Accepted"], to: ["FIND-1:?"] },
    ]);
    assert.equal(seen.S400.changes.removed.length, 8, "a ticket removed under complete sources");
    assert.ok(seen.S400.changes.removed.every((key) => key.startsWith("ticket.ABC-4.")));
    assert.deepEqual(seen.S500.changes.removed, ["review.FIND-5.status"], "a finding that left Review");
    assert.equal(seen.S600.case, "new");
    assert.equal(seen.S600.previous, null);
    assert.deepEqual(recorded.not_observed_so_far, []);

    const done = await store.completeRun({
      run_id: start.run_id,
      outcome: "completed",
      decisions: [
        { subject: "S100", assessment: "needs_work", attention: attention("ABC-1", "chase Ann"), basis: "overdue" },
        { subject: "S200", assessment: "review", attention: attention("ABC-2"), basis: "now In Review" },
        { subject: "S300", assessment: "nothing_due", attention: null, basis: "on track" },
        { subject: "S400", assessment: "verify", attention: attention("ABC-4-new"), basis: "ticket gone" },
        {
          subject: "S500",
          assessment: "nothing_due",
          attention: null,
          basis: "in no source; last nothing_due",
          close: { reason: "in no source, Bugcrowd list complete" },
        },
        { subject: "S600", assessment: "review", attention: attention("submission:S600"), basis: "new" },
        { subject: "S700", assessment: "undetermined", attention: null, basis: "last review; in no current source" },
      ],
    });
    const cases = Object.fromEntries(done.cases.map((c) => [c.subject, c]));
    assert.deepEqual([cases.S100.attention, cases.S100.attention_since], ["continued", one.decidedAt]);
    assert.deepEqual([cases.S200.attention, cases.S200.attention_since], ["opened", w.now().toISOString()]);
    assert.equal(cases.S400.attention, "opened", "a different target is a new streak");
    assert.deepEqual([cases.S500.status, cases.S500.attention], ["closed", "none"]);
    assert.deepEqual([cases.S600.status, cases.S600.attention], ["open", "opened"]);
    assert.deepEqual([cases.S700.status, cases.S700.attention, cases.S700.attention_since], ["open", "ended", null]);
    assert.deepEqual(done.not_decided, ["S310", "S320", "S330"]);

    const after = await store.getResponsibility(DEFINITION.key, false);
    assert.equal(after.last_run?.run_id, start.run_id);
    assert.equal(after.last_run?.by, "bob@example.com");
    assert.equal(after.open_cases[0].subject, "S100", "the oldest attention streak leads");
    assert.equal(after.open_cases.some((c) => c.subject === "S500"), false, "closed cases are not open");

    for (const subject of ["S100", "S200"]) {
      const history = await store.getCase({ responsibility: DEFINITION.key, subject, limit: 10 });
      assert.deepEqual(
        history.history.map((h) => [h.run.agent.name, h.run.client_name, h.run.by]),
        [
          ["codex", "name of client-b", "bob@example.com"],
          ["claude-code", "name of client-a", "alice@example.com"],
        ],
      );
    }
  } finally {
    await w.close();
  }
});

test("A2: the Implement search is incomplete in run 2 — ticket keys become unknown, not removed", async () => {
  const w = await world();
  try {
    await runOne(w);
    const store = w.storeFor("bob", "client-b");
    const start = await store.startRun({ responsibility: DEFINITION.key, agent: AGENT_B, supersede: false });

    const incomplete: Source[] = SOURCES.map((source) =>
      source.name === "implement" ? { ...source, complete: false, note: "search failed after page 1" } : source,
    );
    const recorded = await store.recordObservations({
      run_id: start.run_id,
      sources: incomplete,
      subjects: [
        { subject: "S400", facts: { "bugcrowd.state": "UNRESOLVED" } },
        { subject: "S500", facts: { "bugcrowd.state": "not_active" } },
      ],
    });
    const seen = bySubject(recorded.subjects);

    assert.equal(seen.S400.changes.removed.length, 0);
    assert.equal(seen.S400.changes.became_unknown.length, 8);
    assert.deepEqual(seen.S500.changes.removed, ["review.FIND-5.status"], "Review was still read completely");

    const [{ facts }] = await w.db.query<{ facts: Record<string, unknown> }>(
      `SELECT o.facts FROM observations o JOIN cases c ON c.id = o.case_id
        WHERE o.run_id = $1 AND c.subject = 'S400'`,
      [start.run_id],
    );
    assert.equal(facts["ticket.ABC-4.status"], null, "carried as unknown");
    assert.ok(recorded.not_observed_so_far.includes("S100"), "open cases not yet observed are listed");

    const done = await store.completeRun({
      run_id: start.run_id,
      outcome: "partial",
      summary: "implement search incomplete",
      decisions: [
        { subject: "S400", assessment: "undetermined", attention: null, basis: "ticket evidence unknown" },
        { subject: "S500", assessment: "undetermined", attention: null, basis: "a source is incomplete" },
      ],
    });
    assert.equal(done.outcome, "partial");
    assert.ok(done.cases.every((c) => c.status === "open"), "no case closed in this run");
    assert.ok(done.not_observed.includes("S100"));
    const after = await store.getResponsibility(DEFINITION.key, false);
    assert.equal(after.last_run?.outcome, "partial");
    assert.equal(after.last_run?.summary, "implement search incomplete");
  } finally {
    await w.close();
  }
});
