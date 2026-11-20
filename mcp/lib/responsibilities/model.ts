import { createHash } from "node:crypto";

/**
 * The deterministic rules of the responsibilities domain (plan §5), free of SQL
 * and of MCP: fact validation and normalisation, coverage carry-over, the diff,
 * vocabulary checks and case transitions. The store applies them inside its
 * transactions; the tests exercise them directly.
 */

// --- limits (§5.4) -----------------------------------------------------------

export const RUN_LIFETIME_MS = 2 * 60 * 60 * 1000;
export const RUN_LIMIT = 1000;
export const MAX_SUBJECTS_PER_CALL = 200;
export const MAX_DECISIONS = 1000;
export const MAX_OPEN_CASES = 1000;
export const MAX_FACT_KEYS = 100;
export const MAX_FACT_KEY_LENGTH = 120;
export const MAX_FACT_STRING = 500;
export const MAX_FACT_ARRAY_ITEMS = 50;
export const MAX_FACT_ARRAY_ITEM = 200;
export const MAX_SUBJECT = 200;
export const MAX_BASIS = 500;
export const MAX_ACTION = 300;
export const MAX_TARGET = 100;
export const MAX_SUMMARY = 1000;
export const MAX_REPORT = 65_536;
export const MAX_EXPECTATION = 8000;
export const MAX_TITLE = 120;
export const MAX_CLOSE_REASON = 300;
export const MAX_CITES = 20;

export const RESPONSIBILITY_KEY = /^[a-z0-9][a-z0-9-]{1,62}$/;
export const SUBJECT_TYPE = /^[a-z][a-z0-9_]{0,59}$/;
export const ASSESSMENT_LABEL = /^[a-z][a-z0-9_]{0,39}$/;
export const FACT_KEY = /^[a-z][a-z0-9_]*(\.[A-Za-z0-9_-]+){0,3}$/;
export const FACT_GROUP = /^[a-z][a-z0-9_]*$/;

// --- refusals ----------------------------------------------------------------

/**
 * A domain refusal: the request reached the tool and was refused, nothing was
 * written. Becomes an `isError` result `{error, reason, ...detail}`.
 */
export class Refusal extends Error {
  override readonly name = "Refusal";
  readonly code: string;
  readonly detail: Record<string, unknown>;

  constructor(code: string, reason: string, detail: Record<string, unknown> = {}) {
    super(reason);
    this.code = code;
    this.detail = detail;
  }

  toJSON(): Record<string, unknown> {
    return { error: this.code, reason: this.message, ...this.detail };
  }
}

// --- canonical JSON ------------------------------------------------------------

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** JSON with object keys sorted at every level: equal values, equal strings. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const inner = (value as Record<string, unknown>)[key];
      if (inner !== undefined) out[key] = sortKeys(inner);
    }
    return out;
  }
  return value;
}

export function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

// --- responsibilities ----------------------------------------------------------

export type Assessment = { label: string; attention: boolean };

export type ResponsibilityContent = {
  title: string;
  subject_type: string;
  expectation: string;
  assessments: Assessment[];
};

/** Refuses a vocabulary with repeated labels. */
export function checkAssessments(assessments: readonly Assessment[]): void {
  const seen = new Set<string>();
  for (const { label } of assessments) {
    if (seen.has(label)) {
      throw new Refusal("invalid_assessments", `The label ${label} appears more than once.`, { label });
    }
    seen.add(label);
  }
}

/** sha256 of the canonical JSON of the four versioned fields. */
export function contentHash(content: ResponsibilityContent): string {
  const normalised = {
    title: content.title,
    subject_type: content.subject_type,
    expectation: content.expectation,
    assessments: content.assessments.map(({ label, attention }) => ({ label, attention })),
  };
  return createHash("sha256").update(canonicalJson(normalised)).digest("hex");
}

// --- facts (§5.2) ----------------------------------------------------------------

export type FactValue = string | number | boolean | null | string[];
export type Facts = Record<string, FactValue>;

/** The key's group: its first segment, which sources declare they cover. */
export function groupOf(key: string): string {
  const dot = key.indexOf(".");
  return dot === -1 ? key : key.slice(0, dot);
}

/**
 * Validates and normalises one subject's facts. Arrays are stored sorted and
 * de-duplicated so they compare as sets. Throws `invalid_fact` naming the
 * subject and key; nothing is silently cut.
 */
export function normaliseFacts(subject: string, raw: Record<string, unknown>): Facts {
  const keys = Object.keys(raw);
  if (keys.length > MAX_FACT_KEYS) {
    throw new Refusal("invalid_fact", `At most ${MAX_FACT_KEYS} facts per subject.`, { subject });
  }
  const facts: Facts = {};
  for (const key of keys) {
    const bad = (why: string) =>
      new Refusal("invalid_fact", `Fact ${JSON.stringify(key)} of ${subject}: ${why}`, { subject, key });
    if (key.length > MAX_FACT_KEY_LENGTH || !FACT_KEY.test(key)) {
      throw bad(
        `keys match ^[a-z][a-z0-9_]*(\\.[A-Za-z0-9_-]+){0,3}$ and are at most ${MAX_FACT_KEY_LENGTH} characters.`,
      );
    }
    const value = raw[key];
    if (value === null || typeof value === "boolean") {
      facts[key] = value;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) throw bad("numbers must be finite.");
      facts[key] = value;
    } else if (typeof value === "string") {
      if (value.length > MAX_FACT_STRING) throw bad(`strings are at most ${MAX_FACT_STRING} characters.`);
      facts[key] = value;
    } else if (Array.isArray(value)) {
      if (value.length > MAX_FACT_ARRAY_ITEMS) throw bad(`arrays hold at most ${MAX_FACT_ARRAY_ITEMS} items.`);
      for (const item of value) {
        if (typeof item !== "string") throw bad("arrays hold strings only.");
        if (item.length > MAX_FACT_ARRAY_ITEM) {
          throw bad(`array items are at most ${MAX_FACT_ARRAY_ITEM} characters.`);
        }
      }
      facts[key] = [...new Set(value as string[])].sort();
    } else {
      throw bad("values are a string, a finite number, a boolean, null, or an array of strings.");
    }
  }
  return facts;
}

// --- sources --------------------------------------------------------------------

export type Source = {
  name: string;
  complete: boolean;
  count?: number;
  note?: string;
  covers: string[];
};

/**
 * Normalises a declaration so that the same declaration in a different order is
 * canonically identical: sources sorted by name, covers sorted and unique.
 * Refuses repeated source names.
 */
export function normaliseSources(sources: readonly Source[]): Source[] {
  const names = new Set<string>();
  const out: Source[] = [];
  for (const source of sources) {
    if (names.has(source.name)) {
      throw new Refusal("invalid_sources", `The source ${source.name} is declared more than once.`, {
        source: source.name,
      });
    }
    names.add(source.name);
    const normalised: Source = {
      name: source.name,
      complete: source.complete,
      covers: [...new Set(source.covers)].sort(),
    };
    if (source.count !== undefined) normalised.count = source.count;
    if (source.note !== undefined) normalised.note = source.note;
    out.push(normalised);
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Step 1 of §5.2: every key of the previous observation that is absent now and
 * whose group is not covered, or covered by a source with `complete: false`, is
 * stored as `null` (unknown) rather than read as removed.
 */
export function carryUnknowns(previous: Facts | null, current: Facts, sources: readonly Source[]): Facts {
  if (!previous) return { ...current };
  const out: Facts = { ...current };
  for (const key of Object.keys(previous)) {
    if (Object.hasOwn(out, key)) continue;
    const group = groupOf(key);
    const covering = sources.filter((source) => source.covers.includes(group));
    if (covering.length === 0 || covering.some((source) => !source.complete)) out[key] = null;
  }
  return out;
}

export type Changes = {
  added: string[];
  removed: string[];
  became_unknown: string[];
  changed: { key: string; from: FactValue; to: FactValue }[];
};

/**
 * Step 2 of §5.2: the diff of the stored facts against the previous observation.
 *
 * Presence is always an own-property check: a valid key such as `constructor`
 * is inherited by every plain object, so `in` would report it present.
 */
export function diffFacts(previous: Facts | null, current: Facts): { changes: Changes; unchanged: number } {
  const before = previous ?? {};
  const changes: Changes = { added: [], removed: [], became_unknown: [], changed: [] };
  let unchanged = 0;

  for (const key of Object.keys(current).sort()) {
    const now = current[key];
    if (!Object.hasOwn(before, key)) {
      changes.added.push(key);
      continue;
    }
    const was = before[key];
    if (now === null) {
      if (was !== null) changes.became_unknown.push(key);
      else unchanged += 1;
      continue;
    }
    if (sameJson(was, now)) unchanged += 1;
    else changes.changed.push({ key, from: was, to: now });
  }
  for (const key of Object.keys(before).sort()) {
    if (!Object.hasOwn(current, key)) changes.removed.push(key);
  }
  return { changes, unchanged };
}

// --- decisions and transitions (§5.3) -------------------------------------------

export type Attention = { action: string; target: string; assignee?: string };

export type DecisionInput = {
  subject: string;
  assessment: string;
  attention: Attention | null;
  basis: string;
  cites?: string[];
  close?: { reason: string };
};

/** Validates one decision against the run's vocabulary. */
export function checkDecision(decision: DecisionInput, vocabulary: readonly Assessment[]): Assessment {
  const label = vocabulary.find((one) => one.label === decision.assessment);
  if (!label) {
    throw new Refusal(
      "unknown_assessment",
      `${decision.subject}: ${decision.assessment} is not a label of this run's version.`,
      { subject: decision.subject, labels: vocabulary.map((one) => one.label) },
    );
  }
  if (decision.close && label.attention) {
    throw new Refusal(
      "close_with_attention",
      `${decision.subject}: a case cannot be closed with ${label.label}, which needs attention.`,
      { subject: decision.subject },
    );
  }
  if (label.attention !== (decision.attention !== null)) {
    throw new Refusal(
      "attention_mismatch",
      label.attention
        ? `${decision.subject}: ${label.label} needs attention {action, target}.`
        : `${decision.subject}: ${label.label} takes no attention (send null).`,
      { subject: decision.subject, assessment: label.label, attention_required: label.attention },
    );
  }
  return label;
}

export type CaseRow = {
  status: "open" | "closed";
  attention_since: Date | null;
};

export type LatestDecision = { assessment: string; attention: Attention | null } | null;

export type Transition = {
  status: "open" | "closed";
  closed_at: Date | null;
  close_reason: string | null;
  attention_since: Date | null;
  attention: "opened" | "continued" | "ended" | "none";
};

/**
 * The case after a decision (plan §5.3). Attention continues — `attention_since`
 * kept — only when the case was open and its latest decision had the same
 * assessment and the same `attention.target`; free-text `action` is ignored.
 */
export function transition(
  current: CaseRow,
  latest: LatestDecision,
  decision: DecisionInput,
  label: Assessment,
  now: Date,
): Transition {
  const hadAttention = current.status === "open" && current.attention_since !== null;

  if (decision.close) {
    return {
      status: "closed",
      closed_at: now,
      close_reason: decision.close.reason,
      attention_since: null,
      attention: hadAttention ? "ended" : "none",
    };
  }
  if (!label.attention) {
    return {
      status: "open",
      closed_at: null,
      close_reason: null,
      attention_since: null,
      attention: hadAttention ? "ended" : "none",
    };
  }
  const continues =
    current.status === "open" &&
    current.attention_since !== null &&
    latest !== null &&
    latest.assessment === decision.assessment &&
    latest.attention !== null &&
    decision.attention !== null &&
    latest.attention.target === decision.attention.target;
  return {
    status: "open",
    closed_at: null,
    close_reason: null,
    attention_since: continues ? current.attention_since : now,
    attention: continues ? "continued" : "opened",
  };
}

/** The key two subjects collide on. */
export function subjectKey(subject: string): string {
  return subject.toLowerCase();
}

/** Refuses two entries for one subject (case-insensitive) in one call. */
export function checkUniqueSubjects(subjects: readonly string[]): void {
  const seen = new Set<string>();
  for (const subject of subjects) {
    const key = subjectKey(subject);
    if (seen.has(key)) {
      throw new Refusal("duplicate_subject", `${subject} appears more than once in this call.`, { subject });
    }
    seen.add(key);
  }
}
