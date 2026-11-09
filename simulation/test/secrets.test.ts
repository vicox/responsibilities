import assert from "node:assert/strict";
import { test } from "node:test";
import type { Judge } from "../judges/judge.ts";
import { REDACTED, redactor, secretValues } from "../redact.ts";
import { runOnce, scripted } from "./helpers.ts";

const KEY = "planted-api-key-value-0123456789";
const TOKEN = "planted-token-value-abcdefgh";
const env = { MY_API_KEY: KEY, SERVICE_TOKEN: TOKEN, HOME: "/home/someone", SHORT_SECRET: "abc" };

test("redaction: secret-named variables of 8 characters or more, and common key patterns", () => {
  assert.deepEqual(secretValues(env).sort(), [KEY, TOKEN].sort());
  const redact = redactor(env);
  assert.equal(redact(`a ${KEY} b ${TOKEN} c abc /home/someone`), `a ${REDACTED} b ${REDACTED} c abc /home/someone`);
  for (const text of ["sk-ant-api03-abcdefghijklmnop", "ghp_abcdefghijklmnopqrstuvwxyz0123", "xoxb-1234567890-abcdef", "AKIAABCDEFGHIJKLMNOP", "Bearer abcdefghijklmnopqrstuvwxyz.123"]) {
    assert.equal(redact(`x ${text} y`), `x ${REDACTED} y`, text);
  }
  assert.equal(redact("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "digests stay");
});

test("planted values never reach the journal, the inbox, the report or the console", async () => {
  const leaky: Judge = {
    name: "leaky", model: null, flags: [`--token=${TOKEN}`],
    ask: async ({ day }) => {
      const output = structuredClone(scripted[String(day)]);
      for (const p of output.proposals) for (const a of p.attentions) a.reason = `${a.reason} ${KEY}`;
      return {
        output, error: null, tool_free: true, tool_detail: `env ${TOKEN}`, raw: `raw ${KEY} ${TOKEN}`, stderr: `warning: ${KEY}`,
        exit_code: 0, timed_out: false, duration_ms: 1, cli_version: null, model: null, cost_usd: null,
      };
    },
  };
  const run = await runOnce({ judge: leaky, env });
  assert.equal(run.secrets_absent, true);
  assert.equal(run.status, "passed", run.checks.filter((c) => !c.ok).map((c) => c.name).join("; "));
  for (const [name, content] of [["journal", run.file("journal.jsonl")], ["inbox", run.file("inbox.md")], ["report", run.file("report.md")], ["console", run.console]] as const) {
    for (const value of [KEY, TOKEN]) assert.ok(!content.includes(value), `${name} holds a planted value`);
  }
  assert.ok(run.file("inbox.md").includes(REDACTED), "the reason reached the inbox, redacted");
});
