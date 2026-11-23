import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { digest, step, view, type Check, type Definition, type Observation, type RuleTrace } from "../core.ts";
import { BUGCROWD, submission } from "./fixtures.ts";
import {
  buildRunObservations,
  caseIdOf,
  kindsReadByRules,
  newestByKind,
  openCases,
  selectLookback,
  validateDefinition,
  viewNow,
} from "./host.ts";
import { Refusal, type Row } from "./model.ts";

/** P1: the host's pure functions (docs/core-integration-plan.md §4.1, §4.2, §3.2). */

const DEF: Definition = { ...BUGCROWD, id: "def-1", version: 1 };
const T = (minute: number) => new Date(Date.UTC(2026, 10, 24, 9, minute)).toISOString();
const withDigest = (rows: Row[]) => rows.map((row) => ({ digest: digest(row), row }));

function obs(id: string, kind: string, occurred_at: string, rows: Row[] = [], complete = true): Observation {
  return { id, kind, occurred_at, subjects: [], rows, complete };
}

function refusalCode(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof Refusal, String(error));
    return error.code;
  }
  assert.fail("expected a refusal");
}

describe("P1-T1 buildRunObservations", () => {
  const rows: Row[] = [
    { submission: "91aa", state: "NEW" },
    { submission: "7f3c", state: "TRIAGED" },
    { state: "orphan" },
    { submission: 17, state: "NEW" },
    { submission: "7f3c", state: "TRIAGED" },
  ];

  test("one observation per kind: derived id, rows as a set in digest order, subjects sorted and unique", () => {
    const built = buildRunObservations(
      "run-1",
      [
        { kind: "review", complete: false, recorded_at: new Date(T(5)) },
        { kind: "bugcrowd", complete: true, recorded_at: T(4) },
      ],
      new Map([
        ["bugcrowd", withDigest(rows)],
        ["review", []],
      ]),
      DEF.identity,
      new Map(),
    );
    assert.deepEqual(built.map((o) => o.id), ["run-1:bugcrowd", "run-1:review"]);
    const [bugcrowd, review] = built;
    assert.equal(bugcrowd.occurred_at, T(4));
    assert.equal(bugcrowd.complete, true);
    assert.equal(bugcrowd.rows.length, 4, "the same row twice is one row");
    assert.deepEqual(bugcrowd.rows.map((row) => digest(row)), bugcrowd.rows.map((row) => digest(row)).sort());
    assert.deepEqual(bugcrowd.subjects, [
      { type: "bugcrowd_submission", keys: { submission: "7f3c" } },
      { type: "bugcrowd_submission", keys: { submission: "91aa" } },
      { type: "bugcrowd_submission", keys: { submission: 17 } },
    ]);
    assert.deepEqual([review.rows, review.subjects, review.complete, review.occurred_at], [[], [], false, T(5)]);

    const permuted = buildRunObservations(
      "run-1",
      [{ kind: "bugcrowd", complete: true, recorded_at: T(4) }],
      new Map([["bugcrowd", withDigest([...rows].reverse())]]),
      DEF.identity,
      new Map(),
    );
    assert.equal(digest(permuted[0]), digest(bugcrowd), "the order rows arrived in does not matter");
  });

  test("occurred_at is strictly after the newest stored observation of the kind, whatever the clock says", () => {
    const at = (recorded: string, stored: string) =>
      buildRunObservations(
        "run-2",
        [{ kind: "bugcrowd", complete: true, recorded_at: recorded }],
        new Map(),
        DEF.identity,
        new Map([["bugcrowd", { id: "run-1:bugcrowd", kind: "bugcrowd", occurred_at: stored }]]),
      )[0].occurred_at;
    assert.equal(at(T(10), T(5)), T(10), "a clock ahead of the stored one is used as it is");
    assert.equal(at(T(5), T(5)), "2026-11-24T09:05:00.001Z", "the same instant: one millisecond later");
    assert.equal(at(T(1), T(5)), "2026-11-24T09:05:00.001Z", "a clock that went back");
  });
});

describe("P1-T2 selectLookback", () => {
  // Run 1 opens a case for 7f3c on bugcrowd and review; later runs are stored too.
  const r1Bugcrowd = obs("r1:bugcrowd", "bugcrowd", T(0), [{ submission: "7f3c" }]);
  const r1Review = obs("r1:review", "review", T(0), []);
  const opened = (() => {
    const all = [r1Bugcrowd, r1Review];
    const v = view(DEF, null, all, T(1));
    return step(DEF, null, all, {
      basis: v.basis,
      evaluator: "test",
      proposals: [{ subject: submission("7f3c"), status: "open", cites: ["r1:bugcrowd", "r1:review"] }],
    }, T(1)).state!;
  })();
  // Two stored bugcrowd observations at the same instant: the core takes the larger id.
  const r2Bugcrowd = obs("r2:bugcrowd", "bugcrowd", T(2), [{ submission: "7f3c" }], false);
  const r3Bugcrowd = obs("r3:bugcrowd", "bugcrowd", T(2), []);
  const stored = [r1Bugcrowd, r1Review, r2Bugcrowd, r3Bugcrowd];
  // This run recorded only implement and recently_closed; bugcrowd and review are missing.
  const run = [obs("r9:implement", "implement", T(9)), obs("r9:recently_closed", "recently_closed", T(9))];

  test("(a) the run, (b) what open cases rest on, (c) the newest of each kind over run and stored", () => {
    const newestStored = [...newestByKind(stored).values()];
    assert.deepEqual(newestStored.map((o) => o.id).sort(), ["r1:review", "r3:bugcrowd"], "ties go to the larger id");
    const selected = selectLookback(opened, DEF, run, [r1Bugcrowd, r1Review], newestStored);
    assert.deepEqual(selected, ["r1:bugcrowd", "r1:review", "r3:bugcrowd", "r9:implement", "r9:recently_closed"]);

    // Without an open case, (b) adds nothing.
    assert.deepEqual(selectLookback(null, DEF, run, [], newestStored), [
      "r1:review",
      "r3:bugcrowd",
      "r9:implement",
      "r9:recently_closed",
    ]);
    // A stored observation newer than the run's own is still the one chosen.
    const late = obs("r8:implement", "implement", T(30));
    assert.ok(selectLookback(null, DEF, run, [], [...newestStored, late]).includes("r8:implement"));
  });

  test("the observation a closing rule reads in step is the one the host chose", () => {
    const byId = new Map([...stored, ...run].map((o) => [o.id, o]));
    const selected = selectLookback(opened, DEF, run, [r1Bugcrowd, r1Review], [...newestByKind(stored).values()]);
    const observations = selected.map((id) => byId.get(id)!);
    const now = viewNow(new Date(T(0)), opened, observations);
    assert.equal(now, T(9), "never before the observations or state.now");
    const v = view(DEF, opened, observations, now);
    const r = step(DEF, opened, observations, {
      basis: v.basis,
      evaluator: "test",
      proposals: [{ subject: submission("7f3c"), status: "resolved", cites: ["r9:implement"] }],
    }, now);

    const check: Check | undefined =
      r.transitions[0]?.closing_check ?? r.rejections.find((x) => x.code === "CLOSING_NOT_MET")?.detail.closing_check;
    assert.ok(check, JSON.stringify(r));
    const traces: RuleTrace[] = check.criteria.flatMap((c) => c.routes.flatMap((route) => route.rules));
    const chosen = newestByKind(observations);
    for (const trace of traces) assert.equal(trace.observation, chosen.get(trace.kind)?.id, trace.kind);
    assert.equal(traces.find((t) => t.kind === "bugcrowd")?.observation, "r3:bugcrowd");
    assert.equal(r.transitions[0]?.to, "resolved", "r3 lists no 7f3c, so the closing criteria are met");
  });
});

describe("P1-T3 validateDefinition", () => {
  const now = new Date(T(0));

  test("a valid definition gets its id and version", () => {
    assert.deepEqual(validateDefinition(BUGCROWD, "def-1", 3, now), { ...BUGCROWD, id: "def-1", version: 3 });
  });

  test("the core's own checks refuse an invalid match and a repeated Attention type", () => {
    const badMatch = {
      ...BUGCROWD,
      closing: [{ description: "x", rules: [{ kind: "bugcrowd", match: { submission: "ticket" } }] }],
    };
    assert.equal(refusalCode(() => validateDefinition(badMatch, "d", 1, now)), "invalid_definition");
    const twice = { ...BUGCROWD, attention_types: [...BUGCROWD.attention_types!, BUGCROWD.attention_types![0]] };
    assert.equal(refusalCode(() => validateDefinition(twice, "d", 1, now)), "invalid_definition");
    const twoAbsentRoutes = {
      ...BUGCROWD,
      closing: [{ description: "x", any_of: [{ rules: [BUGCROWD.closing[0].rules![0]] }, { rules: [BUGCROWD.closing[0].rules![1]] }] }],
    };
    assert.equal(refusalCode(() => validateDefinition(twoAbsentRoutes, "d", 1, now)), "invalid_definition");
  });

  test("routed Attention types and success criteria are refused in v1", () => {
    const routed = { ...BUGCROWD, attention_types: [{ key: "x", description: "x", delivery: { route: "#sec" } }] };
    assert.equal(refusalCode(() => validateDefinition(routed, "d", 1, now)), "delivery_unsupported");
    const success = { ...BUGCROWD, success: [{ description: "x", rules: [{ kind: "bugcrowd", match: { submission: "submission" } }] }] };
    assert.equal(refusalCode(() => validateDefinition(success, "d", 1, now)), "success_unsupported");
  });
});

test("rule kinds, case ids and the order of open cases", () => {
  assert.deepEqual(kindsReadByRules(DEF), ["bugcrowd", "implement", "recently_closed", "review"]);
  assert.equal(
    caseIdOf("def-1", submission("7f3c")),
    digest({ definition_id: "def-1", subject_type: "bugcrowd_submission", keys: { submission: "7f3c" } }),
  );

  const c = (keys: string, attentions: Record<string, string>, status = "open") => ({
    subject: submission(keys),
    status,
    episode: 1,
    seq: 1,
    version: 1,
    title: null,
    summary: null,
    evidence: {},
    first_observed: T(0),
    last_observed: T(0),
    attentions: Object.fromEntries(
      Object.entries(attentions).map(([type, at]) => [
        type,
        { status: at === "closed" ? "closed" : "open", activation: 1, opened_at: at === "closed" ? T(0) : at, closed_at: null },
      ]),
    ),
  });
  const state = {
    spec: "responsibility-core/1",
    definition_id: "def-1",
    identity_digest: "x",
    now: T(9),
    improvements: {},
    cases: {
      a: c("b", {}),
      b: c("a", {}),
      c: c("z", { review: T(5) }),
      d: c("y", { needs_work: T(7), review: T(3) }),
      e: c("x", { verify: "closed" }),
      f: c("w", { review: T(1) }, "resolved"),
    },
  } as unknown as Parameters<typeof openCases>[0];
  const listed = openCases(state);
  assert.deepEqual(listed.cases.map((one) => one.subject.keys.submission), ["y", "z", "a", "b", "x"]);
  assert.deepEqual(listed.cases[0].attentions.map((a) => a.type), ["needs_work", "review"]);
  assert.equal(listed.open_case_count, 5);
  assert.equal(listed.truncated, false);
});
