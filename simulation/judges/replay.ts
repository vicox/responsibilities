// Hand-written judge outputs, one per day, answered without any model. Only the tests use
// it: the simulation's command line offers live judges only.
import type { Judge, JudgeAnswer, JudgeRequest } from "./judge.ts";

export function replayJudge(days: Record<string, unknown>, name = "replay"): Judge {
  return {
    name,
    model: null,
    flags: [],
    ask: async ({ day }: JudgeRequest): Promise<JudgeAnswer> => {
      const output = Object.hasOwn(days, String(day)) ? days[String(day)] : null;
      return {
        output, error: output === null ? `no scripted output for day ${day}` : null, tool_free: true, tool_detail: "no process",
        raw: JSON.stringify(output), stderr: "", exit_code: 0, timed_out: false, duration_ms: 0, cli_version: null, model: null, cost_usd: null,
      };
    },
  };
}
