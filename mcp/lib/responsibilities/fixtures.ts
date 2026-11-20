import { embeddedDriver } from "../db/pglite.ts";
import type { SqlDriver } from "../db/driver.ts";
import { migrateAll, seedMembers } from "../testing.ts";
import { Refusal, type Assessment, type Source } from "./model.ts";
import { responsibilityStore, type ResponsibilityStore } from "./store.ts";

/** Test fixtures for the responsibilities store (not a test file). */

export const VOCABULARY: Assessment[] = [
  { label: "needs_work", attention: true },
  { label: "review", attention: true },
  { label: "verify", attention: true },
  { label: "ready_to_close", attention: true },
  { label: "nothing_due", attention: false },
  { label: "undetermined", attention: false },
];

export const DEFINITION = {
  key: "bugcrowd-findings",
  title: "Bugcrowd findings",
  subject_type: "bugcrowd_submission",
  expectation: "Every active submission is triaged, fixed, verified and closed on time.",
  assessments: VOCABULARY,
};

export const SOURCES: Source[] = [
  { name: "bugcrowd", complete: true, count: 0, covers: ["bugcrowd"] },
  { name: "review", complete: true, count: 0, covers: ["review"] },
  { name: "implement", complete: true, count: 0, covers: ["ticket"] },
  { name: "recently_closed", complete: true, count: 0, covers: ["ticket"] },
];

export const AGENT_A = { name: "claude-code", model: "opus", skill: "lively-findings:status" };
export const AGENT_B = { name: "codex", skill: "lively-findings:status" };

export type World = {
  db: SqlDriver;
  workspaceId: string;
  members: Record<string, string>;
  now: () => Date;
  advance: (ms: number) => void;
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
    storeFor: (member, client = "client-a", ws = workspaceId) =>
      responsibilityStore(
        db,
        { workspaceId: ws, memberId: members[member] ?? member, clientId: client, clientName: `name of ${client}` },
        { now },
      ),
    close: () => db.close(),
  };
}

/** The refusal code a promise rejects with. */
export async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Refusal) return error.code;
    throw error;
  }
  throw new Error("expected a refusal, got a result");
}
