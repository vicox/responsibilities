import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  carryUnknowns,
  checkAssessments,
  checkDecision,
  contentHash,
  diffFacts,
  normaliseFacts,
  normaliseSources,
  Refusal,
  transition,
  type Assessment,
  type DecisionInput,
  type Source,
} from "./model.ts";

function refusalCode(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof Refusal, String(error));
    return error.code;
  }
  assert.fail("expected a refusal");
}

describe("fact validation and normalisation", () => {
  test("accepts the five value kinds and stores arrays sorted and de-duplicated", () => {
    const facts = normaliseFacts("S1", {
      "bugcrowd.state": "NEW",
      "bugcrowd.priority": 3,
      "bugcrowd.duplicate": false,
      "bugcrowd.submitted_at": null,
      "ticket.ABC-1.reports": ["FIND-2:Accepted", "FIND-1:?", "FIND-2:Accepted"],
    });
    assert.deepEqual(facts["ticket.ABC-1.reports"], ["FIND-1:?", "FIND-2:Accepted"]);
    assert.equal(facts["bugcrowd.submitted_at"], null);
  });

  test("refuses bad keys, values, sizes and counts with invalid_fact", () => {
    const bad: Record<string, unknown>[] = [
      { "Bugcrowd.state": "x" },
      { "a.b.c.d.e": "x" },
      { "a..b": "x" },
      { ["a." + "x".repeat(120)]: 1 },
      { a: "x".repeat(501) },
      { a: Number.POSITIVE_INFINITY },
      { a: { nested: true } },
      { a: [1, 2] },
      { a: Array.from({ length: 51 }, (_, i) => String(i)) },
      { a: ["x".repeat(201)] },
      Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, i])),
    ];
    for (const facts of bad) {
      assert.equal(refusalCode(() => normaliseFacts("S1", facts)), "invalid_fact", JSON.stringify(facts).slice(0, 60));
    }
  });

  test("a key may have up to three dotted segments after its group", () => {
    assert.ok(normaliseFacts("S", { "review.FIND-12.status": "Review", "a.b.c.d": 1 }));
  });
});

describe("sources", () => {
  test("normalisation makes reordered declarations identical", () => {
    const a = normaliseSources([
      { name: "review", complete: true, covers: ["review"] },
      { name: "bugcrowd", complete: true, count: 3, covers: ["bugcrowd", "bugcrowd"] },
    ]);
    const b = normaliseSources([
      { name: "bugcrowd", complete: true, count: 3, covers: ["bugcrowd"] },
      { name: "review", complete: true, covers: ["review"] },
    ]);
    assert.deepEqual(a, b);
  });

  test("a repeated source name is refused", () => {
    assert.equal(
      refusalCode(() =>
        normaliseSources([
          { name: "x", complete: true, covers: ["a"] },
          { name: "x", complete: false, covers: ["b"] },
        ]),
      ),
      "invalid_sources",
    );
  });
});

describe("coverage carry-over (§5.2 step 1)", () => {
  const sources: Source[] = [
    { name: "bugcrowd", complete: true, covers: ["bugcrowd"] },
    { name: "implement", complete: false, covers: ["ticket"] },
    { name: "recently_closed", complete: true, covers: ["ticket"] },
  ];

  test("absent under a complete source stays absent; incomplete or uncovered becomes null", () => {
    const previous = { "bugcrowd.state": "NEW", "ticket.A-1.status": "Open", "review.F-1.status": "Review" };
    const carried = carryUnknowns(previous, {}, sources);
    assert.deepEqual(carried, { "ticket.A-1.status": null, "review.F-1.status": null });
  });

  test("present keys are never overwritten and there is nothing to carry without a previous observation", () => {
    assert.deepEqual(carryUnknowns({ "bugcrowd.state": "NEW" }, { "bugcrowd.state": "TRIAGED" }, sources), {
      "bugcrowd.state": "TRIAGED",
    });
    assert.deepEqual(carryUnknowns(null, { a: 1 }, sources), { a: 1 });
  });
});

describe("the diff (§5.2 step 2)", () => {
  test("added, removed, became_unknown, changed and unchanged are distinct", () => {
    const previous = {
      same: "x",
      gone: "y",
      unknown_now: "z",
      changed: "a",
      from_null: null,
      still_null: null,
      arr: ["a"],
    };
    const current = {
      same: "x",
      unknown_now: null,
      changed: "b",
      from_null: "v",
      still_null: null,
      arr: ["a"],
      fresh: 1,
    };
    const { changes, unchanged } = diffFacts(previous, current);
    assert.deepEqual(changes.added, ["fresh"]);
    assert.deepEqual(changes.removed, ["gone"]);
    assert.deepEqual(changes.became_unknown, ["unknown_now"]);
    assert.deepEqual(changes.changed, [
      { key: "changed", from: "a", to: "b" },
      { key: "from_null", from: null, to: "v" },
    ]);
    assert.equal(unchanged, 3);
  });

  test("an array to null, to [] and to a new member are three different results", () => {
    const previous = { a: ["FIND-1:Accepted"], b: ["FIND-1:Accepted"], c: ["FIND-1:Accepted"] };
    const { changes } = diffFacts(previous, { a: null, b: [], c: ["FIND-1:?"] });
    assert.deepEqual(changes.became_unknown, ["a"]);
    assert.deepEqual(
      changes.changed.map((one) => [one.key, one.to]),
      [
        ["b", []],
        ["c", ["FIND-1:?"]],
      ],
    );
  });

  test("keys named like Object.prototype members are ordinary facts", () => {
    // `constructor` is a valid key and is inherited by every plain object.
    const facts = normaliseFacts("S1", { constructor: "x", "constructor.name": 1, tostring: true });

    assert.deepEqual(diffFacts(null, facts).changes.added, ["constructor", "constructor.name", "tostring"]);
    assert.deepEqual(diffFacts(facts, facts), {
      changes: { added: [], removed: [], became_unknown: [], changed: [] },
      unchanged: 3,
    });
    assert.deepEqual(diffFacts({ constructor: "x" }, {}).changes.removed, ["constructor"]);
    assert.deepEqual(diffFacts({}, { constructor: "x" }).changes.added, ["constructor"]);
    assert.deepEqual(diffFacts({ constructor: "x" }, { constructor: "y" }).changes.changed, [
      { key: "constructor", from: "x", to: "y" },
    ]);

    const incomplete: Source[] = [{ name: "s", complete: false, covers: ["constructor"] }];
    assert.deepEqual(carryUnknowns({ constructor: "x" }, {}, incomplete), { constructor: null });
    assert.deepEqual(diffFacts({ constructor: "x" }, { constructor: null }).changes.became_unknown, ["constructor"]);
    const complete: Source[] = [{ name: "s", complete: true, covers: ["constructor"] }];
    assert.deepEqual(carryUnknowns({ constructor: "x" }, {}, complete), {});
  });

  test("no previous observation: every key is added", () => {
    assert.deepEqual(diffFacts(null, { a: 1, b: null }).changes.added, ["a", "b"]);
  });
});

describe("vocabulary and transitions (§5.3)", () => {
  const vocabulary: Assessment[] = [
    { label: "needs_work", attention: true },
    { label: "review", attention: true },
    { label: "nothing_due", attention: false },
    { label: "undetermined", attention: false },
  ];
  const decide = (over: Partial<DecisionInput>): DecisionInput => ({
    subject: "S1",
    assessment: "nothing_due",
    attention: null,
    basis: "b",
    ...over,
  });
  const attention = (target: string, action = "do it") => ({ action, target });

  test("vocabulary refusals", () => {
    assert.equal(refusalCode(() => checkDecision(decide({ assessment: "nope" }), vocabulary)), "unknown_assessment");
    assert.equal(refusalCode(() => checkDecision(decide({ assessment: "review" }), vocabulary)), "attention_mismatch");
    assert.equal(
      refusalCode(() => checkDecision(decide({ attention: attention("X-1") }), vocabulary)),
      "attention_mismatch",
    );
    assert.equal(
      refusalCode(() =>
        checkDecision(decide({ assessment: "review", attention: attention("X-1"), close: { reason: "r" } }), vocabulary),
      ),
      "close_with_attention",
    );
    assert.equal(refusalCode(() => checkAssessments([...vocabulary, vocabulary[0]])), "invalid_assessments");
  });

  const now = new Date("2026-11-19T12:00:00Z");
  const earlier = new Date("2026-11-01T08:00:00Z");
  const label = (name: string) => vocabulary.find((one) => one.label === name)!;

  test("same assessment and same target continues attention, whatever the action says", () => {
    const next = transition(
      { status: "open", attention_since: earlier },
      { assessment: "needs_work", attention: attention("ABC-1", "old words") },
      decide({ assessment: "needs_work", attention: attention("ABC-1", "new words") }),
      label("needs_work"),
      now,
    );
    assert.equal(next.attention, "continued");
    assert.equal(next.attention_since, earlier);
  });

  test("a different target or a different assessment opens a new streak", () => {
    for (const [assessment, target] of [
      ["needs_work", "ABC-2"],
      ["review", "ABC-1"],
    ]) {
      const next = transition(
        { status: "open", attention_since: earlier },
        { assessment: "needs_work", attention: attention("ABC-1") },
        decide({ assessment, attention: attention(target) }),
        label(assessment),
        now,
      );
      assert.equal(next.attention, "opened", `${assessment} ${target}`);
      assert.equal(next.attention_since, now);
    }
  });

  test("a label without attention ends a streak; close closes and clears it", () => {
    const ended = transition(
      { status: "open", attention_since: earlier },
      { assessment: "needs_work", attention: attention("ABC-1") },
      decide({ assessment: "undetermined" }),
      label("undetermined"),
      now,
    );
    assert.deepEqual([ended.status, ended.attention, ended.attention_since], ["open", "ended", null]);

    const closed = transition(
      { status: "open", attention_since: null },
      { assessment: "nothing_due", attention: null },
      decide({ close: { reason: "gone from every source" } }),
      label("nothing_due"),
      now,
    );
    assert.deepEqual(
      [closed.status, closed.closed_at, closed.close_reason, closed.attention_since, closed.attention],
      ["closed", now, "gone from every source", null, "none"],
    );
  });

  test("reopening a closed case: without attention it is plain open; with attention it opens a streak", () => {
    const plain = transition(
      { status: "closed", attention_since: null },
      { assessment: "nothing_due", attention: null },
      decide({ assessment: "undetermined" }),
      label("undetermined"),
      now,
    );
    assert.deepEqual([plain.status, plain.closed_at, plain.close_reason, plain.attention], ["open", null, null, "none"]);

    const withAttention = transition(
      { status: "closed", attention_since: null },
      { assessment: "needs_work", attention: attention("ABC-1") },
      decide({ assessment: "needs_work", attention: attention("ABC-1") }),
      label("needs_work"),
      now,
    );
    assert.deepEqual(
      [withAttention.status, withAttention.attention, withAttention.attention_since],
      ["open", "opened", now],
      "a closed case never continues a streak",
    );
  });

  test("the content hash ignores nothing that is versioned and depends on nothing else", () => {
    const content = { title: "T", subject_type: "s", expectation: "E", assessments: vocabulary };
    assert.equal(contentHash(content), contentHash({ ...content, assessments: [...vocabulary] }));
    assert.notEqual(contentHash(content), contentHash({ ...content, expectation: "E2" }));
    assert.notEqual(
      contentHash(content),
      contentHash({ ...content, assessments: [{ label: "needs_work", attention: false }, ...vocabulary.slice(1)] }),
    );
  });
});
