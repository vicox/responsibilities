import { digest, step, view } from "../src/index.ts";
import type { Definition, Observation, Proposal, ProposedAttention, ProposedImprovement, State, StepResult } from "../src/index.ts";

export const definition: Definition = {
  id: "security-reports",
  version: 1,
  identity: { subject_type: "report", subject_keys: ["report"] },
  accountable: "team:security",
  expectations: "Every report gets an owner within one working day.",
  include: ["open_reports", "closed_reports"],
  closing: [
    { description: "The report is no longer open.", rules: [{ kind: "open_reports", match: { report: "report" }, condition: "absent", scope: "all" }] },
    { description: "Somebody confirmed the fix." },
  ],
  success: [
    { description: "The report was fixed.", rules: [{ kind: "closed_reports", match: { report: "report" }, where: { resolution: "fixed" } }] },
  ],
  attention_types: [
    {
      key: "needs_owner", description: "Nobody owns the report yet.",
      when: [{ kind: "open_reports", match: { report: "report" }, where: { state: "new" } }], delivery: { route: "security-oncall" },
    },
    { key: "review", description: "Someone should read the report." },
  ],
};

/** The same Responsibility without closing rules: resolving needs new evidence. */
export const wordsOnly: Definition = { ...definition, closing: [{ description: "Somebody confirmed the fix." }] };

export const at = (day: number, minute = 0): string => `2026-11-${String(day).padStart(2, "0")}T09:${String(minute).padStart(2, "0")}:00.000Z`;
export const subject = (report: number | string) => ({ type: "report", keys: { report } });
export const caseOf = (report: number | string, d: Definition = definition): string =>
  digest({ definition_id: d.id, subject_type: "report", keys: { report } });
export const improvementOf = (key: string, d: Definition = definition): string => digest({ definition_id: d.id, key });

/** A complete list of open reports, each in `state` (`new` unless named). */
export const openList = (id: string, day: number, reports: (number | string)[], complete = true, state = "new"): Observation => ({
  id, kind: "open_reports", occurred_at: at(day), subjects: reports.map(subject), rows: reports.map((report) => ({ report, state })), complete,
});

export const closedList = (id: string, day: number, rows: Record<string, unknown>[], complete = true): Observation => ({
  id, kind: "closed_reports", occurred_at: at(day), subjects: [], rows: rows as Observation["rows"], complete,
});

export const propose = (report: number | string, status: "open" | "resolved", cites: string[], more: Partial<Proposal> = {}): Proposal =>
  ({ subject: subject(report), status, cites, ...more });

export const attention = (type: string, intent: ProposedAttention["intent"], reason = "Because."): ProposedAttention => ({ type, intent, reason });

export const improve = (key: string, cites: string[], more: Partial<ProposedImprovement> = {}): ProposedImprovement =>
  ({ key, title: "Assign on intake", change: "Assign an owner when a report arrives.", rationale: "Reports waited without an owner.", cites, ...more });

export interface Options { d?: Definition; improvements?: ProposedImprovement[] }

/** `view`, then `step` with an evaluation bound to that view: one honest step. */
export function judge(state: State | null, observations: Observation[], proposals: Proposal[], now: string, o: Options = {}): StepResult {
  const d = o.d ?? definition;
  const v = view(d, state, observations, now);
  return step(d, state, observations, { basis: v.basis, evaluator: "test", proposals, ...(o.improvements ? { improvements: o.improvements } : {}) }, now);
}

/** Report 173 opened from `open-1` on day 2. */
export function opened(): StepResult {
  return judge(null, [openList("open-1", 2, [173])], [propose(173, "open", ["open-1"], { title: "Report 173 has no owner" })], at(2, 1));
}

export const codes = (r: StepResult) => r.rejections.map((x) => x.code);
