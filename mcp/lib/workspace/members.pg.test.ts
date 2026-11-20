import assert from "node:assert/strict";
import test from "node:test";

import { sqlOAuthStore } from "../oauth/store/sql.ts";
import { pgSchema, pgSkip } from "../pg-testing.ts";
import { migrateAll } from "../testing.ts";
import { AccessDeniedError, addMember, addWorkspace, admitMember, mcpSession, removeMember } from "./members.ts";

/**
 * Membership races on real Postgres with independent connections (plan §11).
 */

const ROUNDS = 15;
const allow = () => undefined;

test("concurrent first-login binds: exactly one Google account is bound", { skip: pgSkip }, async () => {
  const { drivers, drop } = await pgSchema(2);
  try {
    await migrateAll(drivers[0]);
    await addWorkspace(drivers[0], "acme", "Acme");
    for (let round = 0; round < ROUNDS; round++) {
      const email = `p${round}@example.com`;
      const member = await addMember(drivers[0], "acme", email);
      const results = await Promise.allSettled([
        admitMember(drivers[0], { email, subject: `sub-a-${round}` }),
        admitMember(drivers[1], { email, subject: `sub-b-${round}` }),
      ]);
      const admitted = results.filter((r) => r.status === "fulfilled");
      const refused = results.filter((r) => r.status === "rejected");
      assert.equal(admitted.length, 1, `round ${round}`);
      assert.ok((refused[0] as PromiseRejectedResult).reason instanceof AccessDeniedError);

      const [row] = await drivers[0].query<{ google_sub: string }>(`SELECT google_sub FROM members WHERE id = $1`, [
        member.id,
      ]);
      const winner = results[0].status === "fulfilled" ? `sub-a-${round}` : `sub-b-${round}`;
      assert.equal(row.google_sub, winner);
    }
  } finally {
    await drop();
  }
});

test("member:remove racing refresh: refused, or minted and then refused at /mcp", { skip: pgSkip }, async () => {
  const { drivers, drop } = await pgSchema(2);
  try {
    await migrateAll(drivers[0]);
    await addWorkspace(drivers[0], "acme", "Acme");
    const outcomes = new Set<string>();
    for (let round = 0; round < ROUNDS; round++) {
      const email = `r${round}@example.com`;
      const member = await addMember(drivers[0], "acme", email);
      const store = sqlOAuthStore(drivers[1]);
      const refresh = await store.issueRefreshToken({
        clientId: "client-1",
        scope: "mcp",
        resource: "https://responsibilities.example/mcp",
        userId: member.id,
      });

      const [removed, rotated] = await Promise.allSettled([
        removeMember(drivers[0], email),
        store.rotateRefreshToken(refresh, allow),
      ]);
      assert.equal(removed.status, "fulfilled");
      assert.equal(rotated.status, "fulfilled");
      const rotation = (rotated as PromiseFulfilledResult<Awaited<ReturnType<typeof store.rotateRefreshToken>>>).value;
      outcomes.add(rotation.outcome);

      // Whatever the order, the removed member can no longer act.
      assert.equal(await mcpSession(drivers[0], member.id, "client-1"), undefined, "/mcp refuses");
      if (rotation.outcome === "rotated") {
        assert.deepEqual(await store.rotateRefreshToken(rotation.refreshToken, allow), { outcome: "unknown" });
      } else {
        assert.equal(rotation.outcome, "unknown");
      }
    }
    for (const outcome of outcomes) assert.ok(["rotated", "unknown"].includes(outcome), outcome);
  } finally {
    await drop();
  }
});
