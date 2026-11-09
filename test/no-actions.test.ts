// responsibility-core/1 has no Actions: the core asks for Attention and leaves acting to
// people and their systems. This guards the library, its contract and its documentation.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("..", import.meta.url);
const FORBIDDEN = ["offered_actions", "action_requests", "max_requests", "ACTION_", "OfferedAction"];

test("no Action API remains in src/, the schema, the README or the reference", () => {
  const files = [
    ...readdirSync(new URL("src/", root)).map((name) => `src/${name}`),
    "README.md",
    "docs/reference.md",
  ];
  assert.ok(files.includes("src/schema.json"));
  for (const file of files) {
    const text = readFileSync(new URL(file, root), "utf8");
    for (const word of FORBIDDEN) assert.ok(!text.includes(word), `${file} mentions ${word}`);
  }
});
