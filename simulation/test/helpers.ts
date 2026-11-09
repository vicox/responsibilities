import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Entry } from "../journal.ts";
import type { Judge } from "../judges/judge.ts";
import { replayJudge } from "../judges/replay.ts";
import type { Options, Outcome } from "../loop.ts";
import { loadScenario, SIMULATION, simulate } from "../loop.ts";
import { checks } from "../scenario/security-fix/checks.ts";

export const scenario = loadScenario("security-fix");
export const scripted = JSON.parse(readFileSync(new URL("scenario/security-fix/scripted.json", SIMULATION), "utf8")).days as Record<string, any>;
export const tempDir = (prefix = "responsibilities-sim-test-") => mkdtempSync(join(tmpdir(), prefix));

export interface Run extends Outcome {
  dir: string;
  console: string;
  journal: Entry[];
  file: (name: string) => string;
}

/** One run in a fresh directory, with the scripted judge unless another is given. */
export async function runOnce(o: Partial<Options> & { judge?: Judge } = {}): Promise<Run> {
  const dir = join(tempDir(), "run");
  const printed: string[] = [];
  const outcome = await simulate({
    judge: replayJudge(scripted), scenario, dir, run_id: "test", env: {}, print: (text) => printed.push(text), checks,
    clock: () => "2026-11-09T12:00:00.000Z", ...o,
  });
  const file = (name: string) => readFileSync(join(dir, name), "utf8");
  const journal = file("journal.jsonl").trim().split("\n").map((line) => JSON.parse(line) as Entry);
  return { ...outcome, dir, console: printed.join("\n"), journal, file };
}
