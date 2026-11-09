// The report: per day the context sent, the judge's answer, each proposal taken or refused
// with its code and trace, Attention events with each rule's result, deliveries and
// Improvements. Printed to the console and written to report.md, from what the loop journals.
import { digest } from "../src/index.ts";
import type { Check, Evaluation, Proposal, Rejection, State, StepResult, Subject } from "../src/index.ts";

export const subjectText = (s: Subject): string => `${s.type} ${Object.entries(s.keys).map(([k, v]) => `${k}=${v}`).join(", ")}`;

/** The core's ref of a proposal: cites sorted, Attention entries ordered by (type, H(entry)). */
export function proposalRef(p: Proposal): string {
  const attentions = p.attentions?.map((a) => ({ a, h: digest(a) }))
    .sort((x, y) => (x.a.type < y.a.type ? -1 : x.a.type > y.a.type ? 1 : x.h < y.h ? -1 : x.h > y.h ? 1 : 0)).map(({ a }) => a);
  return digest({ ...p, cites: [...p.cites].sort(), ...(attentions ? { attentions } : {}) });
}

export function check(c: Check, indent = "    "): string[] {
  return [
    `${indent}check: ${c.result}`,
    ...c.criteria.flatMap((criterion) => criterion.routes.flatMap((route, i) => [
      ...(criterion.routes.length > 1 ? [`${indent}  route ${i + 1}: ${route.result}`] : []),
      ...route.rules.map((r) => `${indent}  ${criterion.routes.length > 1 ? "  " : ""}- ${r.kind} (${r.observation ?? "none"}): ${r.result}, ${r.reason}`),
    ])),
  ];
}

const rejectionLine = (x: Rejection): string[] => [
  `    ${x.code} on ${x.ref.part}${"key" in x.ref && x.ref.key ? ` ${x.ref.key}` : ""}: ${x.detail.message}${x.detail.unknown ? ` (${x.detail.unknown.join(", ")})` : ""}`,
  ...(x.detail.closing_check ? check(x.detail.closing_check, "      ") : []),
  ...(x.detail.gate_check ? check(x.detail.gate_check, "      ") : []),
];

export function header(o: { run_id: string; judge: string; model: string | null; dir: string; scenario: string }): string {
  return [
    `# Simulation ${o.run_id}`,
    "",
    `Judge: ${o.judge}${o.model ? ` (${o.model})` : ""}. Scenario: ${o.scenario}. Run directory: ${o.dir}`,
    "",
  ].join("\n");
}

export function dayStart(day: number, now: string, added: string[], prompt: string): string {
  return [
    `## D${day} · ${now}`,
    "",
    `New observations: ${added.length ? added.join(", ") : "(none)"}`,
    "",
    "### Context sent",
    "",
    "```text",
    prompt,
    "```",
    "",
  ].join("\n");
}

export function answer(
  evaluation: Evaluation | null,
  attempts: { error: string | null; duration_ms: number; tool_detail: string | null; model: string | null; cost_usd: number | null }[],
): string {
  const tries = attempts.map((a, i) => `- attempt ${i + 1}: ${a.error ? `unusable, ${a.error}` : "usable"}, ${(a.duration_ms / 1000).toFixed(1)} s`
    + `${a.model ? `, ${a.model}` : ""}${a.cost_usd === null ? "" : `, $${a.cost_usd.toFixed(4)}`}${a.tool_detail ? `; ${a.tool_detail}` : ""}`);
  return [
    "### The judge's answer",
    "",
    ...tries,
    "",
    ...(evaluation ? ["```json", JSON.stringify({ proposals: evaluation.proposals, improvements: evaluation.improvements ?? [] }, null, 2), "```", ""] : []),
  ].join("\n");
}

export function decisions(evaluation: Evaluation, r: StepResult, state: State | null): string {
  const subjectOf = (case_id: string) => (state?.cases[case_id] ? subjectText(state.cases[case_id]!.subject) : case_id);
  const refs = new Map(evaluation.proposals.map((p) => [proposalRef(p), p]));
  const out: string[] = ["### What the core decided", ""];

  out.push("Proposals:");
  if (!evaluation.proposals.length) out.push("  (none)");
  for (const [ref, p] of refs) {
    const refused = r.rejections.filter((x) => "proposal" in x.ref && x.ref.proposal === ref);
    const whole = refused.some((x) => x.ref.part === "proposal");
    const verdict = whole ? "refused" : refused.length ? "taken in part" : "taken";
    out.push(`  - ${subjectText(p.subject)} → ${p.status}: ${verdict}`);
    for (const x of refused) out.push(...rejectionLine(x));
  }
  const orphans = r.rejections.filter((x) => "proposal" in x.ref && !refs.has(x.ref.proposal));
  for (const x of orphans) out.push(...rejectionLine(x));

  out.push("", "Case transitions:");
  if (!r.transitions.length) out.push("  (none)");
  for (const t of r.transitions) {
    out.push(`  - ${subjectOf(t.case_id)}: ${t.kind}${t.from && t.from !== t.to ? ` ${t.from} → ${t.to}` : ` (${t.to})`}, evidence +[${t.added_evidence.map((e) => e.obs_id).join(", ")}]`);
    if (t.closing_check) out.push(...check(t.closing_check));
  }

  out.push("", "Attention events:");
  if (!r.attention_events.length) out.push("  (none)");
  for (const e of r.attention_events) {
    out.push(`  - ${subjectOf(e.case_id)}: ${e.type} ${e.event} (activation ${e.activation}), ${e.reason}`);
    if (e.gate_check) out.push(...check(e.gate_check));
  }

  out.push("", "Deliveries:");
  if (!r.deliveries.length) out.push("  (none)");
  for (const d of r.deliveries) out.push(`  - [${d.route}] ${d.type} for ${subjectText(d.subject)}, activation ${d.activation}`);

  out.push("", "Improvements:");
  const improvementRejections = r.rejections.filter((x) => x.ref.part === "improvement");
  if (!r.improvement_events.length && !improvementRejections.length) out.push("  (none)");
  for (const e of r.improvement_events) {
    const i = state?.improvements[e.improvement_id];
    out.push(`  - ${e.key} ${e.kind}: ${i?.title ?? ""}`);
    if (i) out.push(`    change: ${i.change}`, `    rationale: ${i.rationale}`, `    evidence: ${Object.keys(i.evidence).sort().join(", ")}`);
  }
  for (const x of improvementRejections) out.push(...rejectionLine(x));
  out.push("");
  return out.join("\n");
}

export function failed(day: number, reason: string, note = "The core was not called; the state is unchanged."): string {
  return [`### D${day} FAILED`, "", reason, "", note, ""].join("\n");
}

export function summary(status: string, failedDays: number[], checks: { name: string; ok: boolean; detail: string }[], secretsAbsent: boolean): string {
  return [
    "## Result",
    "",
    `Status: ${status.toUpperCase()}${failedDays.length ? `; failed days: ${failedDays.map((d) => `D${d}`).join(", ")}` : ""}`,
    "",
    ...checks.map((c) => `- ${c.ok ? "PASS" : "FAIL"} ${c.name}${c.detail ? `: ${c.detail}` : ""}`),
    `- ${secretsAbsent ? "PASS" : "FAIL"} no secret value in the run directory`,
    "",
  ].join("\n");
}
