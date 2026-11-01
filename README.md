# responsibilities-core

You write down a Responsibility, such as *every customer inquiry gets a first answer within 24 hours*. Facts arrive as observations, an LLM judges them, and this library decides what follows: which Cases are open, which evidence they rest on, and which actions to request. It is four pure functions over plain JSON. It loads, stores, schedules, calls models and executes nothing; the same inputs give byte-identical outputs.

## Who does what

- **Host** – your code. Loads observations, stores the state, calls the LLM, executes action requests, supplies `now`.
- **LLM** – the judge. Reads a `View` and proposes: open or resolve a case, cite evidence, request actions. It changes nothing itself and never dismisses.
- **Person** – decides explicitly with `command`, for example to dismiss a case. Trusted: no judgment gates.
- **Core** – this library. Checks every proposal against fixed rules, keeps cases and evidence, and returns what changed and which actions are requested. No I/O, no clock, no execution.

The words used below:

- **Definition** – the Responsibility: `identity` (subject type and key names), `accountable` (who answers for it), `expectations` (words for the LLM), `include` (observation kinds the LLM sees and may cite), `closing` (when a case is over), `success` (what a good outcome is).
- **Observation** – an immutable fact: `id`, `kind`, `occurred_at`, `rows`, and `complete` (the rows are everything the source had).
- **Case** – one subject under the Responsibility, here one inquiry: `open`, `resolved` or `dismissed`, with linked evidence and an `episode` that counts status changes.
- **Action request** – an action the host offered and the LLM asked for, checked by the core. The host executes it; its effect returns only as a new observation.

## The four functions

**`view(definition, state, observations, offered_actions, max_requests, now)` → `View`**
*What is going on?* Prepares the LLM's context: the included observations, the open cases, the closing descriptions, `expectations`, the offered actions, `max_requests`, and a `basis` that binds all of these inputs.

**`step(definition, state, observations, offered_actions, max_requests, evaluation, now)` → `{spec, state, transitions, rejections, action_requests, state_digest}`**
*Does the LLM's proposal hold?* `evaluation` is `{basis, evaluator, proposals}`, with `basis` copied from the view. Each proposal is taken, taken in part, or rejected with a code; from what is taken follow the new state and the action requests.

**`command(definition, state, {actor: "person:<id>", case_id, status, reason?}, now)` → same as `step`**
*A person decided.* Sets `open`, `resolved` or `dismissed` on an existing case without judgment gates; `reason` is required for `dismissed`.

**`assess(definition, state, case_id, observations, now)` → `{spec, case_id, result: "met" | "not_met" | "unknown", criteria}`**
*Was it a success?* Reads the success criteria, with a trace per rule; no success criteria is `unknown`. Writes nothing.

**Closed is not success.** `resolved` means the case is over. When the LLM proposes it, `step` accepts it only if the closing criteria with rules are met (without rules, it needs new evidence); a person's `command` sets it without that check. Whether the outcome was good is a separate question for `assess`: an inquiry answered after 25 hours is resolved and not a success.

All four are synchronous. `state` is `null` before the first step. A contract violation throws `InputError` and returns nothing; a refused proposal is data, a `rejection`. `src/schema.json` (exported as `schema` and as `responsibilities-core/schema.json`) defines every input and output. Also exported: `digest` (`H`), `canonical` (RFC 8785), `SPEC`, `InputError`, the types.

## Example: answer every customer inquiry within 24 hours

This block runs as a test, and `fixtures/example.json` is its recording.

```ts
import { assess, command, digest, step, view, type Definition, type OfferedAction } from "responsibilities-core";

const definition: Definition = {
  id: "inquiries-answered",
  version: 1,
  identity: { subject_type: "inquiry", subject_keys: ["inquiry"] },
  accountable: "team:support",
  expectations: "Every customer inquiry gets a first answer within 24 hours.",
  include: ["waiting_for_us", "answered"],
  closing: [{
    description: "The inquiry no longer waits for us.",
    rules: [{ kind: "waiting_for_us", match: { inquiry: "inquiry" }, condition: "absent", scope: "all" }],
  }],
  success: [{
    description: "The first answer came within 24 hours.",
    rules: [{ kind: "answered", match: { inquiry: "inquiry" }, where: { within_24h: true } }],
  }],
};
const offered: OfferedAction[] = [{ key: "remind", params: { channel: "string", text: "string" } }];  // the host's choice
const inquiry = (id: string) => ({ type: "inquiry", keys: { inquiry: id } });
const caseId = (id: string) => digest({ definition_id: definition.id, subject_type: "inquiry", keys: { inquiry: id } });

// Day 1. The host loads the helpdesk's complete list of inquiries waiting for us.
const waiting1 = { id: "waiting-1", kind: "waiting_for_us", occurred_at: "2026-11-02T09:00:00.000Z",
                   subjects: [inquiry("T-1042"), inquiry("T-1043")], complete: true,
                   rows: [{ inquiry: "T-1042", customer: "ACME" }, { inquiry: "T-1043", customer: "unknown" }] };
let now = "2026-11-02T09:01:00.000Z";

// view: what is going on? The host gives v1 to its LLM.
const v1 = view(definition, null, [waiting1], offered, 1, now);

// step: the LLM proposes two cases and a reminder; the core checks and applies them.
const r1 = step(definition, null, [waiting1], offered, 1, {
  basis: v1.basis,
  evaluator: "llm",
  proposals: [
    { subject: inquiry("T-1042"), status: "open", cites: ["waiting-1"], title: "ACME waits for an answer",
      actions: [{ key: "remind", arguments: { channel: "#support", text: "T-1042 from ACME waits for an answer." },
                  reason: "Nobody has answered yet." }] },
    { subject: inquiry("T-1043"), status: "open", cites: ["waiting-1"] },
  ],
}, now);
// r1.transitions:     two cases "opened" by "judge:llm"
// r1.action_requests: [{ key: "remind", episode: 1, id: digest([caseId("T-1042"), "remind", 1]), … }]
// The host stores r1, then posts the reminder itself. The core never learns that it did.

// command: a person decides that T-1043 is spam.
const c1 = command(definition, r1.state, { actor: "person:mia", case_id: caseId("T-1043"),
                                           status: "dismissed", reason: "Spam." }, "2026-11-02T09:30:00.000Z");

// Day 2. T-1042 got its first answer after 25 hours; the helpdesk says so.
const waiting2 = { id: "waiting-2", kind: "waiting_for_us", occurred_at: "2026-11-03T10:00:00.000Z",
                   subjects: [], rows: [], complete: true };
const answered1 = { id: "answered-1", kind: "answered", occurred_at: "2026-11-03T10:00:00.000Z",
                    subjects: [inquiry("T-1042")], rows: [{ inquiry: "T-1042", within_24h: false }], complete: true };
now = "2026-11-03T10:01:00.000Z";
const v2 = view(definition, c1.state, [waiting2, answered1], offered, 1, now);  // v2.open_cases: T-1042 only

// step: the LLM proposes to resolve. The closing rule checks it against waiting-2: met.
const r2 = step(definition, c1.state, [waiting2, answered1], offered, 1, {
  basis: v2.basis,
  evaluator: "llm",
  proposals: [{ subject: inquiry("T-1042"), status: "resolved", cites: ["waiting-2", "answered-1"] }],
}, now);
// r2.transitions: [{ kind: "status_changed", from: "open", to: "resolved", closing_check: { result: "met" }, … }]

// assess: resolved, but was it a success?
const a = assess(definition, r2.state, caseId("T-1042"), [answered1], now);
// a.result: "not_met" (answered, but not within 24 hours)
```

Had the LLM proposed `resolved` while T-1042 was still waiting, `step` would have returned `CLOSING_NOT_MET` and kept the case open. `caseId` works because ids are derived (see [Determinism and replay](#determinism-and-replay)).

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

## What `step` checks

1. Every input, or it throws: schema, NFC, times (`now` ≥ `state.now`, nothing occurs after `now`), identity binding, observation conflicts.
2. `basis`. If `evaluation.basis` differs from the recomputed one, every proposal gets `BASIS_MISMATCH` and the state is returned unchanged, `now` included.
3. Order. Observations, proposals and action entries are ordered canonically; list order never matters.
4. Per proposal: whole-proposal gates; cited observations are linked as evidence (a new case is created `open`); the status gate; title and summary; action gates.
5. The limit. At most `max_requests` requests are accepted, the first by `(case_id, key)`.
6. One transition per proposal that changed something; then `state.now = now`.

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

## Criteria

```js
{ description: "…", rules: [rule, …] }               // all rules must hold
{ description: "…", any_of: [{ rules: […] }, …] }    // one route must hold
{ description: "…" }                                 // closing only: words for the LLM, gates nothing
// rule:
{ kind, match: { column: subject_key }, where: { column: value } }   // where is optional
{ kind, match: { column: subject_key }, condition: "absent", scope: "all" }
```

A rule reads the latest observation of its `kind` (by `occurred_at`, then `id`) among the observations passed to this call, included or not. `match` joins 1–3 row columns to subject keys, exactly. A presence rule is `met` when a joined row has every `where` value, `not_met` only when the observation is complete and every joined row has another non-null value, otherwise `unknown`: a missing row is never an answer. An `absent` rule (`scope: all`: the observation lists every subject) is `not_met` when a row joins, `met` when the observation is complete and no row could be the subject, otherwise `unknown`. Rules combine as a three-valued AND, routes as OR, criteria as AND. Only one route of an `any_of` may use `absent`. Rules compare values and never compute: a deadline such as 24 hours arrives already decided, as in `within_24h`.

## Host obligations

1. **Pass `step` exactly the inputs of its `view`**, `now` included. Another `now`, or a state saved in between, gives `BASIS_MISMATCH`. Pass the observations the closing rules read: the core has no lookback.
2. **Compare and set.** Store the new state only if the stored `state_digest` is still the one read; store it with its transitions and requests in one transaction (outbox). Transitions are the history; the state keeps none.
3. **Execute only stored requests** – never from a failed save, never from a replay. The core guarantees at most one accepted request per `(case_id, key, episode)` along one state line, and a stable `request_id`; nobody guarantees exactly-once effects. Choose per action:
   - *at most once*: durably mark `request_id` as started before executing; never execute a started id again.
   - *at least once*: retry until confirmed; only where the target takes `request_id` as an idempotency key, or a duplicate is acceptable.
4. **Feed effects back as observations.** The core never learns sent, failed or skipped.
5. **Validate the LLM's raw output against the schema** first; a non-conforming proposal makes `step` throw.
6. **Give canonical input.** Strings in NFC; times exactly `YYYY-MM-DDTHH:MM:SS.sssZ`; integers within ±(2^53−1); fractions only in observation rows. The core refuses, it does not normalize. Subject keys compare exactly: `173` ≠ `"173"`, `"Web"` ≠ `"web"`.
7. **Never change an observation.** The core detects a changed observation only once it is linked as evidence.
8. **Keep one state per Responsibility.** `now` never goes back.

## Determinism and replay

`H(x)` is the SHA-256 hex of the RFC 8785 bytes of `x`, exported as `digest`. All ids are derived:

```
case_id       = H({definition_id, subject_type, keys})
transition id = H([case_id, seq])
request id    = H([case_id, key, episode])
basis         = H({spec, state_digest, definition_digest, observations_digest, offered_actions_digest, max_requests, now})
proposal ref  = H(proposal, with cites sorted and actions ordered by (key, H(arguments), H(action)))
```

The evaluation records the LLM's proposals, so applying the recorded inputs of each `step` and `command` in order reproduces every output byte for byte; each `state_digest` is checked. `test/replay.test.ts` replays the recordings in `fixtures/`: `example.json` is the example above; `actions.json` shows a request, the same key refused as `ACTION_REPEATED` in that episode, the request allowed again after a reopen, and a person's dismissal. Fixtures are bound to `SPEC` (`responsibility-core/0`); `npm run fixtures` re-records them.

## Not in v0

Loading observations, lookback windows, persistence, scheduling, model clients, executing actions, requests by persons, dismissal by the LLM, action conditions and parameter binding, globs and value lists in rules.

## License

MIT, see [LICENSE](LICENSE).
