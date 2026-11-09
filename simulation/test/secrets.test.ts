import assert from "node:assert/strict";
import { test } from "node:test";
import type { Judge } from "../judges/judge.ts";
import { leaks, REDACTED, redactDeep, redactor, secretValues, strings } from "../redact.ts";
import { runOnce, scripted } from "./helpers.ts";

const KEY = "planted-api-key-value-0123456789";
const TOKEN = "planted-token-value-abcdefgh";
/** JSON escapes it, so it must be caught as it stands in text and as it stands in JSON. */
const PASSWORD = "quote\"and\\back-123";
const env = { MY_API_KEY: KEY, SERVICE_TOKEN: TOKEN, DB_PASSWORD: PASSWORD, HOME: "/home/someone", SHORT_SECRET: "abc" };
const planted = [KEY, TOKEN, PASSWORD];

test("redaction: secret-named variables of 8 characters or more, their JSON forms, and common key patterns", () => {
  assert.deepEqual(secretValues(env).sort(), [...planted].sort());
  const redact = redactor(env);
  assert.equal(redact(`a ${KEY} b ${TOKEN} c abc /home/someone`), `a ${REDACTED} b ${REDACTED} c abc /home/someone`);
  assert.equal(redact(`x ${PASSWORD} y ${JSON.stringify(PASSWORD)} z`), `x ${REDACTED} y "${REDACTED}" z`);
  for (const text of ["sk-ant-api03-abcdefghijklmnop", "ghp_abcdefghijklmnopqrstuvwxyz0123", "xoxb-1234567890-abcdef", "AKIAABCDEFGHIJKLMNOP", "Bearer abcdefghijklmnopqrstuvwxyz.123"]) {
    assert.equal(redact(`x ${text} y`), `x ${REDACTED} y`, text);
  }
  assert.equal(redact("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "digests stay");

  // Redacting before serializing leaves nothing to decode.
  const entry = { reason: `p=${PASSWORD}`, nested: [{ [`k-${PASSWORD}`]: PASSWORD }] };
  const line = JSON.stringify(redactDeep(entry, redact));
  assert.equal(leaks(line, planted), false);
  assert.equal(leaks(strings(JSON.parse(line)).join("\n"), planted), false);
  assert.equal(leaks(JSON.stringify(entry), planted), true, "the check sees the escaped form");
});

test("planted values never reach the journal, the inbox, the report or the console, escaped or decoded", async () => {
  const leaky: Judge = {
    name: "leaky", model: null, flags: [`--token=${TOKEN}`],
    ask: async ({ day }) => {
      const output = structuredClone(scripted[String(day)]);
      for (const p of output.proposals) {
        for (const a of p.attentions) a.reason = `${a.reason} ${KEY} ${PASSWORD}`;
        if (p.title) p.title = `${p.title} ${PASSWORD}`; // it returns in the next day's prompt, JSON-escaped
      }
      return {
        output, error: null, tool_free: true, tool_detail: `env ${TOKEN}`, raw: `raw ${KEY} ${TOKEN} ${JSON.stringify(PASSWORD)}`, stderr: `warning: ${PASSWORD}`,
        exit_code: 0, timed_out: false, duration_ms: 1, cli_version: null, model: null, cost_usd: null,
      };
    },
  };
  const run = await runOnce({ judge: leaky, env });
  assert.equal(run.secrets_absent, true);
  assert.equal(run.status, "passed", run.checks.filter((c) => !c.ok).map((c) => c.name).join("; "));
  for (const [name, content] of [["journal", run.file("journal.jsonl")], ["inbox", run.file("inbox.md")], ["report", run.file("report.md")], ["console", run.console]] as const) {
    assert.equal(leaks(content, planted), false, `${name} holds a planted value`);
  }
  assert.equal(leaks(run.journal.flatMap((e) => strings(e)).join("\n"), planted), false, "the decoded journal holds a planted value");
  assert.ok(run.file("inbox.md").includes(REDACTED), "the reason reached the inbox, redacted");
});
