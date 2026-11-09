// The six-day arc through the scripted judge: every deterministic expectation of the
// scenario, with no model and no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate as evaluateCriteria } from "../../src/criteria.ts";
import { digest } from "../../src/index.ts";
import type { Subject } from "../../src/index.ts";
import { runOnce, scenario } from "./helpers.ts";

const subject = (finding_id: string): Subject => ({ type: "finding", keys: { app: "macro-studio", finding_id } });
const caseOf = (finding_id: string) => digest({ definition_id: "security-fixes-ship", subject_type: "finding", keys: subject(finding_id).keys });

test("the scripted arc passes every check, D5 is quiet and D6's reopening is refused as audit context", async () => {
  const run = await runOnce();
  assert.equal(run.status, "passed", run.checks.filter((c) => !c.ok).map((c) => c.name).join("; "));
  assert.ok(run.checks.length >= 14);
  assert.ok(run.checks.every((c) => c.ok));
  assert.equal(run.secrets_absent, true);

  const day = (n: number) => run.results.find((r) => r.day === n)!;
  assert.deepEqual(day(5).result!.transitions, [], "nothing proposed, nothing changed");
  assert.deepEqual([day(5).result!.attention_events, day(5).result!.deliveries], [[], []]);

  const d6 = day(6).result!;
  assert.deepEqual(d6.rejections.map((x) => [x.code, x.ref.part, "case_id" in x.ref ? x.ref.case_id : null]), [["REOPEN_WHILE_CLOSING_MET", "status", caseOf("F-17")]]);
  assert.equal(day(6).state!.cases[caseOf("F-17")]!.status, "resolved", "the refusal changed nothing");
  assert.ok(Object.hasOwn(day(6).state!.cases[caseOf("F-17")]!.evidence, "prerelease-scan-d6"), "the new evidence is still linked");
  assert.match(run.console, /REOPEN_WHILE_CLOSING_MET on status/);

  // D6's Improvement observes a possible gap, resting on F-17's evidence and the scan; it prescribes nothing.
  assert.ok(run.console.includes("  - fix-verification-gap proposed: Security fixes may be closed without sufficient verification\n"));
  assert.ok(run.console.includes("    rationale: A previously resolved security finding was detected again during a pre-release scan. This suggests a potential gap in how the effectiveness of security fixes is verified before findings are closed.\n"));
  assert.ok(run.console.includes("    evidence: bugcrowd-d1, bugcrowd-d4, prerelease-scan-d6, pull-requests-d3\n"));

  // One sink: the inbox holds the two deliveries, each once.
  const inbox = run.file("inbox.md");
  assert.equal(inbox.match(/^## \[/gm)!.length, 2);
  assert.match(inbox, /## \[security-oncall\] security_review · finding app=macro-studio, finding_id=F-17/);
  assert.match(inbox, /## \[release-review\] release_review · finding app=macro-studio, finding_id=DAST-301/);

  // One journal, typed records in order.
  const types = run.journal.map((e) => e.type);
  assert.equal(types[0], "run_started");
  assert.equal(types.at(-1), "run_finished");
  assert.equal(types.filter((t) => t === "step").length, 6);
  assert.equal(types.filter((t) => t === "signal").length, scenario.days.flatMap((d) => d.observations).length);
  assert.equal(types.filter((t) => t === "delivery").length, 2);
  assert.ok(run.journal.filter((e) => e.type === "trace_check").every((e) => e.type === "trace_check" && e.ok));
  assert.equal(run.file("report.md").includes("Status: PASSED"), true);
});

test("two runs give identical state digests, day by day", async () => {
  const digests = async () => (await runOnce()).journal.flatMap((e) => (e.type === "step" ? [e.state_digest] : []));
  const first = await digests();
  assert.equal(first.length, 6);
  assert.deepEqual(await digests(), first);
});

test("observations are cumulative: D6 alone leaves both checks unknown, D1..D6 meets them", () => {
  const { definition, days } = scenario;
  const all = days.flatMap((d) => d.observations);
  const only6 = days.at(-1)!.observations;
  const releaseReview = definition.attention_types!.find((t) => t.key === "release_review")!;
  const gate = (observations: typeof all) => evaluateCriteria([{ description: releaseReview.description, rules: releaseReview.when! }], subject("DAST-301"), observations).result;
  const closing = (observations: typeof all) => evaluateCriteria(definition.closing, subject("F-17"), observations).result;
  assert.deepEqual([closing(only6), gate(only6)], ["unknown", "unknown"]);
  assert.deepEqual([closing(all), gate(all)], ["met", "met"]);
});
