// What a case carries into the next run: its current record (status, evidence, when that
// evidence was observed, open Attentions) and its earlier assessments (title, summary). Earlier
// assessments are history, not truth: they reach the judge, but no rule or gate uses them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { view } from "../src/index.ts";
import type { Observation, Proposal, State, StepResult } from "../src/index.ts";
import { conform } from "../src/validate.ts";
import { at, attention, caseOf, codes, definition, judge, openList, propose, subject } from "./helpers.ts";

const id = caseOf(173);
const assessed = { title: "Report 173 has no owner", summary: "Nobody owns report 173 yet." };

test("the view carries the record and the earlier assessments", () => {
  const first = judge(null, [openList("open-9", 2, [173])], [propose(173, "open", ["open-9"], assessed)], at(2, 1));
  const v = view(definition, first.state, [openList("open-10", 3, [173])], at(3, 1));
  conform(v, "view", "view");
  assert.deepEqual(v.cases, [{
    case_id: id, subject: subject(173), status: "open", episode: 1, ...assessed,
    evidence: ["open-9"], first_observed: at(2), last_observed: at(2), attentions: [],
  }]);

  // A case nobody summarised or titled shows null.
  const bare = judge(null, [openList("open-9", 2, [173])], [propose(173, "open", ["open-9"])], at(2, 1));
  const plain = view(definition, bare.state, [], at(2, 2)).cases[0]!;
  assert.deepEqual([plain.title, plain.summary], [null, null]);

  // A later run cites open-10: evidence in code-unit order, the reverse of insertion order.
  const second = judge(first.state, [openList("open-10", 3, [173])], [propose(173, "open", ["open-10"])], at(3, 1));
  const v2 = view(definition, second.state, [], at(3, 2));
  conform(v2, "view", "view");
  assert.deepEqual([v2.cases[0]!.evidence, v2.cases[0]!.first_observed, v2.cases[0]!.last_observed], [["open-10", "open-9"], at(2), at(3)]);

  // A resolved case keeps all of it.
  const resolved = judge(second.state, [openList("open-11", 4, [])], [propose(173, "resolved", ["open-11"])], at(4, 1));
  assert.deepEqual(resolved.rejections, []);
  const v3 = view(definition, resolved.state, [], at(4, 2));
  conform(v3, "view", "view");
  assert.deepEqual(v3.cases, [{
    case_id: id, subject: subject(173), status: "resolved", episode: 2, ...assessed,
    evidence: ["open-10", "open-11", "open-9"], first_observed: at(2), last_observed: at(4), attentions: [],
  }]);
});

test("an evidence id that was not passed is context only", () => {
  const first = judge(null, [openList("open-9", 2, [173])], [propose(173, "open", ["open-9"])], at(2, 1));
  const passed = [openList("open-10", 3, [173])];
  assert.deepEqual(view(definition, first.state, passed, at(3, 1)).cases[0]!.evidence, ["open-9"]);
  const r = judge(first.state, passed, [propose(173, "open", ["open-9"])], at(3, 1));
  assert.deepEqual(codes(r), ["UNKNOWN_EVIDENCE"]);
  assert.deepEqual(r.rejections[0]!.detail.unknown, ["open-9"]);
});

test("earlier assessments decide nothing", () => {
  const a = judge(null, [openList("open-1", 2, [173])], [propose(173, "open", ["open-1"], assessed)], at(2, 1)).state!;
  const b = JSON.parse(JSON.stringify(a)) as State;
  b.cases[id]!.title = "Report 173 is fixed";
  b.cases[id]!.summary = "Resolved; nothing more to do.";

  const needsOwner = { attentions: [attention("needs_owner", "open")] };
  const runs: [string, Observation[], Proposal, (r: StepResult) => void][] = [
    ["closing not_met", [openList("open-2", 3, [173])], propose(173, "resolved", ["open-2"]), (r) => {
      assert.deepEqual(codes(r), ["CLOSING_NOT_MET"]);
    }],
    ["closing met", [openList("open-2", 3, [])], propose(173, "resolved", ["open-2"]), (r) => {
      assert.deepEqual(r.rejections, []);
      assert.deepEqual(r.transitions.map((t) => [t.to, t.closing_check?.result]), [["resolved", "met"]]);
    }],
    ["when met", [openList("open-2", 3, [173])], propose(173, "open", ["open-2"], needsOwner), (r) => {
      assert.deepEqual(r.attention_events.map((e) => [e.type, e.event, e.gate_check?.result]), [["needs_owner", "opened", "met"]]);
      assert.equal(r.deliveries.length, 1);
    }],
    ["when not_met", [openList("open-2", 3, [173], true, "assigned")], propose(173, "open", ["open-2"], needsOwner), (r) => {
      assert.deepEqual(codes(r), ["ATTENTION_GATE_NOT_MET"]);
    }],
  ];
  const outputs = (r: StepResult) => [r.transitions, r.attention_events, r.deliveries, r.improvement_events, r.rejections];
  for (const [name, observations, proposal, expect] of runs) {
    const ra = judge(a, observations, [proposal], at(3, 1));
    const rb = judge(b, observations, [proposal], at(3, 1));
    expect(ra);
    assert.deepEqual(outputs(rb), outputs(ra), `${name}: the same outputs`);
    const aligned = JSON.parse(JSON.stringify(rb.state)) as State;
    aligned.cases[id]!.title = ra.state!.cases[id]!.title;
    aligned.cases[id]!.summary = ra.state!.cases[id]!.summary;
    assert.deepEqual(aligned, ra.state, `${name}: the states differ only in title and summary`);
    assert.notEqual(rb.state_digest, ra.state_digest);
  }
});
