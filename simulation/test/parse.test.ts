import assert from "node:assert/strict";
import { test } from "node:test";
import type { Judge, JudgeAnswer, JudgeRequest } from "../judges/judge.ts";
import { parse, ParseError } from "../parse.ts";
import { runOnce, scripted } from "./helpers.ts";

const BASIS = "0".repeat(64);
const output = (proposal: Record<string, unknown> = {}) => ({
  proposals: [{
    subject_type: "finding", subject_keys: [{ name: "app", value: "a" }, { name: "finding_id", value: "F-1" }],
    status: "open", cites: ["x"], title: null, summary: "S", attentions: [{ type: "t", intent: "open", reason: "R" }], ...proposal,
  }],
  improvements: [{ key: "k", title: "T", change: "C", rationale: "R", cites: ["x"] }],
});

test("parse maps the structured output to an Evaluation", () => {
  assert.deepEqual(parse(output(), BASIS, "claude"), {
    basis: BASIS, evaluator: "claude",
    proposals: [{ subject: { type: "finding", keys: { app: "a", finding_id: "F-1" } }, status: "open", cites: ["x"], summary: "S", attentions: [{ type: "t", intent: "open", reason: "R" }] }],
    improvements: [{ key: "k", title: "T", change: "C", rationale: "R", cites: ["x"] }],
  });
  const none = parse(output({ attentions: [], summary: null, title: "" }), BASIS, "claude").proposals[0]!;
  assert.deepEqual(Object.keys(none).sort(), ["cites", "status", "subject"]);
  assert.equal(parse(output({ summary: "Café" }), BASIS, "c").proposals[0]!.summary, "Café", "NFC");
});

test("parse refuses what does not fit, with a message for the retry", () => {
  const refuses = (value: unknown, pattern: RegExp) => assert.throws(() => parse(value, BASIS, "c"), (e: unknown) => e instanceof ParseError && pattern.test(e.message));
  refuses("text", /output must be an object/);
  refuses({ proposals: [] }, /output\.improvements is required/);
  refuses({ ...output(), extra: 1 }, /output\.extra is not allowed/);
  refuses(output({ status: "dismissed" }), /status must be "open" or "resolved"/);
  refuses(output({ subject_keys: [{ name: "app", value: "a" }, { name: "app", value: "b" }] }), /names app twice/);
  refuses(output({ attentions: [{ type: "t", intent: "maybe", reason: "R" }] }), /intent must be/);
  refuses(output({ cites: ["x", "x"] }), /cites must not repeat/);
  refuses(output({ subject_keys: [] }), /keys must have at least 1 entries/);
});

/** A judge that answers from a list, one entry per call, and records each request. */
function scriptedCalls(answers: Partial<JudgeAnswer>[]): Judge & { requests: JudgeRequest[] } {
  const requests: JudgeRequest[] = [];
  return {
    name: "fake", model: null, flags: [], requests,
    ask: async (request) => {
      requests.push(request);
      const a = answers.shift() ?? { output: scripted[String(request.day)], error: null };
      return { output: null, error: null, tool_free: true, tool_detail: null, raw: "", stderr: "", exit_code: 0, timed_out: false, duration_ms: 1, cli_version: null, model: null, cost_usd: null, ...a };
    },
  };
}

test("an unusable answer is retried once with the error; then the core is called", async () => {
  const judge = scriptedCalls([{ output: { proposals: "no", improvements: [] } }]);
  const run = await runOnce({ judge });
  assert.equal(run.status, "passed");
  assert.equal(judge.requests.length, 7);
  assert.deepEqual(judge.requests.slice(0, 2).map((r) => [r.day, r.attempt]), [[1, 1], [1, 2]]);
  assert.match(judge.requests[1]!.prompt, /Your previous answer could not be used: output\.proposals must be an array/);
  assert.equal(judge.requests[1]!.prompt.startsWith(judge.requests[0]!.prompt), true);
  const d1 = run.journal.filter((e) => "day" in e && e.day === 1).map((e) => e.type);
  assert.deepEqual(d1, ["signal", "context", "judge_output", "judge_output", "step", "delivery", "trace_check"]);
});

test("two unusable answers fail the day: judge_failed, no step, the state unchanged, the run failed", async () => {
  const judge = scriptedCalls([{ output: null, error: "claude exited with code 1: auth" }, { output: { proposals: [] } }]);
  const run = await runOnce({ judge });
  assert.equal(run.status, "failed");
  const d1 = run.journal.filter((e) => "day" in e && e.day === 1).map((e) => e.type);
  assert.deepEqual(d1, ["signal", "context", "judge_output", "judge_output", "judge_failed"]);
  const day1 = run.results[0]!;
  assert.deepEqual([day1.result, day1.state], [null, null]);
  assert.match(run.console, /### D1 FAILED/);
  assert.match(run.file("report.md"), /FAIL Every day: a usable answer: D1/);
  assert.equal(run.results.length, 6, "the following days still run");
});

test("an answer without a no-tool proof is never applied: it is retried, then the day fails", async () => {
  const retried = await runOnce({ judge: scriptedCalls([{ output: null, error: "claude timed out after 180 s", tool_free: null }]) });
  assert.equal(retried.status, "passed");
  assert.ok(retried.checks.find((c) => c.name === "Every day: no tool ran")!.ok);

  const once = scriptedCalls([{ output: scripted["1"], tool_free: null }]);
  const recovered = await runOnce({ judge: once });
  assert.equal(recovered.status, "passed");
  assert.match(once.requests[1]!.prompt, /no proof that no tool ran/);

  const unproved = { output: scripted["1"], tool_free: null };
  const failed = await runOnce({ judge: scriptedCalls([unproved, unproved]) });
  assert.equal(failed.status, "failed");
  const d1 = failed.journal.filter((e) => "day" in e && e.day === 1).map((e) => e.type);
  assert.deepEqual(d1, ["signal", "context", "judge_output", "judge_output", "judge_failed"], "no step, no delivery");
  assert.deepEqual([failed.results[0]!.result, failed.results[0]!.state], [null, null]);
});

test("a tool that ran fails the day at once, without a retry", async () => {
  const judge = scriptedCalls([{ output: scripted["1"], tool_free: false, tool_detail: "tool uses: [Bash]" }]);
  const run = await runOnce({ judge });
  assert.deepEqual(judge.requests.filter((r) => r.day === 1).length, 1);
  const failed = run.journal.find((e) => e.type === "judge_failed");
  assert.ok(failed && failed.type === "judge_failed" && /a tool ran or was offered: tool uses: \[Bash\]/.test(failed.reason));
  assert.equal(run.checks.find((c) => c.name === "Every day: no tool ran")!.ok, false);
});
