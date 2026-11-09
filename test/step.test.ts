import assert from "node:assert/strict";
import { test } from "node:test";
import { command, digest, step, view } from "../src/index.ts";
import { at, attention, caseOf, closedList, codes, definition, improve, judge, openList, opened, propose, wordsOnly } from "./helpers.ts";

test("a proposal with evidence opens a case", () => {
  const r = opened();
  const id = caseOf(173);
  const c = r.state!.cases[id]!;
  assert.deepEqual(r.rejections, []);
  assert.equal(c.status, "open");
  assert.equal(c.episode, 1);
  assert.equal(c.title, "Report 173 has no owner");
  assert.deepEqual(Object.keys(c.evidence), ["open-1"]);
  assert.equal(c.first_observed, at(2));
  assert.equal(r.transitions.length, 1);
  const [t] = r.transitions;
  assert.equal(t!.id, digest([id, 1]));
  assert.equal(t!.kind, "opened");
  assert.equal(t!.from, null);
  assert.equal(t!.actor, "judge:test");
  assert.equal(t!.title, "Report 173 has no owner");
  assert.equal(r.state_digest, digest(r.state));
});

test("whole-proposal gates, in order", () => {
  const o = [openList("open-1", 2, [173, 174, 175]), { ...openList("other-1", 2, [173]), kind: "unrelated" }];
  const r = judge(null, o, [
    { subject: { type: "ticket", keys: { report: 1 } }, status: "open", cites: ["open-1"] },
    { subject: { type: "report", keys: { report: 1, extra: 2 } }, status: "open", cites: ["open-1"] },
    propose(173, "open", ["open-1"]),
    propose(173, "open", ["open-1"], { title: "Same subject" }),
    propose(174, "open", []),
    propose(175, "open", ["other-1", "missing"]),
    propose(176, "resolved", ["open-1"]),
  ], at(2, 1));
  assert.deepEqual(codes(r).sort(), [
    "CONFLICTING_PROPOSALS", "CONFLICTING_PROPOSALS", "IDENTITY_MISMATCH", "IDENTITY_MISMATCH",
    "NO_EVIDENCE", "STATUS_NOT_ALLOWED", "UNKNOWN_EVIDENCE",
  ]);
  assert.ok(r.rejections.every((x) => x.ref.part === "proposal"));
  assert.deepEqual(r.rejections.find((x) => x.code === "UNKNOWN_EVIDENCE")!.detail.unknown, ["missing", "other-1"]);
  assert.deepEqual(r.state!.cases, {});
  assert.deepEqual(r.transitions, []);
});

test("resolving is gated by closing rules, and a rejected status keeps evidence but not text", () => {
  const first = opened();
  const still = openList("open-2", 3, [173]);
  const r = judge(first.state, [still], [propose(173, "resolved", ["open-2"], { title: "Done", summary: "Fixed" })], at(3, 1));
  assert.deepEqual(codes(r), ["CLOSING_NOT_MET"]);
  const [x] = r.rejections;
  assert.equal(x!.ref.part, "status");
  assert.equal(x!.detail.closing_check!.result, "not_met");
  assert.equal(x!.detail.proposed_title, "Done");
  assert.equal(x!.detail.proposed_summary, "Fixed");
  const c = r.state!.cases[caseOf(173)]!;
  assert.equal(c.status, "open");
  assert.equal(c.title, "Report 173 has no owner");
  assert.deepEqual(Object.keys(c.evidence).sort(), ["open-1", "open-2"]);
  assert.equal(r.transitions[0]!.kind, "updated");
  assert.equal(r.transitions[0]!.title, undefined);

  // An incomplete list cannot show absence: unknown is not met.
  const cut = openList("open-3", 4, [], false);
  assert.deepEqual(codes(judge(r.state, [cut], [propose(173, "resolved", ["open-3"])], at(4, 1))), ["CLOSING_NOT_MET"]);
});

test("closing met resolves, even without new evidence", () => {
  const gone = openList("open-2", 3, []);
  const linked = judge(opened().state, [gone], [propose(173, "open", ["open-2"])], at(3, 1));
  assert.equal(linked.transitions[0]!.kind, "updated");
  const r = judge(linked.state, [gone], [propose(173, "resolved", ["open-2"])], at(3, 2));
  assert.deepEqual(r.rejections, []);
  const [t] = r.transitions;
  assert.equal(t!.kind, "status_changed");
  assert.deepEqual(t!.added_evidence, []);
  assert.equal(t!.closing_check!.result, "met");
  assert.equal(r.state!.cases[caseOf(173)]!.episode, 2);
});

test("without closing rules, a status change needs new evidence", () => {
  const first = judge(null, [openList("open-1", 2, [173])], [propose(173, "open", ["open-1"])], at(2, 1), { d: wordsOnly });
  const again = judge(first.state, [openList("open-1", 2, [173])], [propose(173, "resolved", ["open-1"])], at(2, 2), { d: wordsOnly });
  assert.deepEqual(codes(again), ["STATUS_UNCHANGED_NO_NEW_EVIDENCE"]);
  assert.deepEqual(again.transitions, []);
  const fresh = judge(first.state, [openList("open-2", 3, [173])], [propose(173, "resolved", ["open-2"])], at(3, 1), { d: wordsOnly });
  assert.deepEqual(fresh.rejections, []);
  assert.equal(fresh.state!.cases[caseOf(173, wordsOnly)]!.status, "resolved");
});

test("reopening: refused while closing is met, needs new evidence otherwise", () => {
  const gone = openList("open-2", 3, []);
  const resolved = judge(opened().state, [gone], [propose(173, "resolved", ["open-2"])], at(3, 1));
  assert.equal(resolved.state!.cases[caseOf(173)]!.status, "resolved");

  assert.deepEqual(codes(judge(resolved.state, [gone], [propose(173, "open", ["open-2"])], at(3, 2))), ["REOPEN_WHILE_CLOSING_MET"]);

  const back = openList("open-3", 4, [173]);
  const stale = judge(resolved.state, [back, openList("open-1", 2, [173])], [propose(173, "open", ["open-1"])], at(4, 1));
  assert.deepEqual(codes(stale), ["STATUS_UNCHANGED_NO_NEW_EVIDENCE"]);

  const r = judge(resolved.state, [back], [propose(173, "open", ["open-3"])], at(4, 1));
  assert.deepEqual(r.rejections, []);
  assert.equal(r.transitions[0]!.from, "resolved");
  assert.equal(r.transitions[0]!.closing_check!.result, "not_met");
  assert.equal(r.state!.cases[caseOf(173)]!.episode, 3);
});

test("title and summary: a missing field keeps the value; the transition carries only what changed", () => {
  const first = opened();
  const o = [openList("open-1", 2, [173])];
  const same = judge(first.state, o, [propose(173, "open", ["open-1"], { title: "Report 173 has no owner" })], at(2, 2));
  assert.deepEqual(same.transitions, [], "nothing changed, nothing recorded");
  const r = judge(first.state, o, [propose(173, "open", ["open-1"], { summary: "Assigned to nobody." })], at(2, 2));
  const c = r.state!.cases[caseOf(173)]!;
  assert.equal(c.title, "Report 173 has no owner");
  assert.equal(c.summary, "Assigned to nobody.");
  assert.equal(r.transitions[0]!.summary, "Assigned to nobody.");
  assert.equal("title" in r.transitions[0]!, false);
});

test("a basis from other inputs rejects every proposal and Improvement and changes nothing", () => {
  const first = opened();
  const o = [openList("open-2", 3, [174])];
  const proposals = [propose(173, "resolved", ["open-2"]), propose(174, "open", ["open-2"], { attentions: [attention("needs_owner", "open")] })];
  const improvements = [improve("assign-on-intake", ["open-2"])];
  const basis = view(definition, first.state, o, at(3, 1)).basis;
  const evaluation = { basis, evaluator: "test", proposals, improvements };
  const reordered = { ...definition, attention_types: [...definition.attention_types!].reverse() };
  assert.equal(step(reordered, first.state, o, evaluation, at(3, 1)).rejections.length, 0, "attention_types order is not an input");
  const steps = [
    [first.state, () => step(definition, first.state, o, evaluation, at(3, 2))], // another now
    [first.state, () => step(definition, first.state, [...o, openList("open-9", 3, [])], evaluation, at(3, 1))], // more observations
    [first.state, () => step(wordsOnly, first.state, o, evaluation, at(3, 1))], // another definition
    [first.state, () => step({ ...definition, attention_types: [] }, first.state, o, evaluation, at(3, 1))], // other attention types
    [null, () => step(definition, null, o, evaluation, at(3, 1))], // another state
  ] as const;
  for (const [state, run] of steps) {
    const r = run();
    assert.deepEqual(codes(r), ["BASIS_MISMATCH", "BASIS_MISMATCH", "BASIS_MISMATCH"]);
    assert.deepEqual(r.rejections.map((x) => x.ref.part), ["proposal", "proposal", "improvement"]);
    assert.equal(r.rejections[0]!.detail.received, basis);
    assert.deepEqual([r.transitions, r.attention_events, r.deliveries, r.improvement_events], [[], [], [], []]);
    assert.deepEqual(r.state, state, "unchanged, now included");
    assert.equal(r.state_digest, digest(state));
  }
});

test("an evaluation without proposals only advances now", () => {
  const first = opened();
  const r = judge(first.state, [], [], at(5));
  assert.equal(r.state!.now, at(5));
  assert.deepEqual(r.state!.cases, first.state!.cases);
});

test("a person's command sets any status, with an actor and no gates", () => {
  const first = opened();
  const id = caseOf(173);
  const dismissed = command(definition, first.state, { actor: "person:ada", case_id: id, status: "dismissed", reason: "Duplicate of 170." }, at(2, 5));
  const [t] = dismissed.transitions;
  assert.equal(t!.actor, "person:ada");
  assert.equal(t!.reason, "Duplicate of 170.");
  assert.equal(t!.id, digest([id, 2]));
  assert.equal(dismissed.state!.cases[id]!.episode, 2);

  // The judge may reopen a dismissed case with new evidence; a person may reopen without.
  const back = judge(dismissed.state, [openList("open-2", 3, [173])], [propose(173, "open", ["open-2"])], at(3, 1));
  assert.equal(back.state!.cases[id]!.status, "open");
  const reopened = command(definition, dismissed.state, { actor: "person:ada", case_id: id, status: "open" }, at(2, 6));
  assert.equal(reopened.state!.cases[id]!.status, "open");
});

test("the judge's closing check reads every observation, not only included kinds", () => {
  const d = { ...definition, include: ["closed_reports"] };
  const first = judge(null, [closedList("closed-1", 2, [{ report: 173, resolution: "open" }])], [propose(173, "open", ["closed-1"])], at(2, 1), { d });
  const r = judge(first.state, [openList("open-2", 3, []), closedList("closed-2", 3, [])], [propose(173, "resolved", ["closed-2"])], at(3, 1), { d });
  assert.deepEqual(r.rejections, []);
  assert.deepEqual(codes(judge(first.state, [openList("open-2", 3, [])], [propose(173, "resolved", ["open-2"])], at(3, 1), { d })), ["UNKNOWN_EVIDENCE"]);
});

test("closing rules read only this step's observations: without the kind they are unknown", () => {
  const r = judge(opened().state, [closedList("closed-1", 3, [{ report: 173, resolution: "fixed" }])], [propose(173, "resolved", ["closed-1"])], at(3, 1));
  assert.deepEqual(codes(r), ["CLOSING_NOT_MET"]);
  assert.equal(r.rejections[0]!.detail.closing_check!.result, "unknown");
});
