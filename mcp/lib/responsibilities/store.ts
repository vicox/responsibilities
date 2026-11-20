import { randomUUID } from "node:crypto";

import type { SqlDriver } from "../db/driver.ts";
import { isUuid } from "../workspace/members.ts";
import {
  canonicalJson,
  carryUnknowns,
  checkAssessments,
  checkDecision,
  contentHash,
  diffFacts,
  MAX_OPEN_CASES,
  normaliseFacts,
  normaliseSources,
  Refusal,
  RUN_IDLE_MS,
  RUN_LIFETIME_MS,
  RUN_LIMIT,
  sameJson,
  transition,
  type Assessment,
  type Attention,
  type Changes,
  type DecisionInput,
  type FactValue,
  type Facts,
  type ResponsibilityContent,
  type Source,
} from "./model.ts";

/**
 * The responsibilities store, opened for one session: a workspace, the member
 * and the client acting in it (plan §5, §7.5). No method takes a workspace,
 * member or client argument; every query filters by `workspace_id`, and the
 * composite foreign keys make cross-workspace references impossible.
 *
 * Every write is one transaction that locks what it decides on and re-checks
 * it, so it lands entirely or is refused with nothing written.
 *
 * Lock modes: runs and cases `FOR UPDATE`; responsibility rows
 * `FOR NO KEY UPDATE` (RESPONSIBILITY_LOCK). The latter still serialises
 * `start_run` and `put_responsibility` against each other, but does not conflict
 * with the `FOR KEY SHARE` that inserting a case or a run takes on the
 * responsibility through its foreign key. With `FOR UPDATE` there, a
 * superseding `start_run` (responsibility, then run) and `record_observations`
 * (run, then a new case's foreign key on the responsibility) formed a lock cycle
 * and Postgres aborted one of them with 40P01.
 */
const RESPONSIBILITY_LOCK = "FOR NO KEY UPDATE";

export type StoreScope = {
  workspaceId: string;
  memberId: string;
  clientId: string;
  clientName: string | null;
};

export type Agent = { name: string; model?: string; skill?: string; skill_version?: string };

export type RunSummary = {
  run_id: string;
  by: string;
  client_name: string | null;
  agent: Agent;
  version: number;
  started_at: string;
  completed_at: string | null;
  outcome: "completed" | "partial" | "failed" | "abandoned" | null;
  sources: Source[] | null;
  summary: string | null;
};

export type CaseState = {
  subject: string;
  opened_at: string;
  assessment: string | null;
  attention: Attention | null;
  attention_since: string | null;
  basis: string | null;
  decided_at: string | null;
  decided_in_run: string | null;
  facts?: Facts;
  facts_observed_at?: string;
};

export type Context = {
  responsibility: {
    key: string;
    title: string;
    subject_type: string;
    version: number;
    expectation: string;
    assessments: Assessment[];
    version_created_at: string;
  };
  last_run: RunSummary | null;
  in_progress: RunSummary | null;
  open_cases: CaseState[];
  open_case_count: number;
  truncated: boolean;
};

export type StartRunResult = {
  run_id: string;
  started_at: string;
  expires_at: string;
  run_limit: number;
  expectation_changed_since_last_run: boolean;
} & Context;

export type ObservedSubject = {
  subject: string;
  case: "new" | "existing";
  case_status: "open" | "closed";
  previous: { run_id: string; observed_at: string; agent: Agent } | null;
  changes: Changes;
  unchanged: number;
};

export type RecordResult = {
  run_id: string;
  subjects: ObservedSubject[];
  not_observed_so_far: string[];
};

export type CompleteResult = {
  run_id: string;
  outcome: "completed" | "partial" | "failed";
  completed_at: string;
  cases: {
    subject: string;
    status: "open" | "closed";
    attention: "opened" | "continued" | "ended" | "none";
    attention_since: string | null;
  }[];
  not_decided: string[];
  not_observed: string[];
  already_completed?: true;
};

export type CaseHistory = {
  subject: string;
  status: "open" | "closed";
  opened_at: string;
  closed_at: string | null;
  close_reason: string | null;
  attention_since: string | null;
  history: {
    run: RunSummary;
    observed_at: string;
    facts: Facts;
    decision: {
      assessment: string;
      attention: Attention | null;
      basis: string;
      cites: string[];
      status: "open" | "closed";
      close_reason: string | null;
    } | null;
  }[];
};

export type ResponsibilityStore = {
  putResponsibility(input: { key: string } & ResponsibilityContent): Promise<{
    key: string;
    version: number;
    changed: boolean;
    previous_version: number | null;
  }>;
  getResponsibility(key: string, includeFacts: boolean): Promise<Context>;
  startRun(input: { responsibility: string; agent: Agent; supersede: boolean }): Promise<StartRunResult>;
  recordObservations(input: {
    run_id: string;
    sources?: Source[];
    subjects: { subject: string; facts: Record<string, unknown> }[];
  }): Promise<RecordResult>;
  completeRun(input: {
    run_id: string;
    outcome: "completed" | "partial" | "failed";
    summary?: string;
    report?: string;
    decisions: DecisionInput[];
  }): Promise<CompleteResult>;
  getCase(input: { responsibility: string; subject: string; limit: number }): Promise<CaseHistory>;
};

type Q = Pick<SqlDriver, "query">;

const COMPLETED = `('completed', 'partial', 'failed')`;

/**
 * A case is part of the baseline only once a completed run has observed it. A
 * case opened by a run that was then abandoned (superseded, idle or expired) keeps its
 * rows, but stays out of open cases, counts, not-observed lists and case
 * history until a completed run observes it. `alias` is the cases alias.
 */
function inBaseline(alias: string): string {
  return `EXISTS (
    SELECT 1 FROM observations bo
      JOIN runs br ON br.workspace_id = bo.workspace_id AND br.id = bo.run_id
     WHERE bo.workspace_id = ${alias}.workspace_id AND bo.case_id = ${alias}.id
       AND br.outcome IN ${COMPLETED})`;
}

export function responsibilityStore(
  driver: SqlDriver,
  scope: StoreScope,
  options: { now?: () => Date } = {},
): ResponsibilityStore {
  const clock = options.now ?? (() => new Date());
  const ws = scope.workspaceId;

  // --- shared reads -------------------------------------------------------------

  async function knownKeys(q: Q): Promise<string[]> {
    const rows = await q.query<{ key: string }>(
      `SELECT key FROM responsibilities WHERE workspace_id = $1 ORDER BY key COLLATE "C"`,
      [ws],
    );
    return rows.map((row) => row.key);
  }

  async function unknownResponsibility(q: Q, key: string): Promise<Refusal> {
    return new Refusal("unknown_responsibility", `There is no responsibility ${key} in this workspace.`, {
      keys: await knownKeys(q),
    });
  }

  type ResponsibilityRow = {
    id: string;
    key: string;
    version_id: string;
    version: number;
    title: string;
    subject_type: string;
    expectation: string;
    assessments: Assessment[];
    content_hash: string;
    version_created_at: Date;
  };

  async function responsibilityByKey(q: Q, key: string, lock: boolean): Promise<ResponsibilityRow> {
    const [found] = await q.query<{ id: string }>(
      `SELECT id FROM responsibilities WHERE workspace_id = $1 AND key = $2${lock ? ` ${RESPONSIBILITY_LOCK}` : ""}`,
      [ws, key],
    );
    if (!found) throw await unknownResponsibility(q, key);
    const [row] = await q.query<ResponsibilityRow>(
      `SELECT r.id, r.key, v.id AS version_id, v.version, v.title, v.subject_type, v.expectation,
              v.assessments, v.content_hash, v.created_at AS version_created_at
         FROM responsibilities r
         JOIN responsibility_versions v ON v.workspace_id = r.workspace_id AND v.responsibility_id = r.id
        WHERE r.workspace_id = $1 AND r.id = $2
        ORDER BY v.version DESC
        LIMIT 1`,
      [ws, found.id],
    );
    if (!row) throw await unknownResponsibility(q, key);
    return row;
  }

  const RUN_SUMMARY_COLUMNS = `
    r.id AS run_id, m.email AS by, r.client_name, r.agent, v.version, r.version_id,
    r.started_at, r.completed_at, r.outcome, r.sources, r.summary`;
  const RUN_SUMMARY_JOINS = `
    JOIN members m ON m.workspace_id = r.workspace_id AND m.id = r.member_id
    JOIN responsibility_versions v ON v.workspace_id = r.workspace_id AND v.id = r.version_id`;

  type RunSummaryRow = {
    run_id: string;
    by: string;
    client_name: string | null;
    agent: Agent;
    version: number;
    version_id: string;
    started_at: Date;
    completed_at: Date | null;
    outcome: RunSummary["outcome"];
    sources: Source[] | null;
    summary: string | null;
  };

  function runSummary(row: RunSummaryRow): RunSummary {
    return {
      run_id: row.run_id,
      by: row.by,
      client_name: row.client_name,
      agent: row.agent,
      version: row.version,
      started_at: iso(row.started_at),
      completed_at: row.completed_at ? iso(row.completed_at) : null,
      outcome: row.outcome,
      sources: row.sources,
      summary: row.summary,
    };
  }

  async function lastCompletedRun(q: Q, responsibilityId: string): Promise<RunSummaryRow | undefined> {
    const [row] = await q.query<RunSummaryRow>(
      `SELECT ${RUN_SUMMARY_COLUMNS} FROM runs r ${RUN_SUMMARY_JOINS}
        WHERE r.workspace_id = $1 AND r.responsibility_id = $2 AND r.outcome IN ${COMPLETED}
        ORDER BY r.completed_at DESC, r.id
        LIMIT 1`,
      [ws, responsibilityId],
    );
    return row;
  }

  async function openRunSummary(q: Q, responsibilityId: string, now: Date): Promise<RunSummaryRow | undefined> {
    const [row] = await q.query<RunSummaryRow>(
      `SELECT ${RUN_SUMMARY_COLUMNS} FROM runs r ${RUN_SUMMARY_JOINS}
        WHERE r.workspace_id = $1 AND r.responsibility_id = $2 AND r.completed_at IS NULL
          AND r.started_at > $3`,
      [ws, responsibilityId, new Date(now.getTime() - RUN_LIFETIME_MS)],
    );
    return row;
  }

  async function context(q: Q, responsibility: ResponsibilityRow, includeFacts: boolean, now: Date): Promise<Context> {
    const last = await lastCompletedRun(q, responsibility.id);
    const open = await openRunSummary(q, responsibility.id, now);

    const [{ count }] = await q.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM cases c
        WHERE c.workspace_id = $1 AND c.responsibility_id = $2 AND c.status = 'open'
          AND ${inBaseline("c")}`,
      [ws, responsibility.id],
    );

    const rows = await q.query<{
      subject: string;
      opened_at: Date;
      attention_since: Date | null;
      assessment: string | null;
      attention: Attention | null;
      basis: string | null;
      decided_at: Date | null;
      decided_in_run: string | null;
      facts: Facts | null;
      facts_observed_at: Date | null;
    }>(
      `SELECT c.subject, c.opened_at, c.attention_since,
              d.assessment, d.attention, d.basis, d.decided_at, d.run_id AS decided_in_run,
              ${includeFacts ? "o.facts, o.observed_at AS facts_observed_at" : "NULL::jsonb AS facts, NULL::timestamptz AS facts_observed_at"}
         FROM cases c
         LEFT JOIN LATERAL (
           SELECT d.assessment, d.attention, d.basis, d.decided_at, d.run_id
             FROM decisions d
            WHERE d.workspace_id = c.workspace_id AND d.case_id = c.id
            ORDER BY d.decided_at DESC, d.run_id
            LIMIT 1
         ) d ON true
         ${
           includeFacts
             ? `LEFT JOIN LATERAL (
                  SELECT o.facts, o.observed_at
                    FROM observations o
                    JOIN runs r ON r.workspace_id = o.workspace_id AND r.id = o.run_id
                   WHERE o.workspace_id = c.workspace_id AND o.case_id = c.id
                     AND r.outcome IN ${COMPLETED}
                   ORDER BY r.completed_at DESC, r.id
                   LIMIT 1
                ) o ON true`
             : ""
         }
        WHERE c.workspace_id = $1 AND c.responsibility_id = $2 AND c.status = 'open'
          AND ${inBaseline("c")}
        ORDER BY (c.attention_since IS NULL), c.attention_since, c.subject COLLATE "C"
        LIMIT $3`,
      [ws, responsibility.id, MAX_OPEN_CASES + 1],
    );

    const truncated = rows.length > MAX_OPEN_CASES;
    const open_cases = rows.slice(0, MAX_OPEN_CASES).map((row): CaseState => {
      const state: CaseState = {
        subject: row.subject,
        opened_at: iso(row.opened_at),
        assessment: row.assessment,
        attention: row.attention,
        attention_since: row.attention_since ? iso(row.attention_since) : null,
        basis: row.basis,
        decided_at: row.decided_at ? iso(row.decided_at) : null,
        decided_in_run: row.decided_in_run,
      };
      if (includeFacts && row.facts && row.facts_observed_at) {
        state.facts = row.facts;
        state.facts_observed_at = iso(row.facts_observed_at);
      }
      return state;
    });

    return {
      responsibility: {
        key: responsibility.key,
        title: responsibility.title,
        subject_type: responsibility.subject_type,
        version: responsibility.version,
        expectation: responsibility.expectation,
        assessments: responsibility.assessments,
        version_created_at: iso(responsibility.version_created_at),
      },
      last_run: last ? runSummary(last) : null,
      in_progress: open ? runSummary(open) : null,
      open_cases,
      open_case_count: count,
      truncated,
    };
  }

  // --- runs: lock and check --------------------------------------------------------

  type RunRow = {
    id: string;
    responsibility_id: string;
    version_id: string;
    member_id: string;
    client_id: string;
    started_at: Date;
    sources: Source[] | null;
    completed_at: Date | null;
    outcome: string | null;
    summary: string | null;
    completion: CompleteResult | null;
  };

  /** Locks the run and checks it is this session's. */
  async function lockOwnRun(q: Q, runId: string): Promise<RunRow> {
    const unknown = new Refusal("unknown_run", `There is no run ${runId} in this workspace.`, { run_id: runId });
    if (!isUuid(runId)) throw unknown;
    const [run] = await q.query<RunRow>(
      `SELECT id, responsibility_id, version_id, member_id, client_id, started_at, sources,
              completed_at, outcome, summary, completion
         FROM runs WHERE workspace_id = $1 AND id = $2
         FOR UPDATE`,
      [ws, runId],
    );
    if (!run) throw unknown;
    if (run.member_id !== scope.memberId || run.client_id !== scope.clientId) {
      throw new Refusal(
        "run_not_yours",
        "This run was started by another member or client; only they can write to it.",
        { run_id: runId },
      );
    }
    return run;
  }

  function expiresAt(run: { started_at: Date }): Date {
    return new Date(run.started_at.getTime() + RUN_LIFETIME_MS);
  }

  /**
   * When the next `start_run` may take the open run over: RUN_IDLE_MS after its
   * last activity, and never later than its lifetime. Its own writes renew it.
   *
   * A run started before `last_active_at` existed has none, and its writes up to
   * then left no trace of when they happened, so it is held for its whole
   * lifetime as before — until a write of this code gives it an activity time.
   */
  function reclaimableAt(run: { started_at: Date; last_active_at: Date | null }): Date {
    if (!run.last_active_at) return expiresAt(run);
    return new Date(Math.min(run.last_active_at.getTime() + RUN_IDLE_MS, expiresAt(run).getTime()));
  }

  /**
   * Stamps the run's activity. Always the last statement of a transaction that
   * holds the run (its row lock, or its own uncommitted insert), with the time
   * read here, after every statement that could wait: a call that stalled
   * anywhere in its transaction holds the run from when it lands, since a
   * takeover reads the row only after this commits.
   */
  async function renew(q: Q, runId: string): Promise<void> {
    await q.query(
      `UPDATE runs SET last_active_at = GREATEST(last_active_at, $3) WHERE workspace_id = $1 AND id = $2`,
      [ws, runId, clock()],
    );
  }

  function refuseIfExpired(run: RunRow, now: Date): void {
    if (now.getTime() >= expiresAt(run).getTime()) {
      throw new Refusal(
        "run_expired",
        "This run passed its 2 h lifetime without completing; start a new run.",
        { run_id: run.id, expires_at: iso(expiresAt(run)) },
      );
    }
  }

  function refuseIfAbandoned(run: RunRow): void {
    if (run.outcome === "abandoned") {
      throw new Refusal(
        "run_abandoned",
        "This run was abandoned (expired, idle and taken over, or superseded); nothing more is recorded in it.",
        { run_id: run.id, summary: run.summary },
      );
    }
  }

  /**
   * Maps subjects to their cases with Postgres' own `lower()` on both sides — the
   * same function the `cases_subject` index uses — and refuses two subjects that
   * fold together.
   */
  async function mapSubjects(
    q: Q,
    responsibilityId: string,
    runId: string,
    subjects: string[],
  ): Promise<
    {
      input: string;
      case_id: string | null;
      status: "open" | "closed" | null;
      attention_since: Date | null;
      observed_in_run: boolean;
    }[]
  > {
    const rows = await q.query<{
      ord: number;
      input: string;
      fold: string;
      case_id: string | null;
      status: "open" | "closed" | null;
      attention_since: Date | null;
      observed_in_run: boolean;
    }>(
      `SELECT s.ord::int AS ord, s.input, lower(s.input) AS fold, c.id AS case_id, c.status, c.attention_since,
              (o.case_id IS NOT NULL) AS observed_in_run
         FROM unnest($3::text[]) WITH ORDINALITY AS s(input, ord)
         LEFT JOIN cases c
           ON c.workspace_id = $1 AND c.responsibility_id = $2 AND lower(c.subject) = lower(s.input)
         LEFT JOIN observations o
           ON o.workspace_id = c.workspace_id AND o.run_id = $4 AND o.case_id = c.id
        ORDER BY s.ord`,
      [ws, responsibilityId, subjects, runId],
    );
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.fold)) {
        throw new Refusal("duplicate_subject", `${row.input} appears more than once in this call.`, {
          subject: row.input,
        });
      }
      seen.add(row.fold);
    }
    return rows;
  }

  async function notObserved(q: Q, responsibilityId: string, runId: string): Promise<string[]> {
    const rows = await q.query<{ subject: string }>(
      `SELECT c.subject FROM cases c
        WHERE c.workspace_id = $1 AND c.responsibility_id = $2 AND c.status = 'open'
          AND ${inBaseline("c")}
          AND NOT EXISTS (
            SELECT 1 FROM observations o
             WHERE o.workspace_id = c.workspace_id AND o.run_id = $3 AND o.case_id = c.id)
        ORDER BY c.subject COLLATE "C"`,
      [ws, responsibilityId, runId],
    );
    return rows.map((row) => row.subject);
  }

  // --- operations ------------------------------------------------------------------

  return {
    async putResponsibility(input) {
      checkAssessments(input.assessments);
      const content: ResponsibilityContent = {
        title: input.title,
        subject_type: input.subject_type,
        expectation: input.expectation,
        assessments: input.assessments.map(({ label, attention }) => ({ label, attention })),
      };
      const hash = contentHash(content);
      const now = clock();

      return driver.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO responsibilities (workspace_id, key, created_at) VALUES ($1, $2, $3)
           ON CONFLICT (workspace_id, key) DO NOTHING`,
          [ws, input.key, now],
        );
        const [locked] = await tx.query<{ id: string }>(
          `SELECT id FROM responsibilities WHERE workspace_id = $1 AND key = $2 ${RESPONSIBILITY_LOCK}`,
          [ws, input.key],
        );
        const [current] = await tx.query<{ version: number; content_hash: string }>(
          `SELECT version, content_hash FROM responsibility_versions
            WHERE workspace_id = $1 AND responsibility_id = $2
            ORDER BY version DESC LIMIT 1`,
          [ws, locked.id],
        );
        if (current && current.content_hash === hash) {
          return { key: input.key, version: current.version, changed: false, previous_version: current.version };
        }
        const version = (current?.version ?? 0) + 1;
        await tx.query(
          `INSERT INTO responsibility_versions
             (workspace_id, responsibility_id, version, title, subject_type, expectation,
              assessments, content_hash, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
          [
            ws,
            locked.id,
            version,
            content.title,
            content.subject_type,
            content.expectation,
            JSON.stringify(content.assessments),
            hash,
            scope.memberId,
            now,
          ],
        );
        return { key: input.key, version, changed: true, previous_version: current?.version ?? null };
      });
    },

    async getResponsibility(key, includeFacts) {
      const responsibility = await responsibilityByKey(driver, key, false);
      return context(driver, responsibility, includeFacts, clock());
    },

    async startRun({ responsibility: key, agent, supersede }) {
      return driver.transaction(async (tx) => {
        const responsibility = await responsibilityByKey(tx, key, true);
        const runId = randomUUID();

        // last_active_at comes from the locked row itself: a record_observations
        // that renewed it and committed while this waited for the lock is seen.
        const [open] = await tx.query<{ id: string; started_at: Date; last_active_at: Date | null }>(
          `SELECT id, started_at, last_active_at FROM runs
            WHERE workspace_id = $1 AND responsibility_id = $2 AND completed_at IS NULL
            FOR UPDATE`,
          [ws, responsibility.id],
        );
        // The time is read once the locks are held, so a start that waited for
        // them judges the open run, and begins its own, at the time it got them.
        const now = clock();
        if (open) {
          const abandon = (summary: string) =>
            tx.query(
              `UPDATE runs SET completed_at = $3, outcome = 'abandoned', summary = $4
                WHERE workspace_id = $1 AND id = $2`,
              [ws, open.id, now, summary],
            );
          // Who starts makes no difference: one OAuth client (a claude.ai
          // connector, a Claude Code installation) serves concurrent sessions,
          // so the same member and client is no evidence the open run is dead.
          if (now.getTime() >= expiresAt(open).getTime()) {
            await abandon("expired: not completed within its 2 h lifetime");
          } else if (now.getTime() >= reclaimableAt(open).getTime()) {
            await abandon(`idle: no activity for ${RUN_IDLE_MS / 60_000} min; taken over by run ${runId}`);
          } else if (!supersede) {
            const [summary] = await tx.query<RunSummaryRow>(
              `SELECT ${RUN_SUMMARY_COLUMNS} FROM runs r ${RUN_SUMMARY_JOINS}
                WHERE r.workspace_id = $1 AND r.id = $2`,
              [ws, open.id],
            );
            throw new Refusal(
              "run_in_progress",
              `Another run of ${key} is in progress and active; report without history, or pass supersede: true ` +
                `only if asked to. A start_run from reclaimable_at takes it over unless it records again.`,
              {
                run: runSummary(summary),
                expires_at: iso(expiresAt(open)),
                reclaimable_at: iso(reclaimableAt(open)),
              },
            );
          } else {
            await abandon(`superseded by run ${runId}`);
          }
        }

        await tx.query(
          `INSERT INTO runs
             (workspace_id, id, responsibility_id, version_id, member_id, client_id, client_name, agent,
              started_at, last_active_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $9)`,
          [
            ws,
            runId,
            responsibility.id,
            responsibility.version_id,
            scope.memberId,
            scope.clientId,
            scope.clientName,
            JSON.stringify(agent),
            now,
          ],
        );

        const last = await lastCompletedRun(tx, responsibility.id);
        const ctx = await context(tx, responsibility, true, now);
        await renew(tx, runId);
        return {
          run_id: runId,
          started_at: iso(now),
          expires_at: iso(expiresAt({ started_at: now })),
          run_limit: RUN_LIMIT,
          expectation_changed_since_last_run: last !== undefined && last.version_id !== responsibility.version_id,
          ...ctx,
        };
      });
    },

    async recordObservations(input) {
      // Facts are validated before the database is touched.
      const normalised = input.subjects.map((entry) => ({
        subject: entry.subject,
        facts: normaliseFacts(entry.subject, entry.facts),
      }));
      const declared = input.sources ? normaliseSources(input.sources) : undefined;

      return driver.transaction(async (tx) => {
        const run = await lockOwnRun(tx, input.run_id);
        // Read once the run is locked, for the lifetime check and the records;
        // the hold itself is stamped at the very end (renew).
        const now = clock();
        refuseIfAbandoned(run);
        if (run.completion) {
          throw new Refusal("run_completed", "This run is completed and immutable.", { run_id: run.id });
        }
        refuseIfExpired(run, now);

        let sources = run.sources;
        if (declared) {
          if (!sources) {
            sources = declared;
            await tx.query(`UPDATE runs SET sources = $3::jsonb WHERE workspace_id = $1 AND id = $2`, [
              ws,
              run.id,
              canonicalJson(declared),
            ]);
          } else if (!sameJson(sources, declared)) {
            throw new Refusal(
              "sources_conflict",
              "This run already declared different sources; sources are immutable for a run.",
              { declared: sources },
            );
          }
        } else if (!sources) {
          throw new Refusal(
            "sources_required",
            "The first record_observations of a run must declare its sources.",
            { run_id: run.id },
          );
        }

        const mapped = await mapSubjects(
          tx,
          run.responsibility_id,
          run.id,
          normalised.map((entry) => entry.subject),
        );

        const [{ count: observed }] = await tx.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM observations WHERE workspace_id = $1 AND run_id = $2`,
          [ws, run.id],
        );
        const added = mapped.filter((row) => !row.observed_in_run).length;
        if (observed + added > RUN_LIMIT) {
          throw new Refusal(
            "run_too_large",
            `A run observes at most ${RUN_LIMIT} distinct subjects; this call would make ${observed + added}.`,
            { run_limit: RUN_LIMIT, observed },
          );
        }

        // New cases, opened by their first observation.
        const fresh = mapped.filter((row) => row.case_id === null).map((row) => row.input);
        const created = new Map<string, { id: string; status: "open" | "closed" }>();
        if (fresh.length) {
          const rows = await tx.query<{ id: string; subject: string; status: "open" | "closed" }>(
            `INSERT INTO cases (workspace_id, responsibility_id, subject, opened_at)
             SELECT $1, $2, s, $4 FROM unnest($3::text[]) AS s
             RETURNING id, subject, status`,
            [ws, run.responsibility_id, fresh, now],
          );
          for (const row of rows) created.set(row.subject, { id: row.id, status: row.status });
        }
        const caseIds = mapped.map((row) => row.case_id ?? created.get(row.input)!.id);

        const previousRows = await tx.query<{
          case_id: string;
          run_id: string;
          observed_at: Date;
          facts: Facts;
          agent: Agent;
        }>(
          `SELECT DISTINCT ON (o.case_id) o.case_id, o.run_id, o.observed_at, o.facts, r.agent
             FROM observations o
             JOIN runs r ON r.workspace_id = o.workspace_id AND r.id = o.run_id
            WHERE o.workspace_id = $1 AND o.case_id = ANY($2::uuid[]) AND r.outcome IN ${COMPLETED}
            ORDER BY o.case_id, r.completed_at DESC, r.id`,
          [ws, caseIds],
        );
        // A case is "existing" once a completed run has observed it; one seen only
        // by abandoned runs (or only by this run) is still "new".
        const previous = new Map(previousRows.map((row) => [row.case_id, row]));

        const subjects: ObservedSubject[] = [];
        const stored: string[] = [];
        normalised.forEach((entry, index) => {
          const caseId = caseIds[index];
          const before = previous.get(caseId);
          const facts = carryUnknowns(before?.facts ?? null, entry.facts, sources!);
          const { changes, unchanged } = diffFacts(before?.facts ?? null, facts);
          stored.push(canonicalJson(facts));
          subjects.push({
            subject: entry.subject,
            case: before ? "existing" : "new",
            case_status: mapped[index].status ?? created.get(entry.subject)!.status,
            previous: before
              ? { run_id: before.run_id, observed_at: iso(before.observed_at), agent: before.agent }
              : null,
            changes,
            unchanged,
          });
        });

        if (caseIds.length) {
          await tx.query(
            `INSERT INTO observations (workspace_id, run_id, case_id, facts, observed_at)
             SELECT $1, $2, t.case_id, t.facts::jsonb, $5
               FROM unnest($3::uuid[], $4::text[]) AS t(case_id, facts)
             ON CONFLICT (workspace_id, run_id, case_id)
             DO UPDATE SET facts = EXCLUDED.facts, observed_at = EXCLUDED.observed_at`,
            [ws, run.id, caseIds, stored, now],
          );
        }

        const notObservedSoFar = await notObserved(tx, run.responsibility_id, run.id);
        // An accepted call, with or without subjects, keeps the run held (RUN_IDLE_MS).
        await renew(tx, run.id);
        return { run_id: run.id, subjects, not_observed_so_far: notObservedSoFar };
      });
    },

    async completeRun(input) {
      const now = clock();
      return driver.transaction(async (tx) => {
        const run = await lockOwnRun(tx, input.run_id);
        refuseIfAbandoned(run);
        // A repeat by the same member and client gets the stored result back,
        // before the lifetime is looked at (plan §5.1).
        if (run.completion) return { ...run.completion, already_completed: true as const };
        refuseIfExpired(run, now);
        if (!run.sources) {
          throw new Refusal(
            "sources_required",
            "A run declares its sources (record_observations) before it completes.",
            { run_id: run.id },
          );
        }
        if (input.outcome === "failed" && !input.summary) {
          throw new Refusal("summary_required", "A failed run needs a summary saying why.", { run_id: run.id });
        }

        const [version] = await tx.query<{ assessments: Assessment[] }>(
          `SELECT assessments FROM responsibility_versions WHERE workspace_id = $1 AND id = $2`,
          [ws, run.version_id],
        );
        const mapped = await mapSubjects(
          tx,
          run.responsibility_id,
          run.id,
          input.decisions.map((decision) => decision.subject),
        );
        const labels = input.decisions.map((decision) => checkDecision(decision, version.assessments));
        mapped.forEach((row) => {
          if (!row.case_id || !row.observed_in_run) {
            throw new Refusal(
              "unobserved_subject",
              `${row.input} was not observed in this run; record it before deciding it.`,
              { subject: row.input },
            );
          }
        });
        const caseIds = mapped.map((row) => row.case_id!);

        // Lock the decided cases in case-id order, then read them as locked.
        const locked = new Map(
          (
            await tx.query<{ id: string; status: "open" | "closed"; attention_since: Date | null }>(
              `SELECT id, status, attention_since FROM cases
                WHERE workspace_id = $1 AND id = ANY($2::uuid[])
                ORDER BY id
                FOR UPDATE`,
              [ws, caseIds],
            )
          ).map((row) => [row.id, row]),
        );
        const latest = new Map(
          (
            await tx.query<{ case_id: string; assessment: string; attention: Attention | null }>(
              `SELECT DISTINCT ON (case_id) case_id, assessment, attention
                 FROM decisions
                WHERE workspace_id = $1 AND case_id = ANY($2::uuid[])
                ORDER BY case_id, decided_at DESC, run_id`,
              [ws, caseIds],
            )
          ).map((row) => [row.case_id, row]),
        );

        const cases: CompleteResult["cases"] = [];
        const updates = {
          id: [] as string[],
          status: [] as string[],
          closed_at: [] as (string | null)[],
          close_reason: [] as (string | null)[],
          attention_since: [] as (string | null)[],
        };
        const decisions = {
          case_id: [] as string[],
          assessment: [] as string[],
          attention: [] as (string | null)[],
          basis: [] as string[],
          cites: [] as string[],
          status: [] as string[],
          close_reason: [] as (string | null)[],
        };

        input.decisions.forEach((decision, index) => {
          const caseId = caseIds[index];
          const current = locked.get(caseId)!;
          const before = latest.get(caseId);
          const next = transition(
            current,
            before ? { assessment: before.assessment, attention: before.attention } : null,
            decision,
            labels[index],
            now,
          );
          updates.id.push(caseId);
          updates.status.push(next.status);
          updates.closed_at.push(next.closed_at ? iso(next.closed_at) : null);
          updates.close_reason.push(next.close_reason);
          updates.attention_since.push(next.attention_since ? iso(next.attention_since) : null);

          decisions.case_id.push(caseId);
          decisions.assessment.push(decision.assessment);
          decisions.attention.push(decision.close || !decision.attention ? null : JSON.stringify(decision.attention));
          decisions.basis.push(decision.basis);
          decisions.cites.push(JSON.stringify(decision.cites ?? []));
          decisions.status.push(decision.close ? "closed" : "open");
          decisions.close_reason.push(decision.close?.reason ?? null);

          cases.push({
            subject: decision.subject,
            status: next.status,
            attention: next.attention,
            attention_since: next.attention_since ? iso(next.attention_since) : null,
          });
        });

        if (caseIds.length) {
          await tx.query(
            `INSERT INTO decisions
               (workspace_id, run_id, case_id, assessment, attention, basis, cites, status, close_reason, decided_at)
             SELECT $1, $2, t.case_id, t.assessment, t.attention::jsonb, t.basis,
                    ARRAY(SELECT jsonb_array_elements_text(t.cites::jsonb)), t.status, t.close_reason, $10
               FROM unnest($3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[])
                 AS t(case_id, assessment, attention, basis, cites, status, close_reason)`,
            [
              ws,
              run.id,
              decisions.case_id,
              decisions.assessment,
              decisions.attention,
              decisions.basis,
              decisions.cites,
              decisions.status,
              decisions.close_reason,
              now,
            ],
          );
          await tx.query(
            `UPDATE cases c
                SET status = t.status, closed_at = t.closed_at::timestamptz,
                    close_reason = t.close_reason, attention_since = t.attention_since::timestamptz
               FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[])
                 AS t(id, status, closed_at, close_reason, attention_since)
              WHERE c.workspace_id = $1 AND c.id = t.id`,
            [ws, updates.id, updates.status, updates.closed_at, updates.close_reason, updates.attention_since],
          );
        }

        const notDecided = (
          await tx.query<{ subject: string }>(
            `SELECT c.subject FROM observations o
               JOIN cases c ON c.workspace_id = o.workspace_id AND c.id = o.case_id
              WHERE o.workspace_id = $1 AND o.run_id = $2 AND NOT (o.case_id = ANY($3::uuid[]))
              ORDER BY c.subject COLLATE "C"`,
            [ws, run.id, caseIds],
          )
        ).map((row) => row.subject);

        const result: CompleteResult = {
          run_id: run.id,
          outcome: input.outcome,
          completed_at: iso(now),
          cases,
          not_decided: notDecided,
          not_observed: await notObserved(tx, run.responsibility_id, run.id),
        };

        await tx.query(
          `UPDATE runs SET completed_at = $3, outcome = $4, summary = $5, report = $6, completion = $7::jsonb
            WHERE workspace_id = $1 AND id = $2`,
          [ws, run.id, now, input.outcome, input.summary ?? null, input.report ?? null, JSON.stringify(result)],
        );
        return result;
      });
    },

    async getCase({ responsibility: key, subject, limit }) {
      const responsibility = await responsibilityByKey(driver, key, false);
      const [found] = await driver.query<{
        id: string;
        subject: string;
        status: "open" | "closed";
        opened_at: Date;
        closed_at: Date | null;
        close_reason: string | null;
        attention_since: Date | null;
      }>(
        `SELECT c.id, c.subject, c.status, c.opened_at, c.closed_at, c.close_reason, c.attention_since
           FROM cases c
          WHERE c.workspace_id = $1 AND c.responsibility_id = $2 AND lower(c.subject) = lower($3)
            AND ${inBaseline("c")}`,
        [ws, responsibility.id, subject],
      );
      if (!found) {
        throw new Refusal("unknown_case", `${key} has no case ${subject} observed by a completed run.`, {
          subject,
        });
      }
      const rows = await driver.query<
        RunSummaryRow & {
          observed_at: Date;
          facts: Facts;
          decided: boolean;
          assessment: string | null;
          attention: Attention | null;
          basis: string | null;
          cites: string[] | null;
          decision_status: "open" | "closed" | null;
          decision_close_reason: string | null;
        }
      >(
        `SELECT ${RUN_SUMMARY_COLUMNS}, o.observed_at, o.facts,
                (d.case_id IS NOT NULL) AS decided, d.assessment, d.attention, d.basis, d.cites,
                d.status AS decision_status, d.close_reason AS decision_close_reason
           FROM observations o
           JOIN runs r ON r.workspace_id = o.workspace_id AND r.id = o.run_id
           ${RUN_SUMMARY_JOINS}
           LEFT JOIN decisions d
             ON d.workspace_id = o.workspace_id AND d.run_id = o.run_id AND d.case_id = o.case_id
          WHERE o.workspace_id = $1 AND o.case_id = $2 AND r.outcome IN ${COMPLETED}
          ORDER BY r.completed_at DESC, r.id
          LIMIT $3`,
        [ws, found.id, limit],
      );
      return {
        subject: found.subject,
        status: found.status,
        opened_at: iso(found.opened_at),
        closed_at: found.closed_at ? iso(found.closed_at) : null,
        close_reason: found.close_reason,
        attention_since: found.attention_since ? iso(found.attention_since) : null,
        history: rows.map((row) => ({
          run: runSummary(row),
          observed_at: iso(row.observed_at),
          facts: row.facts,
          decision: row.decided
            ? {
                assessment: row.assessment!,
                attention: row.attention,
                basis: row.basis!,
                cites: row.cites ?? [],
                status: row.decision_status!,
                close_reason: row.decision_close_reason,
              }
            : null,
        })),
      };
    },
  };
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export type { FactValue };
