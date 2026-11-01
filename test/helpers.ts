import { digest, step, view } from "../src/index.ts";
import type { Definition, Observation, OfferedAction, Proposal, State, StepResult } from "../src/index.ts";

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
};

/** The same Responsibility without closing rules: resolving needs new evidence. */
export const wordsOnly: Definition = { ...definition, closing: [{ description: "Somebody confirmed the fix." }] };

export const offered: OfferedAction[] = [
  { key: "notify", params: { channel: "string", text: "string" } },
  { key: "label", params: { name: "string", urgent: "bool" } },
];

export const at = (day: number, minute = 0): string => `2026-11-${String(day).padStart(2, "0")}T09:${String(minute).padStart(2, "0")}:00.000Z`;
export const subject = (report: number | string) => ({ type: "report", keys: { report } });
export const caseOf = (report: number | string, d: Definition = definition): string =>
  digest({ definition_id: d.id, subject_type: "report", keys: { report } });

/** A complete list of open reports. */
export const openList = (id: string, day: number, reports: (number | string)[], complete = true): Observation => ({
  id, kind: "open_reports", occurred_at: at(day), subjects: reports.map(subject), rows: reports.map((report) => ({ report, state: "new" })), complete,
});

export const closedList = (id: string, day: number, rows: Record<string, unknown>[], complete = true): Observation => ({
  id, kind: "closed_reports", occurred_at: at(day), subjects: [], rows: rows as Observation["rows"], complete,
});

export const propose = (report: number | string, status: "open" | "resolved", cites: string[], more: Partial<Proposal> = {}): Proposal =>
  ({ subject: subject(report), status, cites, ...more });

export interface Options { d?: Definition; actions?: OfferedAction[]; max?: number }

/** `view`, then `step` with an evaluation bound to that view: one honest step. */
export function judge(state: State | null, observations: Observation[], proposals: Proposal[], now: string, o: Options = {}): StepResult {
  const d = o.d ?? definition, actions = o.actions ?? offered, max = o.max ?? 5;
  const v = view(d, state, observations, actions, max, now);
  return step(d, state, observations, actions, max, { basis: v.basis, evaluator: "test", proposals }, now);
}

/** Report 173 opened from `open-1` on day 2. */
export function opened(): StepResult {
  return judge(null, [openList("open-1", 2, [173])], [propose(173, "open", ["open-1"], { title: "Report 173 has no owner" })], at(2, 1));
}

export const codes = (r: StepResult) => r.rejections.map((x) => x.code);
