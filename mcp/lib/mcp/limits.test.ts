import assert from "node:assert/strict";
import test from "node:test";

import { MAX_FACT_ARRAY_ITEMS, MAX_FACT_KEYS, MAX_SUBJECTS_PER_CALL } from "../responsibilities/model.ts";
import { protocolElementCount } from "./limits.ts";
import { MAX_TOOL_INPUT_ELEMENTS } from "./server.ts";

/**
 * The two element bounds of GHSA-46jr-4wx8-v453: what the protocol part of a
 * request may carry, and the largest tool arguments a tool legitimately takes.
 */

test("array elements and object members are counted, tool-call arguments left out", () => {
  assert.equal(protocolElementCount({ a: [1, 2, { b: null }] }, Infinity), 5);

  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x", arguments: { many: [1, 2, 3] } } };
  assert.equal(protocolElementCount(call, Infinity), 6, "the arguments member counts, its contents do not");

  const other = { jsonrpc: "2.0", id: 1, method: "prompts/get", params: { name: "x", arguments: { many: [1, 2, 3] } } };
  assert.equal(protocolElementCount(other, Infinity), 10, "only a tools/call's arguments are left out");

  assert.equal(protocolElementCount([call, call], Infinity), 14, "in a batch too, plus the batch's own elements");
});

test("counting stops once past the bound", () => {
  assert.equal(protocolElementCount({ icons: new Array(1_000_000).fill(0) }, 10), 11);
  assert.equal(protocolElementCount(new Array(1_000_000).fill({}), 10), 1_000_000);
});

test("MAX_TOOL_INPUT_ELEMENTS is record_observations at its limits; complete_run at its limits is below it", () => {
  const list = <T>(length: number, item: (index: number) => T): T[] => Array.from({ length }, (_, index) => item(index));

  const observations = {
    run_id: "00000000-0000-4000-8000-000000000000",
    sources: list(10, (index) => ({
      name: `source-${index}`,
      complete: true,
      count: 0,
      note: "",
      covers: list(10, (group) => `group_${group}`),
    })),
    subjects: list(MAX_SUBJECTS_PER_CALL, (index) => ({
      subject: `S-${index}`,
      facts: Object.fromEntries(
        list(MAX_FACT_KEYS, (key) => [`fact_${key}`, list(MAX_FACT_ARRAY_ITEMS, (value) => `v${value}`)] as const),
      ),
    })),
  };
  assert.equal(protocolElementCount(observations, Infinity), MAX_TOOL_INPUT_ELEMENTS);

  const completion = {
    run_id: "00000000-0000-4000-8000-000000000000",
    outcome: "completed",
    summary: "s",
    report: "r",
    decisions: list(1000, (index) => ({
      subject: `S-${index}`,
      assessment: "open",
      attention: { action: "a", target: "t", assignee: "x" },
      basis: "b",
      cites: list(20, (cite) => `fact_${cite}`),
      close: { reason: "r" },
    })),
  };
  assert.ok(protocolElementCount(completion, Infinity) < MAX_TOOL_INPUT_ELEMENTS);
});
