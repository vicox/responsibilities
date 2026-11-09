import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { view } from "../../src/index.ts";
import type { Observation } from "../../src/index.ts";
import { SIMULATION } from "../loop.ts";
import { render, SYSTEM } from "../prompt.ts";
import { scenario } from "./helpers.ts";

test("each day's prompt holds every observation so far and none of the rules", () => {
  const { definition, days } = scenario;
  const rules = [
    ...definition.closing.flatMap((c) => [...(c.rules ?? []), ...(c.any_of ?? []).flatMap((r) => r.rules)]),
    ...(definition.attention_types ?? []).flatMap((t) => t.when ?? []),
  ];
  assert.ok(rules.length >= 5);
  const all: Observation[] = [];
  for (const d of days) {
    all.push(...d.observations);
    const prompt = render(view(definition, null, all, d.judge_at), definition, d.judge_at);
    for (const o of all) assert.ok(prompt.includes(JSON.stringify(o)), `D${d.day} includes ${o.id}`);
    for (const rule of rules) assert.ok(!prompt.includes(JSON.stringify(rule)) && !prompt.includes(JSON.stringify(rule.match)), `D${d.day} shows no rule`);
    assert.ok(!/"(match|where|when|any_of)"/.test(prompt), `D${d.day} shows no rule keys`);
    for (const t of definition.attention_types!) assert.ok(prompt.includes(`${t.key}: ${t.description} (checked: opens only when its rules hold; delivered when opened)`));
    assert.ok(prompt.includes("A case is over when:\n- The report is resolved at its source."));
  }
});

test("the template names nothing of the scenario", () => {
  const source = readFileSync(new URL("prompt.ts", SIMULATION), "utf8") + SYSTEM + readFileSync(new URL("judge-schema.json", SIMULATION), "utf8");
  for (const word of ["dast", "f-17", "scan", "release", "xss", "verif", "bugcrowd", "macro"]) {
    assert.ok(!source.toLowerCase().includes(word), `the template mentions ${word}`);
  }
});
