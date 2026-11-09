// npm run simulation -- --judge claude|codex [--model <name>] [--pause]
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { claudeJudge } from "./judges/claude.ts";
import { codexJudge } from "./judges/codex.ts";
import { loadScenario, SIMULATION, simulate } from "./loop.ts";
import { redactor } from "./redact.ts";
import { checks } from "./scenario/security-fix/checks.ts";

export const USAGE = "usage: npm run simulation -- --judge claude|codex [--model <name>] [--pause]";
/** A planted secret: the run must end without its value anywhere in the run directory. */
export const CANARY = "RESPONSIBILITIES_SIMULATION_CANARY_TOKEN";

export interface Args {
  judge: "claude" | "codex";
  model?: string;
  pause: boolean;
}

export function parseArgs(argv: string[]): Args | string {
  let judge: string | undefined;
  let model: string | undefined;
  let pause = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--judge" || arg === "--model") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) return `${arg} needs a value`;
      if (arg === "--judge") judge = value;
      else model = value;
    } else if (arg === "--pause") pause = true;
    else return `unknown argument: ${arg}`;
  }
  if (judge !== "claude" && judge !== "codex") return "--judge must be claude or codex";
  return { judge, ...(model ? { model } : {}), pause };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === "string") {
    process.stderr.write(`${args}\n${USAGE}\n`);
    return 2;
  }
  if (args.pause && !(process.stdin.isTTY && process.stdout.isTTY)) {
    process.stderr.write("--pause waits for Enter after each day and needs an interactive terminal; nothing was run.\n");
    return 2;
  }
  process.env[CANARY] ??= randomBytes(16).toString("hex");
  const judge = args.judge === "claude" ? claudeJudge({ model: args.model }) : codexJudge({ model: args.model });
  const run_id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${args.judge}`;
  const dir = fileURLToPath(new URL(`runs/${run_id}/`, SIMULATION));

  let pause: (() => Promise<string | null>) | undefined;
  let close = () => {};
  if (args.pause) {
    const rl = createInterface({ input: process.stdin });
    const lines = rl[Symbol.asyncIterator]();
    pause = async () => {
      const next = await lines.next();
      return next.done ? null : next.value;
    };
    close = () => rl.close();
  }
  try {
    const outcome = await simulate({
      judge, scenario: loadScenario("security-fix"), dir, run_id, env: process.env,
      print: (text) => process.stdout.write(`${text}\n`), pause, checks,
    });
    process.stdout.write(`Journal, inbox and report: ${dir}\n`);
    return outcome.status === "failed" ? 1 : 0;
  } finally {
    close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => process.exit(code), (error) => {
    process.stderr.write(`${redactor(process.env)(error instanceof Error ? error.stack ?? error.message : String(error))}\n`);
    process.exit(1);
  });
}
