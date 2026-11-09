// A fixture is a recorded sequence of calls without their state: replaying threads the
// state from each step or command into the next call, and every output must match
// byte for byte (its digest). After an intended change: npm run fixtures.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { assess, command, digest, SPEC, step, view } from "../src/index.ts";
import type { State, StepResult } from "../src/index.ts";
import type { Call } from "./recorder.ts";

export interface Fixture {
  spec: string;
  calls: { fn: Call["fn"]; args: Record<string, any>; state_digest?: string; result_digest: string }[];
}

export function record(calls: Call[]): Fixture {
  return {
    spec: SPEC,
    calls: calls.map(({ fn, args, result }) => ({
      fn,
      args,
      ...(fn === "step" || fn === "command" ? { state_digest: (result as StepResult).state_digest } : {}),
      result_digest: digest(result),
    })),
  };
}

/** Each call's state (threaded) and result. */
export function replay(fixture: Fixture): { state: State | null; result: unknown }[] {
  let state: State | null = null;
  return fixture.calls.map(({ fn, args: a }) => {
    const before = state;
    let result: unknown;
    if (fn === "view") result = view(a.definition, state, a.observations, a.now);
    if (fn === "assess") result = assess(a.definition, state, a.case_id, a.observations, a.now);
    if (fn === "step") state = (result = step(a.definition, state, a.observations, a.evaluation, a.now)).state;
    if (fn === "command") state = (result = command(a.definition, state, a.command, a.now)).state;
    return { state: before, result };
  });
}

/** The recorded calls are `fixtures/<name>`, and they thread state as a replay does. */
export function matchFixture(name: string, calls: Call[]): void {
  const path = new URL(`../fixtures/${name}`, import.meta.url);
  const recorded = record(calls);
  if (process.env.UPDATE_FIXTURES) writeFileSync(path, `${JSON.stringify(recorded, null, 2)}\n`);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), recorded, `fixtures/${name} is this recording`);
  assert.deepEqual(replay(recorded).map((r) => r.state), calls.map((c) => c.state));
}
