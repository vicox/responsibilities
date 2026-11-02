# Responsibilities

### The responsibility layer.

*For human, agent, and automated work.*

Customers need answers. Bookings need payment. Important changes need follow-through. Responsibilities helps define what should happen, recognise when action is needed, and follow each case through to its outcome.

## Why Responsibilities?

Noticing a problem is one thing. Making sure something happens about it — and knowing how it turned out — is another.

An alert is forgotten. A ticket is closed while the customer is still waiting. An agent stops working without anyone noticing. Responsibilities connects what should happen with what actually happens. It keeps each case in view, from the first sign that action is needed to its eventual outcome, whether the work is done by a person, an agent, or an automation.

## How Responsibilities works

Responsibilities connects what should happen with what actually happens through four steps: **Observe → Judge → Decide → Act**.

1. **Observe** — Your application collects facts and calls `view` to give the LLM the relevant context: expectations, observations, and open cases.
2. **Judge** — The LLM interprets that context and proposes which cases to open or resolve and which actions to request.
3. **Decide** — Responsibilities uses `step` to validate those proposals, update case state, and return action requests.
4. **Act** — Your application executes the requested actions. Their results become new observations, and the cycle continues.

The responsibilities are deliberately separated. **Your application observes and acts. The LLM judges. Responsibilities decides.**

Responsibilities never calls an LLM, executes an action, or stores data. Its decisions are deterministic: the same inputs produce the same outputs.

People can intervene through `command`, and `assess` checks whether a case achieved its expected outcome.

### Core concepts

- **Definition** – the Responsibility: `identity` (subject type and key names), `accountable` (who answers for it), `expectations` (words for the LLM), `include` (observation kinds the LLM sees and may cite), `closing` (when a case is over), `success` (what a good outcome is).
- **Observation** – an immutable fact: `id`, `kind`, `occurred_at`, `rows`, and `complete` (the rows are everything the source had).
- **Case** – one subject under the Responsibility, here one inquiry: `open`, `resolved` or `dismissed`, with linked evidence and an `episode` that counts status changes.
- **Action request** – an action the host offered and the LLM asked for, checked by the core. The host executes it; its effect returns only as a new observation.

## API at a glance

- `view` – prepares the LLM's context.
- `step` – validates the LLM's proposals and returns the new state and action requests.
- `command` – lets a person set a case's status directly.
- `assess` – checks whether a case met its success criteria.

**`view(definition, state, observations, offered_actions, max_requests, now)` → `View`**
*What is going on?* Prepares the LLM's context: the included observations, the open cases, the closing descriptions, `expectations`, the offered actions, `max_requests`, and a `basis` that binds all of these inputs.

**`step(definition, state, observations, offered_actions, max_requests, evaluation, now)` → `{spec, state, transitions, rejections, action_requests, state_digest}`**
*Does the LLM's proposal hold?* `evaluation` is `{basis, evaluator, proposals}`, with `basis` copied from the view. Each proposal is taken, taken in part, or rejected with a [code](docs/reference.md#rejections); from what is taken follow the new state and the action requests.

**`command(definition, state, {actor: "person:<id>", case_id, status, reason?}, now)` → same as `step`**
*Optional: a person decides.* Sets `open`, `resolved` or `dismissed` on an existing case without judgment gates; `reason` is required for `dismissed`. The loop does not need it; it is how a person steps in.

**`assess(definition, state, case_id, observations, now)` → `{spec, case_id, result: "met" | "not_met" | "unknown", criteria}`**
*Was it a success?* Reads the success criteria, with a trace per rule; no success criteria is `unknown`. Writes nothing.

`resolved` means the case is over. When the LLM proposes it, `step` accepts it only if the closing criteria with rules are met (without rules, it needs new evidence); a person's `command` sets it without that check. Whether the outcome was good is the separate question `assess` answers.

All four are synchronous. `state` is `null` before the first step. A contract violation throws `InputError` and returns nothing; a refused proposal is data, a `rejection`. `src/schema.json` (exported as `schema` and as `responsibilities-core/schema.json`) defines every input and output. Also exported: `digest` ([`H`](docs/reference.md#determinism-and-replay)), `canonical` (RFC 8785), `SPEC`, `InputError`, the types.

## See it in action

A customer inquiry has been waiting for an answer. Responsibilities recognises that it needs attention, requests a reminder, and tracks what happens next. When the inquiry is eventually answered, it checks whether the 24-hour target was met.

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

## Integration

What a host needs: the quickstart, one host step, the host obligations and the scope. The [reference](docs/reference.md) specifies the rest: criteria, what `step` checks, transitions, rejection codes, derived ids and replay.

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

### Determinism and replay

All ids are derived, not generated: the same case, action key and episode always give the same `request_id`. Applying the recorded inputs of each `step` and `command` in order reproduces every output byte for byte, and a replay must never execute actions (Host obligation 3). The hash `H`, every derived id, the `basis` and the recorded fixtures are specified in the [reference](docs/reference.md#determinism-and-replay).

### Scope

**Outside the core, by design:** loading observations and choosing their time window, storage, scheduling, model calls, executing actions, the clock. These belong to the host. Dismissal belongs to a person, never to the LLM.

**Not in v0:** action requests by persons, conditions and parameter binding for actions, globs and value lists in rules.

## License

MIT, see [LICENSE](LICENSE).
