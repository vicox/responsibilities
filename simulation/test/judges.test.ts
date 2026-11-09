// The CLI judges against fake `claude` and `codex` executables first on PATH: the
// arguments, stdin, the empty temporary directory, the "no tool ran" proof, timeouts and
// failures. No real CLI and no network.
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeJudge } from "../judges/claude.ts";
import { codexJudge } from "../judges/codex.ts";
import { JUDGE_SCHEMA } from "../loop.ts";
import { tempDir } from "./helpers.ts";

// One fake for both CLIs: it records how it was called, then answers as FAKE_MODE says.
const FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const cli = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const mode = process.env.FAKE_MODE || "ok";
if (cli === "codex" && args[0] === "--version") { console.log("codex-cli 0.160.0"); process.exit(0); }
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  fs.writeFileSync(process.env.FAKE_RECORD + "." + cli, JSON.stringify({ args, cwd: process.cwd(), entries: fs.readdirSync(process.cwd()), stdin }));
  const output = JSON.parse(process.env.FAKE_OUTPUT);
  const out = (event) => console.log(JSON.stringify(event));
  if (mode === "hang") return setTimeout(() => {}, 60000);
  if (mode === "fail") { console.error("Invalid API key"); process.exit(1); }
  if (cli === "claude") {
    if (mode !== "noinit") out({ type: "system", subtype: "init", tools: mode === "tool" ? ["Bash", "StructuredOutput"] : ["StructuredOutput"], mcp_servers: [], model: "fake-model", claude_code_version: "9.9.9", cwd: process.cwd() });
    if (mode === "tool") out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } });
    out({ type: "assistant", message: { content: [{ type: "tool_use", name: "StructuredOutput", input: output }] } });
    out({ type: "result", subtype: "success", is_error: false, structured_output: output, total_cost_usd: 0.0123 });
  } else {
    out({ type: "thread.started", thread_id: "t" });
    out({ type: "turn.started" });
    if (mode === "tool") out({ type: "item.completed", item: { id: "1", type: "command_execution", command: "ls" } });
    out({ type: "item.completed", item: { id: "2", type: "agent_message", text: JSON.stringify(output) } });
    out({ type: "turn.completed", usage: {} });
    const last = args[args.indexOf("--output-last-message") + 1];
    if (mode !== "nomessage") fs.writeFileSync(last, JSON.stringify(output));
  }
});
`;

function fakes() {
  const bin = tempDir("responsibilities-fake-bin-");
  for (const cli of ["claude", "codex"]) {
    writeFileSync(join(bin, cli), FAKE);
    chmodSync(join(bin, cli), 0o755);
  }
  const record = join(tempDir(), "record");
  const env = (mode: string, output: unknown = { proposals: [], improvements: [] }) => ({
    ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_MODE: mode, FAKE_RECORD: record, FAKE_OUTPUT: JSON.stringify(output),
  });
  const called = (cli: string) => JSON.parse(readFileSync(`${record}.${cli}`, "utf8")) as { args: string[]; cwd: string; entries: string[]; stdin: string };
  return { env, called };
}

const request = { day: 1, attempt: 1, system: "SYSTEM TEXT", prompt: "PROMPT TEXT", schema: JUDGE_SCHEMA };

test("claude: isolated flags, the prompt on stdin, an empty temporary directory, the structured output", async () => {
  const { env, called } = fakes();
  const output = { proposals: [], improvements: [{ key: "k", title: "t", change: "c", rationale: "r", cites: ["x"] }] };
  const a = await claudeJudge({ env: env("ok", output), model: "opus" }).ask(request);
  assert.equal(a.error, null);
  assert.deepEqual(a.output, output);
  assert.deepEqual([a.tool_free, a.cli_version, a.model, a.exit_code, a.cost_usd], [true, "9.9.9", "fake-model", 0, 0.0123]);
  const c = called("claude");
  assert.deepEqual(c.args, [
    "-p", "--safe-mode", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--output-format", "stream-json", "--verbose",
    "--max-budget-usd", "2", "--model", "opus", "--json-schema", JSON.stringify(JUDGE_SCHEMA), "--system-prompt", "SYSTEM TEXT",
  ]);
  assert.equal(c.stdin, "PROMPT TEXT");
  assert.deepEqual(c.entries, [], "the working directory is empty");
  assert.ok(c.cwd.startsWith(tmpdir()) || c.cwd.startsWith(`/private${tmpdir()}`), c.cwd);
  assert.ok(!c.cwd.includes("responsibilities-simulation/"), "never the repository");
  assert.equal(existsSync(c.cwd), false, "removed afterwards");
});

test("claude: a tool on offer or used, a missing init event, a failure and a timeout give no output", async () => {
  const { env } = fakes();
  const tool = await claudeJudge({ env: env("tool") }).ask(request);
  assert.equal(tool.tool_free, false);
  assert.match(tool.tool_detail!, /tools offered: \[Bash, StructuredOutput\].*tool uses: \[Bash, StructuredOutput\]/);
  const noinit = await claudeJudge({ env: env("noinit") }).ask(request);
  assert.deepEqual([noinit.output, noinit.tool_free], [null, null]);
  assert.match(noinit.error!, /no init event/);
  const fail = await claudeJudge({ env: env("fail") }).ask(request);
  assert.deepEqual([fail.output, fail.exit_code], [null, 1]);
  assert.match(fail.error!, /claude exited with code 1: Invalid API key/);
  const hang = await claudeJudge({ env: env("hang"), timeout_ms: 300 }).ask(request);
  assert.deepEqual([hang.output, hang.timed_out], [null, true]);
  assert.match(hang.error!, /timed out/);
  const missing = await claudeJudge({ env: { ...env("ok"), PATH: tempDir() } }).ask(request);
  assert.match(missing.error!, /could not be started/);
});

test("codex: documented flags, instructions and prompt on stdin, the schema and last message outside the work directory", async () => {
  const { env, called } = fakes();
  const output = { proposals: [], improvements: [] };
  const a = await codexJudge({ env: env("ok", output), model: "gpt-x" }).ask(request);
  assert.equal(a.error, null);
  assert.deepEqual([a.output, a.tool_free, a.cli_version], [output, true, "0.160.0"]);
  const c = called("codex");
  const schema = c.args[c.args.indexOf("--output-schema") + 1]!;
  const last = c.args[c.args.indexOf("--output-last-message") + 1]!;
  const work = c.args[c.args.indexOf("-C") + 1]!;
  assert.deepEqual(c.args, [
    "exec", "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral", "--ignore-user-config", "--ignore-rules",
    "-c", "project_doc_max_bytes=0", "-c", "history.persistence=\"none\"", "--json", "--color", "never", "-m", "gpt-x",
    "--output-schema", schema, "--output-last-message", last, "-C", work, "-",
  ]);
  assert.ok(c.cwd === work || c.cwd === `/private${work}`, "it runs in the directory -C names");
  assert.equal(c.stdin, "SYSTEM TEXT\n\n---\n\nPROMPT TEXT");
  assert.deepEqual(c.entries, []);
  assert.ok(!schema.startsWith(work) && !last.startsWith(work));
  assert.equal(existsSync(c.cwd), false);
});

test("codex: a command execution, a failure and a missing last message give no usable output", async () => {
  const { env } = fakes();
  const tool = await codexJudge({ env: env("tool") }).ask(request);
  assert.equal(tool.tool_free, false);
  assert.match(tool.tool_detail!, /command_execution/);
  const fail = await codexJudge({ env: env("fail") }).ask(request);
  assert.match(fail.error!, /codex exited with code 1/);
  const none = await codexJudge({ env: env("nomessage") }).ask(request);
  assert.deepEqual([none.output, none.error], [null, "codex wrote no last message"]);
});
