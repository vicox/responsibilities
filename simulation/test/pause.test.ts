import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadScenario, SIMULATION } from "../loop.ts";
import { parseArgs, SCENARIOS } from "../run.ts";
import { runOnce, tempDir } from "./helpers.ts";

const RUN = fileURLToPath(new URL("run.ts", SIMULATION));

test("the command line takes a live judge, a scenario, a model and --pause, nothing else", () => {
  assert.deepEqual(parseArgs(["--judge", "claude"]), { judge: "claude", scenario: "security-fix", pause: false });
  assert.deepEqual(parseArgs(["--judge", "codex", "--model", "gpt-x", "--pause"]), { judge: "codex", scenario: "security-fix", model: "gpt-x", pause: true });
  assert.deepEqual(parseArgs(["--scenario", "support-handoff", "--judge", "claude"]), { judge: "claude", scenario: "support-handoff", pause: false });
  assert.equal(parseArgs([]), "--judge must be claude or codex");
  assert.equal(parseArgs(["--judge", "replay"]), "--judge must be claude or codex");
  assert.equal(parseArgs(["--judge"]), "--judge needs a value");
  assert.equal(parseArgs(["--judge", "claude", "--scenario"]), "--scenario needs a value");
  assert.equal(parseArgs(["--judge", "claude", "--scenario", "billing"]), "--scenario must be security-fix or support-handoff");
  assert.equal(parseArgs(["--judge", "claude", "--until", "4"]), "unknown argument: --until");
  assert.equal(parseArgs(["--judge", "claude", "--resume"]), "unknown argument: --resume");
});

test("every scenario on the command line loads, with its checks", () => {
  for (const [name, checks] of Object.entries(SCENARIOS)) {
    const scenario = loadScenario(name);
    assert.equal(scenario.days.length, 6, name);
    assert.ok(checks([], scenario).some((c) => !c.ok), `${name}: no result passes no check`);
  }
});

test("--pause without a terminal exits before D1, starting no judge and writing no run", () => {
  const record = join(tempDir(), "called");
  const bin = tempDir();
  writeFileSync(join(bin, "claude"), "#!/usr/bin/env node\nrequire(\"node:fs\").writeFileSync(process.env.FAKE_RECORD, \"called\");\n");
  chmodSync(join(bin, "claude"), 0o755);
  const runs = fileURLToPath(new URL("runs/", SIMULATION));
  const before = existsSync(runs) ? readdirSync(runs).length : 0;
  const r = spawnSync(process.execPath, [RUN, "--judge", "claude", "--pause"], {
    input: "\n", encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_RECORD: record },
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--pause .* needs an interactive terminal; nothing was run/);
  assert.equal(r.stdout, "");
  assert.equal(existsSync(record), false, "no judge was started");
  assert.equal(existsSync(runs) ? readdirSync(runs).length : 0, before);
});

test("a bad argument prints the usage and exits 2", () => {
  const r = spawnSync(process.execPath, [RUN, "--judge", "replay"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: npm run simulation -- --judge claude\|codex \[--scenario security-fix\|support-handoff\]/);
});

const lines = (...input: (string | null)[]) => async () => (input.length ? input.shift()! : null);

test("--pause: Enter goes on to the next day, q stops and the journal says so", async () => {
  const run = await runOnce({ pause: lines("", "q") });
  assert.equal(run.status, "stopped");
  assert.deepEqual(run.results.map((r) => r.day), [1, 2]);
  assert.deepEqual(run.journal.filter((e) => e.type === "run_stopped"), [{ type: "run_stopped", day: 2 }]);
  const finished = run.journal.at(-1)!;
  assert.ok(finished.type === "run_finished" && finished.status === "stopped");
  assert.match(run.console, /Stopped after D2\./);
  assert.equal(run.console.match(/Enter: next day · q: stop/g)!.length, 2);
});

test("--pause: the end of input stops; Enter through every day runs all six without a pause after the last", async () => {
  const eof = await runOnce({ pause: lines("") });
  assert.deepEqual([eof.status, eof.results.length], ["stopped", 2]);
  const all = await runOnce({ pause: lines("", "", "", "", "", "") });
  assert.deepEqual([all.status, all.results.length], ["passed", 6]);
  assert.equal(all.console.match(/Enter: next day · q: stop/g)!.length, 5);
});
