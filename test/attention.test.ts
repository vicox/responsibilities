// Attentions: which entries are taken, in which order they are checked, and what an
// opening records and delivers. The last test is recorded as fixtures/attention.json.
import assert from "node:assert/strict";
import { test } from "node:test";
import { digest } from "../src/index.ts";
import type { Definition, Proposal, State } from "../src/index.ts";
import { matchFixture } from "./fixture.ts";
import { at, attention, caseOf, codes, definition, judge, openList, opened, propose } from "./helpers.ts";
import { calls, command, step, view } from "./recorder.ts";

const id = caseOf(173);
const withAttention = (type: string, intent: "open" | "keep" | "close", cites = ["open-1"], status: "open" | "resolved" = "open", reason = "Because."): Proposal =>
  propose(173, status, cites, { attentions: [attention(type, intent, reason)] });
/** Case 173, open, with `needs_owner` open (activation 1). */
const owned = () => judge(null, [openList("open-1", 2, [173])], [withAttention("needs_owner", "open")], at(2, 1));
/** The same, then resolved on day 3: the report is no longer listed. */
function resolved(): State {
  const gone = openList("open-2", 3, []);
  const r = judge(owned().state, [gone], [propose(173, "resolved", ["open-2"])], at(3, 1));
  assert.equal(r.state!.cases[id]!.status, "resolved");
  return r.state!;
}

test("an opening passes its when check, records the trace, and is delivered once", () => {
  const r = owned();
  assert.deepEqual(r.rejections, []);
  assert.deepEqual(r.state!.cases[id]!.attentions, { needs_owner: { status: "open", activation: 1, opened_at: at(2, 1), closed_at: null } });
  const [e] = r.attention_events;
  assert.equal(r.attention_events.length, 1);
  assert.deepEqual([e!.id, e!.case_id, e!.type, e!.event, e!.activation, e!.actor, e!.reason], [digest([id, "needs_owner", 1, "opened"]), id, "needs_owner", "opened", 1, "judge:test", "Because."]);
  assert.equal(e!.gate_check!.result, "met");
  assert.deepEqual(e!.gate_check!.criteria[0]!.routes[0]!.rules.map((x) => [x.kind, x.observation, x.result]), [["open_reports", "open-1", "met"]]);
  assert.deepEqual(r.deliveries, [{
    id: digest([id, "needs_owner", 1]), case_id: id, subject: { type: "report", keys: { report: 173 } }, type: "needs_owner", activation: 1,
    route: "security-oncall", reason: "Because.", event_id: e!.id,
  }]);
  assert.equal(r.transitions.length, 1, "the case transition is separate from the Attention event");
});

test("checks in order: repeated, no reason, not declared, then for an actual opening the case and the when rules", () => {
  const o = [openList("open-1", 2, [173])];
  const r = judge(null, o, [propose(173, "open", ["open-1"], {
    attentions: [
      attention("review", "open", " "), attention("review", "close"), // repeated wins over the blank reason
      attention("needs_owner", "open", "  "),
      attention("escalate", "open"), attention("archive", "keep"), attention("legal", "close"),
    ],
  })], at(2, 1));
  assert.deepEqual(r.rejections.map((x) => [x.ref.part, (x.ref as { key: string }).key, x.code]), [
    ["attention", "archive", "ATTENTION_NOT_DECLARED"], ["attention", "escalate", "ATTENTION_NOT_DECLARED"],
    ["attention", "legal", "ATTENTION_NOT_DECLARED"], ["attention", "needs_owner", "ATTENTION_NO_REASON"],
    ["attention", "review", "ATTENTION_REPEATED"], ["attention", "review", "ATTENTION_REPEATED"],
  ]);
  assert.deepEqual(r.attention_events, []);
  assert.equal(r.transitions[0]!.kind, "opened", "refused entries do not undo the case");

  // On a resolved case an actual reopening is refused for the case before its rules are
  // read: here they would be unknown (no row lists 173), and the refusal names the case.
  const o3 = [openList("open-3", 4, [174])];
  const closed = judge(resolved(), o3, [withAttention("needs_owner", "close", ["open-3"], "resolved")], at(4, 1));
  const back = judge(closed.state, o3, [withAttention("needs_owner", "open", ["open-3"], "resolved")], at(4, 2));
  assert.deepEqual(codes(back), ["ATTENTION_CASE_NOT_OPEN"]);
  assert.equal(back.rejections[0]!.detail.gate_check, undefined);
  const first = judge(resolved(), o3, [withAttention("review", "open", ["open-3"], "resolved")], at(4, 1));
  assert.deepEqual(codes(first), ["ATTENTION_CASE_NOT_OPEN"], "and an actual first opening");
});

test("the when check answers met, not_met and unknown on open cases", () => {
  const state = opened().state;
  const assigned = judge(state, [openList("open-2", 3, [173], true, "assigned")], [withAttention("needs_owner", "open", ["open-2"])], at(3, 1));
  assert.deepEqual(codes(assigned), ["ATTENTION_GATE_NOT_MET"]);
  assert.equal(assigned.rejections[0]!.detail.gate_check!.result, "not_met");
  assert.equal(assigned.state!.cases[id]!.status, "open");

  const unlisted = judge(state, [openList("open-2", 3, [174])], [withAttention("needs_owner", "open", ["open-2"])], at(3, 1));
  assert.deepEqual(codes(unlisted), ["ATTENTION_GATE_NOT_MET"]);
  assert.equal(unlisted.rejections[0]!.detail.gate_check!.result, "unknown");
  assert.match(unlisted.rejections[0]!.detail.message, /are unknown/);

  const cut = judge(state, [openList("open-2", 3, [173], false, "assigned")], [withAttention("needs_owner", "open", ["open-2"])], at(3, 1));
  assert.equal(cut.rejections[0]!.detail.gate_check!.result, "unknown", "a cut list may hide the row that holds");

  const met = judge(state, [openList("open-2", 3, [173])], [withAttention("needs_owner", "open", ["open-2"])], at(3, 1));
  assert.deepEqual(met.rejections, []);
  assert.equal(met.attention_events[0]!.gate_check!.result, "met");
  assert.deepEqual(met.attention_events.map((e) => e.event), ["opened"]);
});

test("a type without when opens without a check; a type without a route is not delivered", () => {
  const r = judge(opened().state, [openList("open-1", 2, [173])], [withAttention("review", "open")], at(2, 2));
  assert.deepEqual(r.rejections, []);
  assert.deepEqual(r.attention_events.map((e) => [e.type, e.event, e.gate_check]), [["review", "opened", undefined]]);
  assert.deepEqual(r.deliveries, []);
});

test("close and keep never check the case or the when rules", () => {
  const notMet = [openList("open-2", 3, [173], true, "assigned")];
  const unknown = [openList("open-2", 3, [174])];
  for (const o of [notMet, unknown]) {
    const closed = judge(owned().state, o, [withAttention("needs_owner", "close", ["open-2"])], at(3, 1));
    assert.deepEqual(closed.rejections, []);
    assert.deepEqual(closed.attention_events.map((e) => [e.event, e.activation, e.gate_check]), [["closed", 1, undefined]]);
    assert.deepEqual(closed.state!.cases[id]!.attentions.needs_owner, { status: "closed", activation: 1, opened_at: at(2, 1), closed_at: at(3, 1) });
    assert.deepEqual(closed.deliveries, []);

    const kept = judge(owned().state, o, [withAttention("needs_owner", "keep", ["open-2"])], at(3, 1));
    assert.deepEqual([kept.rejections, kept.attention_events, kept.deliveries], [[], [], []]);
    assert.deepEqual(kept.state!.cases[id]!.attentions, owned().state!.cases[id]!.attentions);
  }

  // On a resolved case, with the rules unknown: close still closes, keep still does nothing.
  const state = resolved();
  const closed = judge(state, [openList("open-3", 4, [])], [withAttention("needs_owner", "close", ["open-3"], "resolved")], at(4, 1));
  assert.deepEqual(closed.rejections, []);
  assert.deepEqual(closed.attention_events.map((e) => e.event), ["closed"]);
  const kept = judge(state, [openList("open-3", 4, [])], [withAttention("needs_owner", "keep", ["open-3"], "resolved")], at(4, 1));
  assert.deepEqual([kept.rejections, kept.attention_events], [[], []]);

  // Closing one that is not open does nothing.
  const twice = judge(closed.state, [openList("open-3", 4, [])], [withAttention("needs_owner", "close", ["open-3"], "resolved")], at(4, 2));
  assert.deepEqual([twice.rejections, twice.attention_events], [[], []]);
  const never = judge(opened().state, [openList("open-1", 2, [173])], [withAttention("review", "close")], at(2, 2));
  assert.deepEqual([never.rejections, never.attention_events], [[], []]);
});

test("open on an Attention that is already open does nothing, even with its rules not_met on a resolved case", () => {
  const state = resolved();
  const r = judge(state, [openList("open-3", 4, [174], true, "assigned")], [withAttention("needs_owner", "open", ["open-3"], "resolved")], at(4, 1));
  assert.deepEqual([r.rejections, r.attention_events, r.deliveries], [[], [], []]);
  assert.equal(r.state!.cases[id]!.attentions.needs_owner!.activation, 1);

  // Re-applying the opening evaluation emits nothing twice.
  const first = owned();
  const again = judge(first.state, [openList("open-1", 2, [173])], [withAttention("needs_owner", "open")], at(2, 2));
  assert.deepEqual([again.transitions, again.attention_events, again.deliveries, again.rejections], [[], [], [], []]);
});

test("a reopening gets a new activation and a new delivery id", () => {
  const closed = judge(owned().state, [openList("open-2", 3, [173])], [withAttention("needs_owner", "close", ["open-2"])], at(3, 1));
  const r = judge(closed.state, [openList("open-3", 4, [173])], [withAttention("needs_owner", "open", ["open-3"])], at(4, 1));
  assert.deepEqual(r.rejections, []);
  const [e] = r.attention_events;
  assert.deepEqual([e!.event, e!.activation, e!.id], ["reopened", 2, digest([id, "needs_owner", 2, "reopened"])]);
  assert.equal(r.deliveries[0]!.id, digest([id, "needs_owner", 2]));
  assert.notEqual(r.deliveries[0]!.id, owned().deliveries[0]!.id);
  assert.deepEqual(r.state!.cases[id]!.attentions.needs_owner, { status: "open", activation: 2, opened_at: at(4, 1), closed_at: null });
});

test("a type no longer declared may still be closed, but not opened or kept", () => {
  const first = judge(opened().state, [openList("open-1", 2, [173])], [withAttention("review", "open")], at(2, 2));
  const v2: Definition = { ...definition, version: 2, attention_types: definition.attention_types!.filter((t) => t.key !== "review") };
  const kept = judge(first.state, [openList("open-1", 2, [173])], [withAttention("review", "keep")], at(2, 3), { d: v2 });
  assert.deepEqual(codes(kept), ["ATTENTION_NOT_DECLARED"]);
  const r = judge(first.state, [openList("open-1", 2, [173])], [withAttention("review", "close")], at(2, 3), { d: v2 });
  assert.deepEqual(r.rejections, []);
  assert.deepEqual(r.attention_events.map((e) => [e.event, e.version]), [["closed", 2]]);
  const reopen = judge(r.state, [openList("open-1", 2, [173])], [withAttention("review", "open")], at(2, 4), { d: v2 });
  assert.deepEqual(codes(reopen), ["ATTENTION_NOT_DECLARED"]);
});

test("a proposal rejected as a whole carries its Attention entries with it", () => {
  const r = judge(null, [openList("open-1", 2, [173])], [propose(173, "open", [], { attentions: [attention("needs_owner", "open"), attention("x", "open", "")] })], at(2, 1));
  assert.deepEqual(codes(r), ["NO_EVIDENCE"]);
  assert.deepEqual([r.attention_events, r.deliveries], [[], []]);
});

test("Attention names that are Object.prototype members are plain data", () => {
  const d: Definition = { ...definition, attention_types: [{ key: "__proto__", description: "Odd." }, { key: "constructor", description: "Odd." }] };
  const r = judge(null, [openList("open-1", 2, [173])], [propose(173, "open", ["open-1"], { attentions: [attention("__proto__", "open"), attention("constructor", "open")] })], at(2, 1), { d });
  assert.deepEqual(r.rejections, []);
  const stored = JSON.parse(JSON.stringify(r.state)) as State;
  assert.deepEqual(Object.keys(stored.cases[id]!.attentions).sort(), ["__proto__", "constructor"]);
  const closed = judge(stored, [openList("open-1", 2, [173])], [propose(173, "open", ["open-1"], { attentions: [attention("__proto__", "close")] })], at(2, 2), { d });
  assert.deepEqual(closed.attention_events.map((e) => [e.type, e.event]), [["__proto__", "closed"]]);
});

test("one Attention across a case's life; recorded as fixtures/attention.json", () => {
  function turn(state: State | null, observations: ReturnType<typeof openList>[], proposal: Proposal, now: string) {
    const v = view(definition, state, observations, now);
    return step(definition, state, observations, { basis: v.basis, evaluator: "llm-triage", proposals: [proposal] }, now);
  }
  const r1 = turn(null, [openList("open-1", 2, [173])], withAttention("needs_owner", "open", ["open-1"], "open", "Nobody owns report 173."), at(2, 1));
  assert.deepEqual(r1.deliveries.map((x) => [x.route, x.activation]), [["security-oncall", 1]]);

  const r2 = turn(r1.state, [openList("open-2", 3, [173], true, "assigned")], withAttention("needs_owner", "close", ["open-2"], "open", "Ada owns it now."), at(3, 1));
  assert.deepEqual(r2.attention_events.map((e) => e.event), ["closed"]);

  const r3 = turn(r2.state, [openList("open-3", 4, [])], propose(173, "resolved", ["open-3"]), at(4, 1));
  assert.equal(r3.state!.cases[id]!.status, "resolved");

  const early = judge(r3.state, [openList("open-4", 5, [173])], [withAttention("needs_owner", "open", ["open-4"], "resolved", "Back without an owner.")], at(5, 1));
  assert.deepEqual(codes(early), ["ATTENTION_CASE_NOT_OPEN"], "not recorded: the fixture threads one state line");

  const r4 = turn(r3.state, [openList("open-4", 5, [173])], withAttention("needs_owner", "open", ["open-4"], "open", "Back without an owner."), at(5, 1));
  assert.deepEqual(r4.attention_events.map((e) => [e.event, e.activation]), [["reopened", 2]]);
  assert.deepEqual(r4.deliveries.map((x) => [x.route, x.activation]), [["security-oncall", 2]]);

  const r5 = command(definition, r4.state, { actor: "person:ada", case_id: id, status: "dismissed", reason: "Duplicate of report 170." }, at(5, 2));
  assert.deepEqual([r5.transitions[0]!.actor, r5.state!.cases[id]!.episode, r5.state!.cases[id]!.attentions.needs_owner!.status], ["person:ada", 4, "open"]);

  matchFixture("attention.json", calls);
});
