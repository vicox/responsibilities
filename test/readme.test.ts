// Runs the README example against the recording library, checks what its comments
// claim, and compares the recording with fixtures/example.json.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { digest } from "../src/index.ts";
import type { Assessment, StepResult, View } from "../src/index.ts";
import { matchFixture } from "./fixture.ts";
import { calls } from "./recorder.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

test("the README example runs, does what it says, and is the fixture", async () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const block = /## Example\n[\s\S]*?```ts\n([\s\S]*?)\n```/.exec(readme)?.[1];
  assert.ok(block, "README has an Example section with a ts block");
  const source = block.replace('from "responsibilities-core"', `from ${JSON.stringify(pathToFileURL(join(root, "test/recorder.ts")).href)}`);
  const file = join(mkdtempSync(join(tmpdir(), "responsibilities-core-")), "example.ts");
  writeFileSync(file, source);
  await import(pathToFileURL(file).href);

  assert.deepEqual(calls.map((c) => c.fn), ["view", "step", "view", "step", "assess"]);
  const [, r1, v2, r2, a] = calls.map((c) => c.result) as [View, StepResult, View, StepResult, Assessment];
  const id = r1.transitions[0]!.case_id;
  assert.equal(r1.transitions[0]!.kind, "opened");
  assert.equal(r1.transitions[0]!.actor, "judge:llm-triage");
  assert.deepEqual(r1.transitions[0]!.added_evidence.map((e) => e.obs_id), ["open-1"]);
  assert.equal(r1.action_requests.length, 1);
  assert.equal(r1.action_requests[0]!.id, digest([id, "notify", 1]));
  assert.deepEqual(v2.open_cases.map((c) => c.subject.keys), [{ report: 173 }]);
  assert.deepEqual(r2.rejections, []);
  assert.deepEqual([r2.transitions[0]!.kind, r2.transitions[0]!.from, r2.transitions[0]!.to], ["status_changed", "open", "resolved"]);
  assert.equal(r2.transitions[0]!.closing_check!.result, "met");
  assert.equal(a.result, "met");

  matchFixture("example.json", calls);
});
