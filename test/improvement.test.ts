// Improvements: proposed changes to how the work is done, each citing evidence, kept
// independent of any one Case.
import assert from "node:assert/strict";
import { test } from "node:test";
import { digest } from "../src/index.ts";
import { at, closedList, codes, definition, improve, improvementOf, judge, openList, opened } from "./helpers.ts";

const o = [openList("open-1", 2, [173]), closedList("closed-1", 2, [{ report: 170, resolution: "fixed" }])];
const iid = improvementOf("assign-on-intake");

test("one citation is enough; the Improvement is recorded with its evidence and an event", () => {
  const r = judge(null, o, [], at(2, 1), { improvements: [improve("assign-on-intake", ["open-1"])] });
  assert.deepEqual(r.rejections, []);
  assert.deepEqual(r.state!.cases, {}, "no case is needed");
  assert.deepEqual(r.state!.improvements, {
    [iid]: {
      key: "assign-on-intake", title: "Assign on intake", change: "Assign an owner when a report arrives.", rationale: "Reports waited without an owner.",
      evidence: { "open-1": digest(o[0]) }, proposed_at: at(2, 1), updated_at: at(2, 1), seq: 1, version: 1,
    },
  });
  assert.deepEqual(r.improvement_events, [{
    id: digest([iid, 1]), improvement_id: iid, key: "assign-on-intake", kind: "proposed", actor: "judge:test",
    added_evidence: [{ obs_id: "open-1", digest: digest(o[0]) }],
    title: "Assign on intake", change: "Assign an owner when a report arrives.", rationale: "Reports waited without an owner.",
    version: 1, at: at(2, 1),
  }]);
});

test("refused: no citation, unknown citations, blank text, the same key twice", () => {
  const other = { ...openList("other-1", 2, [173]), kind: "unrelated" };
  const r = judge(null, [...o, other], [], at(2, 1), {
    improvements: [
      improve("none", []),
      improve("unknown", ["open-1", "missing", "other-1"]),
      improve("blank", ["open-1"], { change: "  " }),
      improve("twice", ["open-1"]), improve("twice", ["closed-1"], { title: "Other" }),
    ],
  });
  assert.deepEqual(r.rejections.map((x) => [x.ref.part, (x.ref as { key: string }).key, x.code]), [
    ["improvement", "blank", "IMPROVEMENT_INCOMPLETE"],
    ["improvement", "none", "NO_EVIDENCE"],
    ["improvement", "twice", "IMPROVEMENT_CONFLICT"], ["improvement", "twice", "IMPROVEMENT_CONFLICT"],
    ["improvement", "unknown", "UNKNOWN_EVIDENCE"],
  ]);
  assert.deepEqual(r.rejections.find((x) => x.code === "UNKNOWN_EVIDENCE")!.detail.unknown, ["missing", "other-1"]);
  assert.deepEqual([r.improvement_events, r.state!.improvements], [[], {}]);
  for (const x of r.rejections) assert.equal((x.ref as { improvement: string }).improvement.length, 64);
});

test("the same key again: nothing new emits nothing; new evidence or text is an update", () => {
  const first = judge(null, o, [], at(2, 1), { improvements: [improve("assign-on-intake", ["open-1"])] });
  const same = judge(first.state, o, [], at(2, 2), { improvements: [improve("assign-on-intake", ["open-1"])] });
  assert.deepEqual([same.improvement_events, same.rejections], [[], []]);
  assert.equal(same.state!.improvements[iid]!.seq, 1);

  const more = judge(first.state, o, [], at(2, 2), { improvements: [improve("assign-on-intake", ["closed-1", "open-1"])] });
  assert.deepEqual(more.improvement_events.map((e) => [e.id, e.kind, e.added_evidence.map((x) => x.obs_id), e.title]), [[digest([iid, 2]), "updated", ["closed-1"], undefined]]);
  assert.deepEqual(Object.keys(more.state!.improvements[iid]!.evidence).sort(), ["closed-1", "open-1"]);

  const reworded = judge(first.state, o, [], at(2, 2), { improvements: [improve("assign-on-intake", ["open-1"], { change: "Assign within one hour." })], d: { ...definition, version: 2 } });
  const [e] = reworded.improvement_events;
  assert.deepEqual([e!.kind, e!.change, "title" in e!, e!.version, e!.added_evidence], ["updated", "Assign within one hour.", false, 2, []]);
  assert.deepEqual([reworded.state!.improvements[iid]!.proposed_at, reworded.state!.improvements[iid]!.updated_at], [at(2, 1), at(2, 2)]);
});

test("Improvements and cases are independent in one evaluation", () => {
  const r = judge(opened().state, o, [], at(2, 2), { improvements: [improve("assign-on-intake", ["open-1"]), improve("label-on-intake", ["open-1"], { title: "Label" })] });
  assert.deepEqual(r.transitions, []);
  assert.deepEqual(r.improvement_events.map((e) => e.improvement_id), [iid, improvementOf("label-on-intake")].sort());
  assert.deepEqual(codes(r), []);
});
