import { randomUUID } from "node:crypto";

import {
  digest,
  InputError,
  step,
  view,
  type AttentionEvent,
  type Definition,
  type Evaluation,
  type Observation,
  type Proposal,
  type Rejection,
  type State,
  type StepResult,
  type Transition,
  type View,
} from "../core.ts";
import type { SqlDriver } from "../db/driver.ts";
import { isUuid } from "../workspace/members.ts";
import {
  buildRunObservations,
  caseIdOf,
  caseSummary,
  openCases,
  openEvidenceIds,
  recordableKinds,
  selectLookback,
  validateDefinition,
  viewNow,
  type CaseSummary,
  type DefinitionInput,
  type ObservationRef,
  type RunKind,
} from "./host.ts";
import {
  MAX_KINDS_PER_RUN,
  MAX_ROWS_PER_CALL,
  normaliseRows,
  Refusal,
  refuseUnstorableText,
  RUN_IDLE_MS,
  RUN_LIFETIME_MS,
  RUN_LIMIT,
  type Row,
} from "./model.ts";

/**
 * The responsibilities store, opened for one session: a workspace, the member
 * and the client acting in it. It is the host of responsibilities-core
 * (docs/core-integration-plan.md): auth scope, runs, storage, lookback and the
 * clock are its own; every decision about cases, status and Attentions is
 * `view` and `step`. No method takes a workspace, member or client argument;
 * every query filters by `workspace_id`, and the composite foreign keys make
 * cross-workspace references impossible.
 *
 * Every write is one transaction that locks what it decides on and re-checks
 * it, so it lands entirely or is refused with nothing written.
 *
 * Lock modes: runs `FOR UPDATE`; responsibility rows `FOR NO KEY UPDATE`
 * (RESPONSIBILITY_LOCK). The latter still serialises `start_run` and
 * `put_responsibility` against each other, but does not conflict with the
 * `FOR KEY SHARE` that inserting a run, a stored observation or a state takes on
 * the responsibility through its foreign key. With `FOR UPDATE` there, a
 * superseding `start_run` (responsibility, then run) and a write holding the run
 * that then inserts such a row formed a lock cycle (40P01). The state is
 * written only by `complete_run`, which holds the run, so it is read without a
 * lock elsewhere and locked `FOR UPDATE` there.
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
  summary: string | null;
};

export type Context = {
  responsibility: {
    key: string;
    title: string;
    version: number;
    definition: Definition;
    version_created_at: string;
  };
  last_run: RunSummary | null;
  in_progress: RunSummary | null;
  cases: CaseSummary[];
  open_case_count: number;
  truncated: boolean;
};

export type StartRunResult = {
  run_id: string;
  started_at: string;
  expires_at: string;
  run_limit: number;
  expectation_changed_since_last_run: boolean;
  include: string[];
  attention_types: { key: string; description: string; checked: boolean }[];
  cases: CaseSummary[];
};

export type ObservationInput = {
  kind: string;
  complete: boolean;
  replace?: boolean;
  rows: Record<string, unknown>[];
};

export type RecordResult = {
  run_id: string;
  observations: { kind: string; id: string; rows: number; complete: boolean }[];
};

export type CompleteInput = {
  run_id: string;
  outcome: "completed" | "partial" | "failed";
  summary?: string;
  report?: string;
  evaluation?: { basis: string; proposals: Proposal[] };
};

export type CompleteResult = {
  run_id: string;
  outcome: "completed" | "partial" | "failed";
  completed_at: string;
  basis: string | null;
  transitions: Transition[];
  attention_events: AttentionEvent[];
  rejections: Rejection[];
  state_digest: string | null;
  already_completed?: true;
};

export type CaseHistory = CaseSummary & {
  history: {
    run: RunSummary;
    at: string;
    transitions: Transition[];
    attention_events: AttentionEvent[];
    proposal: Proposal | null;
    cited: string[];
  }[];
};

export type ResponsibilityStore = {
  putResponsibility(input: { key: string; title: string; definition: DefinitionInput }): Promise<{
    key: string;
    version: number;
    changed: boolean;
    previous_version: number | null;
  }>;
  getResponsibility(key: string): Promise<Context>;
  startRun(input: { responsibility: string; agent: Agent; supersede: boolean }): Promise<StartRunResult>;
  recordObservations(input: { run_id: string; observations: ObservationInput[] }): Promise<RecordResult>;
  viewRun(input: { run_id: string }): Promise<View>;
  completeRun(input: CompleteInput): Promise<CompleteResult>;
  getCase(input: { responsibility: string; keys: Record<string, string | number>; limit: number }): Promise<CaseHistory>;
};

type Q = Pick<SqlDriver, "query">;

const COMPLETED = `('completed', 'partial', 'failed')`;

/** The inputs of one `view` or `step` for a run, read under its lock (plan §4.3, §4.4). */
type StepInputs = {
  definition: Definition;
  state: State | null;
  stateDigest: string | null;
  /** This run's observations (lookback a), as `complete_run` freezes them. */
  runObservations: Observation[];
  /** Everything passed to the core: (a) ∪ (b) ∪ (c). */
  observations: Observation[];
};

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
    definition: Definition;
    version_created_at: Date;
  };

  async function responsibilityByKey(q: Q, key: string, lock: boolean): Promise<ResponsibilityRow> {
    const [found] = await q.query<{ id: string }>(
      `SELECT id FROM responsibilities WHERE workspace_id = $1 AND key = $2${lock ? ` ${RESPONSIBILITY_LOCK}` : ""}`,
      [ws, key],
    );
    if (!found) throw await unknownResponsibility(q, key);
    const [row] = await q.query<ResponsibilityRow>(
      `SELECT r.id, r.key, v.id AS version_id, v.version, v.title, v.definition,
              v.created_at AS version_created_at
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

  async function definitionOf(q: Q, versionId: string): Promise<Definition> {
    const [row] = await q.query<{ definition: Definition }>(
      `SELECT definition FROM responsibility_versions WHERE workspace_id = $1 AND id = $2`,
      [ws, versionId],
    );
    return row.definition;
  }

  async function loadState(
    q: Q,
    responsibilityId: string,
    lock: boolean,
  ): Promise<{ state: State | null; digest: string | null }> {
    const [row] = await q.query<{ state: State; state_digest: string }>(
      `SELECT state, state_digest FROM responsibility_states
        WHERE workspace_id = $1 AND responsibility_id = $2${lock ? " FOR UPDATE" : ""}`,
      [ws, responsibilityId],
    );
    return { state: row?.state ?? null, digest: row?.state_digest ?? null };
  }

  const RUN_SUMMARY_COLUMNS = `
    r.id AS run_id, m.email AS by, r.client_name, r.agent, v.version, r.version_id,
    r.started_at, r.completed_at, r.outcome, r.summary`;
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

  // --- runs: lock and check --------------------------------------------------------

  type RunRow = {
    id: string;
    responsibility_id: string;
    version_id: string;
    member_id: string;
    client_id: string;
    agent: Agent;
    started_at: Date;
    view_now: Date | null;
    view_basis: string | null;
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
      `SELECT id, responsibility_id, version_id, member_id, client_id, agent, started_at,
              view_now, view_basis, completed_at, outcome, summary, completion
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
   * A run without `last_active_at` has left no trace of when its writes
   * happened, so it is held for its whole lifetime — until a write of this code
   * gives it an activity time.
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

  function refuseIfCompleted(run: RunRow): void {
    if (run.completion) {
      throw new Refusal("run_completed", "This run is completed and immutable.", { run_id: run.id });
    }
  }

  // --- the core's inputs for a run ----------------------------------------------------

  /**
   * Definition, state and observations for `view` and `step` of a run, built by
   * the same functions for `view_run` and `complete_run`. While the run holds
   * its lock nothing else adds stored observations or changes the state, so the
   * result is the same at both, unless a recording changed the run.
   */
  async function stepInputs(q: Q, run: RunRow, lockState: boolean): Promise<StepInputs> {
    const definition = await definitionOf(q, run.version_id);
    const { state, digest: stateDigest } = await loadState(q, run.responsibility_id, lockState);

    const kinds = await q.query<RunKind>(
      `SELECT kind, complete, recorded_at FROM run_observation_kinds
        WHERE workspace_id = $1 AND run_id = $2`,
      [ws, run.id],
    );
    const rows = new Map<string, { digest: string; row: Row }[]>();
    for (const one of await q.query<{ kind: string; row_digest: string; row: Row }>(
      `SELECT kind, row_digest, row FROM run_rows WHERE workspace_id = $1 AND run_id = $2`,
      [ws, run.id],
    )) {
      rows.set(one.kind, [...(rows.get(one.kind) ?? []), { digest: one.row_digest, row: one.row }]);
    }

    const wanted = [...new Set([...recordableKinds(definition), ...kinds.map((k) => k.kind)])];
    const newestStored = (
      await q.query<{ id: string; kind: string; occurred_at: Date }>(
        `SELECT DISTINCT ON (kind) id, kind, occurred_at FROM core_observations
          WHERE workspace_id = $1 AND responsibility_id = $2 AND kind = ANY($3::text[])
          ORDER BY kind, occurred_at DESC, id COLLATE "C" DESC`,
        [ws, run.responsibility_id, wanted],
      )
    ).map(ref);
    const runObservations = buildRunObservations(
      run.id,
      kinds,
      rows,
      definition.identity,
      new Map(newestStored.map((o) => [o.kind, o])),
    );

    const evidenceIds = openEvidenceIds(state);
    const evidence = evidenceIds.length
      ? (
          await q.query<{ id: string; kind: string; occurred_at: Date }>(
            `SELECT id, kind, occurred_at FROM core_observations
              WHERE workspace_id = $1 AND responsibility_id = $2 AND id = ANY($3::text[])`,
            [ws, run.responsibility_id, evidenceIds],
          )
        ).map(ref)
      : [];

    const selected = selectLookback(state, definition, runObservations, evidence, newestStored);
    const own = new Set(runObservations.map((o) => o.id));
    const storedIds = selected.filter((id) => !own.has(id));
    const stored = storedIds.length
      ? (
          await q.query<{ body: Observation }>(
            `SELECT body FROM core_observations
              WHERE workspace_id = $1 AND responsibility_id = $2 AND id = ANY($3::text[])`,
            [ws, run.responsibility_id, storedIds],
          )
        ).map((row) => row.body)
      : [];

    return { definition, state, stateDigest, runObservations, observations: [...runObservations, ...stored] };
  }

  /** The core's view of these inputs at `now`, or `undefined` if the core refuses them. */
  function viewOrNothing(inputs: StepInputs, now: string): View | undefined {
    try {
      return view(inputs.definition, inputs.state, inputs.observations, now);
    } catch (error) {
      if (error instanceof InputError) return undefined;
      throw error;
    }
  }

  // --- operations ------------------------------------------------------------------

  return {
    async putResponsibility(input) {
      refuseUnstorableText({ title: input.title, definition: input.definition });
      const now = clock();
      const hash = digest({ title: input.title, definition: input.definition });

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
        const [current] = await tx.query<{ version: number; content_hash: string; definition: Definition }>(
          `SELECT version, content_hash, definition FROM responsibility_versions
            WHERE workspace_id = $1 AND responsibility_id = $2
            ORDER BY version DESC LIMIT 1`,
          [ws, locked.id],
        );
        const version = (current?.version ?? 0) + 1;
        const definition = validateDefinition(input.definition, locked.id, version, now);
        if (current) {
          // The state is bound to one subject_type and set of subject_keys (src/core.ts, identity digest).
          const before = current.definition.identity;
          const after = definition.identity;
          const keys = (list: string[]) => JSON.stringify([...list].sort());
          if (before.subject_type !== after.subject_type || keys(before.subject_keys) !== keys(after.subject_keys)) {
            throw new Refusal(
              "identity_change",
              "identity.subject_type and the set of subject_keys cannot change: cases are bound to them. " +
                "Define a new responsibility instead.",
              { identity: before },
            );
          }
          if (current.content_hash === hash) {
            return { key: input.key, version: current.version, changed: false, previous_version: current.version };
          }
        }
        await tx.query(
          `INSERT INTO responsibility_versions
             (workspace_id, responsibility_id, version, title, definition, content_hash, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
          [ws, locked.id, version, input.title, JSON.stringify(definition), hash, scope.memberId, now],
        );
        return { key: input.key, version, changed: true, previous_version: current?.version ?? null };
      });
    },

    async getResponsibility(key) {
      const responsibility = await responsibilityByKey(driver, key, false);
      const now = clock();
      const last = await lastCompletedRun(driver, responsibility.id);
      const open = await openRunSummary(driver, responsibility.id, now);
      const { state } = await loadState(driver, responsibility.id, false);
      return {
        responsibility: {
          key: responsibility.key,
          title: responsibility.title,
          version: responsibility.version,
          definition: responsibility.definition,
          version_created_at: iso(responsibility.version_created_at),
        },
        last_run: last ? runSummary(last) : null,
        in_progress: open ? runSummary(open) : null,
        ...openCases(state),
      };
    },

    async startRun({ responsibility: key, agent, supersede }) {
      return driver.transaction(async (tx) => {
        const responsibility = await responsibilityByKey(tx, key, true);
        const runId = randomUUID();

        // last_active_at comes from the locked row itself: a write that renewed
        // it and committed while this waited for the lock is seen.
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
        const { state } = await loadState(tx, responsibility.id, false);
        const definition = responsibility.definition;
        await renew(tx, runId);
        return {
          run_id: runId,
          started_at: iso(now),
          expires_at: iso(expiresAt({ started_at: now })),
          run_limit: RUN_LIMIT,
          expectation_changed_since_last_run: last !== undefined && last.version_id !== responsibility.version_id,
          include: definition.include,
          attention_types: (definition.attention_types ?? []).map((type) => ({
            key: type.key,
            description: type.description,
            checked: type.when !== undefined,
          })),
          cases: openCases(state).cases,
        };
      });
    },

    async recordObservations(input) {
      // Rows are checked and digested before the database is touched.
      const entries = input.observations.map((entry) => ({
        kind: entry.kind,
        complete: entry.complete,
        replace: entry.replace ?? false,
        rows: normaliseRows(entry.kind, entry.rows).map((row) => ({ digest: digest(row), row })),
      }));
      const total = entries.reduce((sum, entry) => sum + entry.rows.length, 0);
      if (total > MAX_ROWS_PER_CALL) {
        throw new Refusal("call_too_large", `At most ${MAX_ROWS_PER_CALL} rows per call; this call has ${total}.`, {
          rows: total,
        });
      }

      return driver.transaction(async (tx) => {
        const run = await lockOwnRun(tx, input.run_id);
        // Read once the run is locked, for the lifetime check and the records;
        // the hold itself is stamped at the very end (renew).
        const now = clock();
        refuseIfAbandoned(run);
        refuseIfCompleted(run);
        refuseIfExpired(run, now);

        const recordable = recordableKinds(await definitionOf(tx, run.version_id));
        const kinds = new Map(
          (
            await tx.query<{ kind: string; complete: boolean }>(
              `SELECT kind, complete FROM run_observation_kinds WHERE workspace_id = $1 AND run_id = $2`,
              [ws, run.id],
            )
          ).map((row) => [row.kind, row.complete]),
        );

        let changed = false;
        const counts = new Map<string, number>();
        for (const entry of entries) {
          if (!recordable.includes(entry.kind)) {
            throw new Refusal(
              "unknown_kind",
              `${entry.kind} is neither included in this run's version nor read by one of its rules.`,
              { kind: entry.kind, kinds: recordable },
            );
          }
          const known = kinds.get(entry.kind);
          if (known !== undefined && known !== entry.complete) {
            throw new Refusal(
              "observation_conflict",
              `This run recorded ${entry.kind} as complete: ${known}; whether a kind is complete is fixed for a run.`,
              { kind: entry.kind, complete: known },
            );
          }

          let before = new Set<string>();
          if (known === undefined) {
            if (kinds.size >= MAX_KINDS_PER_RUN) {
              throw new Refusal("run_too_large", `A run records at most ${MAX_KINDS_PER_RUN} kinds.`, {
                kinds: [...kinds.keys()],
              });
            }
            await tx.query(
              `INSERT INTO run_observation_kinds (workspace_id, run_id, kind, complete, recorded_at)
               VALUES ($1, $2, $3, $4, $5)`,
              [ws, run.id, entry.kind, entry.complete, now],
            );
            kinds.set(entry.kind, entry.complete);
            changed = true;
          } else {
            before = new Set(
              (
                await tx.query<{ row_digest: string }>(
                  `SELECT row_digest FROM run_rows WHERE workspace_id = $1 AND run_id = $2 AND kind = $3`,
                  [ws, run.id, entry.kind],
                )
              ).map((row) => row.row_digest),
            );
          }

          // Rows are a set: the same row again changes nothing.
          const after = new Set(entry.replace ? [] : before);
          const added = new Map<string, Row>();
          for (const { digest: d, row } of entry.rows) {
            after.add(d);
            if (!before.has(d)) added.set(d, row);
          }
          if (after.size > RUN_LIMIT) {
            throw new Refusal(
              "run_too_large",
              `A run records at most ${RUN_LIMIT} rows of one kind; ${entry.kind} would have ${after.size}.`,
              { kind: entry.kind, run_limit: RUN_LIMIT },
            );
          }
          const removed = [...before].filter((d) => !after.has(d));
          if (removed.length) {
            await tx.query(
              `DELETE FROM run_rows
                WHERE workspace_id = $1 AND run_id = $2 AND kind = $3 AND row_digest = ANY($4::text[])`,
              [ws, run.id, entry.kind, removed],
            );
          }
          if (added.size) {
            await tx.query(
              `INSERT INTO run_rows (workspace_id, run_id, kind, row_digest, row)
               SELECT $1, $2, $3, t.row_digest, t.row::jsonb
                 FROM unnest($4::text[], $5::text[]) AS t(row_digest, row)`,
              [ws, run.id, entry.kind, [...added.keys()], [...added.values()].map((row) => JSON.stringify(row))],
            );
          }
          if (known !== undefined && (removed.length || added.size)) {
            await tx.query(
              `UPDATE run_observation_kinds SET recorded_at = $4
                WHERE workspace_id = $1 AND run_id = $2 AND kind = $3`,
              [ws, run.id, entry.kind, now],
            );
            changed = true;
          }
          counts.set(entry.kind, after.size);
        }

        // A changed observation invalidates the last view: complete_run then needs a new one.
        if (changed) {
          await tx.query(`UPDATE runs SET view_now = NULL, view_basis = NULL WHERE workspace_id = $1 AND id = $2`, [
            ws,
            run.id,
          ]);
        }
        // An accepted call, changed or not, keeps the run held (RUN_IDLE_MS).
        await renew(tx, run.id);
        return {
          run_id: run.id,
          observations: [...counts].map(([kind, rows]) => ({
            kind,
            id: `${run.id}:${kind}`,
            rows,
            complete: kinds.get(kind)!,
          })),
        };
      });
    },

    async viewRun({ run_id }) {
      return driver.transaction(async (tx) => {
        const run = await lockOwnRun(tx, run_id);
        const now = clock();
        refuseIfAbandoned(run);
        refuseIfCompleted(run);
        refuseIfExpired(run, now);

        const inputs = await stepInputs(tx, run, false);
        // A valid snapshot is delivered again as it was, without a new time.
        if (run.view_now && run.view_basis) {
          const again = viewOrNothing(inputs, iso(run.view_now));
          if (again?.basis === run.view_basis) {
            await renew(tx, run.id);
            return again;
          }
        }
        const at = viewNow(now, inputs.state, inputs.observations);
        const fresh = viewOrNothing(inputs, at);
        if (!fresh) {
          throw new Refusal("invalid_input", "The stored inputs of this run are not valid core input.", {
            run_id: run.id,
          });
        }
        await tx.query(`UPDATE runs SET view_now = $3, view_basis = $4 WHERE workspace_id = $1 AND id = $2`, [
          ws,
          run.id,
          at,
          fresh.basis,
        ]);
        await renew(tx, run.id);
        return fresh;
      });
    },

    async completeRun(input) {
      refuseUnstorableText({ summary: input.summary, report: input.report, evaluation: input.evaluation });

      return driver.transaction(async (tx) => {
        const run = await lockOwnRun(tx, input.run_id);
        const now = clock();
        refuseIfAbandoned(run);
        // A repeat by the same member and client gets the stored result back,
        // before the lifetime is looked at.
        if (run.completion) return { ...run.completion, already_completed: true as const };
        refuseIfExpired(run, now);

        const finish = async (result: CompleteResult) => {
          await tx.query(
            `UPDATE runs SET completed_at = $3, outcome = $4, summary = $5, report = $6, completion = $7::jsonb
              WHERE workspace_id = $1 AND id = $2`,
            [ws, run.id, now, input.outcome, input.summary ?? null, input.report ?? null, JSON.stringify(result)],
          );
          return result;
        };

        if (input.outcome === "failed") {
          if (!input.summary) {
            throw new Refusal("summary_required", "A failed run needs a summary saying why.", { run_id: run.id });
          }
          if (input.evaluation) {
            throw new Refusal("evaluation_forbidden", "A failed run takes no evaluation; nothing is stepped.", {
              run_id: run.id,
            });
          }
          return finish({
            run_id: run.id,
            outcome: "failed",
            completed_at: iso(now),
            basis: null,
            transitions: [],
            attention_events: [],
            rejections: [],
            state_digest: null,
          });
        }

        if (!input.evaluation) {
          throw new Refusal(
            "evaluation_required",
            `A ${input.outcome} run completes with an evaluation {basis, proposals} of its view_run.`,
            { run_id: run.id },
          );
        }
        if (!run.view_now || !run.view_basis) {
          throw new Refusal(
            "view_required",
            "There is no current view of this run: call view_run (again, after recording) and evaluate that view.",
            { run_id: run.id },
          );
        }
        // Checked by the host itself: with no proposals, `step` would take any basis silently.
        if (input.evaluation.basis !== run.view_basis) {
          throw new Refusal(
            "basis_mismatch",
            "evaluation.basis is not the basis of the last view_run of this run; copy it from that view.",
            { expected: run.view_basis, received: input.evaluation.basis },
          );
        }

        const inputs = await stepInputs(tx, run, true);
        const at = iso(run.view_now);
        if (viewOrNothing(inputs, at)?.basis !== run.view_basis) {
          throw new Refusal(
            "view_stale",
            "The inputs of this run changed since its view; call view_run again and evaluate the new view.",
            { run_id: run.id },
          );
        }

        const evaluation: Evaluation = {
          basis: run.view_basis,
          evaluator: run.agent.name,
          proposals: input.evaluation.proposals,
        };
        let result: StepResult;
        try {
          result = step(inputs.definition, inputs.state, inputs.observations, evaluation, at);
        } catch (error) {
          if (error instanceof InputError) throw new Refusal("invalid_input", error.message, { run_id: run.id });
          throw error;
        }

        // This run's observations, frozen: what later lookbacks and replays read.
        const frozen = inputs.runObservations;
        if (frozen.length) {
          await tx.query(
            `INSERT INTO core_observations
               (workspace_id, responsibility_id, id, kind, occurred_at, body, digest, run_id)
             SELECT $1, $2, t.id, t.kind, t.occurred_at::timestamptz, t.body::jsonb, t.digest, $3
               FROM unnest($4::text[], $5::text[], $6::text[], $7::text[], $8::text[])
                 AS t(id, kind, occurred_at, body, digest)`,
            [
              ws,
              run.responsibility_id,
              run.id,
              frozen.map((o) => o.id),
              frozen.map((o) => o.kind),
              frozen.map((o) => o.occurred_at),
              frozen.map((o) => JSON.stringify(o)),
              frozen.map((o) => digest(o)),
            ],
          );
        }

        // Compare and set: the state is stored only if it is still the one read.
        const written = inputs.stateDigest === null
          ? await tx.query(
              `INSERT INTO responsibility_states (workspace_id, responsibility_id, state, state_digest, updated_at)
               VALUES ($1, $2, $3::jsonb, $4, $5)
               ON CONFLICT DO NOTHING
               RETURNING 1`,
              [ws, run.responsibility_id, JSON.stringify(result.state), result.state_digest, now],
            )
          : await tx.query(
              `UPDATE responsibility_states SET state = $3::jsonb, state_digest = $4, updated_at = $5
                WHERE workspace_id = $1 AND responsibility_id = $2 AND state_digest = $6
                RETURNING 1`,
              [ws, run.responsibility_id, JSON.stringify(result.state), result.state_digest, now, inputs.stateDigest],
            );
        if (!written.length) {
          throw new Refusal("state_conflict", "The responsibility's state changed while this run completed; retry.", {
            run_id: run.id,
          });
        }

        await tx.query(
          `INSERT INTO core_steps
             (workspace_id, run_id, version_id, now, basis, observation_ids, evaluation, result,
              state_digest_before, state_digest_after)
           VALUES ($1, $2, $3, $4, $5, $6::text[], $7::jsonb, $8::jsonb, $9, $10)`,
          [
            ws,
            run.id,
            run.version_id,
            at,
            run.view_basis,
            inputs.observations.map((o) => o.id).sort(),
            JSON.stringify(evaluation),
            JSON.stringify({ ...result, state: undefined }), // the state itself is in responsibility_states
            inputs.stateDigest,
            result.state_digest,
          ],
        );
        const caseIds = new Set([
          ...result.transitions.map((t) => t.case_id),
          ...result.attention_events.map((e) => e.case_id),
          ...evaluation.proposals.map((p) => caseIdOf(inputs.definition.id, p.subject)),
        ]);
        if (caseIds.size) {
          await tx.query(
            `INSERT INTO core_step_cases (workspace_id, case_id, run_id)
             SELECT $1, c, $2 FROM unnest($3::text[]) AS c`,
            [ws, run.id, [...caseIds]],
          );
        }

        return finish({
          run_id: run.id,
          outcome: input.outcome,
          completed_at: iso(now),
          basis: run.view_basis,
          transitions: result.transitions,
          attention_events: result.attention_events,
          rejections: result.rejections,
          state_digest: result.state_digest,
        });
      });
    },

    async getCase({ responsibility: key, keys, limit }) {
      const responsibility = await responsibilityByKey(driver, key, false);
      const caseId = caseIdOf(responsibility.id, {
        type: responsibility.definition.identity.subject_type,
        keys,
      });
      const { state } = await loadState(driver, responsibility.id, false);
      const found = state && Object.hasOwn(state.cases, caseId) ? state.cases[caseId] : undefined;
      if (!found) {
        throw new Refusal("unknown_case", `${key} has no case with these keys.`, { keys });
      }
      const rows = await driver.query<
        RunSummaryRow & { now: Date; result: Omit<StepResult, "state">; evaluation: Evaluation }
      >(
        `SELECT ${RUN_SUMMARY_COLUMNS}, s.now, s.result, s.evaluation
           FROM core_step_cases sc
           JOIN core_steps s ON s.workspace_id = sc.workspace_id AND s.run_id = sc.run_id
           JOIN runs r ON r.workspace_id = s.workspace_id AND r.id = s.run_id
           ${RUN_SUMMARY_JOINS}
          WHERE sc.workspace_id = $1 AND sc.case_id = $2 AND r.responsibility_id = $3
          ORDER BY s.now DESC, r.completed_at DESC, r.id
          LIMIT $4`,
        [ws, caseId, responsibility.id, limit],
      );
      return {
        ...caseSummary(caseId, found),
        history: rows.map((row) => {
          const proposal =
            row.evaluation.proposals.find((p) => caseIdOf(responsibility.id, p.subject) === caseId) ?? null;
          return {
            run: runSummary(row),
            at: iso(row.now),
            transitions: row.result.transitions.filter((t) => t.case_id === caseId),
            attention_events: row.result.attention_events.filter((e) => e.case_id === caseId),
            proposal,
            cited: proposal ? [...proposal.cites].sort() : [],
          };
        }),
      };
    },
  };
}

function ref(row: { id: string; kind: string; occurred_at: Date }): ObservationRef {
  return { id: row.id, kind: row.kind, occurred_at: iso(row.occurred_at) };
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
