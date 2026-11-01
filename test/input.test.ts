import assert from "node:assert/strict";
import { test } from "node:test";
import { assess, canonical, command, InputError, step, view } from "../src/index.ts";
import type { Definition, Observation, Proposal, State } from "../src/index.ts";
import { at, caseOf, definition, judge, offered, openList, opened, propose } from "./helpers.ts";

const refuses = (run: () => unknown, pattern: RegExp) => assert.throws(run, (e: unknown) => e instanceof InputError && pattern.test(e.message));
const o1 = openList("open-1", 2, [173]);
const look = (d: unknown, state: unknown = null, observations: unknown = [o1], now: unknown = at(2, 1)) =>
  view(d as Definition, state as State, observations as Observation[], offered, 5, now as string);
const proposeOne = (p: unknown) => judge(null, [o1], [p as Proposal], at(2, 1));

test("strings must be NFC and well-formed", () => {
  refuses(() => proposeOne(propose(173, "open", ["open-1"], { title: "Café" })), /title is not NFC/);
  refuses(() => look(definition, null, [{ ...o1, rows: [{ ["Café"]: 1 }] }]), /rows\[0\] key .+ is not NFC/);
  refuses(() => proposeOne(propose(173, "open", ["open-1"], { summary: "\uD800" })), /not well-formed/);
});

test("times are exactly YYYY-MM-DDTHH:MM:SS.sssZ and real", () => {
  for (const now of ["2026-11-02T09:01:00Z", "2026-11-02T10:01:00.000+01:00", "2026-11-02T09:01:00.0000Z", "2026-02-30T09:00:00.000Z"]) {
    refuses(() => look(definition, null, [o1], now), /^now /);
  }
});

test("subject keys are strings or integers, compared exactly", () => {
  for (const value of [1.5, true, null, "", 2 ** 53]) {
    refuses(() => proposeOne({ subject: { type: "report", keys: { report: value } }, status: "open", cites: ["open-1"] }), /subject\.keys\.report/);
  }
  const both = judge(null, [o1], [propose(173, "open", ["open-1"]), propose("173", "open", ["open-1"])], at(2, 1));
  assert.equal(Object.keys(both.state!.cases).length, 2, "173 and \"173\" are two subjects");
});

test("arrays with holes are not JSON", () => {
  refuses(() => look(definition, null, [{ ...o1, rows: new Array(1) }]), /rows\[0\] is not JSON/);
});

test("a counter that cannot grow refuses the call instead of overflowing", () => {
  const { state } = opened();
  const id = caseOf(173);
  const full = (field: "seq" | "episode") => ({ ...state!, cases: { [id]: { ...state!.cases[id]!, [field]: Number.MAX_SAFE_INTEGER } } });
  refuses(() => judge(full("seq"), [openList("open-2", 3, [173])], [propose(173, "open", ["open-2"])], at(3, 1)), /seq cannot count/);
  refuses(() => judge(full("episode"), [openList("open-2", 3, [])], [propose(173, "resolved", ["open-2"])], at(3, 1)), /episode cannot count/);
  refuses(() => command(definition, full("seq"), { actor: "person:ada", case_id: id, status: "resolved" }, at(3)), /cannot count/);
});

test("numbers: finite everywhere, integers in range outside rows, fractions only in rows", () => {
  refuses(() => look(definition, null, [{ ...o1, rows: [{ x: Number.NaN }] }]), /not a finite number/);
  assert.ok(look(definition, null, [{ ...o1, rows: [{ report: 173, score: 0.25 }] }]));
  refuses(() => view(definition, null, [o1], offered, 2 ** 53, at(2, 1)), /max_requests/);
  refuses(() => look({ ...definition, version: 1.5 }), /definition\.version must be an integer/);
});

test("the state is bound to the definition's id and identity, not its version", () => {
  const { state } = opened();
  refuses(() => look({ ...definition, id: "other" }, state), /belongs to definition/);
  refuses(() => look({ ...definition, identity: { subject_type: "report", subject_keys: ["report", "repo"] } }, state), /another subject_type or subject_keys/);
  assert.ok(look({ ...definition, version: 2, accountable: "team:other" }, state));
  const forged = { ...state!, cases: { [caseOf(999)]: state!.cases[caseOf(173)]! } };
  refuses(() => look(definition, forged), /is not the id of its subject/);
  refuses(() => look(definition, { ...state!, spec: "responsibility-core/1" }), /state\.spec/);
});

test("time is monotone and observations are not from the future", () => {
  const { state } = opened();
  refuses(() => look(definition, state, [o1], at(2, 0)), /before state\.now/);
  refuses(() => look(definition, null, [openList("open-9", 3, [])], at(2, 1)), /occurred after now/);
});

test("observation ids collide only as errors, and linked observations are immutable", () => {
  refuses(() => look(definition, null, [o1, { ...o1, rows: [] }]), /open-1 occurs twice/);
  refuses(() => look(definition, null, [o1, o1]), /open-1 occurs twice/);
  const { state } = opened();
  refuses(() => look(definition, state, [{ ...o1, rows: [{ report: 174 }] }]), /not the one linked/);
});

test("definitions: rules name subject keys, success needs rules, one absent route per any_of", () => {
  const rule = { kind: "open_reports", match: { id: "report_id" }, condition: "absent", scope: "all" } as const;
  refuses(() => look({ ...definition, closing: [{ description: "x", rules: [rule] }] }), /report_id, which is not a subject key/);
  refuses(() => look({ ...definition, success: [{ description: "x" }] }), /definition\.success\[0\]/);
  const absent = { ...rule, match: { report: "report" } };
  refuses(() => look({ ...definition, closing: [{ description: "x", any_of: [{ rules: [absent] }, { rules: [{ ...absent, kind: "other" }] }] }] }), /only one route/);
  refuses(() => look({ ...definition, closing: [{ description: "x", rules: [{ ...absent, where: { a: 1 } }] }] }), /closing\[0\]/);
  refuses(() => look({ ...definition, include: ["a", "a"] }), /must not repeat/);
});

test("proposals, offered actions and commands are checked against the schema", () => {
  refuses(() => proposeOne(propose(173, "open", ["open-1"], { title: "" })), /title must not be empty/);
  refuses(() => proposeOne({ ...propose(173, "open", ["open-1"]), confidence: 0.9 }), /confidence is not allowed/);
  refuses(() => proposeOne(propose(173, "dismissed" as "open", ["open-1"])), /status must be one of "open", "resolved"/);
  refuses(() => proposeOne(propose(173, "open", ["open-1", "open-1"])), /cites must not repeat/);
  refuses(() => view(definition, null, [o1], [...offered, offered[0]!], 5, at(2, 1)), /notify occurs twice/);
  refuses(() => view(definition, null, [o1], [{ key: "x", params: { a: "float" as "int" } }], 5, at(2, 1)), /params\.a/);

  const { state } = opened();
  const id = caseOf(173);
  refuses(() => command(definition, state, { actor: "person:ada", case_id: id, status: "dismissed" }, at(3)), /reason is required/);
  refuses(() => command(definition, state, { actor: "ada", case_id: id, status: "resolved" }, at(3)), /actor/);
  refuses(() => command(definition, state, { actor: "person:ada", case_id: caseOf(1), status: "resolved" }, at(3)), /there is no case/);
  refuses(() => command(definition, state, { actor: "person:ada", case_id: id, status: "open" }, at(3)), /already open/);
  refuses(() => assess(definition, state, caseOf(1), [], at(3)), /there is no case/);
});

test("inputs are never mutated, and outputs share nothing with them", () => {
  const freeze = <T>(value: T): T => {
    if (value && typeof value === "object") Object.values(value).forEach(freeze);
    return Object.freeze(value);
  };
  const { state } = opened();
  const inputs = freeze({
    state,
    observations: [openList("open-2", 3, [173]), o1],
    proposals: [propose(173, "open", ["open-2"], { summary: "Still open.", actions: [{ key: "notify", arguments: { channel: "#s", text: "t" }, reason: "r" }] })],
  });
  const before = canonical(inputs);
  const v = view(definition, inputs.state, inputs.observations, offered, 5, at(3, 1));
  const r = step(definition, inputs.state, inputs.observations, offered, 5, { basis: v.basis, evaluator: "test", proposals: inputs.proposals }, at(3, 1));
  assert.equal(canonical(inputs), before);
  r.action_requests[0]!.arguments.channel = "#changed";
  assert.equal(inputs.proposals[0]!.actions![0]!.arguments.channel, "#s");
});

test("ids that are Object.prototype names are plain data", () => {
  const odd = [openList("__proto__", 2, [173]), openList("constructor", 2, [173])];
  const r = judge(null, odd, [propose(173, "open", ["__proto__", "constructor"])], at(2, 1));
  const c = r.state!.cases[caseOf(173)]!;
  assert.deepEqual(Object.keys(c.evidence).sort(), ["__proto__", "constructor"]);
  const stored = JSON.parse(JSON.stringify(r.state)) as State;
  assert.ok(look(definition, stored, odd));
  refuses(() => look(definition, stored, [{ ...odd[0]!, rows: [] }, odd[1]!]), /__proto__ is not the one linked/);
});
