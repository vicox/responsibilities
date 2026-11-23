import type { Proposal, Subject } from "../core.ts";
import { embeddedDriver } from "../db/pglite.ts";
import type { SqlDriver } from "../db/driver.ts";
import { migrateAll, seedMembers } from "../testing.ts";
import type { DefinitionInput } from "./host.ts";
import { Refusal } from "./model.ts";
import { responsibilityStore, type CompleteResult, type ObservationInput, type ResponsibilityStore } from "./store.ts";

/** Test fixtures for the responsibilities store (not a test file). */

const absent = (kind: string) => ({ kind, match: { submission: "submission" }, condition: "absent" as const, scope: "all" as const });

/**
 * The Bugcrowd responsibility of docs/core-integration-plan.md §3.9: four kinds,
 * closing when no complete list names the submission any more, and four
 * Attention types of which `review` is gated on the Review list.
 */
export const BUGCROWD: DefinitionInput = {
  identity: { subject_type: "bugcrowd_submission", subject_keys: ["submission"] },
  accountable: "team:security",
  expectations: "Every active submission is triaged, fixed, verified and closed on time.",
  include: ["bugcrowd", "review", "implement", "recently_closed"],
  closing: [
    {
      description: "No current source lists the submission.",
      rules: [absent("bugcrowd"), absent("review"), absent("implement"), absent("recently_closed")],
    },
  ],
  success: [],
  attention_types: [
    { key: "needs_work", description: "Someone has to act on the submission or its ticket." },
    {
      key: "review",
      description: "The finding waits in Review.",
      when: [{ kind: "review", match: { submission: "submission" } }],
    },
    { key: "verify", description: "The fix has to be verified." },
    { key: "ready_to_close", description: "The submission can be closed in Bugcrowd." },
  ],
};

export const DEFINITION = { key: "bugcrowd-findings", title: "Bugcrowd findings", definition: BUGCROWD };

export const AGENT_A = { name: "claude-code", model: "opus", skill: "lively-findings:status" };
export const AGENT_B = { name: "codex", skill: "lively-findings:status" };

export const submission = (id: string): Subject => ({ type: "bugcrowd_submission", keys: { submission: id } });

/** One complete observation of `kind` listing the given rows. */
export const listed = (kind: string, rows: Record<string, unknown>[] = [], complete = true): ObservationInput => ({
  kind,
  complete,
  rows,
});

/** All four kinds, complete and empty unless given. */
export const EMPTY: ObservationInput[] = BUGCROWD.include.map((kind) => listed(kind));

export type World = {
  db: SqlDriver;
  workspaceId: string;
  members: Record<string, string>;
  now: () => Date;
  advance: (ms: number) => void;
  set: (time: string) => void;
  storeFor: (member: string, client?: string, workspaceId?: string) => ResponsibilityStore;
  close: () => Promise<void>;
};

/** A fresh embedded database with workspace `acme` (alice, bob) and a movable clock. */
export async function world(driver?: SqlDriver): Promise<World> {
  const db = driver ?? (await embeddedDriver());
  await migrateAll(db);
  const { workspaceId, members } = await seedMembers(db, ["alice", "bob"], "acme");
  let current = new Date("2026-11-19T09:00:00.000Z");
  const now = () => new Date(current);
  return {
    db,
    workspaceId,
    members,
    now,
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
    },
    set: (time) => {
      current = new Date(time);
    },
    storeFor: (member, client = "client-a", ws = workspaceId) =>
      responsibilityStore(
        db,
        { workspaceId: ws, memberId: members[member] ?? member, clientId: client, clientName: `name of ${client}` },
        { now },
      ),
    close: () => db.close(),
  };
}

/** view_run, then complete_run with that view's basis. */
export async function judge(
  store: ResponsibilityStore,
  runId: string,
  proposals: Proposal[] = [],
  outcome: "completed" | "partial" = "completed",
): Promise<CompleteResult> {
  const { basis } = await store.viewRun({ run_id: runId });
  return store.completeRun({ run_id: runId, outcome, evaluation: { basis, proposals } });
}

/** The refusal code a promise rejects with. */
export async function refusal(promise: Promise<unknown>): Promise<string> {
  return (await refusalDetail(promise)).error as string;
}

/** The refusal a promise rejects with, as its JSON. */
export async function refusalDetail(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Refusal) return error.toJSON();
    throw error;
  }
  throw new Error("expected a refusal, got a result");
}
