import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { view } from "../../src/index.ts";
import type { Observation } from "../../src/index.ts";
import { loadScenario, SIMULATION } from "../loop.ts";
import { render, SYSTEM } from "../prompt.ts";

for (const [name, closing] of [["security-fix", "The report is resolved at its source."], ["support-handoff", "The customer's problem is solved and the case is solved in the helpdesk."]]) {
  test(`${name}: each day's prompt holds every observation so far and none of the rules`, () => {
    const { definition, days } = loadScenario(name!);
    const rules = [
      ...definition.closing.flatMap((c) => [...(c.rules ?? []), ...(c.any_of ?? []).flatMap((r) => r.rules)]),
      ...(definition.attention_types ?? []).flatMap((t) => t.when ?? []),
    ];
    assert.ok(rules.length >= 2);
    const all: Observation[] = [];
    for (const d of days) {
      all.push(...d.observations);
      const prompt = render(view(definition, null, all, d.judge_at), definition, d.judge_at);
      for (const o of all) assert.ok(prompt.includes(JSON.stringify(o)), `D${d.day} includes ${o.id}`);
      for (const rule of rules) assert.ok(!prompt.includes(JSON.stringify(rule)) && !prompt.includes(JSON.stringify(rule.match)), `D${d.day} shows no rule`);
      assert.ok(!/"(match|where|when|any_of)"/.test(prompt), `D${d.day} shows no rule keys`);
      for (const t of definition.attention_types!) assert.ok(prompt.includes(`${t.key}: ${t.description} (checked: opens only when its rules hold; delivered when opened)`));
      assert.ok(prompt.includes(`A case is over when:\n- ${closing}`));
    }
  });
}

test("the rules frame an Improvement as an observed possible gap, not an instruction or a remedy", () => {
  assert.ok(SYSTEM.includes("Attentions identify where action is needed now, in one case; Improvements identify where something could work better in how the work is done."));
  assert.ok(SYSTEM.includes("It is not an instruction, a remedy or a redesign of the process; a person decides what, if anything, changes."));
  assert.ok(SYSTEM.includes("state the gap in how the work is done, not what happened in one case, and no more certain than the evidence"));
  assert.ok(SYSTEM.includes("name what could work better, not how: propose no new step, check, tool, workflow, rule, signal or Responsibility"));
});

test("the template names nothing of either scenario", () => {
  const source = readFileSync(new URL("prompt.ts", SIMULATION), "utf8") + SYSTEM + readFileSync(new URL("judge-schema.json", SIMULATION), "utf8");
  for (const word of [
    "dast", "f-17", "scan", "release", "xss", "verif", "bugcrowd", "macro",
    "support", "engineer", "customer", "handoff", "handed", "escalat", "helpdesk", "sup-1042", "stall", "follow-up",
  ]) {
    assert.ok(!source.toLowerCase().includes(word), `the template mentions ${word}`);
  }
});
