import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { canonical, digest, SPEC, step, view } from "../src/index.ts";
import type { Observation, OfferedAction, Proposal, ProposedAction, State } from "../src/index.ts";
import { conform } from "../src/validate.ts";
import type { Fixture } from "./fixture.ts";
import { replay } from "./fixture.ts";
import { at, closedList, definition, judge, offered, openList, opened, propose } from "./helpers.ts";

const fixtures = new URL("../fixtures/", import.meta.url);
const OUTPUT = { view: "view", step: "step_result", command: "step_result", assess: "assessment" } as const;

test("replaying each fixture reproduces every output byte for byte", () => {
  const names = readdirSync(fixtures).filter((name) => name.endsWith(".json")).sort();
  assert.deepEqual(names, ["actions.json", "example.json"]);
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
// existing cases, a conflict, an identity mismatch, several actions and a limit.
function rich(order: (list: unknown[]) => unknown[]) {
  const state = opened().state as State;
  const observations: Observation[] = [
    openList("open-2", 3, [173, 174, 175]), openList("open-3", 3, [176]), closedList("closed-1", 3, [{ report: 170, resolution: "fixed" }]),
  ];
  const act = (key: string, text: string): ProposedAction =>
    ({ key, arguments: key === "notify" ? { channel: "#s", text } : { name: text, urgent: false }, reason: "Because." });
  const proposals: Proposal[] = [
    propose(173, "open", ["open-2", "closed-1"], { summary: "Still open.", actions: [act("notify", "a"), act("label", "b")] }),
    propose(174, "open", ["open-2"], { actions: [act("label", "c"), act("notify", "d"), act("notify", "e")] }),
    propose(175, "open", ["open-2"], { title: "One" }),
    propose(175, "open", ["open-3"], { title: "Two" }),
    propose(176, "open", ["open-3", "open-2"], { actions: [act("notify", "f"), act("label", "g"), { ...act("label", "g"), reason: "Other." }] }),
    { subject: { type: "ticket", keys: { report: 1 } }, status: "open", cites: ["open-2"] },
  ];
  const shuffle = <T>(list: T[]) => order(list) as T[];
  const p = shuffle(proposals).map((x) => ({ ...x, cites: shuffle(x.cites), ...(x.actions ? { actions: shuffle(x.actions) } : {}) }));
  const o = shuffle(observations);
  const a = shuffle(offered) as OfferedAction[];
  const v = view(definition, state, o, a, 3, at(3, 1));
  return { v, r: step(definition, state, o, a, 3, { basis: v.basis, evaluator: "test", proposals: p }, at(3, 1)) };
}

test("P3: permuted inputs give identical outputs", () => {
  const orders: ((list: unknown[]) => unknown[])[] = [
    (l) => [...l].reverse(),
    (l) => [...l.slice(1), ...l.slice(0, 1)],
    (l) => [...l].sort((x, y) => (canonical(x) < canonical(y) ? -1 : 1)),
  ];
  const base = canonical(rich((l) => l));
  for (const order of orders) assert.equal(canonical(rich(order)), base);
  const { v, r } = rich((l) => l);
  conform(v, "view", "view");
  conform(r, "step_result", "step");
  assert.equal(r.action_requests.length, 3);
  assert.ok(r.rejections.some((x) => x.code === "ACTION_OVER_LIMIT"));
  assert.ok(r.rejections.some((x) => x.code === "CONFLICTING_PROPOSALS"));
});

test("P2: the same inputs give the same bytes", () => {
  const run = () => canonical(judge(opened().state, [openList("open-2", 3, [])], [propose(173, "resolved", ["open-2"])], at(3, 1)));
  assert.equal(run(), run());
});
