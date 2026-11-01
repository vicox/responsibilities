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

export type ParamType = "string" | "int" | "bool";

export interface OfferedAction {
  key: string;
  params: Record<string, ParamType>;
}

export interface ProposedAction {
  key: string;
  arguments: Record<string, Scalar>;
  reason: string;
}

export interface Proposal {
  subject: Subject;
  status: "open" | "resolved";
  cites: string[];
  title?: string;
  summary?: string;
  actions?: ProposedAction[];
}

export interface Evaluation {
  /** Copied from the `View` the judge was given. */
  basis: Hash;
  evaluator: string;
  proposals: Proposal[];
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
  /** `[key, episode]` of the requests of the current episode. */
  requested: [string, number][];
}

export interface State {
  spec: string;
  definition_id: string;
  identity_digest: Hash;
  now: Time;
  cases: Record<Hash, Case>;
}

export interface View {
  spec: string;
  basis: Hash;
  observations: Observation[];
  open_cases: { case_id: Hash; subject: Subject; status: Status; episode: number }[];
  closing: string[];
  expectations?: string;
  offered_actions: OfferedAction[];
  max_requests: number;
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
  | "ACTION_NOT_OFFERED"
  | "ACTION_ARGUMENTS"
  | "ACTION_NO_REASON"
  | "ACTION_CASE_NOT_OPEN"
  | "ACTION_REPEATED"
  | "ACTION_OVER_LIMIT";

export interface Rejection {
  /** `proposal` is `H(proposal)`. `part` says what was not taken: all of it, its status and text, or one action. */
  ref: { proposal: Hash; case_id?: Hash; part: "proposal" | "status" | "action"; key?: string };
  code: RejectionCode;
  detail: {
    message: string;
    expected?: Hash;
    received?: Hash;
    unknown?: string[];
    closing_check?: Check;
    proposed_title?: string;
    proposed_summary?: string;
  };
}

export interface ActionRequest {
  /** `H([case_id, key, episode])`: the dedupe key, stable across replays. */
  id: Hash;
  case_id: Hash;
  key: string;
  arguments: Record<string, Scalar>;
  reason: string;
  episode: number;
  transition_id: Hash;
}

export interface StepResult {
  spec: string;
  state: State | null;
  transitions: Transition[];
  rejections: Rejection[];
  action_requests: ActionRequest[];
  state_digest: Hash;
}

export interface Assessment {
  spec: string;
  case_id: Hash;
  result: Outcome;
  criteria: CriterionTrace[];
}
