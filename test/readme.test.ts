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
  const block = /## Example[^\n]*\n[\s\S]*?```ts\n([\s\S]*?)\n```/.exec(readme)?.[1];
  assert.ok(block, "README has an Example section with a ts block");
  const source = block.replace('from "responsibilities-core"', `from ${JSON.stringify(pathToFileURL(join(root, "test/recorder.ts")).href)}`);
  const file = join(mkdtempSync(join(tmpdir(), "responsibilities-core-")), "example.ts");
  writeFileSync(file, source);
  await import(pathToFileURL(file).href);

  assert.deepEqual(calls.map((c) => c.fn), ["view", "step", "command", "view", "step", "assess"]);
  const [, r1, c1, v2, r2, a] = calls.map((c) => c.result) as [View, StepResult, StepResult, View, StepResult, Assessment];
  const caseId = (id: string) => digest({ definition_id: "inquiries-answered", subject_type: "inquiry", keys: { inquiry: id } });
  const subject = (id: string) => r1.state!.cases[id]!.subject.keys.inquiry;

  assert.deepEqual(r1.rejections, []);
  assert.deepEqual(r1.transitions.map((t) => [subject(t.case_id), t.kind, t.actor]).sort(),
    [["T-1042", "opened", "judge:llm"], ["T-1043", "opened", "judge:llm"]]);
  assert.deepEqual(r1.action_requests.map((r) => [r.key, r.episode, r.id]), [["remind", 1, digest([caseId("T-1042"), "remind", 1])]]);
  assert.deepEqual([c1.transitions[0]!.case_id, c1.transitions[0]!.to, c1.transitions[0]!.actor], [caseId("T-1043"), "dismissed", "person:mia"]);
  assert.deepEqual(v2.open_cases.map((c) => c.case_id), [caseId("T-1042")]);
  assert.deepEqual(r2.rejections, []);
  assert.deepEqual([r2.transitions[0]!.kind, r2.transitions[0]!.from, r2.transitions[0]!.to], ["status_changed", "open", "resolved"]);
  assert.equal(r2.transitions[0]!.closing_check!.result, "met");
  assert.equal(a.result, "not_met");

  matchFixture("example.json", calls);
});
