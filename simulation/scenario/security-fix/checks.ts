// The acceptance criteria of the security-fix scenario that code can decide. Whether an
// Improvement's wording proposes a sensible change is for a person to judge; the report
// shows it.
import { assess, digest } from "../../../src/index.ts";
import type { Check } from "../../../src/index.ts";
import type { CheckResult, DayResult, Scenario } from "../../loop.ts";

const APP = "macro-studio";
const SCAN = "prerelease-scan-d6";

export function checks(results: DayResult[], scenario: Scenario): CheckResult[] {
  const { definition } = scenario;
  const caseOf = (finding_id: string) => digest({ definition_id: definition.id, subject_type: "finding", keys: { app: APP, finding_id } });
  const f17 = caseOf("F-17");
  const dast = caseOf("DAST-301");
  const day = (n: number) => results.find((r) => r.day === n);
  const out: CheckResult[] = [];
  const add = (name: string, ok: boolean, detail = "") => out.push({ name, ok, detail });
  const allMet = (c: Check | undefined) => !!c && c.result === "met" && c.criteria.every((k) => k.routes.every((r) => r.rules.every((x) => x.result === "met")));

  // D1
  const d1 = day(1)?.result;
  add("D1: case F-17 opens", !!d1?.transitions.some((t) => t.case_id === f17 && t.kind === "opened"));
  add("D1: security_review opens on F-17 with its check met",
    !!d1?.attention_events.some((e) => e.case_id === f17 && e.type === "security_review" && e.event === "opened" && allMet(e.gate_check)));
  add("D1: exactly one delivery, to security-oncall",
    d1?.deliveries.length === 1 && d1.deliveries[0]!.route === "security-oncall", `${d1?.deliveries.map((x) => x.route).join(", ") ?? "no step"}`);

  // By D4
  const s4 = day(4)?.state;
  add("By D4: security_review on F-17 is closed", s4?.cases[f17]?.attentions.security_review?.status === "closed");

  // D4
  const d4 = day(4);
  const resolved = d4?.result?.transitions.find((t) => t.case_id === f17 && t.to === "resolved" && t.kind === "status_changed");
  add("D4: F-17 is resolved, with its closing check met", !!resolved && resolved.closing_check?.result === "met");
  const assessed = d4?.state?.cases[f17] ? assess(definition, d4.state, f17, d4.observations, d4.now).result : null;
  add("D4: assess is unknown (closed at source; outcome not verified)", assessed === "unknown", `${assessed}`);

  // D5
  const d5 = day(5)?.result;
  const quiet = !!d5 && !d5.attention_events.length && !d5.deliveries.length
    && !d5.transitions.some((t) => t.kind === "opened" || (t.kind === "status_changed" && t.to === "open"));
  add("D5: quiet (no Attention event, no delivery, no case opened or reopened)", quiet);

  // D6
  const d6 = day(6);
  const r6 = d6?.result;
  add("D6: case DAST-301 opens, citing the scan",
    !!r6?.transitions.some((t) => t.case_id === dast && t.kind === "opened" && t.added_evidence.some((e) => e.obs_id === SCAN)));
  add("D6: release_review opens on DAST-301 with both rules met",
    !!r6?.attention_events.some((e) => e.case_id === dast && e.type === "release_review" && e.event === "opened"
      && allMet(e.gate_check) && e.gate_check!.criteria[0]!.routes[0]!.rules.length === 2));
  add("D6: exactly one delivery, to release-review",
    r6?.deliveries.length === 1 && r6.deliveries[0]!.route === "release-review", `${r6?.deliveries.map((x) => x.route).join(", ") ?? "no step"}`);
  const earlier = new Set(results.filter((r) => r.day <= 4).flatMap((r) => r.added)
    .filter((id) => results.flatMap((r) => r.observations).find((o) => o.id === id)?.subjects.some((s) => s.keys.finding_id === "F-17")));
  const cited = (r6?.improvement_events ?? []).map((e) => d6!.state!.improvements[e.improvement_id]!)
    .filter((i) => Object.hasOwn(i.evidence, SCAN) && Object.keys(i.evidence).some((id) => earlier.has(id)));
  add("D6: an Improvement cites the scan and an F-17 observation from D1–D4", cited.length > 0,
    cited.map((i) => `${i.key} [${Object.keys(i.evidence).sort().join(", ")}]`).join("; "));

  // Every day
  add("Every day: a usable answer", results.every((r) => !(r.failed && !r.result)), results.filter((r) => r.failed && !r.result).map((r) => `D${r.day}`).join(", "));
  add("Every day: trace checks pass", results.every((r) => r.trace_ok));
  add("Every day: no tool ran", results.every((r) => r.tool_free));
  add("All six days ran", results.length === scenario.days.length);
  return out;
}
