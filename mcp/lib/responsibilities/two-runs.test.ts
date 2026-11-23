/* eslint-disable @typescript-eslint/no-explicit-any -- tool results are read as the plain JSON they are */
import assert from "node:assert/strict";
import test from "node:test";

/**
 * P2-T10 (docs/core-integration-plan.md §8): the Bugcrowd scenario of §3.9 over
 * three runs, through the MCP endpoint and its eight tools, by two members on two
 * clients whose only shared memory is the service. Run 1 opens a case with a
 * gated `review` Attention; run 2 closes it and opens `needs_work`, and asking to
 * resolve another case while the Implement search is incomplete is refused by
 * the core (CLOSING_NOT_MET, unknown); run 3 resolves it on complete lists.
 */
process.env.PUBLIC_ORIGIN = "http://localhost:3000";
process.env.OAUTH_SIGNING_SECRET = "test-signing-secret-of-at-least-32-bytes";
process.env.DEV_DATABASE_DIR = "memory://"; // never the developer's .devdb

const { handleMcpRequest } = await import("../mcp/endpoint.ts");
const { deployment, signingKey } = await import("../oauth/config.ts");
const { mintAccessToken } = await import("../oauth/tokens.ts");
const { database } = await import("../db.ts");
const { memberIdFor, seedMembers } = await import("../testing.ts");
const { AGENT_A, AGENT_B, DEFINITION } = await import("./fixtures.ts");

const db = await database();
await seedMembers(db, ["alice", "bob"], "acme");
await db.query(
  `INSERT INTO oauth_clients (client_id, redirect_uris, client_name, registered_at)
   VALUES ('client-1', '{http://localhost/cb}', 'Claude Code', now()), ('client-2', '{http://localhost/cb}', 'Codex', now())`,
);

const PROTOCOL_VERSION = "2026-07-28";

async function tokenFor(member: string, clientId: string): Promise<string> {
  const { token } = await mintAccessToken(deployment(), signingKey(), { id: memberIdFor(member) }, clientId, "mcp", deployment().resource);
  return token;
}

type Result = { structuredContent?: Record<string, any>; isError?: boolean };

async function tool(token: string, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await handleMcpRequest(
    new Request("http://localhost:3000/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL_VERSION,
        "mcp-method": "tools/call",
        "mcp-name": name,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name,
          arguments: args,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }),
  );
  assert.equal(response.status, 200);
  const result = (await response.json()).result as Result;
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result)}`);
  return result.structuredContent!;
}

const s = (submission: string) => ({ type: "bugcrowd_submission", keys: { submission } });

test("P2-T10 three runs over the tools: open with a gated Attention, swap Attentions, CLOSING_NOT_MET, resolve", async () => {
  const alice = await tokenFor("alice", "client-1");
  const bob = await tokenFor("bob", "client-2");
  assert.deepEqual(await tool(alice, "put_responsibility", DEFINITION), {
    key: DEFINITION.key,
    version: 1,
    changed: true,
    previous_version: null,
  });

  // Run 1 (alice, Claude Code)
  const r1 = await tool(alice, "start_run", { responsibility: DEFINITION.key, agent: AGENT_A });
  assert.deepEqual(r1.include, ["bugcrowd", "review", "implement", "recently_closed"]);
  assert.deepEqual(r1.cases, []);
  const recorded = await tool(alice, "record_observations", {
    run_id: r1.run_id,
    observations: [
      { kind: "bugcrowd", complete: true, rows: [{ submission: "7f3c", state: "TRIAGED" }, { submission: "91aa", state: "NEW" }] },
      { kind: "review", complete: true, rows: [{ submission: "7f3c", finding: "FIND-12", status: "Review" }] },
      { kind: "implement", complete: true, rows: [] },
      { kind: "recently_closed", complete: true, rows: [] },
    ],
  });
  assert.deepEqual(recorded.observations.map((o: { id: string; rows: number }) => [o.id, o.rows]), [
    [`${r1.run_id}:bugcrowd`, 2],
    [`${r1.run_id}:review`, 1],
    [`${r1.run_id}:implement`, 0],
    [`${r1.run_id}:recently_closed`, 0],
  ]);
  const v1 = await tool(alice, "view_run", { run_id: r1.run_id });
  assert.equal(v1.spec, "responsibility-core/1");
  assert.equal(v1.observations.length, 4);
  assert.deepEqual(v1.attention_types.find((t: { key: string }) => t.key === "review"), {
    key: "review",
    description: "The finding waits in Review.",
    checked: true,
    routed: false,
  });
  const done1 = await tool(alice, "complete_run", {
    run_id: r1.run_id,
    outcome: "completed",
    evaluation: {
      basis: v1.basis,
      proposals: [
        {
          subject: s("7f3c"),
          status: "open",
          cites: [`${r1.run_id}:bugcrowd`, `${r1.run_id}:review`],
          title: "FIND-12",
          attentions: [{ type: "review", intent: "open", reason: "FIND-12 waits in Review" }],
        },
        { subject: s("91aa"), status: "open", cites: [`${r1.run_id}:bugcrowd`], attentions: [{ type: "needs_work", intent: "open", reason: "Triage 91aa" }] },
      ],
    },
  });
  assert.deepEqual(done1.rejections, []);
  assert.deepEqual(done1.transitions.map((t: { kind: string }) => t.kind), ["opened", "opened"]);
  const events1 = done1.attention_events.map((e: { type: string; event: string; gate_check?: { result: string } }) => [e.type, e.event, e.gate_check?.result ?? null]);
  assert.deepEqual(events1.sort(), [["needs_work", "opened", null], ["review", "opened", "met"]]);

  // Run 2 (bob, Codex): only the service connects it to run 1.
  const r2 = await tool(bob, "start_run", { responsibility: DEFINITION.key, agent: AGENT_B });
  assert.deepEqual(
    r2.cases.map((c: { subject: { keys: { submission: string } }; attentions: { type: string }[] }) => [c.subject.keys.submission, c.attentions.map((a) => a.type)]),
    [["7f3c", ["review"]], ["91aa", ["needs_work"]]],
  );
  await tool(bob, "record_observations", {
    run_id: r2.run_id,
    observations: [
      { kind: "bugcrowd", complete: true, rows: [{ submission: "7f3c", state: "TRIAGED" }] },
      { kind: "review", complete: true, rows: [] },
      { kind: "implement", complete: false, rows: [{ submission: "7f3c", ticket: "ABC-1", status: "In Progress" }] },
      { kind: "recently_closed", complete: true, rows: [] },
    ],
  });
  const v2 = await tool(bob, "view_run", { run_id: r2.run_id });
  assert.deepEqual(
    v2.observations.map((o: { id: string }) => o.id).sort(),
    [`${r1.run_id}:bugcrowd`, `${r1.run_id}:review`, ...["bugcrowd", "implement", "recently_closed", "review"].map((k) => `${r2.run_id}:${k}`)].sort(),
    "this run's observations and, from run 1, what the open cases rest on",
  );
  const done2 = await tool(bob, "complete_run", {
    run_id: r2.run_id,
    outcome: "partial",
    summary: "implement search incomplete",
    evaluation: {
      basis: v2.basis,
      proposals: [
        {
          subject: s("7f3c"),
          status: "open",
          cites: [`${r2.run_id}:review`, `${r2.run_id}:implement`],
          summary: "FIND-12 left Review; ABC-1 in progress",
          attentions: [
            { type: "review", intent: "close", reason: "FIND-12 no longer in Review" },
            { type: "needs_work", intent: "open", reason: "Fix ABC-1 (Ann)" },
          ],
        },
        { subject: s("91aa"), status: "resolved", cites: [`${r2.run_id}:bugcrowd`], attentions: [{ type: "needs_work", intent: "keep", reason: "still open" }] },
      ],
    },
  });
  assert.equal(done2.outcome, "partial");
  assert.deepEqual(done2.rejections.map((r: { code: string; ref: { part: string } }) => [r.code, r.ref.part]), [["CLOSING_NOT_MET", "status"]]);
  const check = done2.rejections[0].detail.closing_check;
  assert.equal(check.result, "unknown");
  const implement = check.criteria[0].routes[0].rules.find((r: { kind: string }) => r.kind === "implement");
  assert.deepEqual([implement.observation, implement.result], [`${r2.run_id}:implement`, "unknown"]);
  assert.deepEqual(
    done2.attention_events.map((e: { type: string; event: string }) => [e.type, e.event]).sort(),
    [["needs_work", "opened"], ["review", "closed"]],
  );

  // Run 3 (alice): every list complete, 91aa in none of them.
  const r3 = await tool(alice, "start_run", { responsibility: DEFINITION.key, agent: AGENT_A });
  await tool(alice, "record_observations", {
    run_id: r3.run_id,
    observations: [
      { kind: "bugcrowd", complete: true, rows: [{ submission: "7f3c", state: "TRIAGED" }] },
      { kind: "review", complete: true, rows: [] },
      { kind: "implement", complete: true, rows: [{ submission: "7f3c", ticket: "ABC-1", status: "In Progress" }] },
      { kind: "recently_closed", complete: true, rows: [] },
    ],
  });
  const v3 = await tool(alice, "view_run", { run_id: r3.run_id });
  const done3 = await tool(alice, "complete_run", {
    run_id: r3.run_id,
    outcome: "completed",
    evaluation: {
      basis: v3.basis,
      proposals: [
        { subject: s("91aa"), status: "resolved", cites: [`${r3.run_id}:bugcrowd`], attentions: [{ type: "needs_work", intent: "close", reason: "gone from every list" }] },
      ],
    },
  });
  assert.deepEqual(done3.rejections, []);
  assert.deepEqual(done3.transitions.map((t: { kind: string; to: string; closing_check?: { result: string } }) => [t.kind, t.to, t.closing_check?.result]), [
    ["status_changed", "resolved", "met"],
  ]);

  const ctx = await tool(bob, "get_responsibility", { key: DEFINITION.key });
  assert.deepEqual(ctx.cases.map((c: { subject: { keys: { submission: string } } }) => c.subject.keys.submission), ["7f3c"]);
  assert.deepEqual(ctx.cases[0].attentions.map((a: { type: string }) => a.type), ["needs_work"]);
  assert.equal(ctx.cases[0].summary, "FIND-12 left Review; ABC-1 in progress");
  assert.equal(ctx.last_run.run_id, r3.run_id);

  const history = await tool(bob, "get_case", { responsibility: DEFINITION.key, keys: { submission: "91aa" } });
  assert.equal(history.status, "resolved");
  assert.equal(history.episode, 2);
  assert.deepEqual(
    history.history.map((h: { run: { run_id: string; agent: { name: string }; by: string } }) => [h.run.run_id, h.run.agent.name, h.run.by]),
    [
      [r3.run_id, "claude-code", "alice@example.com"],
      [r2.run_id, "codex", "bob@example.com"],
      [r1.run_id, "claude-code", "alice@example.com"],
    ],
  );
  assert.equal(history.history[1].proposal.status, "resolved", "the refused proposal is history too");
  assert.deepEqual(history.history[1].attention_events, []);
});
