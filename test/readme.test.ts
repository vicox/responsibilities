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
  const section = /\n## See it in action\n([\s\S]*?)\n## /.exec(readme)?.[1] ?? "";
  const blocks = [...section.matchAll(/```ts\n([\s\S]*?)\n```/g)].map((m) => m[1]!);
  assert.equal(blocks.length, 2, "the See it in action section has two ts blocks, run as one module");
  const source = blocks.join("\n").replaceAll('from "responsibilities-core"', `from ${JSON.stringify(pathToFileURL(join(root, "test/recorder.ts")).href)}`);
  const file = join(mkdtempSync(join(tmpdir(), "responsibilities-core-")), "example.ts");
  writeFileSync(file, source);
  await import(pathToFileURL(file).href);

  assert.deepEqual(calls.map((c) => c.fn), ["view", "step", "command", "assess"]);
  const [, r, c, a] = calls.map((call) => call.result) as [View, StepResult, StepResult, Assessment];
  const caseId = digest({ definition_id: "inquiries-answered", subject_type: "inquiry", keys: { inquiry: "T-1042" } });

  assert.deepEqual(r.rejections, []);
  assert.deepEqual(r.transitions.map((t) => [t.case_id, t.kind, t.to, t.actor]), [[caseId, "opened", "open", "judge:llm"]]);
  assert.deepEqual(r.action_requests.map((x) => [x.case_id, x.key, x.episode]), [[caseId, "remind", 1]]);
  assert.deepEqual(r.action_requests[0]!.arguments, { channel: "#support", text: "ACME waits for an answer to T-1042." });
  assert.deepEqual(c.transitions.map((t) => [t.case_id, t.kind, t.from, t.to, t.actor]), [[caseId, "status_changed", "open", "resolved", "person:mia"]]);
  assert.equal(c.state!.cases[caseId]!.status, "resolved");
  assert.equal(a.result, "not_met");

  matchFixture("example.json", calls);
});
