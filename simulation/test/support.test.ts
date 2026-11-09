// The support-handoff arc through the scripted judge: one customer case handed from
// Support to Engineering and forgotten; an escalation for a person now, an Improvement
// about the handoff for later. No model and no network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { digest } from "../../src/index.ts";
import { replayJudge } from "../judges/replay.ts";
import { loadScenario, SIMULATION } from "../loop.ts";
import { checks } from "../scenario/support-handoff/checks.ts";
import { runOnce } from "./helpers.ts";

const scenario = loadScenario("support-handoff");
const scripted = JSON.parse(readFileSync(new URL("scenario/support-handoff/scripted.json", SIMULATION), "utf8")).days as Record<string, unknown>;
const run = () => runOnce({ scenario, judge: replayJudge(scripted), checks });
const sup = digest({ definition_id: "customer-support-quality", subject_type: "customer_case", keys: { case: "SUP-1042" } });

test("the scripted support arc passes every check: quiet until D5, one escalation, closed once a person acted", async () => {
  const r = await run();
  assert.equal(r.status, "passed", r.checks.filter((c) => !c.ok).map((c) => c.name).join("; "));
  assert.ok(r.checks.length >= 13);
  assert.ok(r.checks.every((c) => c.ok));
  assert.equal(r.secrets_absent, true);
  assert.match(r.console, /Scenario: support-handoff\./);

  const day = (n: number) => r.results.find((x) => x.day === n)!;
  for (const n of [2, 3, 4]) assert.deepEqual([day(n).result!.attention_events, day(n).result!.deliveries], [[], []], `D${n} is quiet`);

  // One case across the handoff: Support's case and Engineering's ticket are its evidence.
  const final = day(6).state!;
  assert.deepEqual(Object.keys(final.cases), [sup]);
  assert.ok(["support-cases-d2", "engineering-tickets-d2", "engineering-tickets-d6"].every((id) => Object.hasOwn(final.cases[sup]!.evidence, id)));
  assert.equal(final.cases[sup]!.status, "open");

  // The Attention is over once a person acted; the Improvement stays for a person to decide.
  assert.deepEqual(final.cases[sup]!.attentions.escalation, { status: "closed", activation: 1, opened_at: "2026-11-06T18:00:00.000Z", closed_at: "2026-11-07T18:00:00.000Z" });
  assert.deepEqual(Object.values(final.improvements).map((i) => i.key), ["follow-up-after-handoff"]);
  assert.ok(r.console.includes("  - follow-up-after-handoff proposed: Customer cases handed to another team may lose follow-up\n"));
  assert.ok(r.console.includes("This suggests a potential gap in how follow-up is owned once a case moves from Support to Engineering."));
  assert.ok(r.console.includes("    evidence: engineering-tickets-d2, engineering-tickets-d5, support-cases-d2, support-cases-d5\n"));

  // One delivery, to the support lead.
  const inbox = r.file("inbox.md");
  assert.equal(inbox.match(/^## \[/gm)!.length, 1);
  assert.match(inbox, /## \[support-lead\] escalation · customer_case case=SUP-1042/);
  assert.equal(r.journal.filter((e) => e.type === "step").length, 6);
});

test("an escalation on D4, before three days have passed, fails the run", async () => {
  const early = structuredClone(scripted) as Record<string, any>;
  early["4"] = {
    proposals: [{ ...early["5"].proposals[0], cites: ["support-cases-d4", "engineering-tickets-d4"] }],
    improvements: [],
  };
  early["5"] = { proposals: [], improvements: early["5"].improvements };
  const r = await runOnce({ scenario, judge: replayJudge(early), checks });
  assert.equal(r.status, "failed");
  const failed = r.checks.filter((c) => !c.ok).map((c) => c.name);
  assert.ok(failed.includes("D2–D4: quiet (no Attention event, no delivery, no case opened or status changed)"));
  assert.ok(failed.includes("D5: escalation opens on SUP-1042 with its check met"));
});

test("a second case for Engineering's ticket, on any day, fails the run", async () => {
  const split = structuredClone(scripted) as Record<string, any>;
  split["6"].proposals.push({
    subject_type: "customer_case", subject_keys: [{ name: "case", value: "ENG-311" }], status: "open",
    cites: ["engineering-tickets-d6"], title: "PDF export times out in the renderer", summary: null, attentions: [],
  });
  const r = await runOnce({ scenario, judge: replayJudge(split), checks });
  assert.equal(Object.keys(r.results.find((x) => x.day === 6)!.state!.cases).length, 2, "the core opened the second case");
  assert.equal(r.status, "failed");
  assert.deepEqual(r.checks.filter((c) => !c.ok).map((c) => [c.name, c.detail]), [["Every day: one case only, SUP-1042", "another case on D6"]]);
});

test("the escalation's gate is the helpdesk's status: it holds while the case waits on Engineering", async () => {
  const r = await run();
  const opened = r.results.find((x) => x.day === 5)!.result!.attention_events[0]!;
  const rule = opened.gate_check!.criteria[0]!.routes[0]!.rules[0]!;
  assert.deepEqual([rule.kind, rule.observation, rule.result], ["support_cases", "support-cases-d5", "met"]);
});
