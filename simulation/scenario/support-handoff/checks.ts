// The acceptance criteria of the support-handoff scenario that code can decide. Whether an
// Improvement observes a plausible gap, worded no more certainly than its evidence and
// without prescribing a workflow, is for a person to judge; the report shows it.
import { digest } from "../../../src/index.ts";
import type { Check } from "../../../src/index.ts";
import type { CheckResult, DayResult, Scenario } from "../../loop.ts";

const CASE = "SUP-1042";

export function checks(results: DayResult[], scenario: Scenario): CheckResult[] {
  const { definition } = scenario;
  const sup = digest({ definition_id: definition.id, subject_type: "customer_case", keys: { case: CASE } });
  const day = (n: number) => results.find((r) => r.day === n);
  const out: CheckResult[] = [];
  const add = (name: string, ok: boolean, detail = "") => out.push({ name, ok, detail });
  const allMet = (c: Check | undefined) => !!c && c.result === "met" && c.criteria.every((k) => k.routes.every((r) => r.rules.every((x) => x.result === "met")));
  const quiet = (n: number) => {
    const r = day(n)?.result;
    return !!r && !r.attention_events.length && !r.deliveries.length
      && !r.transitions.some((t) => t.kind === "opened" || t.kind === "status_changed");
  };
  const observation = (id: string) => results.flatMap((r) => r.observations).find((o) => o.id === id);
  const addedOn = (days: number[]) => new Set(results.filter((r) => days.includes(r.day)).flatMap((r) => r.added));

  // D1
  const d1 = day(1)?.result;
  add("D1: case SUP-1042 opens", !!d1?.transitions.some((t) => t.case_id === sup && t.kind === "opened"));
  add("D1: no Attention event, no delivery", !!d1 && !d1.attention_events.length && !d1.deliveries.length);

  // D2–D4: the handoff, then two days of silence, need nobody yet.
  add("D2–D4: quiet (no Attention event, no delivery, no case opened or status changed)", [2, 3, 4].every(quiet),
    [2, 3, 4].filter((n) => !quiet(n)).map((n) => `D${n}`).join(", "));

  // D5: more than three days without progress or an update.
  const d5 = day(5)?.result;
  add("D5: escalation opens on SUP-1042 with its check met",
    !!d5?.attention_events.some((e) => e.case_id === sup && e.type === "escalation" && e.event === "opened" && allMet(e.gate_check)));
  add("D5: exactly one delivery, to support-lead",
    d5?.deliveries.length === 1 && d5.deliveries[0]!.route === "support-lead", `${d5?.deliveries.map((x) => x.route).join(", ") ?? "no step"}`);

  // The Responsibility follows the case across the handoff: one case, with Engineering's ticket as its evidence.
  const s5 = day(5)?.state;
  const ids = Object.keys(s5?.cases ?? {});
  add("By D5: one case only, SUP-1042", ids.length === 1 && ids[0] === sup, `${ids.length} case(s)`);
  add("By D5: SUP-1042 has Engineering's ticket as evidence",
    Object.keys(s5?.cases[sup]?.evidence ?? {}).some((id) => observation(id)?.kind === "engineering_tickets"));

  // D6: a person acted; the Attention is over, the Improvement stays for a person to decide.
  const d6 = day(6);
  const r6 = d6?.result;
  add("D6: escalation on SUP-1042 closes, no delivery",
    !!r6?.attention_events.some((e) => e.case_id === sup && e.type === "escalation" && e.event === "closed") && !r6.deliveries.length);
  add("D6: SUP-1042 stays open", d6?.state?.cases[sup]?.status === "open");
  const handoff = addedOn([2]);
  const silence = addedOn([3, 4, 5]);
  const cited = Object.values(d6?.state?.improvements ?? {})
    .filter((i) => Object.keys(i.evidence).some((id) => handoff.has(id)) && Object.keys(i.evidence).some((id) => silence.has(id)));
  add("By D6: an Improvement cites the handoff (D2) and a day without progress (D3–D5)", cited.length > 0,
    cited.map((i) => `${i.key} [${Object.keys(i.evidence).sort().join(", ")}]`).join("; "));

  // Every day
  add("Every day: a usable answer", results.every((r) => !(r.failed && !r.result)), results.filter((r) => r.failed && !r.result).map((r) => `D${r.day}`).join(", "));
  add("Every day: trace checks pass", results.every((r) => r.trace_ok));
  add("Every day: no tool ran", results.every((r) => r.tool_free));
  add("All six days ran", results.length === scenario.days.length);
  return out;
}
