import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { canonical, digest, SPEC, step, view } from "../src/index.ts";
import type { Definition, Observation, Proposal, ProposedImprovement, State } from "../src/index.ts";
import { conform } from "../src/validate.ts";
import type { Fixture } from "./fixture.ts";
import { replay } from "./fixture.ts";
import { at, attention, closedList, definition, improve, judge, openList, opened, propose } from "./helpers.ts";

const fixtures = new URL("../fixtures/", import.meta.url);
const OUTPUT = { view: "view", step: "step_result", command: "step_result", assess: "assessment" } as const;

test("replaying each fixture reproduces every output byte for byte", () => {
  const names = readdirSync(fixtures).filter((name) => name.endsWith(".json")).sort();
  assert.deepEqual(names, ["attention.json", "example.json"]);
  for (const name of names) {
    const fixture = JSON.parse(readFileSync(new URL(name, fixtures), "utf8")) as Fixture;
    assert.equal(fixture.spec, SPEC);
    replay(fixture).forEach(({ result }, i) => {
      const call = fixture.calls[i]!;
      assert.equal(digest(result), call.result_digest, `${name}, call ${i} (${call.fn})`);
      if (call.state_digest) assert.equal((result as { state_digest: string }).state_digest, call.state_digest);
      conform(result, OUTPUT[call.fn], `${name}, call ${i}`);
    });
  }
});

// A step that exercises every ordering: several observations, proposals for new and
// existing cases, a conflict, an identity mismatch, Attention entries of the same type
// with different intents and reasons, and Improvements, valid and refused.
function rich(order: (list: unknown[]) => unknown[]) {
  const state = opened().state as State;
  const observations: Observation[] = [
    openList("open-2", 3, [173, 174, 175]), openList("open-3", 3, [173, 174, 175, 176]), closedList("closed-1", 3, [{ report: 170, resolution: "fixed" }]),
  ];
  const proposals: Proposal[] = [
    propose(173, "open", ["open-2", "closed-1"], { summary: "Still open.", attentions: [attention("needs_owner", "open"), attention("review", "open")] }),
    propose(174, "open", ["open-2"], {
      attentions: [attention("review", "open", "First."), attention("review", "close", "Second."), attention("review", "open", "Third."), attention("needs_owner", "open")],
    }),
    propose(175, "open", ["open-2"], { title: "One" }),
    propose(175, "open", ["open-3"], { title: "Two" }),
    propose(176, "open", ["open-3", "open-2"], { attentions: [attention("needs_owner", "open"), attention("review", "keep"), attention("escalate", "open")] }),
    { subject: { type: "ticket", keys: { report: 1 } }, status: "open", cites: ["open-2"] },
  ];
  const improvements: ProposedImprovement[] = [
    improve("assign-on-intake", ["open-2", "closed-1", "open-3"]),
    improve("twice", ["open-2"], { title: "One" }),
    improve("twice", ["open-3"], { title: "Two" }),
    improve("blank", ["open-2"], { rationale: " " }),
  ];
  const shuffle = <T>(list: T[]) => order(list) as T[];
  const p = shuffle(proposals).map((x) => ({ ...x, cites: shuffle(x.cites), ...(x.attentions ? { attentions: shuffle(x.attentions) } : {}) }));
  const i = shuffle(improvements).map((x) => ({ ...x, cites: shuffle(x.cites) }));
  const o = shuffle(observations);
  const d: Definition = { ...definition, attention_types: shuffle(definition.attention_types!) };
  const v = view(d, state, o, at(3, 1));
  return { v, r: step(d, state, o, { basis: v.basis, evaluator: "test", proposals: p, improvements: i }, at(3, 1)) };
}

test("P3: permuted inputs give identical outputs, same-type Attention entries included", () => {
  const orders: ((list: unknown[]) => unknown[])[] = [
    (l) => [...l].reverse(),
    (l) => [...l.slice(1), ...l.slice(0, 1)],
    (l) => [...l.slice(2), ...l.slice(0, 2)],
    (l) => [...l].sort((x, y) => (canonical(x) < canonical(y) ? -1 : 1)),
  ];
  const base = canonical(rich((l) => l));
  for (const order of orders) assert.equal(canonical(rich(order)), base);
  const { v, r } = rich((l) => l);
  conform(v, "view", "view");
  conform(r, "step_result", "step");
  const repeated = r.rejections.filter((x) => x.code === "ATTENTION_REPEATED");
  assert.equal(repeated.length, 3, "every entry of the repeated type");
  assert.equal(new Set(repeated.map((x) => canonical(x))).size, 1, "with one ref");
  assert.deepEqual(codes(r).filter((c) => c !== "ATTENTION_REPEATED").sort(), [
    "ATTENTION_NOT_DECLARED", "CONFLICTING_PROPOSALS", "CONFLICTING_PROPOSALS", "IDENTITY_MISMATCH",
    "IMPROVEMENT_CONFLICT", "IMPROVEMENT_CONFLICT", "IMPROVEMENT_INCOMPLETE",
  ]);
  assert.deepEqual(r.attention_events.map((e) => `${e.type} ${e.event}`).sort(), ["needs_owner opened", "needs_owner opened", "needs_owner opened", "review opened"]);
  assert.equal(r.deliveries.length, 3);
  assert.equal(r.improvement_events.length, 1);
});

const codes = (r: { rejections: { code: string }[] }) => r.rejections.map((x) => x.code);

test("P2: the same inputs give the same bytes", () => {
  const run = () => canonical(judge(opened().state, [openList("open-2", 3, [])], [propose(173, "resolved", ["open-2"])], at(3, 1)));
  assert.equal(run(), run());
});
