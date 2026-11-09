// The library, with every call recorded: what the README example imports in its test.
import * as core from "../src/index.ts";
import type { State } from "../src/index.ts";

export * from "../src/index.ts";

export interface Call {
  fn: "view" | "step" | "command" | "assess";
  state: State | null;
  args: Record<string, unknown>;
  result: unknown;
}

export const calls: Call[] = [];

export const view: typeof core.view = (definition, state, observations, now) => {
  const result = core.view(definition, state, observations, now);
  calls.push({ fn: "view", state, args: { definition, observations, now }, result });
  return result;
};

export const step: typeof core.step = (definition, state, observations, evaluation, now) => {
  const result = core.step(definition, state, observations, evaluation, now);
  calls.push({ fn: "step", state, args: { definition, observations, evaluation, now }, result });
  return result;
};

export const command: typeof core.command = (definition, state, command, now) => {
  const result = core.command(definition, state, command, now);
  calls.push({ fn: "command", state, args: { definition, command, now }, result });
  return result;
};

export const assess: typeof core.assess = (definition, state, case_id, observations, now) => {
  const result = core.assess(definition, state, case_id, observations, now);
  calls.push({ fn: "assess", state, args: { definition, case_id, observations, now }, result });
  return result;
};
