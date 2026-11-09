// One run: per day, the day's observations join every earlier one, then view, prompt,
// judge, parse, step, deliver, journal, trace check, report, and a pause if asked.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digest, step, view } from "../src/index.ts";
import type { Definition, Evaluation, Observation, State, StepResult } from "../src/index.ts";
import { Inbox } from "./deliver.ts";
import { Journal } from "./journal.ts";
import type { Judge, JudgeAnswer } from "./judges/judge.ts";
import { parse, ParseError } from "./parse.ts";
import { render, retryNote, SYSTEM } from "./prompt.ts";
import { leaks, redactor, secretValues, strings } from "./redact.ts";
import * as report from "./report.ts";
import { trace } from "./trace.ts";

export const SIMULATION = new URL(".", import.meta.url);
const read = (url: URL) => readFileSync(url, "utf8");
export const JUDGE_SCHEMA = JSON.parse(read(new URL("judge-schema.json", SIMULATION))) as object;

export interface Day {
  day: number;
  observe_at: string;
  judge_at: string;
  observations: Observation[];
}

export interface Scenario {
  name: string;
  definition: Definition;
  days: Day[];
  digest: string;
}

export function loadScenario(name: string): Scenario {
  const dir = new URL(`scenario/${name}/`, SIMULATION);
  const definition = JSON.parse(read(new URL("definition.json", dir))) as Definition;
  const { days } = JSON.parse(read(new URL("days.json", dir))) as { days: Day[] };
  return { name, definition, days, digest: digest({ definition, days }) };
}

export interface DayResult {
  day: number;
  now: string;
  added: string[];
  /** Every observation up to and including this day. */
  observations: Observation[];
  evaluation: Evaluation | null;
  result: StepResult | null;
  /** The state after this day. */
  state: State | null;
  /** Why the day failed, or null. */
  failed: string | null;
  tool_free: boolean;
  trace_ok: boolean;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Options {
  judge: Judge;
  scenario: Scenario;
  /** The run directory; created. */
  dir: string;
  run_id: string;
  /** Whose secret values are redacted from everything written and printed. */
  env: NodeJS.ProcessEnv;
  print: (text: string) => void;
  /** After each day: the next line of input, or null at its end. Absent: no pause. */
  pause?: () => Promise<string | null>;
  checks?: (results: DayResult[], scenario: Scenario) => CheckResult[];
  clock?: () => string;
}

export interface Outcome {
  status: "passed" | "failed" | "stopped";
  results: DayResult[];
  checks: CheckResult[];
  secrets_absent: boolean;
}

export async function simulate(o: Options): Promise<Outcome> {
  const clock = o.clock ?? (() => new Date().toISOString());
  const redact = redactor(o.env);
  mkdirSync(o.dir, { recursive: true });
  const journal = new Journal(join(o.dir, "journal.jsonl"), redact);
  const inbox = new Inbox(join(o.dir, "inbox.md"), redact);
  const text: string[] = [];
  const say = (chunk: string) => {
    const safe = redact(chunk);
    text.push(safe);
    o.print(safe);
  };
  const { definition } = o.scenario;

  journal.append({
    type: "run_started", at: clock(), run_id: o.run_id, judge: o.judge.name, model: o.judge.model, flags: o.judge.flags,
    prompt_template_digest: digest(SYSTEM + read(new URL("prompt.ts", SIMULATION))), judge_schema_digest: digest(JUDGE_SCHEMA),
    scenario: o.scenario.name, scenario_digest: o.scenario.digest, node: process.version,
  });
  say(report.header({ run_id: o.run_id, judge: o.judge.name, model: o.judge.model, dir: o.dir, scenario: o.scenario.name }));

  let state: State | null = null;
  const observations: Observation[] = [];
  const results: DayResult[] = [];
  let stopped = false;

  for (const d of o.scenario.days) {
    const now = d.judge_at;
    for (const observation of d.observations) {
      observations.push(observation);
      journal.append({ type: "signal", day: d.day, observation });
    }
    const v = view(definition, state, observations, now);
    const prompt = render(v, definition, now);
    journal.append({ type: "context", day: d.day, now, basis: v.basis, system: SYSTEM, prompt });
    say(report.dayStart(d.day, now, d.observations.map((x) => x.id), prompt));

    // Judge, with one retry for an answer that cannot be used.
    const attempts: JudgeAnswer[] = [];
    let evaluation: Evaluation | null = null;
    let failed: string | null = null;
    for (let attempt = 1; attempt <= 2 && !evaluation && !failed; attempt++) {
      const last = attempts.at(-1);
      const a = await o.judge.ask({ day: d.day, attempt, system: SYSTEM, prompt: last ? prompt + retryNote(last.error!) : prompt, schema: JUDGE_SCHEMA });
      let error = a.error;
      if (a.tool_free === false) failed = `a tool ran or was offered: ${a.tool_detail}`;
      // Only an answer that proves no tool ran is used; one without proof counts as unusable.
      if (!error && !failed && a.tool_free !== true) error = "the answer carries no proof that no tool ran";
      if (!error && !failed) {
        try {
          evaluation = parse(a.output, v.basis, o.judge.name);
        } catch (e) {
          if (!(e instanceof ParseError)) throw e;
          error = e.message;
        }
      }
      attempts.push({ ...a, error });
      journal.append({
        type: "judge_output", day: d.day, attempt, duration_ms: a.duration_ms, exit_code: a.exit_code, timed_out: a.timed_out,
        tool_free: a.tool_free, cli_version: a.cli_version, model: a.model, cost_usd: a.cost_usd, raw: a.raw, stderr: a.stderr,
        evaluation, error: failed ?? error,
      });
    }
    if (!evaluation && !failed) failed = `no usable answer after ${attempts.length} attempts: ${attempts.at(-1)!.error}`;
    say(report.answer(evaluation, attempts));
    // No attempt showed a tool; an answer that was used proved that none ran.
    const tool_free = !attempts.some((a) => a.tool_free === false);

    if (failed) {
      journal.append({ type: "judge_failed", day: d.day, reason: failed });
      say(report.failed(d.day, failed));
      results.push({ day: d.day, now, added: d.observations.map((x) => x.id), observations: [...observations], evaluation: null, result: null, state, failed, tool_free, trace_ok: true });
    } else {
      const r = step(definition, state, observations, evaluation!, now);
      journal.append({
        type: "step", day: d.day, now, evaluation: evaluation!, transitions: r.transitions, attention_events: r.attention_events,
        deliveries: r.deliveries, improvement_events: r.improvement_events, rejections: r.rejections, state_digest: r.state_digest,
      });
      state = r.state;
      for (const delivery of r.deliveries) {
        const written = inbox.deliver(delivery, d.day, now);
        journal.append({ type: "delivery", day: d.day, delivery_id: delivery.id, route: delivery.route, written });
      }
      const violations = trace(state, r, journal.signals());
      journal.append({ type: "trace_check", day: d.day, ok: !violations.length, violations });
      say(report.decisions(evaluation!, r, state));
      const dayFailed = violations.length ? `trace check: ${violations.join("; ")}` : null;
      if (dayFailed) say(report.failed(d.day, dayFailed, "The step was applied, but its evidence does not trace to the journal."));
      results.push({ day: d.day, now, added: d.observations.map((x) => x.id), observations: [...observations], evaluation, result: r, state, failed: dayFailed, tool_free, trace_ok: !violations.length });
    }

    if (o.pause && d !== o.scenario.days.at(-1)) {
      o.print("Enter: next day · q: stop\n");
      const line = await o.pause();
      if (line === null || line.trim().toLowerCase() === "q") {
        journal.append({ type: "run_stopped", day: d.day });
        say(`Stopped after D${d.day}.\n`);
        stopped = true;
        break;
      }
    }
  }

  const checks = stopped || !o.checks ? [] : o.checks(results, o.scenario);
  const failedDays = results.filter((r) => r.failed).map((r) => r.day);
  // Everything in the run directory so far, the journal also decoded, and the report about to be written.
  const values = secretValues(o.env);
  const files = readdirSync(o.dir).map((name) => readFileSync(join(o.dir, name), "utf8"));
  const decoded = journal.entries.flatMap((entry) => strings(entry));
  const secrets_absent = ![...files, ...text, ...decoded].some((content) => leaks(content, values));
  const status = stopped ? "stopped" : failedDays.length || checks.some((c) => !c.ok) || !secrets_absent ? "failed" : "passed";
  say(report.summary(status, failedDays, checks, secrets_absent));
  writeFileSync(join(o.dir, "report.md"), text.join("\n"));
  journal.append({ type: "run_finished", at: clock(), status, failed_days: failedDays, checks, secrets_absent });
  return { status, results, checks, secrets_absent };
}
