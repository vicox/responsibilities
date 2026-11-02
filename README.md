# Responsibilities

### The responsibility layer.

*For human, agent, and automated work.*

Customers need answers. Bookings need payment. Important changes need follow-through. Responsibilities helps define what should happen, recognise when action is needed, and follow each case through to its outcome.

## Why Responsibilities?

Noticing a problem is one thing. Making sure something happens about it — and knowing how it turned out — is another.

An alert is forgotten. A ticket is closed while the customer is still waiting. An agent stops working without anyone noticing. Responsibilities connects what should happen with what actually happens. It keeps each case in view, from the first sign that action is needed to its eventual outcome, whether the work is done by a person, an agent, or an automation.

## What Responsibilities Core does

The loop is **Observe → Judge → Decide → Act**. The host, which is your code, observes, acts and persists; an LLM judges; the deterministic core validates every proposal and decides what follows. This library, `responsibilities-core`, is that decision step, as four pure functions over plain JSON:

1. **Observe** (host). The host loads observations (facts from its systems) and calls `view` to prepare the LLM's context: the included observations, the open cases, the expectations and the offered actions.
2. **Judge** (LLM). The LLM reads the view and proposes: open or resolve a case, cite evidence, request actions. It changes nothing itself and never dismisses.
3. **Decide** (core). `step` checks every proposal against fixed rules and returns the new state (the cases and their evidence), the transitions and the action requests. It executes nothing.
4. **Act** (host). The host stores the result, then executes the stored requests. Their effects return only as new observations, and the loop starts again from the stored state.

A person can step in at any point with `command`, and `assess` reports whether a case met its success criteria. The core loads, stores, schedules, calls models and executes nothing, and has no clock: the host supplies `now`. The same inputs give byte-identical outputs.

The words used below:

- **Definition** – the Responsibility: `identity` (subject type and key names), `accountable` (who answers for it), `expectations` (words for the LLM), `include` (observation kinds the LLM sees and may cite), `closing` (when a case is over), `success` (what a good outcome is).
- **Observation** – an immutable fact: `id`, `kind`, `occurred_at`, `rows`, and `complete` (the rows are everything the source had).
- **Case** – one subject under the Responsibility, here one inquiry: `open`, `resolved` or `dismissed`, with linked evidence and an `episode` that counts status changes.
- **Action request** – an action the host offered and the LLM asked for, checked by the core. The host executes it; its effect returns only as a new observation.

## See it in action

The Responsibility: every customer inquiry gets a first answer within 24 hours. Both blocks run as one test, and `fixtures/example.json` is their recording.

### 1. An inquiry waits: `view` and `step`

One inquiry, one case, one proposal from the LLM, one action request.

```ts
import { step, view, type Definition, type OfferedAction } from "responsibilities-core";

const definition: Definition = {
  id: "inquiries-answered",
  version: 1,
  identity: { subject_type: "inquiry", subject_keys: ["inquiry"] },  // one case per inquiry
  accountable: "team:support",
  expectations: "Every customer inquiry gets a first answer within 24 hours.",
  include: ["waiting_for_us"],                                       // what the LLM sees
  closing: [],
  success: [],                                                       // part 2 adds one
};

// The host loaded this from its helpdesk: the complete list of inquiries waiting for us.
const waiting = {
  id: "waiting-1", kind: "waiting_for_us", occurred_at: "2026-11-02T09:00:00.000Z",
  subjects: [{ type: "inquiry", keys: { inquiry: "T-1042" } }],
  rows: [{ inquiry: "T-1042", customer: "ACME" }], complete: true,
};
// What the host lets the LLM ask for in this step.
const offered: OfferedAction[] = [{ key: "remind", params: { channel: "string", text: "string" } }];
const now = "2026-11-02T09:01:00.000Z";

// view: what is going on? The host sends v to its LLM. (1 = at most one request per step)
const v = view(definition, null, [waiting], offered, 1, now);

// The LLM answers with a proposal; step checks it and derives what follows.
const r = step(definition, null, [waiting], offered, 1, {
  basis: v.basis,                     // the answer is bound to exactly what the LLM saw
  evaluator: "llm",
  proposals: [{
    subject: { type: "inquiry", keys: { inquiry: "T-1042" } },
    status: "open",
    cites: ["waiting-1"],             // evidence must come from v
    actions: [{ key: "remind", arguments: { channel: "#support", text: "ACME waits for an answer to T-1042." },
                reason: "Nobody has answered yet." }],
  }],
}, now);

// r.transitions:     [{ kind: "opened", to: "open", actor: "judge:llm", … }]  a case for T-1042
// r.action_requests: [{ key: "remind", arguments: { … }, episode: 1, … }]   the host posts it, not the core
// r.state:           the host stores it; the next call starts from it
```

### 2. A person closes it, and success is assessed: `command` and `assess`

The next day, Mia from support closes the case. The helpdesk reports that the first answer came after 25 hours. The core computes no business metrics: the host's helpdesk export decides `within_24h`, and the success rule only compares it.

```ts
import { assess, command } from "responsibilities-core";

// Version 2 of the Responsibility says what a good outcome is.
const definition2: Definition = { ...definition, version: 2, success: [{
  description: "The first answer came within 24 hours.",
  rules: [{ kind: "answered", match: { inquiry: "inquiry" }, where: { within_24h: true } }],
}] };
const caseId = r.transitions[0]!.case_id;
const later = "2026-11-03T10:00:00.000Z";

// command: an explicit human decision, without judgment gates.
const c = command(definition2, r.state, { actor: "person:mia", case_id: caseId, status: "resolved",
                                          reason: "Answered by email." }, later);

// assess: the case is closed, but was it a success?
const answered = {
  id: "answered-1", kind: "answered", occurred_at: later,
  subjects: [{ type: "inquiry", keys: { inquiry: "T-1042" } }],
  rows: [{ inquiry: "T-1042", within_24h: false }], complete: true,
};
const a = assess(definition2, c.state, caseId, [answered], later);

// c.transitions: [{ kind: "status_changed", from: "open", to: "resolved", actor: "person:mia", … }]
// a.result:      "not_met"   closed is not success
```

The case is over, and its success criterion was not met. The core keeps both facts apart.

## The four functions

**`view(definition, state, observations, offered_actions, max_requests, now)` → `View`**
*What is going on?* Prepares the LLM's context: the included observations, the open cases, the closing descriptions, `expectations`, the offered actions, `max_requests`, and a `basis` that binds all of these inputs.

**`step(definition, state, observations, offered_actions, max_requests, evaluation, now)` → `{spec, state, transitions, rejections, action_requests, state_digest}`**
*Does the LLM's proposal hold?* `evaluation` is `{basis, evaluator, proposals}`, with `basis` copied from the view. Each proposal is taken, taken in part, or rejected with a code; from what is taken follow the new state and the action requests.

**`command(definition, state, {actor: "person:<id>", case_id, status, reason?}, now)` → same as `step`**
*Optional: a person decides.* Sets `open`, `resolved` or `dismissed` on an existing case without judgment gates; `reason` is required for `dismissed`. The loop does not need it; it is how a person steps in.

**`assess(definition, state, case_id, observations, now)` → `{spec, case_id, result: "met" | "not_met" | "unknown", criteria}`**
*Was it a success?* Reads the success criteria, with a trace per rule; no success criteria is `unknown`. Writes nothing.

**Closed is not success.** `resolved` means the case is over. When the LLM proposes it, `step` accepts it only if the closing criteria with rules are met (without rules, it needs new evidence); a person's `command` sets it without that check. Whether the outcome was good is the separate question `assess` answers.

All four are synchronous. `state` is `null` before the first step. A contract violation throws `InputError` and returns nothing; a refused proposal is data, a `rejection`. `src/schema.json` (exported as `schema` and as `responsibilities-core/schema.json`) defines every input and output. Also exported: `digest` (`H`), `canonical` (RFC 8785), `SPEC`, `InputError`, the types.

## Integration and reference

### Quickstart

Run the tests, including both blocks above, and build the library:

```sh
npm install
npm test        # type check, tests, README example, fixture replay (Node ≥ 22.18)
npm run build   # dist/: ES module and .d.ts, no runtime dependencies
```

### Integration pattern

One host step. `askYourLLM` and `yourStore` stand for your own code; the library provides neither.

```ts
const v = view(definition, state, observations, offered, maxRequests, now);
const proposals = await askYourLLM(v);           // validate against schema.json#/$defs/proposal
const r = step(definition, state, observations, offered, maxRequests,
               { basis: v.basis, evaluator: "my-llm", proposals }, now);
// One transaction, and only if the stored state_digest is still `readDigest`:
await yourStore.commitIf(readDigest, { state: r.state, state_digest: r.state_digest,
                                       transitions: r.transitions, outbox: r.action_requests });
// Then execute from the outbox (see Host obligations).
```

### Host obligations

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

### Criteria

```js
{ description: "…", rules: [rule, …] }               // all rules must hold
{ description: "…", any_of: [{ rules: […] }, …] }    // one route must hold
{ description: "…" }                                 // closing only: words for the LLM, gates nothing
// rule:
{ kind, match: { column: subject_key }, where: { column: value } }   // where is optional
{ kind, match: { column: subject_key }, condition: "absent", scope: "all" }
```

A rule reads the latest observation of its `kind` (by `occurred_at`, then `id`) among the observations passed to this call, included or not. `match` joins 1–3 row columns to subject keys, exactly. A presence rule is `met` when a joined row has every `where` value, `not_met` only when the observation is complete and every joined row has another non-null value, otherwise `unknown`: a missing row is never an answer. An `absent` rule (`scope: all`: the observation lists every subject) is `not_met` when a row joins, `met` when the observation is complete and no row could be the subject, otherwise `unknown`. Rules combine as a three-valued AND, routes as OR, criteria as AND. Only one route of an `any_of` may use `absent`. Rules compare values and never compute; a derived fact such as `within_24h` arrives in the observation.

### What `step` checks

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

### Determinism and replay

`H(x)` is the SHA-256 hex of the RFC 8785 bytes of `x`, exported as `digest`. All ids are derived:

```
case_id       = H({definition_id, subject_type, keys})
transition id = H([case_id, seq])
request id    = H([case_id, key, episode])
basis         = H({spec, state_digest, definition_digest, observations_digest, offered_actions_digest, max_requests, now})
proposal ref  = H(proposal, with cites sorted and actions ordered by (key, H(arguments), H(action)))
```

The evaluation records the LLM's proposals, so applying the recorded inputs of each `step` and `command` in order reproduces every output byte for byte; each `state_digest` is checked. `test/replay.test.ts` replays the recordings in `fixtures/`: `example.json` is the example above; `actions.json` shows a request, the same key refused as `ACTION_REPEATED` in that episode, the request allowed again after a reopen, and a person's dismissal. Fixtures are bound to `SPEC` (`responsibility-core/0`); `npm run fixtures` re-records them.

### Scope

**Outside the core, by design:** loading observations and choosing their time window, storage, scheduling, model calls, executing actions, the clock. These belong to the host. Dismissal belongs to a person, never to the LLM.

**Not in v0:** action requests by persons, conditions and parameter binding for actions, globs and value lists in rules.

## License

MIT, see [LICENSE](LICENSE).
