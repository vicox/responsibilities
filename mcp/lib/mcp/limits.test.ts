import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CITES,
  MAX_COLUMNS,
  MAX_KINDS_PER_RUN,
  MAX_PROPOSAL_ATTENTIONS,
  MAX_PROPOSALS,
  MAX_ROW_ARRAY_ITEMS,
  MAX_ROWS_PER_CALL,
} from "../responsibilities/model.ts";
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

test("MAX_TOOL_INPUT_ELEMENTS is record_observations at its limits; complete_run and put_responsibility at theirs are below it", () => {
  const list = <T>(length: number, item: (index: number) => T): T[] => Array.from({ length }, (_, index) => item(index));

  const observations = {
    run_id: "00000000-0000-4000-8000-000000000000",
    observations: list(MAX_KINDS_PER_RUN, (index) => ({
      kind: `k${index}`,
      complete: true,
      replace: false,
      rows: list(MAX_ROWS_PER_CALL / MAX_KINDS_PER_RUN, () =>
        Object.fromEntries(list(MAX_COLUMNS, (column) => [`c${column}`, list(MAX_ROW_ARRAY_ITEMS, (value) => `v${value}`)] as const)),
      ),
    })),
  };
  assert.equal(protocolElementCount(observations, Infinity), MAX_TOOL_INPUT_ELEMENTS);

  const completion = {
    run_id: "00000000-0000-4000-8000-000000000000",
    outcome: "completed",
    summary: "s",
    report: "r",
    evaluation: {
      basis: "0".repeat(64),
      proposals: list(MAX_PROPOSALS, (index) => ({
        subject: { type: "t", keys: { a: `S-${index}`, b: 1, c: 2 } },
        status: "open",
        cites: list(MAX_CITES, (cite) => `run:${cite}`),
        title: "t",
        summary: "s",
        attentions: list(MAX_PROPOSAL_ATTENTIONS, () => ({ type: "x", intent: "open", reason: "r" })),
      })),
    },
  };
  assert.ok(protocolElementCount(completion, Infinity) < MAX_TOOL_INPUT_ELEMENTS);

  const rules = list(10, () => ({ kind: "k", match: { a: "a", b: "b", c: "c" }, where: { x: 1 } }));
  const criterion = { description: "d", rules, any_of: list(10, () => ({ rules })) };
  const definition = {
    key: "k",
    title: "t",
    definition: {
      identity: { subject_type: "t", subject_keys: ["a", "b", "c"] },
      accountable: "a",
      expectations: "e",
      include: list(MAX_KINDS_PER_RUN, (index) => `k${index}`),
      closing: list(20, () => criterion),
      success: list(20, () => criterion),
      attention_types: list(20, () => ({ key: "x", description: "d", when: rules, delivery: { route: "r" } })),
    },
  };
  assert.ok(protocolElementCount(definition, Infinity) < MAX_TOOL_INPUT_ELEMENTS);
});
