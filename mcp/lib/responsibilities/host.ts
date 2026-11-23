import {
  canonical,
  digest,
  InputError,
  view,
  type Case,
  type Definition,
  type Observation,
  type Rule,
  type State,
  type Subject,
} from "../core.ts";
import { MAX_OPEN_CASES, Refusal, type Row } from "./model.ts";

/**
 * The host's side of responsibilities-core (plan §2, §4.1, §4.2): rows into
 * observations, the lookback, the definition check, and read models shaped from
 * the core's own types. Pure: no database, and no rule about status, Attentions
 * or closing — `view` and `step` decide those.
 */

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const iso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();
const plusMs = (time: string, ms: number): string => new Date(Date.parse(time) + ms).toISOString();
const maxIso = (times: readonly string[]): string => times.reduce((a, b) => (b > a ? b : a));

/** `case_id = H({definition_id, subject_type, keys})` (docs/reference.md, derived ids). */
export function caseIdOf(definitionId: string, subject: Subject): string {
  return digest({ definition_id: definitionId, subject_type: subject.type, keys: subject.keys });
}

/** An observation as far as ordering and lookback need it, before its rows are loaded. */
export type ObservationRef = Pick<Observation, "id" | "kind" | "occurred_at">;

/** Later in the core's order: `occurred_at`, then `id` (`src/criteria.ts`, `evaluate`). */
export function later(a: ObservationRef, b: ObservationRef): boolean {
  return a.occurred_at === b.occurred_at ? a.id > b.id : a.occurred_at > b.occurred_at;
}

/** The newest of each kind among `observations`, by the core's order. */
export function newestByKind<T extends ObservationRef>(observations: readonly T[]): Map<string, T> {
  const newest = new Map<string, T>();
  for (const observation of observations) {
    const seen = newest.get(observation.kind);
    if (!seen || later(observation, seen)) newest.set(observation.kind, observation);
  }
  return newest;
}

/** The kinds a closing, `when` or success rule of the definition reads, sorted. */
export function kindsReadByRules(definition: Pick<Definition, "closing" | "success" | "attention_types">): string[] {
  const rules: Rule[] = [];
  for (const criterion of [...definition.closing, ...definition.success]) {
    rules.push(...(criterion.rules ?? []), ...(criterion.any_of ?? []).flatMap((route) => route.rules));
  }
  for (const type of definition.attention_types ?? []) rules.push(...(type.when ?? []));
  return [...new Set(rules.map((rule) => rule.kind))].sort(compare);
}

/** The kinds a run of this definition may record: those it includes and those its rules read. */
export function recordableKinds(definition: Definition): string[] {
  return [...new Set([...definition.include, ...kindsReadByRules(definition)])].sort(compare);
}

/** One kind recorded in a run, as stored. */
export type RunKind = { kind: string; complete: boolean; recorded_at: Date | string };

/**
 * Subjects of the rows that carry every subject key in a column of the same
 * name, sorted and unique. The core reads no `subjects` (only its schema checks
 * them), so this decides nothing; it only describes the rows.
 */
export function subjectsFromRows(rows: readonly Row[], identity: Definition["identity"]): Subject[] {
  const subjects = new Map<string, Subject>();
  for (const row of rows) {
    const keys: Subject["keys"] = {};
    const complete = identity.subject_keys.every((key) => {
      const value = Object.hasOwn(row, key) ? row[key] : undefined;
      if ((typeof value === "string" && value.length > 0) || Number.isSafeInteger(value)) {
        keys[key] = value as string | number;
        return true;
      }
      return false;
    });
    if (!complete) continue;
    const subject: Subject = { type: identity.subject_type, keys };
    subjects.set(canonical(subject), subject);
  }
  return [...subjects.keys()].sort(compare).map((key) => subjects.get(key)!);
}

/**
 * This run's observations, one per kind (plan §4.1): id `<run_id>:<kind>`, the
 * rows as a set in digest order, and an `occurred_at` strictly after the newest
 * stored observation of the kind — even if the host clock went back or stood
 * still — so the run's own observation is the newest of its kind.
 */
export function buildRunObservations(
  runId: string,
  kinds: readonly RunKind[],
  rows: ReadonlyMap<string, readonly { digest: string; row: Row }[]>,
  identity: Definition["identity"],
  newestStored: ReadonlyMap<string, ObservationRef>,
): Observation[] {
  return kinds
    .map((k): Observation => {
      const set = new Map((rows.get(k.kind) ?? []).map((one) => [one.digest, one.row]));
      const listed = [...set.keys()].sort(compare).map((d) => set.get(d)!);
      const stored = newestStored.get(k.kind);
      const recorded = iso(k.recorded_at);
      return {
        id: `${runId}:${k.kind}`,
        kind: k.kind,
        occurred_at: stored ? maxIso([recorded, plusMs(stored.occurred_at, 1)]) : recorded,
        subjects: subjectsFromRows(listed, identity),
        rows: listed,
        complete: k.complete,
      };
    })
    .sort((a, b) => compare(a.id, b.id));
}

/** The evidence ids of every open case: candidates for lookback (b). */
export function openEvidenceIds(state: State | null): string[] {
  const ids = new Set<string>();
  for (const c of Object.values(state?.cases ?? {})) {
    if (c.status === "open") for (const id of Object.keys(c.evidence)) ids.add(id);
  }
  return [...ids].sort(compare);
}

/**
 * The lookback (plan §4.2, `README.md` "History and lookback"), as the ids of
 * the observations to pass to `view` and `step`:
 *
 * - (a) every observation of this run;
 * - (b) for every open case, the newest observation of each kind it rests on;
 * - (c) for every kind a rule reads or the definition includes, the newest
 *   observation over this run and the stored ones.
 *
 * `evidence` describes the stored observations open cases rest on;
 * `newestStored` holds at least the newest stored observation of each kind in (c).
 * Nothing assumes this run's observation is the newest: (c) compares.
 */
export function selectLookback(
  state: State | null,
  definition: Definition,
  run: readonly ObservationRef[],
  evidence: readonly ObservationRef[],
  newestStored: readonly ObservationRef[],
): string[] {
  const selected = new Set(run.map((o) => o.id));

  const byId = new Map(evidence.map((o) => [o.id, o]));
  for (const c of Object.values(state?.cases ?? {})) {
    if (c.status !== "open") continue;
    const rests = Object.keys(c.evidence).flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    for (const o of newestByKind(rests).values()) selected.add(o.id);
  }

  const newest = newestByKind([...run, ...newestStored]);
  for (const kind of [...kindsReadByRules(definition), ...definition.include]) {
    const o = newest.get(kind);
    if (o) selected.add(o.id);
  }
  return [...selected].sort(compare);
}

/**
 * `view_now` (plan §4.3): the host clock, but never before `state.now` or any
 * observation passed, so the core's checks `now ≥ state.now` and
 * `occurred_at ≤ now` cannot fail on a host clock that went back.
 */
export function viewNow(clock: Date, state: State | null, observations: readonly ObservationRef[]): string {
  return maxIso([clock.toISOString(), ...(state ? [state.now] : []), ...observations.map((o) => o.occurred_at)]);
}

/** A definition as `put_responsibility` takes it: the core's, without `id` and `version`. */
export type DefinitionInput = Omit<Definition, "id" | "version">;

/**
 * The full definition of a version, checked (plan §3.2): routed Attention types
 * and success criteria are refused in v1; everything else is the core's own
 * check, through `view` on an empty state.
 */
export function validateDefinition(input: DefinitionInput, id: string, version: number, now: Date): Definition {
  if ((input.attention_types ?? []).some((type) => type.delivery !== undefined)) {
    throw new Refusal(
      "delivery_unsupported",
      "Routed Attention types (delivery) are not supported yet: the server has no outbox to deliver them.",
    );
  }
  if (input.success.length > 0) {
    throw new Refusal("success_unsupported", "Success criteria are not supported yet; send success: [].");
  }
  const definition: Definition = { ...input, id, version };
  try {
    view(definition, null, [], now.toISOString());
  } catch (error) {
    if (error instanceof InputError) throw new Refusal("invalid_definition", error.message);
    throw error;
  }
  return definition;
}

// --- read models -------------------------------------------------------------------

export type CaseSummary = {
  case_id: string;
  subject: Subject;
  status: Case["status"];
  episode: number;
  /** Earlier assessment by a judge: history, not truth. */
  title: string | null;
  /** Earlier assessment by a judge: history, not truth. */
  summary: string | null;
  attentions: { type: string; opened_at: string; activation: number }[];
  evidence: string[];
  first_observed: string;
  last_observed: string;
};

export function caseSummary(caseId: string, c: Case): CaseSummary {
  return {
    case_id: caseId,
    subject: c.subject,
    status: c.status,
    episode: c.episode,
    title: c.title,
    summary: c.summary,
    attentions: Object.keys(c.attentions)
      .filter((type) => c.attentions[type]!.status === "open")
      .sort(compare)
      .map((type) => ({ type, opened_at: c.attentions[type]!.opened_at, activation: c.attentions[type]!.activation })),
    evidence: Object.keys(c.evidence).sort(compare),
    first_observed: c.first_observed,
    last_observed: c.last_observed,
  };
}

/**
 * The open cases of a state (plan §3.3): those with an open Attention first,
 * oldest `opened_at` first, then by their subject keys; at most MAX_OPEN_CASES.
 */
export function openCases(state: State | null): { cases: CaseSummary[]; open_case_count: number; truncated: boolean } {
  const open = Object.entries(state?.cases ?? {})
    .filter(([, c]) => c.status === "open")
    .map(([id, c]) => {
      const summary = caseSummary(id, c);
      return {
        summary,
        since: summary.attentions.length ? summary.attentions.map((a) => a.opened_at).sort(compare)[0]! : null,
        keys: canonical(c.subject.keys),
      };
    })
    .sort(
      (a, b) =>
        Number(a.since === null) - Number(b.since === null) ||
        compare(a.since ?? "", b.since ?? "") ||
        compare(a.keys, b.keys),
    );
  return {
    cases: open.slice(0, MAX_OPEN_CASES).map((one) => one.summary),
    open_case_count: open.length,
    truncated: open.length > MAX_OPEN_CASES,
  };
}
