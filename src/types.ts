// The data the four functions read and return. `src/schema.json` is the contract; these
// types mirror it.

/** `YYYY-MM-DDTHH:MM:SS.sssZ`, nothing else. */
export type Time = string;
/** SHA-256 hex of RFC 8785 bytes. */
export type Hash = string;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** A Subject key value: a string or an integer, compared exactly. */
export type KeyValue = string | number;
export type Scalar = string | number | boolean;
export type Status = "open" | "resolved" | "dismissed";
export type Outcome = "met" | "not_met" | "unknown";

export interface Subject {
  type: string;
  keys: Record<string, KeyValue>;
}

/** Holds when a row of the latest observation of `kind` joins the Subject and has every `where` value. */
export interface PresentRule {
  kind: string;
  /** Row column -> Subject key name, 1 to 3 pairs. */
  match: Record<string, string>;
  where?: Record<string, Scalar>;
}

/** Holds when the latest observation of `kind` is complete and no row joins the Subject. */
export interface AbsentRule {
  kind: string;
  match: Record<string, string>;
  condition: "absent";
  /** The observation lists every Subject it knows of. */
  scope: "all";
}

export type Rule = PresentRule | AbsentRule;

/** `rules` (all must hold), `any_of` (one route must hold), or neither: words only, closing only. */
export interface Criterion {
  description: string;
  rules?: Rule[];
  any_of?: { rules: Rule[] }[];
}

/** A kind of Attention a Case can need: a person or team should look at it. */
export interface AttentionType {
  key: string;
  description: string;
  /** Rules that must all be `met` for the Subject before an Attention of this type opens or reopens. */
  when?: Rule[];
  /** Where an opening or reopening is delivered; without it the Attention is only recorded. */
  delivery?: { route: string };
}

export interface Definition {
  id: string;
  version: number;
  identity: { subject_type: string; subject_keys: string[] };
  accountable: string;
  expectations?: string;
  /** Observation kinds the judge sees and may cite. */
  include: string[];
  closing: Criterion[];
  success: Criterion[];
  attention_types?: AttentionType[];
}

export interface Observation {
  id: string;
  kind: string;
  occurred_at: Time;
  subjects: Subject[];
  rows: { [column: string]: Json }[];
  /** Whether `rows` is everything the source had. Only a complete observation can show absence. */
  complete: boolean;
}

export type AttentionIntent = "open" | "keep" | "close";

export interface ProposedAttention {
  /** An `attention_types` key. */
  type: string;
  intent: AttentionIntent;
  reason: string;
}

export interface Proposal {
  subject: Subject;
  status: "open" | "resolved";
  cites: string[];
  title?: string;
  summary?: string;
  attentions?: ProposedAttention[];
}

/** A proposed change to how the work is done, independent of any one Case. */
export interface ProposedImprovement {
  /** Names the Improvement; the same key again updates it. */
  key: string;
  title: string;
  change: string;
  rationale: string;
  /** Observation ids; at least one. */
  cites: string[];
}

export interface Evaluation {
  /** Copied from the `View` the judge was given. */
  basis: Hash;
  evaluator: string;
  proposals: Proposal[];
  improvements?: ProposedImprovement[];
}

export interface Command {
  /** `person:<id>` */
  actor: string;
  case_id: Hash;
  status: Status;
  /** Required for `dismissed`. */
  reason?: string;
}

export interface Case {
  subject: Subject;
  status: Status;
  /** Status-changing transitions so far, the opening included. */
  episode: number;
  /** Transitions so far; numbers the next transition id. */
  seq: number;
  /** Definition version of the latest transition. */
  version: number;
  title: string | null;
  summary: string | null;
  /** Observation id -> digest of the observation when it was linked. */
  evidence: Record<string, Hash>;
  first_observed: Time;
  last_observed: Time;
  /** Attention type -> its latest activation on this Case. */
  attentions: Record<string, Attention>;
}

export interface Attention {
  status: "open" | "closed";
  /** Openings so far, the first included; a reopening is a new activation. */
  activation: number;
  opened_at: Time;
  closed_at: Time | null;
}

export interface Improvement {
  key: string;
  title: string;
  change: string;
  rationale: string;
  /** Observation id -> digest of the observation when it was cited. */
  evidence: Record<string, Hash>;
  proposed_at: Time;
  updated_at: Time;
  /** Events so far; numbers the next event id. */
  seq: number;
  /** Definition version of the latest event. */
  version: number;
}

export interface State {
  spec: string;
  definition_id: string;
  identity_digest: Hash;
  now: Time;
  cases: Record<Hash, Case>;
  /** `H({definition_id, key})` -> the Improvement. */
  improvements: Record<Hash, Improvement>;
}

export interface View {
  spec: string;
  basis: Hash;
  observations: Observation[];
  /** Every Case, open or not, by case_id. */
  cases: { case_id: Hash; subject: Subject; status: Status; episode: number; title: string | null; attentions: string[] }[];
  /** The declared types; whether a check gates an opening and whether one is delivered, never the rules. */
  attention_types: { key: string; description: string; checked: boolean; routed: boolean }[];
  improvements: { key: string; title: string; change: string }[];
  closing: string[];
  expectations?: string;
}

export interface RuleTrace {
  kind: string;
  condition: "present" | "absent";
  observation: string | null;
  result: Outcome;
  reason: string;
}

export interface CriterionTrace {
  description: string;
  result: Outcome;
  routes: { result: Outcome; rules: RuleTrace[] }[];
}

export interface Check {
  result: Outcome;
  criteria: CriterionTrace[];
}

export interface Transition {
  id: Hash;
  case_id: Hash;
  kind: "opened" | "status_changed" | "updated";
  from: Status | null;
  to: Status;
  /** `judge:<evaluator>` or `person:<id>` */
  actor: string;
  reason?: string;
  added_evidence: { obs_id: string; digest: Hash }[];
  /** Present only when changed by this transition. */
  title?: string;
  summary?: string;
  closing_check?: Check;
  version: number;
  at: Time;
}

export interface AttentionEvent {
  /** `H([case_id, type, activation, event])` */
  id: Hash;
  case_id: Hash;
  type: string;
  event: "opened" | "reopened" | "closed";
  activation: number;
  actor: string;
  reason: string;
  /** The ref of the proposal that asked for it. */
  proposal: Hash;
  /** The `when` check that allowed an opening or reopening. */
  gate_check?: Check;
  version: number;
  at: Time;
}

/** One opening or reopening of a routed Attention type: what the host delivers. */
export interface Delivery {
  /** `H([case_id, type, activation])`: the dedupe key, stable across replays. */
  id: Hash;
  case_id: Hash;
  subject: Subject;
  type: string;
  activation: number;
  route: string;
  reason: string;
  event_id: Hash;
}

export interface ImprovementEvent {
  /** `H([improvement_id, seq])` */
  id: Hash;
  improvement_id: Hash;
  key: string;
  kind: "proposed" | "updated";
  actor: string;
  added_evidence: { obs_id: string; digest: Hash }[];
  /** Present only when changed by this event. */
  title?: string;
  change?: string;
  rationale?: string;
  version: number;
  at: Time;
}

export type RejectionCode =
  | "BASIS_MISMATCH"
  | "UNKNOWN_EVIDENCE"
  | "NO_EVIDENCE"
  | "IDENTITY_MISMATCH"
  | "CONFLICTING_PROPOSALS"
  | "STATUS_NOT_ALLOWED"
  | "CLOSING_NOT_MET"
  | "REOPEN_WHILE_CLOSING_MET"
  | "STATUS_UNCHANGED_NO_NEW_EVIDENCE"
  | "ATTENTION_REPEATED"
  | "ATTENTION_NO_REASON"
  | "ATTENTION_NOT_DECLARED"
  | "ATTENTION_CASE_NOT_OPEN"
  | "ATTENTION_GATE_NOT_MET"
  | "IMPROVEMENT_CONFLICT"
  | "IMPROVEMENT_INCOMPLETE";

export interface Rejection {
  /**
   * `proposal` is `H(proposal)`, `improvement` is `H(improvement)`. `part` says what was not
   * taken: a whole proposal, its status and text, one Attention entry, or one Improvement.
   * `key` is the Attention type or the Improvement key.
   */
  ref:
    | { proposal: Hash; case_id?: Hash; part: "proposal" | "status" | "attention"; key?: string }
    | { improvement: Hash; part: "improvement"; key: string };
  code: RejectionCode;
  detail: {
    message: string;
    expected?: Hash;
    received?: Hash;
    unknown?: string[];
    closing_check?: Check;
    gate_check?: Check;
    proposed_title?: string;
    proposed_summary?: string;
  };
}

export interface StepResult {
  spec: string;
  state: State | null;
  transitions: Transition[];
  attention_events: AttentionEvent[];
  deliveries: Delivery[];
  improvement_events: ImprovementEvent[];
  rejections: Rejection[];
  state_digest: Hash;
}

export interface Assessment {
  spec: string;
  case_id: Hash;
  result: Outcome;
  criteria: CriterionTrace[];
}
