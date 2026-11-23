import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { digest, step, view, type Definition, type Evaluation, type Observation } from "./core.ts";

/**
 * Packaging (docs/core-integration-plan.md P0): the core reached through
 * `lib/core.ts`, the MCP's only import of it, reproduces the core's own recorded
 * fixture byte for byte — the view and the step, with the same state_digest.
 */

type Call = { fn: string; args: Record<string, unknown>; state_digest?: string; result_digest: string };

test("fixtures/example.json replays through lib/core.ts with the recorded digests", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../fixtures/example.json", import.meta.url), "utf8")) as {
    calls: Call[];
  };
  const [viewCall, stepCall] = fixture.calls;
  assert.equal(viewCall.fn, "view");
  assert.equal(stepCall.fn, "step");

  const v = viewCall.args as { definition: Definition; observations: Observation[]; now: string };
  assert.equal(digest(view(v.definition, null, v.observations, v.now)), viewCall.result_digest);

  const s = stepCall.args as { definition: Definition; observations: Observation[]; evaluation: Evaluation; now: string };
  const result = step(s.definition, null, s.observations, s.evaluation, s.now);
  assert.equal(result.state_digest, stepCall.state_digest);
  assert.equal(digest(result), stepCall.result_digest);
});
