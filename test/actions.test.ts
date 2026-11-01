// The action-request scenarios the demo shows, recorded as fixtures/actions.json: a
// request, the same key refused in the same episode, the case resolved and reopened,
// the request allowed again in the new episode, then a person's dismissal.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Proposal, State } from "../src/index.ts";
import { matchFixture } from "./fixture.ts";
import { at, caseOf, codes, definition, offered, openList, propose } from "./helpers.ts";
import { calls, command, step, view } from "./recorder.ts";

const notify = (text: string) => ({ key: "notify", arguments: { channel: "#security", text }, reason: "Nobody owns report 173." });

function turn(state: State | null, observations: ReturnType<typeof openList>[], proposal: Proposal, now: string) {
  const v = view(definition, state, observations, offered, 1, now);
  return step(definition, state, observations, offered, 1, { basis: v.basis, evaluator: "llm-triage", proposals: [proposal] }, now);
}

test("a request once per episode, again after reopening; recorded as fixtures/actions.json", () => {
  const id = caseOf(173);
  const r1 = turn(null, [openList("open-1", 2, [173])], propose(173, "open", ["open-1"], { actions: [notify("Report 173 needs an owner.")] }), at(2, 1));
  assert.deepEqual(r1.action_requests.map((r) => [r.key, r.episode]), [["notify", 1]]);

  const r2 = turn(r1.state, [openList("open-2", 3, [173])], propose(173, "open", ["open-2"], { actions: [notify("Report 173 still needs an owner.")] }), at(3, 1));
  assert.deepEqual(codes(r2), ["ACTION_REPEATED"]);
  assert.deepEqual(r2.action_requests, []);
  assert.equal(r2.transitions[0]!.kind, "updated", "the new evidence is still linked");

  const r3 = turn(r2.state, [openList("open-3", 4, [])], propose(173, "resolved", ["open-3"]), at(4, 1));
  assert.equal(r3.state!.cases[id]!.status, "resolved");

  const r4 = turn(r3.state, [openList("open-4", 5, [173])], propose(173, "open", ["open-4"], { actions: [notify("Report 173 is open again.")] }), at(5, 1));
  assert.deepEqual(r4.action_requests.map((r) => [r.key, r.episode]), [["notify", 3]]);
  assert.notEqual(r4.action_requests[0]!.id, r1.action_requests[0]!.id);

  const r5 = command(definition, r4.state, { actor: "person:ada", case_id: id, status: "dismissed", reason: "Duplicate of report 170." }, at(5, 2));
  assert.deepEqual([r5.transitions[0]!.actor, r5.state!.cases[id]!.episode], ["person:ada", 4]);

  matchFixture("actions.json", calls);
});
