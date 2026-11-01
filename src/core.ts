import { digest as H } from "./canonical.ts";
import { evaluate, hasRules } from "./criteria.ts";
import type {
  ActionRequest, Assessment, Case, Check, Command, Definition, Evaluation, Hash, OfferedAction, Observation,
  ParamType, Proposal, ProposedAction, Rejection, RejectionCode, Scalar, State, Status, StepResult, Subject, Time, Transition, View,
} from "./types.ts";
import { conform, hasOwn, InputError } from "./validate.ts";

/** In every output and every state; fixtures are bound to it. */
export const SPEC = "responsibility-core/0";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One more; a state whose counter cannot grow is refused rather than overflowed. */
function increment(count: number, path: string): number {
  if (count >= Number.MAX_SAFE_INTEGER) throw new InputError(`${path} cannot count beyond 2^53−1`);
  return count + 1;
}

const identityDigest = (d: Definition): Hash =>
  H({ subject_type: d.identity.subject_type, subject_keys: [...d.identity.subject_keys].sort() });
const caseId = (d: Definition, subject: Subject): Hash =>
  H({ definition_id: d.id, subject_type: subject.type, keys: subject.keys });

interface Inputs {
  definition: Definition;
  state: State | null;
  now: Time;
}

/** Definition, state and `now`, validated and copied; the checks every function shares. */
function prepare(definition: unknown, state: unknown, now: unknown): Inputs {
  conform(definition, "definition", "definition");
  conform(state, "state_or_null", "state");
  conform(now, "time", "now");
  const d = clone(definition as Definition);
  const s = clone(state as State | null);

  const criteria = [
    ...d.closing.map((c, i) => [c, `definition.closing[${i}]`] as const),
    ...d.success.map((c, i) => [c, `definition.success[${i}]`] as const),
  ];
  for (const [criterion, path] of criteria) {
    const routes = criterion.any_of ?? (criterion.rules ? [{ rules: criterion.rules }] : []);
    for (const { rules } of routes) {
      for (const rule of rules) {
        for (const [column, key] of Object.entries(rule.match)) {
          if (!d.identity.subject_keys.includes(key)) throw new InputError(`${path}: match.${column} names ${key}, which is not a subject key`);
        }
      }
    }
    const absent = (criterion.any_of ?? []).filter(({ rules }) => rules.some((rule) => hasOwn(rule, "condition")));
    if (absent.length > 1) {
      throw new InputError(`${path}.any_of: only one route may say condition: absent; scope: all covers every subject, so a second would close on whichever kind is silent`);
    }
  }

  if (s) {
    if (s.definition_id !== d.id) throw new InputError(`state belongs to definition ${s.definition_id}, not ${d.id}`);
    if (s.identity_digest !== identityDigest(d)) throw new InputError("state was made for another subject_type or subject_keys");
    if ((now as Time) < s.now) throw new InputError(`now (${now}) is before state.now (${s.now})`);
    for (const [id, c] of Object.entries(s.cases)) {
      if (caseId(d, c.subject) !== id) throw new InputError(`state.cases.${id} is not the id of its subject`);
    }
  }
  return { definition: d, state: s, now: now as Time };
}

/** Observations, validated and sorted by id. */
function observe(observations: unknown, { state, now }: Inputs): Observation[] {
  conform(observations, "observations", "observations");
  const list = clone(observations as Observation[]).sort((a, b) => compare(a.id, b.id));
  list.forEach((o, i) => {
    if (i > 0 && list[i - 1]!.id === o.id) throw new InputError(`observations: ${o.id} occurs twice`);
    if (o.occurred_at > now) throw new InputError(`observation ${o.id} occurred after now`);
    const digest = H(o);
    for (const [id, c] of Object.entries(state?.cases ?? {})) {
      if (hasOwn(c.evidence, o.id) && c.evidence[o.id] !== digest) {
        throw new InputError(`observation ${o.id} is not the one linked to case ${id}: observations are immutable`);
      }
    }
  });
  return list;
}

/** Offered actions, validated and sorted by key. */
function offer(offered_actions: unknown): OfferedAction[] {
  conform(offered_actions, "offered_actions", "offered_actions");
  const list = clone(offered_actions as OfferedAction[]).sort((a, b) => compare(a.key, b.key));
  list.forEach((a, i) => {
    if (i > 0 && list[i - 1]!.key === a.key) throw new InputError(`offered_actions: ${a.key} occurs twice`);
  });
  return list;
}

function basis(inputs: Inputs, observations: Observation[], offered: OfferedAction[], max_requests: number): Hash {
  return H({
    spec: SPEC,
    state_digest: H(inputs.state),
    definition_digest: H(inputs.definition),
    observations_digest: H(observations),
    offered_actions_digest: H(offered),
    max_requests,
    now: inputs.now,
  });
}

/** What the external judge is given, and the `basis` its evaluation must carry. */
export function view(
  definition: Definition, state: State | null, observations: Observation[],
  offered_actions: OfferedAction[], max_requests: number, now: Time,
): View {
  const inputs = prepare(definition, state, now);
  const all = observe(observations, inputs);
  const offered = offer(offered_actions);
  conform(max_requests, "max_requests", "max_requests");
  const d = inputs.definition;
  const cases = inputs.state?.cases ?? {};
  return {
    spec: SPEC,
    basis: basis(inputs, all, offered, max_requests),
    observations: all.filter((o) => d.include.includes(o.kind)),
    open_cases: Object.keys(cases).sort().filter((id) => cases[id]!.status === "open")
      .map((id) => ({ case_id: id, subject: cases[id]!.subject, status: "open" as const, episode: cases[id]!.episode })),
    closing: d.closing.map((c) => c.description),
    ...(d.expectations === undefined ? {} : { expectations: d.expectations }),
    offered_actions: offered,
    max_requests,
  };
}

const ACTION_MESSAGES: Partial<Record<RejectionCode, string>> = {
  ACTION_CASE_NOT_OPEN: "the case is not open after this step",
  ACTION_NOT_OFFERED: "this action is not offered in this step",
  ACTION_ARGUMENTS: "the arguments do not match the offered params exactly",
  ACTION_NO_REASON: "the reason is empty",
  ACTION_REPEATED: "this key was already requested in this episode, or the proposal names it more than once",
  ACTION_OVER_LIMIT: "more requests than max_requests in this step; earlier (case_id, key) come first",
};

const fits = (value: Scalar, type: ParamType): boolean =>
  type === "string" ? typeof value === "string" : type === "int" ? Number.isInteger(value) : typeof value === "boolean";

function argumentsFit(args: Record<string, Scalar>, params: Record<string, ParamType>): boolean {
  const names = Object.keys(params);
  return Object.keys(args).length === names.length && names.every((n) => hasOwn(args, n) && fits(args[n]!, params[n]!));
}

interface Work {
  ref: Hash;
  id: Hash;
  c: Case;
  opened: boolean;
  from: Status | null;
  added: { obs_id: string; digest: Hash }[];
  statusChanged: boolean;
  text: { title?: string; summary?: string };
  closing_check?: Check;
  accepted: ProposedAction[];
}

/** One judgment applied: every proposal is taken, in part, or rejected with a code. */
export function step(
  definition: Definition, state: State | null, observations: Observation[], offered_actions: OfferedAction[],
  max_requests: number, evaluation: Evaluation, now: Time,
): StepResult {
  // 0. Inputs
  const inputs = prepare(definition, state, now);
  const all = observe(observations, inputs);
  const offered = offer(offered_actions);
  conform(max_requests, "max_requests", "max_requests");
  conform(evaluation, "evaluation", "evaluation");
  const { basis: received, evaluator, proposals: raw } = clone(evaluation);
  const d = inputs.definition;
  // 2. Canonical order (observations and offered actions are sorted already). A proposal
  // is hashed with its cites by id and its actions by (key, H(arguments), H(action)), so no
  // list order reaches its ref.
  const proposals = raw.map((p) => {
    const actions = p.actions?.map((a) => ({ a, args: H(a.arguments), whole: H(a) }))
      .sort((x, y) => compare(x.a.key, y.a.key) || compare(x.args, y.args) || compare(x.whole, y.whole)).map(({ a }) => a);
    const canonical: Proposal = { ...p, cites: [...p.cites].sort(compare), ...(actions ? { actions } : {}) };
    return { p: canonical, ref: H(canonical) };
  }).sort((a, b) => compare(a.ref, b.ref));

  // 1. Basis
  const expected = basis(inputs, all, offered, max_requests);
  if (received !== expected) {
    const rejections = proposals.map(({ ref }): Rejection => ({
      ref: { proposal: ref, part: "proposal" },
      code: "BASIS_MISMATCH",
      detail: { message: "the evaluation was made for other inputs than this step's", expected, received },
    }));
    return result(inputs.state, [], rejections, []);
  }

  const next: State = inputs.state ?? { spec: SPEC, definition_id: d.id, identity_digest: identityDigest(d), now, cases: {} };
  const visible = new Map(all.filter((o) => d.include.includes(o.kind)).map((o) => [o.id, o]));
  const offers = new Map(offered.map((a) => [a.key, a.params]));
  const keys = [...d.identity.subject_keys].sort();
  const declared = (s: Subject) => {
    const named = Object.keys(s.keys).sort();
    return s.type === d.identity.subject_type && named.length === keys.length && named.every((k, i) => k === keys[i]);
  };
  const ids = proposals.map(({ p }) => (declared(p.subject) ? caseId(d, p.subject) : null));
  const named = new Map<Hash, number>();
  for (const id of ids) if (id) named.set(id, (named.get(id) ?? 0) + 1);

  const rejections: Rejection[] = [];
  const work: Work[] = [];
  const candidates: { w: Work; action: ProposedAction }[] = [];

  proposals.forEach(({ p, ref }, index) => {
    const id = ids[index]!;
    const whole = (code: RejectionCode, message: string, unknown?: string[]) => {
      rejections.push({ ref: { proposal: ref, ...(id ? { case_id: id } : {}), part: "proposal" }, code, detail: { message, ...(unknown ? { unknown } : {}) } });
    };
    // 3. Whole proposals
    if (!id) return whole("IDENTITY_MISMATCH", `the subject must be a ${d.identity.subject_type} with exactly the keys ${keys.join(", ")}`);
    if (named.get(id)! > 1) return whole("CONFLICTING_PROPOSALS", "more than one proposal names this subject");
    if (!p.cites.length) return whole("NO_EVIDENCE", "the proposal cites no observation");
    const unknown = p.cites.filter((obs) => !visible.has(obs)).sort();
    if (unknown.length) return whole("UNKNOWN_EVIDENCE", "cited observations are not among this step's included observations", unknown);
    const existing = hasOwn(next.cases, id) ? next.cases[id]! : undefined;
    if (!existing && p.status !== "open") return whole("STATUS_NOT_ALLOWED", "a new case can only be proposed as open");

    // 4. Evidence
    const cited = p.cites.map((obs) => visible.get(obs)!).sort((a, b) => compare(a.id, b.id));
    const first = cited[0]!.occurred_at;
    const c: Case = existing ?? {
      subject: p.subject, status: "open", episode: 1, seq: 0, version: d.version, title: null, summary: null,
      evidence: {}, first_observed: first, last_observed: first, requested: [],
    };
    next.cases[id] = c;
    const w: Work = { ref, id, c, opened: !existing, from: existing?.status ?? null, added: [], statusChanged: false, text: {}, accepted: [] };
    work.push(w);
    for (const o of cited) {
      if (hasOwn(c.evidence, o.id)) continue;
      const digest = H(o);
      Object.defineProperty(c.evidence, o.id, { value: digest, enumerable: true, writable: true, configurable: true });
      w.added.push({ obs_id: o.id, digest });
      if (o.occurred_at < c.first_observed) c.first_observed = o.occurred_at;
      if (o.occurred_at > c.last_observed) c.last_observed = o.occurred_at;
    }

    // 5. Status
    let statusRejected = false;
    if (p.status !== c.status) {
      const ruled = d.closing.some(hasRules);
      const check = ruled ? evaluate(d.closing, c.subject, all) : undefined;
      let code: RejectionCode | null = null;
      let message = "";
      if (p.status === "resolved") {
        if (check && check.result !== "met") [code, message] = ["CLOSING_NOT_MET", `the closing criteria are ${check.result}`];
        else if (!check && !w.added.length) [code, message] = ["STATUS_UNCHANGED_NO_NEW_EVIDENCE", "no closing criterion has rules, so resolving needs new evidence"];
      } else if (check?.result === "met") {
        [code, message] = ["REOPEN_WHILE_CLOSING_MET", "the closing criteria are met"];
      } else if (!w.added.length) {
        [code, message] = ["STATUS_UNCHANGED_NO_NEW_EVIDENCE", "reopening needs new evidence"];
      }
      if (code) {
        statusRejected = true;
        rejections.push({
          ref: { proposal: ref, case_id: id, part: "status" },
          code,
          detail: {
            message,
            ...(check ? { closing_check: check } : {}),
            ...(p.title === undefined ? {} : { proposed_title: p.title }),
            ...(p.summary === undefined ? {} : { proposed_summary: p.summary }),
          },
        });
      } else {
        c.status = p.status;
        c.episode = increment(c.episode, `state.cases.${id}.episode`);
        c.requested = [];
        w.statusChanged = true;
        if (check) w.closing_check = check;
      }
    }

    // 6. Title and summary
    if (!statusRejected) {
      if (p.title !== undefined && p.title !== c.title) c.title = w.text.title = p.title;
      if (p.summary !== undefined && p.summary !== c.summary) c.summary = w.text.summary = p.summary;
    }

    // 7. Actions, in canonical order
    const entries = p.actions ?? [];
    const times = new Map<string, number>();
    for (const a of entries) times.set(a.key, (times.get(a.key) ?? 0) + 1);
    for (const action of entries) {
      const params = offers.get(action.key);
      const code: RejectionCode | null =
        c.status !== "open" ? "ACTION_CASE_NOT_OPEN"
        : !params ? "ACTION_NOT_OFFERED"
        : !argumentsFit(action.arguments, params) ? "ACTION_ARGUMENTS"
        : !action.reason.trim() ? "ACTION_NO_REASON"
        : times.get(action.key)! > 1 || c.requested.some(([key, episode]) => key === action.key && episode === c.episode) ? "ACTION_REPEATED"
        : null;
      if (code) rejections.push({ ref: { proposal: ref, case_id: id, part: "action", key: action.key }, code, detail: { message: ACTION_MESSAGES[code]! } });
      else candidates.push({ w, action });
    }
  });

  // 7. The step's limit, by (case_id, key)
  candidates.sort((x, y) => compare(x.w.id, y.w.id) || compare(x.action.key, y.action.key));
  candidates.forEach(({ w, action }, i) => {
    if (i < max_requests) w.accepted.push(action);
    else rejections.push({ ref: { proposal: w.ref, case_id: w.id, part: "action", key: action.key }, code: "ACTION_OVER_LIMIT", detail: { message: ACTION_MESSAGES.ACTION_OVER_LIMIT! } });
  });

  // 8. One transition per proposal that changed something
  const transitions: Transition[] = [];
  const requests: ActionRequest[] = [];
  for (const w of work.sort((x, y) => compare(x.id, y.id))) {
    const { c } = w;
    if (!w.opened && !w.added.length && !w.statusChanged && !Object.keys(w.text).length && !w.accepted.length) continue;
    c.seq = increment(c.seq, `state.cases.${w.id}.seq`);
    c.version = d.version;
    const transition_id = H([w.id, c.seq]);
    transitions.push({
      id: transition_id,
      case_id: w.id,
      kind: w.opened ? "opened" : w.statusChanged ? "status_changed" : "updated",
      from: w.from,
      to: c.status,
      actor: `judge:${evaluator}`,
      added_evidence: w.added,
      ...w.text,
      ...(w.closing_check ? { closing_check: w.closing_check } : {}),
      version: d.version,
      at: now,
    });
    for (const action of w.accepted) {
      c.requested.push([action.key, c.episode]);
      requests.push({
        id: H([w.id, action.key, c.episode]), case_id: w.id, key: action.key, arguments: action.arguments,
        reason: action.reason, episode: c.episode, transition_id,
      });
    }
  }
  next.now = now;
  return result(next, transitions, rejections, requests);
}

/** A person's status change: trusted, so no judgment gates; the case must exist. */
export function command(definition: Definition, state: State | null, command: Command, now: Time): StepResult {
  const inputs = prepare(definition, state, now);
  conform(command, "command", "command");
  const { actor, case_id, status, reason } = clone(command);
  const next = inputs.state;
  if (!next || !hasOwn(next.cases, case_id)) throw new InputError(`command.case_id: there is no case ${case_id}`);
  const c = next.cases[case_id]!;
  if (c.status === status) throw new InputError(`command.status: the case is already ${status}`);
  const from = c.status;
  c.status = status;
  c.episode = increment(c.episode, `state.cases.${case_id}.episode`);
  c.requested = [];
  c.seq = increment(c.seq, `state.cases.${case_id}.seq`);
  c.version = inputs.definition.version;
  next.now = inputs.now;
  const transition: Transition = {
    id: H([case_id, c.seq]), case_id, kind: "status_changed", from, to: status, actor,
    ...(reason === undefined ? {} : { reason }), added_evidence: [], version: inputs.definition.version, at: inputs.now,
  };
  return result(next, [transition], [], []);
}

/** Whether a case's success criteria are met. Reads only; closing is not success. */
export function assess(definition: Definition, state: State | null, case_id: Hash, observations: Observation[], now: Time): Assessment {
  const inputs = prepare(definition, state, now);
  conform(case_id, "hash", "case_id");
  const all = observe(observations, inputs);
  const c = inputs.state && hasOwn(inputs.state.cases, case_id) ? inputs.state.cases[case_id] : undefined;
  if (!c) throw new InputError(`case_id: there is no case ${case_id}`);
  const { success } = inputs.definition;
  const check = evaluate(success, c.subject, all);
  return { spec: SPEC, case_id, result: success.length ? check.result : "unknown", criteria: check.criteria };
}

function result(state: State | null, transitions: Transition[], rejections: Rejection[], requests: ActionRequest[]): StepResult {
  requests.sort((x, y) => compare(x.case_id, y.case_id) || compare(x.key, y.key));
  return { spec: SPEC, state, transitions, rejections, action_requests: requests, state_digest: H(state) };
}
