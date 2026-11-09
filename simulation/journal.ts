// One append-only journal per run: runs/<id>/journal.jsonl. Every history, every check
// result and the report are views over it.
import { appendFileSync } from "node:fs";
import type {
  AttentionEvent, Delivery, Evaluation, ImprovementEvent, Observation, Rejection, Transition,
} from "../src/index.ts";
import type { Redact } from "./redact.ts";

export type Entry =
  | {
    type: "run_started"; at: string; run_id: string; judge: string; model: string | null; flags: string[];
    prompt_template_digest: string; judge_schema_digest: string; scenario_digest: string; node: string;
  }
  | { type: "signal"; day: number; observation: Observation }
  | { type: "context"; day: number; now: string; basis: string; system: string; prompt: string }
  | {
    type: "judge_output"; day: number; attempt: number; duration_ms: number; exit_code: number | null; timed_out: boolean;
    tool_free: boolean | null; cli_version: string | null; model: string | null; cost_usd: number | null; raw: string; stderr: string;
    evaluation: Evaluation | null; error: string | null;
  }
  | { type: "judge_failed"; day: number; reason: string }
  | {
    type: "step"; day: number; now: string; evaluation: Evaluation; transitions: Transition[]; attention_events: AttentionEvent[];
    deliveries: Delivery[]; improvement_events: ImprovementEvent[]; rejections: Rejection[]; state_digest: string;
  }
  | { type: "delivery"; day: number; delivery_id: string; route: string; written: boolean }
  | { type: "trace_check"; day: number; ok: boolean; violations: string[] }
  | { type: "run_stopped"; day: number }
  | { type: "run_finished"; at: string; status: "passed" | "failed" | "stopped"; failed_days: number[]; checks: { name: string; ok: boolean; detail: string }[]; secrets_absent: boolean };

export class Journal {
  /** What was written, after redaction, parsed back: the journal as a reader sees it. */
  readonly entries: Entry[] = [];
  readonly path: string;
  private readonly redact: Redact;
  constructor(path: string, redact: Redact) {
    this.path = path;
    this.redact = redact;
  }

  append(entry: Entry): void {
    const line = this.redact(JSON.stringify(entry));
    appendFileSync(this.path, `${line}\n`);
    this.entries.push(JSON.parse(line) as Entry);
  }

  /** Observation id -> the observation as journaled. */
  signals(): Map<string, Observation> {
    const map = new Map<string, Observation>();
    for (const e of this.entries) if (e.type === "signal") map.set(e.observation.id, e.observation);
    return map;
  }
}
