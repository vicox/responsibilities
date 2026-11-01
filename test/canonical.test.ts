import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { canonical, digest } from "../src/index.ts";

test("RFC 8785: numbers serialize as ECMAScript does", () => {
  // RFC 8785, Appendix B
  const cases: [number, string][] = [
    [0, "0"], [-0, "0"], [1, "1"], [-1, "-1"], [4.5, "4.5"], [0.002, "0.002"], [1e-7, "1e-7"], [1e21, "1e+21"],
    [333333333.33333329, "333333333.3333333"], [1e30, "1e+30"], [9007199254740991, "9007199254740991"],
    [5e-324, "5e-324"], [1.7976931348623157e308, "1.7976931348623157e+308"],
  ];
  for (const [value, text] of cases) assert.equal(canonical(value), text);
});

test("RFC 8785: keys sort by UTF-16 code units, strings escape minimally", () => {
  // RFC 8785, section 3.2.3
  const sorted = { "€": "Euro Sign", "\r": "Carriage Return", "דּ": "Hebrew Letter Dalet With Dagesh", "1": "One",
    "😀": "Emoji: Grinning Face", "\u0080": "Control", "ö": "Latin Small Letter O With Diaeresis" };
  const order = ["\r", "1", "\u0080", "ö", "€", "😀", "דּ"] as const;
  assert.equal(canonical(sorted), `{${order.map((key) => `${JSON.stringify(key)}:${JSON.stringify(sorted[key])}`).join(",")}}`);
  assert.equal(canonical("\u0000\b\f\n\r\t\"\\/\u001f\u007f€"), "\"\\u0000\\b\\f\\n\\r\\t\\\"\\\\/\\u001f\u007f€\"");
  assert.equal(canonical({ b: [1, { d: true, c: null }], a: "x" }), "{\"a\":\"x\",\"b\":[1,{\"c\":null,\"d\":true}]}");
});

test("non-JSON values are refused", () => {
  const refused = [undefined, Number.NaN, Infinity, () => 1, { a: undefined }, new Array(2), "\uD800", { "\uDC00": 1 }, new Date(0), new Map()];
  for (const value of refused) assert.throws(() => canonical(value), TypeError);
});

test("digest is SHA-256 of the canonical UTF-8 bytes", () => {
  const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  for (const length of [0, 1, 54, 55, 56, 63, 64, 65, 119, 120, 1000]) {
    const value = Array.from("ä€😀x".repeat(length)).slice(0, length).join("");
    assert.equal(digest(value), sha(JSON.stringify(value)), `length ${length}`);
  }
  assert.equal(digest({ b: 1, a: 2 }), digest({ a: 2, b: 1 }));
  assert.equal(digest(null), sha("null"));
});
