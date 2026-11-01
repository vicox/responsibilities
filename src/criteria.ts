import type { Check, Criterion, CriterionTrace, Json, Observation, Outcome, Rule, RuleTrace, Subject } from "./types.ts";
import { hasOwn } from "./validate.ts";

export const hasRules = (criterion: Criterion): boolean => criterion.rules !== undefined || criterion.any_of !== undefined;

/** Three-valued AND: any `not_met` decides, then any `unknown`. */
const all = (results: Outcome[]): Outcome =>
  results.includes("not_met") ? "not_met" : results.includes("unknown") ? "unknown" : "met";
/** Three-valued OR: any `met` decides, then any `unknown`. */
const any = (results: Outcome[]): Outcome =>
  results.includes("met") ? "met" : results.includes("unknown") ? "unknown" : "not_met";

/**
 * The criteria that have rules, read for one Subject against the latest observation of
 * each kind among `observations`. Criteria without rules are the judge's and are skipped.
 */
export function evaluate(criteria: Criterion[], subject: Subject, observations: Observation[]): Check {
  const latest = new Map<string, Observation>();
  for (const observation of observations) {
    const seen = latest.get(observation.kind);
    const later = !seen || (observation.occurred_at === seen.occurred_at ? observation.id > seen.id : observation.occurred_at > seen.occurred_at);
    if (later) latest.set(observation.kind, observation);
  }
  const traces = criteria.filter(hasRules).map((criterion): CriterionTrace => {
    const routes = (criterion.any_of ?? [{ rules: criterion.rules! }]).map(({ rules }) => {
      const traced = rules.map((r) => rule(r, subject, latest.get(r.kind)));
      return { result: all(traced.map((t) => t.result)), rules: traced };
    });
    return { description: criterion.description, result: any(routes.map((r) => r.result)), routes };
  });
  return { result: all(traces.map((t) => t.result)), criteria: traces };
}

function rule(r: Rule, subject: Subject, observation: Observation | undefined): RuleTrace {
  const absent = hasOwn(r, "condition");
  const answer = (result: Outcome, reason: string): RuleTrace =>
    ({ kind: r.kind, condition: absent ? "absent" : "present", observation: observation?.id ?? null, result, reason });
  if (!observation) return answer("unknown", `no observation of kind ${r.kind}`);

  const pairs = Object.entries(r.match).map(([column, key]) => [column, subject.keys[key]] as const);
  const joined = observation.rows.filter((row) => pairs.every(([column, value]) => hasOwn(row, column) && row[column] === value));

  if (absent) {
    if (joined.length) return answer("not_met", "the latest observation lists the subject");
    if (!observation.complete) return answer("unknown", "the latest observation is not complete, so silence is not absence");
    const unreadable = observation.rows.findIndex((row) => pairs.some(([column]) => !readable(row, column)));
    if (unreadable >= 0) return answer("unknown", `row ${unreadable} has no readable match column, so it may be the subject`);
    return answer("met", "the latest observation is complete and does not list the subject");
  }

  if (!joined.length) return answer("unknown", "no row lists the subject; a missing row is never an answer");
  const where = Object.entries((r as { where?: Record<string, Json> }).where ?? {});
  const verdicts = joined.map((row): Outcome => {
    if (where.every(([column, value]) => hasOwn(row, column) && row[column] === value)) return "met";
    const failed = where.some(([column, value]) => hasOwn(row, column) && row[column] !== null && row[column] !== value);
    return failed ? "not_met" : "unknown";
  });
  if (verdicts.includes("met")) return answer("met", "a row lists the subject with every where value");
  if (!observation.complete) return answer("unknown", "no listed row has every where value, but the observation is not complete");
  if (verdicts.includes("unknown")) return answer("unknown", "a row that lists the subject has no value for a where column");
  return answer("not_met", "every row that lists the subject has another where value");
}

/** A match column a Subject key could be in: a string, an integer, or an explicit null. */
function readable(row: { [column: string]: Json }, column: string): boolean {
  if (!hasOwn(row, column)) return false;
  const value = row[column];
  return value === null || typeof value === "string" || Number.isInteger(value);
}
