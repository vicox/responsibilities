// Traceability after each step: every piece of evidence of a Case or an Improvement must
// be an observation the journal recorded as a signal, byte for byte (its digest), and every
// Attention event and delivery must belong to a Case.
import { digest } from "../src/index.ts";
import type { Observation, State, StepResult } from "../src/index.ts";

export function trace(state: State | null, result: StepResult, signals: Map<string, Observation>): string[] {
  const violations: string[] = [];
  const evidence = (owner: string, linked: Record<string, string>) => {
    for (const [id, hash] of Object.entries(linked)) {
      const signal = signals.get(id);
      if (!signal) violations.push(`${owner} cites ${id}, which the journal never recorded`);
      else if (digest(signal) !== hash) violations.push(`${owner} cites ${id}, but the journaled observation differs`);
    }
  };
  for (const [id, c] of Object.entries(state?.cases ?? {})) evidence(`case ${id}`, c.evidence);
  for (const [id, i] of Object.entries(state?.improvements ?? {})) evidence(`improvement ${i.key} (${id})`, i.evidence);
  const cases = state?.cases ?? {};
  for (const e of result.attention_events) {
    if (!Object.hasOwn(cases, e.case_id)) violations.push(`attention event ${e.id} names case ${e.case_id}, which does not exist`);
  }
  const events = new Set(result.attention_events.map((e) => e.id));
  for (const d of result.deliveries) {
    if (!events.has(d.event_id)) violations.push(`delivery ${d.id} follows no attention event of this step`);
  }
  return violations;
}
