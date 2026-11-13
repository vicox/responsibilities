import { digest as H } from "./canonical.ts";
import { evaluate, hasRules } from "./criteria.ts";
import type {
  Assessment, AttentionEvent, AttentionType, Case, Check, Command, Criterion, Definition, Delivery, Evaluation, Hash, Improvement,
  ImprovementEvent, Observation, Proposal, ProposedImprovement, Rejection, RejectionCode, State, Status, StepResult, Subject,
  Time, Transition, View,
} from "./types.ts";
import { conform, hasOwn, InputError } from "./validate.ts";

/** In every output and every state; fixtures are bound to it. */
export const SPEC = "responsibility-core/1";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** Sets a data key, even one named like an `Object.prototype` member. */
const put = <T>(record: Record<string, T>, key: string, value: T): void => {
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
};

/** One more; a state whose counter cannot grow is refused rather than overflowed. */
function increment(count: number, path: string): number {
  if (count >= Number.MAX_SAFE_INTEGER) throw new InputError(`${path} cannot count beyond 2^53−1`);
  return count + 1;
}

const identityDigest = (d: Definition): Hash =>
  H({ subject_type: d.identity.subject_type, subject_keys: [...d.identity.subject_keys].sort() });
const caseId = (d: Definition, subject: Subject): Hash =>
  H({ definition_id: d.id, subject_type: subject.type, keys: subject.keys });
const improvementId = (d: Definition, key: string): Hash => H({ definition_id: d.id, key });

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

  const criteria: [Criterion, string][] = [
    ...d.closing.map((c, i): [Criterion, string] => [c, `definition.closing[${i}]`]),
    ...d.success.map((c, i): [Criterion, string] => [c, `definition.success[${i}]`]),
    ...(d.attention_types ?? []).flatMap((t, i): [Criterion, string][] => (t.when ? [[{ description: t.description, rules: t.when }, `definition.attention_types[${i}].when`]] : [])),
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
  if (d.attention_types) {
    d.attention_types.sort((a, b) => compare(a.key, b.key));
    d.attention_types.forEach((t, i) => {
      if (i > 0 && d.attention_types![i - 1]!.key === t.key) throw new InputError(`definition.attention_types: ${t.key} occurs twice`);
    });
  }

  if (s) {
    if (s.definition_id !== d.id) throw new InputError(`state belongs to definition ${s.definition_id}, not ${d.id}`);
    if (s.identity_digest !== identityDigest(d)) throw new InputError("state was made for another subject_type or subject_keys");
    if ((now as Time) < s.now) throw new InputError(`now (${now}) is before state.now (${s.now})`);
    for (const [id, c] of Object.entries(s.cases)) {
      if (caseId(d, c.subject) !== id) throw new InputError(`state.cases.${id} is not the id of its subject`);
    }
    for (const [id, improvement] of Object.entries(s.improvements)) {
      if (improvementId(d, improvement.key) !== id) throw new InputError(`state.improvements.${id} is not the id of its key`);
    }
  }
  return { definition: d, state: s, now: now as Time };
}

/** Observations, validated and sorted by id. */
function observe(observations: unknown, { state, now }: Inputs): Observation[] {
  conform(observations, "observations", "observations");
  const list = clone(observations as Observation[]).sort((a, b) => compare(a.id, b.id));
  const linked: [string, Record<string, Hash>][] = [
    ...Object.entries(state?.cases ?? {}).map(([id, c]) => [`case ${id}`, c.evidence] as [string, Record<string, Hash>]),
    ...Object.entries(state?.improvements ?? {}).map(([id, i]) => [`improvement ${id}`, i.evidence] as [string, Record<string, Hash>]),
  ];
  list.forEach((o, i) => {
    if (i > 0 && list[i - 1]!.id === o.id) throw new InputError(`observations: ${o.id} occurs twice`);
    if (o.occurred_at > now) throw new InputError(`observation ${o.id} occurred after now`);
    const digest = H(o);
    for (const [owner, evidence] of linked) {
      if (hasOwn(evidence, o.id) && evidence[o.id] !== digest) {
        throw new InputError(`observation ${o.id} is not the one linked to ${owner}: observations are immutable`);
      }
    }
  });
  return list;
}

function basis(inputs: Inputs, observations: Observation[]): Hash {
  return H({
    spec: SPEC,
    state_digest: H(inputs.state),
    definition_digest: H(inputs.definition),
    observations_digest: H(observations),
    now: inputs.now,
  });
}

const openAttentions = (c: Case): string[] => Object.keys(c.attentions).filter((type) => c.attentions[type]!.status === "open").sort(compare);

/** What the external judge is given, and the `basis` its evaluation must carry. */
export function view(definition: Definition, state: State | null, observations: Observation[], now: Time): View {
  const inputs = prepare(definition, state, now);
  const all = observe(observations, inputs);
  const d = inputs.definition;
  const cases = inputs.state?.cases ?? {};
  const improvements = Object.values(inputs.state?.improvements ?? {}).sort((a, b) => compare(a.key, b.key));
  return {
    spec: SPEC,
    basis: basis(inputs, all),
    observations: all.filter((o) => d.include.includes(o.kind)),
    cases: Object.keys(cases).sort(compare).map((id) => {
      const c = cases[id]!;
      return {
        case_id: id, subject: c.subject, status: c.status, episode: c.episode, title: c.title, summary: c.summary,
        evidence: Object.keys(c.evidence).sort(compare), first_observed: c.first_observed, last_observed: c.last_observed,
        attentions: openAttentions(c),
      };
    }),
    attention_types: (d.attention_types ?? []).map((t) => ({ key: t.key, description: t.description, checked: t.when !== undefined, routed: t.delivery !== undefined })),
    improvements: improvements.map(({ key, title, change }) => ({ key, title, change })),
    closing: d.closing.map((c) => c.description),
    ...(d.expectations === undefined ? {} : { expectations: d.expectations }),
  };
}

const ATTENTION_MESSAGES: Partial<Record<RejectionCode, string>> = {
  ATTENTION_REPEATED: "the proposal names this attention type more than once",
  ATTENTION_NO_REASON: "the reason is blank",
  ATTENTION_NOT_DECLARED: "this attention type is not declared in this version of the Responsibility",
  ATTENTION_CASE_NOT_OPEN: "only an open case can open an attention; the case is not open after this step",
};

interface Work {
  id: Hash;
  c: Case;
  opened: boolean;
  from: Status | null;
  added: { obs_id: string; digest: Hash }[];
  statusChanged: boolean;
  text: { title?: string; summary?: string };
  closing_check?: Check;
}

/** One judgment applied: every proposal and Improvement is taken, in part, or rejected with a code. */
export function step(definition: Definition, state: State | null, observations: Observation[], evaluation: Evaluation, now: Time): StepResult {
  // 0. Inputs
  const inputs = prepare(definition, state, now);
  const all = observe(observations, inputs);
  conform(evaluation, "evaluation", "evaluation");
  const { basis: received, evaluator, proposals: raw, improvements: offeredImprovements = [] } = clone(evaluation);
  const d = inputs.definition;
  // 2. Canonical order (observations are sorted already). A proposal is hashed with its
  // cites by id and its Attention entries by (type, H(entry)); an Improvement with its
  // cites by id. No list order reaches a ref.
  const proposals = raw.map((p) => {
    const attentions = p.attentions?.map((a) => ({ a, h: H(a) }))
      .sort((x, y) => compare(x.a.type, y.a.type) || compare(x.h, y.h)).map(({ a }) => a);
    const canonical: Proposal = { ...p, cites: [...p.cites].sort(compare), ...(attentions ? { attentions } : {}) };
    return { p: canonical, ref: H(canonical) };
  }).sort((a, b) => compare(a.ref, b.ref));
  const improvements = offeredImprovements.map((i) => {
    const canonical: ProposedImprovement = { ...i, cites: [...i.cites].sort(compare) };
    return { i: canonical, ref: H(canonical) };
  }).sort((a, b) => compare(a.i.key, b.i.key) || compare(a.ref, b.ref));

  // 1. Basis
  const expected = basis(inputs, all);
  if (received !== expected) {
    const detail = { message: "the evaluation was made for other inputs than this step's", expected, received };
    const rejections: Rejection[] = [
      ...proposals.map(({ ref }): Rejection => ({ ref: { proposal: ref, part: "proposal" }, code: "BASIS_MISMATCH", detail })),
      ...improvements.map(({ i, ref }): Rejection => ({ ref: { improvement: ref, part: "improvement", key: i.key }, code: "BASIS_MISMATCH", detail })),
    ];
    return result(inputs.state, [], [], [], [], rejections);
  }

  const next: State = inputs.state ?? { spec: SPEC, definition_id: d.id, identity_digest: identityDigest(d), now, cases: {}, improvements: {} };
  const visible = new Map(all.filter((o) => d.include.includes(o.kind)).map((o) => [o.id, o]));
  const types = new Map<string, AttentionType>((d.attention_types ?? []).map((t) => [t.key, t]));
  const keys = [...d.identity.subject_keys].sort();
  const declared = (s: Subject) => {
    const named = Object.keys(s.keys).sort();
    return s.type === d.identity.subject_type && named.length === keys.length && named.every((k, i) => k === keys[i]);
  };
  const ids = proposals.map(({ p }) => (declared(p.subject) ? caseId(d, p.subject) : null));
  const named = new Map<Hash, number>();
  for (const id of ids) if (id) named.set(id, (named.get(id) ?? 0) + 1);
  const actor = `judge:${evaluator}`;

  const rejections: Rejection[] = [];
  const work: Work[] = [];
  const attentionEvents: AttentionEvent[] = [];
  const deliveries: Delivery[] = [];

  proposals.forEach(({ p, ref }, index) => {
    const id = ids[index]!;
    const whole = (code: RejectionCode, message: string, unknown?: string[]) => {
      rejections.push({ ref: { proposal: ref, ...(id ? { case_id: id } : {}), part: "proposal" }, code, detail: { message, ...(unknown ? { unknown } : {}) } });
    };
    // 3. Whole proposals; a rejected proposal carries its Attention entries with it
    if (!id) return whole("IDENTITY_MISMATCH", `the subject must be a ${d.identity.subject_type} with exactly the keys ${keys.join(", ")}`);
    if (named.get(id)! > 1) return whole("CONFLICTING_PROPOSALS", "more than one proposal names this subject");
    if (!p.cites.length) return whole("NO_EVIDENCE", "the proposal cites no observation");
    const unknown = p.cites.filter((obs) => !visible.has(obs)).sort(compare);
    if (unknown.length) return whole("UNKNOWN_EVIDENCE", "cited observations are not among this step's included observations", unknown);
    const existing = hasOwn(next.cases, id) ? next.cases[id]! : undefined;
    if (!existing && p.status !== "open") return whole("STATUS_NOT_ALLOWED", "a new case can only be proposed as open");

    // 4. Evidence
    const cited = p.cites.map((obs) => visible.get(obs)!);
    const first = cited[0]!.occurred_at;
    const c: Case = existing ?? {
      subject: p.subject, status: "open", episode: 1, seq: 0, version: d.version, title: null, summary: null,
      evidence: {}, first_observed: first, last_observed: first, attentions: {},
    };
    next.cases[id] = c;
    const w: Work = { id, c, opened: !existing, from: existing?.status ?? null, added: [], statusChanged: false, text: {} };
    work.push(w);
    for (const o of cited) {
      if (hasOwn(c.evidence, o.id)) continue;
      const digest = H(o);
      put(c.evidence, o.id, digest);
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
        w.statusChanged = true;
        if (check) w.closing_check = check;
      }
    }

    // 6. Title and summary
    if (!statusRejected) {
      if (p.title !== undefined && p.title !== c.title) c.title = w.text.title = p.title;
      if (p.summary !== undefined && p.summary !== c.summary) c.summary = w.text.summary = p.summary;
    }

    // 7. Attentions, in canonical order. Only an actual opening or reopening checks that the
    // case is open and then its type's `when` rules; keep and close never do.
    const entries = p.attentions ?? [];
    const times = new Map<string, number>();
    for (const a of entries) times.set(a.type, (times.get(a.type) ?? 0) + 1);
    for (const entry of entries) {
      const refuse = (code: RejectionCode, message = ATTENTION_MESSAGES[code]!, gate_check?: Check) => {
        rejections.push({ ref: { proposal: ref, case_id: id, part: "attention", key: entry.type }, code, detail: { message, ...(gate_check ? { gate_check } : {}) } });
      };
      const type = types.get(entry.type);
      const current = hasOwn(c.attentions, entry.type) ? c.attentions[entry.type]! : undefined;
      if (times.get(entry.type)! > 1) { refuse("ATTENTION_REPEATED"); continue; }
      if (!entry.reason.trim()) { refuse("ATTENTION_NO_REASON"); continue; }
      if (!type && !(entry.intent === "close" && current)) { refuse("ATTENTION_NOT_DECLARED"); continue; }
      if (entry.intent === "keep") continue;
      const record = (event: AttentionEvent["event"], activation: number, gate_check?: Check): AttentionEvent => {
        const e: AttentionEvent = {
          id: H([id, entry.type, activation, event]), case_id: id, type: entry.type, event, activation, actor,
          reason: entry.reason, proposal: ref, ...(gate_check ? { gate_check } : {}), version: d.version, at: now,
        };
        attentionEvents.push(e);
        return e;
      };
      if (entry.intent === "close") {
        if (current?.status === "open") {
          current.status = "closed";
          current.closed_at = now;
          record("closed", current.activation);
        }
        continue;
      }
      if (current?.status === "open") continue;
      if (c.status !== "open") { refuse("ATTENTION_CASE_NOT_OPEN"); continue; }
      let gate: Check | undefined;
      if (type!.when) {
        gate = evaluate([{ description: type!.description, rules: type!.when }], c.subject, all);
        if (gate.result !== "met") { refuse("ATTENTION_GATE_NOT_MET", `the when rules of ${entry.type} are ${gate.result}`, gate); continue; }
      }
      const activation = current ? increment(current.activation, `state.cases.${id}.attentions.${entry.type}.activation`) : 1;
      put(c.attentions, entry.type, { status: "open", activation, opened_at: now, closed_at: null });
      const event = record(current ? "reopened" : "opened", activation, gate);
      if (type!.delivery) {
        deliveries.push({
          id: H([id, entry.type, activation]), case_id: id, subject: clone(c.subject), type: entry.type, activation,
          route: type!.delivery.route, reason: entry.reason, event_id: event.id,
        });
      }
    }
  });

  // 8. One transition per proposal that changed the case's status, evidence or text
  const transitions: Transition[] = [];
  for (const w of work.sort((x, y) => compare(x.id, y.id))) {
    const { c } = w;
    if (!w.opened && !w.added.length && !w.statusChanged && !Object.keys(w.text).length) continue;
    c.seq = increment(c.seq, `state.cases.${w.id}.seq`);
    c.version = d.version;
    transitions.push({
      id: H([w.id, c.seq]),
      case_id: w.id,
      kind: w.opened ? "opened" : w.statusChanged ? "status_changed" : "updated",
      from: w.from,
      to: c.status,
      actor,
      added_evidence: w.added,
      ...w.text,
      ...(w.closing_check ? { closing_check: w.closing_check } : {}),
      version: d.version,
      at: now,
    });
  }

  // 9. Improvements, in canonical order: proposed, or updated with new evidence or text
  const improvementEvents: ImprovementEvent[] = [];
  const times = new Map<string, number>();
  for (const { i } of improvements) times.set(i.key, (times.get(i.key) ?? 0) + 1);
  for (const { i, ref } of improvements) {
    const refuse = (code: RejectionCode, message: string, unknown?: string[]) => {
      rejections.push({ ref: { improvement: ref, part: "improvement", key: i.key }, code, detail: { message, ...(unknown ? { unknown } : {}) } });
    };
    if (times.get(i.key)! > 1) { refuse("IMPROVEMENT_CONFLICT", "more than one improvement in this evaluation has this key"); continue; }
    if (![i.title, i.change, i.rationale].every((text) => text.trim())) { refuse("IMPROVEMENT_INCOMPLETE", "title, change and rationale must not be blank"); continue; }
    if (!i.cites.length) { refuse("NO_EVIDENCE", "the improvement cites no observation"); continue; }
    const unknown = i.cites.filter((obs) => !visible.has(obs)).sort(compare);
    if (unknown.length) { refuse("UNKNOWN_EVIDENCE", "cited observations are not among this step's included observations", unknown); continue; }

    const improvement_id = improvementId(d, i.key);
    const existing = hasOwn(next.improvements, improvement_id) ? next.improvements[improvement_id]! : undefined;
    const item: Improvement = existing ?? {
      key: i.key, title: i.title, change: i.change, rationale: i.rationale, evidence: {}, proposed_at: now, updated_at: now, seq: 0, version: d.version,
    };
    const added: { obs_id: string; digest: Hash }[] = [];
    for (const obs of i.cites) {
      if (hasOwn(item.evidence, obs)) continue;
      const digest = H(visible.get(obs)!);
      put(item.evidence, obs, digest);
      added.push({ obs_id: obs, digest });
    }
    const text: { title?: string; change?: string; rationale?: string } = {};
    for (const field of ["title", "change", "rationale"] as const) {
      if (!existing || i[field] !== existing[field]) item[field] = text[field] = i[field];
    }
    if (existing && !added.length && !Object.keys(text).length) continue;
    item.seq = increment(item.seq, `state.improvements.${improvement_id}.seq`);
    item.updated_at = now;
    item.version = d.version;
    next.improvements[improvement_id] = item;
    improvementEvents.push({
      id: H([improvement_id, item.seq]), improvement_id, key: i.key, kind: existing ? "updated" : "proposed", actor,
      added_evidence: added, ...text, version: d.version, at: now,
    });
  }

  next.now = now;
  return result(next, transitions, attentionEvents, deliveries, improvementEvents, rejections);
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
  c.seq = increment(c.seq, `state.cases.${case_id}.seq`);
  c.version = inputs.definition.version;
  next.now = inputs.now;
  const transition: Transition = {
    id: H([case_id, c.seq]), case_id, kind: "status_changed", from, to: status, actor,
    ...(reason === undefined ? {} : { reason }), added_evidence: [], version: inputs.definition.version, at: inputs.now,
  };
  return result(next, [transition], [], [], [], []);
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

function result(
  state: State | null, transitions: Transition[], attention_events: AttentionEvent[], deliveries: Delivery[],
  improvement_events: ImprovementEvent[], rejections: Rejection[],
): StepResult {
  attention_events.sort((x, y) => compare(x.case_id, y.case_id) || compare(x.type, y.type) || x.activation - y.activation || compare(x.event, y.event));
  deliveries.sort((x, y) => compare(x.case_id, y.case_id) || compare(x.type, y.type) || x.activation - y.activation);
  improvement_events.sort((x, y) => compare(x.improvement_id, y.improvement_id));
  return { spec: SPEC, state, transitions, attention_events, deliveries, improvement_events, rejections, state_digest: H(state) };
}
