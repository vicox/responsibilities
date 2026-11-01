# responsibilities-core

A Responsibility core as four pure functions. A Responsibility is a desired state somebody is accountable for. The core keeps one state per Responsibility and decides, from observations and an external judgment, which Cases exist, which evidence they rest on, which status they have, and which actions are requested:

```
definition + state + observations + offered actions + evaluation + now
  → state + transitions + rejections + action requests + state_digest
```

It loads, stores, schedules, calls models and executes nothing. The same inputs give byte-identical outputs.

## Concepts

- **Definition** – the Responsibility: `identity` (subject type and key names), `accountable` (who answers for it), `expectations` (words for the judge), `include` (observation kinds the judge sees and may cite), `closing` (when a Case is over), `success` (what a good outcome is).
- **Observation** – an immutable fact: `id`, `kind`, `occurred_at`, `rows`, and `complete` (the rows are everything the source had).
- **Case** – one Subject under the Responsibility: `open`, `resolved` or `dismissed`; evidence (observation id → digest); title, summary; an `episode` that counts status changes.
- **Judge** – external, typically an LLM. It gets a `View` and returns proposals. The core checks every proposal against fixed gates and takes it, takes part of it, or rejects it with a code. The judge opens and resolves; it never dismisses.
- **Person** – trusted. A `command` sets any status, names its actor and passes no gates.
- **Action request** – the judge may ask for an action the host offers in this step. The core checks and records the request; the host executes it, and its effect comes back only as a new observation.
- **Closing is not success.** `closing` gates `resolved`; `assess` reports separately whether `success` is met.

## Quickstart

```sh
npm install
npm test        # type check, tests, README example, fixture replay (Node ≥ 22.18)
npm run build   # dist/: ES module and .d.ts, no runtime dependencies
```

A host step:

```ts
const v = view(definition, state, observations, offered, maxRequests, now);
const proposals = await myJudge(v);                // validate against schema.json#/$defs/proposal
const r = step(definition, state, observations, offered, maxRequests,
               { basis: v.basis, evaluator: "my-judge", proposals }, now);
// One transaction, and only if the stored state_digest is still `readDigest`:
await store.commitIf(readDigest, { state: r.state, state_digest: r.state_digest,
                                   transitions: r.transitions, outbox: r.action_requests });
// Then execute from the outbox (see Host obligations).
```

## Example

Observation → LLM proposal → Case → action request → new observation → resolved. This block runs as a test, and `fixtures/example.json` is its recording.

```ts
import { assess, step, view, type Definition, type OfferedAction } from "responsibilities-core";

const definition: Definition = {
  id: "security-reports",
  version: 1,
  identity: { subject_type: "report", subject_keys: ["report"] },
  accountable: "team:security",
  expectations: "Every report gets an owner within one working day.",
  include: ["open_reports", "closed_reports"],
  closing: [{
    description: "The report is no longer open.",
    rules: [{ kind: "open_reports", match: { report: "report" }, condition: "absent", scope: "all" }],
  }],
  success: [{
    description: "The report was fixed.",
    rules: [{ kind: "closed_reports", match: { report: "report" }, where: { resolution: "fixed" } }],
  }],
};
const offered: OfferedAction[] = [{ key: "notify", params: { channel: "string", text: "string" } }];
const report = { type: "report", keys: { report: 173 } };

// 1. An observation: the complete list of open reports contains 173.
const open1 = { id: "open-1", kind: "open_reports", occurred_at: "2026-11-02T09:00:00.000Z",
                subjects: [report], rows: [{ report: 173, state: "new" }], complete: true };
let now = "2026-11-02T09:01:00.000Z";
const v1 = view(definition, null, [open1], offered, 1, now);

// 2. The LLM, given v1, proposes a case and a notification. The core opens the case.
const r1 = step(definition, null, [open1], offered, 1, {
  basis: v1.basis,
  evaluator: "llm-triage",
  proposals: [{
    subject: report, status: "open", cites: ["open-1"], title: "Report 173 has no owner",
    actions: [{ key: "notify", arguments: { channel: "#security", text: "Report 173 needs an owner." },
                reason: "New report, nobody assigned." }],
  }],
}, now);
// r1.transitions:     [{ kind: "opened", actor: "judge:llm-triage", added_evidence: [open-1], … }]
// r1.action_requests: [{ key: "notify", episode: 1, id: digest([case_id, "notify", 1]), … }]
// The host commits r1, then sends the notification. Nobody tells the core it was sent.

// 3. A day later: 173 is no longer open, and the closed list says why.
const open2 = { id: "open-2", kind: "open_reports", occurred_at: "2026-11-03T09:00:00.000Z",
                subjects: [], rows: [], complete: true };
const closed1 = { id: "closed-1", kind: "closed_reports", occurred_at: "2026-11-03T09:00:00.000Z",
                  subjects: [report], rows: [{ report: 173, resolution: "fixed" }], complete: true };
now = "2026-11-03T09:01:00.000Z";
const v2 = view(definition, r1.state, [open2, closed1], offered, 1, now);   // v2.open_cases: report 173

// 4. The LLM proposes to resolve. The closing rule checks it against open-2: met.
const r2 = step(definition, r1.state, [open2, closed1], offered, 1, {
  basis: v2.basis,
  evaluator: "llm-triage",
  proposals: [{ subject: report, status: "resolved", cites: ["open-2", "closed-1"], summary: "Fixed in 4.2.1." }],
}, now);
// r2.transitions: [{ kind: "status_changed", from: "open", to: "resolved", closing_check: { result: "met" }, … }]

// 5. Resolved is not yet success; assess reads the success criteria.
const a = assess(definition, r2.state, r2.transitions[0]!.case_id, [closed1], now);
// a.result: "met"
```

Had the LLM proposed `resolved` while 173 was still listed, `step` would have returned `CLOSING_NOT_MET` and linked the cited observations without changing the status.

## API

All four are pure and synchronous over plain JSON. `src/schema.json` (exported as `schema` and as `responsibilities-core/schema.json`) defines every input and output; the library checks inputs against it. A contract violation throws `InputError` and returns nothing. A refused proposal is data: a `rejection`.

| Function | Returns |
|---|---|
| `view(definition, state, observations, offered_actions, max_requests, now)` | `View`: the included observations, open cases, closing descriptions, `expectations`, offered actions, `max_requests`, `basis` |
| `step(definition, state, observations, offered_actions, max_requests, evaluation, now)` | `{spec, state, transitions, rejections, action_requests, state_digest}` |
| `command(definition, state, {actor: "person:<id>", case_id, status, reason?}, now)` | the same; `reason` is required for `dismissed` |
| `assess(definition, state, case_id, observations, now)` | `{spec, case_id, result: "met" \| "not_met" \| "unknown", criteria}`; no success criteria is `unknown` |

`state` is `null` before the first step. Also exported: `digest` (`H`), `canonical` (RFC 8785), `SPEC`, `InputError`, the types.

### `step`

1. Check every input, or throw: schema, NFC, times (`now` ≥ `state.now`, nothing occurs after `now`), identity binding, observation conflicts.
2. Recompute `basis`. If `evaluation.basis` differs, every proposal gets `BASIS_MISMATCH` and the state is returned unchanged, `now` included.
3. Order observations, proposals and action entries canonically; list order never matters.
4. Per proposal: whole-proposal gates; link cited observations as evidence (a new case is created `open`); the status gate; title and summary; action gates.
5. Accept at most `max_requests` requests, the first by `(case_id, key)`.
6. Emit one transition per proposal that changed something; set `state.now = now`.

A transition is `opened`, `status_changed` or `updated`. It names its actor (`judge:<evaluator>` or `person:<id>`), the evidence it linked, `title` and `summary` only if they changed, the `closing_check` that allowed a status change, the definition `version`, and `at`. Each request names the transition that produced it.

| Code | Part | When |
|---|---|---|
| `BASIS_MISMATCH` | proposal | the evaluation was made for other inputs |
| `IDENTITY_MISMATCH` | proposal | subject type or key names are not the declared ones |
| `CONFLICTING_PROPOSALS` | proposal | more than one proposal names the subject; all are rejected |
| `NO_EVIDENCE` | proposal | `cites` is empty |
| `UNKNOWN_EVIDENCE` | proposal | a cited id is not among this step's included observations |
| `STATUS_NOT_ALLOWED` | proposal | a new case proposed as anything but `open` |
| `CLOSING_NOT_MET` | status | `resolved` while closing criteria with rules are not all `met` |
| `REOPEN_WHILE_CLOSING_MET` | status | `open` while they are all `met` |
| `STATUS_UNCHANGED_NO_NEW_EVIDENCE` | status | `open` again, or `resolved` without closing rules, and nothing new is cited |
| `ACTION_CASE_NOT_OPEN` | action | the case is not open after the step |
| `ACTION_NOT_OFFERED` | action | the key is not offered in this step |
| `ACTION_ARGUMENTS` | action | the arguments are not exactly the offered params (`string`, `int`, `bool`) |
| `ACTION_NO_REASON` | action | `reason` is blank |
| `ACTION_REPEATED` | action | the key was requested in this episode already, or appears twice in the proposal |
| `ACTION_OVER_LIMIT` | action | beyond `max_requests` |

Part `proposal`: nothing of it was taken. Part `status`: status, title and summary were not taken (they are in `detail.proposed_title` and `proposed_summary`); new evidence stays linked. Part `action`: only that entry was not taken. An accepted status change increments the episode; a new episode allows each action key once more.

### Criteria

```js
{ description: "…", rules: [rule, …] }               // all rules must hold
{ description: "…", any_of: [{ rules: […] }, …] }    // one route must hold
{ description: "…" }                                 // closing only: words for the judge, gates nothing
// rule:
{ kind, match: { column: subject_key }, where: { column: value } }   // where is optional
{ kind, match: { column: subject_key }, condition: "absent", scope: "all" }
```

A rule reads the latest observation of its `kind` (by `occurred_at`, then `id`) among the observations passed to this call, included or not. `match` joins 1–3 row columns to subject keys, exactly. A presence rule is `met` when a joined row has every `where` value, `not_met` only when the observation is complete and every joined row has another non-null value, otherwise `unknown`: a missing row is never an answer. An `absent` rule (`scope: all`: the observation lists every subject) is `not_met` when a row joins, `met` when the observation is complete and no row could be the subject, otherwise `unknown`. Rules combine as a three-valued AND, routes as OR, criteria as AND. Only one route of an `any_of` may use `absent`.

## Host obligations

1. **Pass `step` exactly the inputs of its `view`**, `now` included. Another `now`, or a state saved in between, gives `BASIS_MISMATCH`. Pass the observations the closing rules read: the core has no lookback.
2. **Compare and set.** Store the new state only if the stored `state_digest` is still the one read; store it with its transitions and requests in one transaction (outbox). Transitions are the history; the state keeps none.
3. **Execute only stored requests** – never from a failed save, never from a replay. The core guarantees at most one accepted request per `(case_id, key, episode)` along one state line, and a stable `request_id`; nobody guarantees exactly-once effects. Choose per action:
   - *at most once*: durably mark `request_id` as started before executing; never execute a started id again.
   - *at least once*: retry until confirmed; only where the target takes `request_id` as an idempotency key, or a duplicate is acceptable.
4. **Feed effects back as observations.** The core never learns sent, failed or skipped.
5. **Validate the judge's raw output against the schema** first; a non-conforming proposal makes `step` throw.
6. **Give canonical input.** Strings in NFC; times exactly `YYYY-MM-DDTHH:MM:SS.sssZ`; integers within ±(2^53−1); fractions only in observation rows. The core refuses, it does not normalize. Subject keys compare exactly: `173` ≠ `"173"`, `"Web"` ≠ `"web"`.
7. **Never change an observation.** The core detects a changed observation only once it is linked as evidence.
8. **Keep one state per Responsibility.** `now` never goes back.

## Determinism and replay

`H(x)` is the SHA-256 hex of the RFC 8785 bytes of `x`. All ids are derived:

```
case_id       = H({definition_id, subject_type, keys})
transition id = H([case_id, seq])
request id    = H([case_id, key, episode])
basis         = H({spec, state_digest, definition_digest, observations_digest, offered_actions_digest, max_requests, now})
proposal ref  = H(proposal, with cites sorted and actions ordered by (key, H(arguments), H(action)))
```

The evaluation records the judge's proposals, so applying the recorded inputs of each `step` and `command` in order reproduces every output byte for byte; each `state_digest` is checked. `test/replay.test.ts` replays the recordings in `fixtures/`: `example.json` is the example above; `actions.json` shows a request, the same key refused as `ACTION_REPEATED` in that episode, the request allowed again after a reopen, and a person's dismissal. Fixtures are bound to `SPEC` (`responsibility-core/0`); `npm run fixtures` re-records them.

## Not in v0

Loading observations, lookback windows, persistence, scheduling, model clients, executing actions, requests by persons, dismissal by the judge, action conditions and parameter binding, globs and value lists in rules.

## License

MIT, see [LICENSE](LICENSE).
