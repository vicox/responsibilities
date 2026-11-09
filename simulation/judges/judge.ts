// What a judge is to the loop, and how a CLI judge is run: without a shell, in an empty
// temporary directory, the prompt on stdin, with a timeout.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface JudgeRequest {
  day: number;
  attempt: number;
  system: string;
  prompt: string;
  schema: object;
}

export interface JudgeAnswer {
  /** The structured output, or null when there is none to use. */
  output: unknown;
  /** Why there is no usable output; null when there is. */
  error: string | null;
  /** Whether the CLI proved that no tool ran: true, false (one ran or was available), or null (no proof). */
  tool_free: boolean | null;
  tool_detail: string | null;
  raw: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
  cli_version: string | null;
  model: string | null;
  /** What the CLI reports the call cost, when it does. */
  cost_usd: number | null;
}

export interface Judge {
  name: string;
  model: string | null;
  /** The fixed flags, for the journal; the per-call schema, system prompt and paths are not among them. */
  flags: string[];
  ask(request: JudgeRequest): Promise<JudgeAnswer>;
}

export interface CliOptions {
  model?: string;
  /** The child's environment; the CLI handles its own login. */
  env?: NodeJS.ProcessEnv;
  timeout_ms?: number;
}

export const TIMEOUT_MS = 180_000;

export interface Spawned {
  code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  duration_ms: number;
  /** Set when the process could not be started at all. */
  error: string | null;
}

export function run(command: string, args: string[], o: { cwd: string; input: string; env: NodeJS.ProcessEnv; timeout_ms: number }): Promise<Spawned> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: o.cwd, env: o.env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timed_out = false;
    let error: string | null = null;
    const timer = setTimeout(() => {
      timed_out = true;
      child.kill("SIGKILL");
    }, o.timeout_ms);
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.stdin.on("error", () => {}); // a child that exits without reading stdin
    child.on("error", (e) => {
      error = e.message;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"),
        timed_out, duration_ms: Date.now() - started, error,
      });
    });
    child.stdin.end(o.input);
  });
}

/** A fresh temporary directory with an empty `work/` the CLI runs in; removed afterwards. */
export async function inEmptyDir<T>(prefix: string, use: (root: string, work: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const work = join(root, "work");
  mkdirSync(work);
  try {
    return await use(root, work);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** JSON lines, skipping any line that is not JSON. */
export function lines(text: string): Record<string, any>[] {
  const events: Record<string, any>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) events.push(value);
    } catch {
      // not an event
    }
  }
  return events;
}

export function failure(s: Spawned, cli: string, timeout_ms: number): string | null {
  if (s.error) return `${cli} could not be started: ${s.error}`;
  if (s.timed_out) return `${cli} timed out after ${Math.round(timeout_ms / 1000)} s`;
  if (s.code !== 0) return `${cli} exited with code ${s.code}${s.stderr.trim() ? `: ${s.stderr.trim().split("\n").slice(-3).join(" | ")}` : ""}`;
  return null;
}
