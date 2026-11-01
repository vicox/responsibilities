import assert from "node:assert/strict";
import { test } from "node:test";
import { assess } from "../src/index.ts";
import type { Criterion, Definition, Observation } from "../src/index.ts";
import { at, caseOf, closedList, definition, judge, openList, opened, propose } from "./helpers.ts";

const { state } = opened();
const id = caseOf(173);
const fixed = (criteria: Criterion[]): Definition => ({ ...definition, success: criteria });
const read = (observations: Observation[], d: Definition = definition) => assess(d, state, id, observations, at(9));
const result = (observations: Observation[], d?: Definition) => read(observations, d).result;
const rule = (o: Observation[], d?: Definition) => read(o, d).criteria[0]!.routes[0]!.rules[0]!;

test("presence: only a row that is there decides met", () => {
  assert.equal(result([]), "unknown", "no observation of the kind");
  assert.equal(result([closedList("c", 3, [{ report: 174, resolution: "fixed" }])]), "unknown", "no row lists the subject");
  assert.equal(result([closedList("c", 3, [{ report: "173", resolution: "fixed" }])]), "unknown", "\"173\" is not 173");
  assert.equal(result([closedList("c", 3, [{ report: 173, resolution: "fixed" }], false)]), "met", "a present row is a fact, even when cut");
  assert.equal(result([closedList("c", 3, [{ report: 173, resolution: "wontfix" }])]), "not_met");
  assert.equal(result([closedList("c", 3, [{ report: 173, resolution: "wontfix" }], false)]), "unknown", "a cut list may hide the row that holds");
  assert.equal(result([closedList("c", 3, [{ report: 173 }])]), "unknown", "no value for the where column");
  assert.equal(result([closedList("c", 3, [{ report: 173, resolution: null }])]), "unknown");
  assert.deepEqual(rule([closedList("c", 3, [{ report: 173, resolution: "fixed" }])]), {
    kind: "closed_reports", condition: "present", observation: "c", result: "met", reason: "a row lists the subject with every where value",
  });
});

test("where values compare with their type", () => {
  const d = fixed([{ description: "Urgent", rules: [{ kind: "closed_reports", match: { report: "report" }, where: { urgent: true, level: 1 } }] }]);
  assert.equal(result([closedList("c", 3, [{ report: 173, urgent: true, level: 1 }])], d), "met");
  assert.equal(result([closedList("c", 3, [{ report: 173, urgent: "true", level: 1 }])], d), "not_met");
  assert.equal(result([closedList("c", 3, [{ report: 173, urgent: true, level: "1" }])], d), "not_met");
});

test("absent: met only for a complete observation that does not list the subject", () => {
  const d = fixed(definition.closing.slice(0, 1));
  assert.equal(result([openList("o", 3, [])], d), "met");
  assert.equal(result([openList("o", 3, [174])], d), "met");
  assert.equal(result([openList("o", 3, [173])], d), "not_met");
  assert.equal(result([openList("o", 3, [173], false)], d), "not_met", "a listed row is a fact, even when cut");
  assert.equal(result([openList("o", 3, [], false)], d), "unknown", "silence of a cut list is not absence");
  assert.equal(result([{ ...openList("o", 3, []), rows: [{ state: "new" }] }], d), "unknown", "a row without the match column may be the subject");
  assert.equal(result([{ ...openList("o", 3, []), rows: [{ report: null }, { report: [173] }] }], d), "unknown");
  assert.equal(result([{ ...openList("o", 3, []), rows: [{ report: null }] }], d), "met", "an explicit null is never a subject key");
});

test("the latest observation of a kind is read: by occurred_at, then id", () => {
  const d = fixed(definition.closing.slice(0, 1));
  assert.equal(result([openList("a", 3, []), openList("b", 4, [173])], d), "not_met");
  assert.equal(result([openList("b", 3, [173]), openList("a", 4, [])], d), "met");
  assert.equal(rule([openList("a", 3, []), openList("b", 3, [173])], d).observation, "b");
});

test("routes are an OR, rules and criteria an AND, all three-valued", () => {
  const fixedRule = { kind: "closed_reports", match: { report: "report" }, where: { resolution: "fixed" } };
  const gone = { kind: "open_reports", match: { report: "report" }, condition: "absent", scope: "all" } as const;
  const either = fixed([{ description: "Fixed, or no longer open", any_of: [{ rules: [fixedRule] }, { rules: [gone] }] }]);
  assert.equal(result([openList("o", 3, [])], either), "met");
  assert.equal(result([openList("o", 3, [173]), closedList("c", 3, [{ report: 173, resolution: "wontfix" }])], either), "not_met");
  assert.equal(result([openList("o", 3, [173])], either), "unknown", "one route cannot be ruled out");

  const both = fixed([{ description: "Fixed and gone", rules: [fixedRule, gone] }]);
  assert.equal(result([openList("o", 3, [173]), closedList("c", 3, [])], both), "not_met", "not_met decides an AND over unknown");
  const two = fixed([{ description: "Fixed", rules: [fixedRule] }, { description: "Gone", rules: [gone] }]);
  assert.equal(result([openList("o", 3, []), closedList("c", 3, [{ report: 173, resolution: "fixed" }])], two), "met");
  assert.equal(read([openList("o", 3, [])], two).criteria.length, 2, "every criterion is traced");
});

test("no success criteria: unknown", () => {
  assert.deepEqual(read([], fixed([])), { spec: "responsibility-core/0", case_id: id, result: "unknown", criteria: [] });
});

test("closing is not success", () => {
  const resolved = judge(state, [openList("open-2", 3, []), closedList("closed-1", 3, [{ report: 173, resolution: "wontfix" }])],
    [propose(173, "resolved", ["open-2", "closed-1"])], at(3, 1));
  assert.equal(resolved.state!.cases[id]!.status, "resolved");
  assert.equal(assess(definition, resolved.state, id, [closedList("closed-1", 3, [{ report: 173, resolution: "wontfix" }])], at(3, 1)).result, "not_met");
});
