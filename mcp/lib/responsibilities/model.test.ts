import assert from "node:assert/strict";
import test from "node:test";

import { MAX_COLUMNS, MAX_ROW_ARRAY_ITEMS, MAX_ROW_STRING, normaliseRows, Refusal, refuseUnstorableText } from "./model.ts";

/** The row checks the host makes before anything reaches the database or the core. */

function refused(work: () => unknown): Record<string, unknown> {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof Refusal, String(error));
    return error.toJSON();
  }
  assert.fail("expected a refusal");
}

test("rows of the five value kinds pass unchanged; a column like an Object.prototype member is an own column", () => {
  const rows: Record<string, unknown>[] = [
    { submission: "7f3c", priority: 2, ratio: 0.5, duplicate: false, closed: null, reports: ["FIND-2", "FIND-1"] },
    { constructor: "x", to_string: "y" },
  ];
  const checked = normaliseRows("bugcrowd", rows);
  assert.deepEqual(checked, rows, "arrays keep their order: a row is data, not a set");
  assert.ok(Object.hasOwn(checked[1], "constructor"));
});

test("limits: columns, names, strings, numbers, arrays", () => {
  const code = (row: Record<string, unknown>) => refused(() => normaliseRows("k", [row])).error;
  assert.equal(code(Object.fromEntries(Array.from({ length: MAX_COLUMNS + 1 }, (_, i) => [`c${i}`, 1]))), "invalid_row");
  assert.equal(code({ "Bad Key": 1 }), "invalid_row");
  assert.equal(code({ ["a".repeat(61)]: 1 }), "invalid_row");
  assert.equal(code({ s: "x".repeat(MAX_ROW_STRING + 1) }), "invalid_row");
  assert.equal(code({ n: Number.POSITIVE_INFINITY }), "invalid_row");
  assert.equal(code({ a: Array.from({ length: MAX_ROW_ARRAY_ITEMS + 1 }, () => "x") }), "invalid_row");
  assert.equal(code({ a: [1] }), "invalid_row");
  assert.equal(code({ o: { nested: true } }), "invalid_row");
  assert.equal(code({ s: "a\u0000b" }), "invalid_row", "Postgres cannot store U+0000");
  assert.equal(code({ s: "\ud800" }), "invalid_row", "an unpaired surrogate is not text");

  const detail = refused(() => normaliseRows("review", [{ a: 1 }, { b: "é" }]));
  assert.deepEqual(detail, {
    error: "not_nfc",
    reason: 'review row 1 column "b" is not NFC; send it in NFC.',
    kind: "review",
    row: 1,
    column: "b",
  });
  assert.equal(refused(() => normaliseRows("k", [{ a: ["ok", "é"] }])).error, "not_nfc", "array items too");
  assert.deepEqual(normaliseRows("k", [{ b: "é" }]), [{ b: "é" }], "NFC passes");
});

test("unstorable text anywhere in a value is refused, keys included", () => {
  assert.equal(refused(() => refuseUnstorableText({ a: [{ b: "x\u0000" }] })).path, "$.a[0].b");
  assert.equal(refused(() => refuseUnstorableText({ ["k\ud800"]: 1 })).error, "invalid_text");
  refuseUnstorableText({ title: "fine", list: ["é", 1, null], nothing: undefined });
});
