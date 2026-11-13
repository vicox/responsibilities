# Responsibilities

### Persistent Responsibilities for AI Agents

*Give AI agents something to own beyond a single task — with persistent context, evidence, and decisions across runs.*

Customers need answers. Bookings need payment. Important changes need follow-through. None of these is a task that ends: each is a lasting expectation, a Responsibility, that an agent can take on run after run. This repository is the open-source core of Responsibilities: the decision step of each run, as four pure functions.

## Why Responsibilities?

Noticing a problem is one thing. Making sure something happens about it — and knowing how it turned out — is another.

An alert is forgotten. A ticket is closed while the customer is still waiting. An agent stops working without anyone noticing. Responsibilities connects what should happen with what actually happens. It keeps each case in view, from the first evidence that something is not as expected to its eventual outcome, whether the work is done by a person, an agent, or an automation.

## How Responsibilities works

Each run follows three steps: **Observe → Judge → Remember**.

1. **Observe** — Your host loads observations within its lookback, plus what [History and lookback](#history-and-lookback) requires whatever its age. It decides when a run happens: on a schedule, or when relevant new evidence arrives. `view` gives the judge the expectations, the observations, the attention types and every case: its current record (status, episode, the ids of its evidence and when that evidence was observed, open Attentions) and its earlier assessments (title, summary), marked as such. It also gives the Improvements so far: earlier proposals for a person.
2. **Judge** — The agent evaluates the evidence against the expectation and decides what follows. It can open, update or resolve cases; open, keep or close Attentions; note Improvements, where something could work better; or decide that nothing needs to happen. Earlier assessments inform the judgment but do not bind it. `step` takes what holds and refuses the rest with a code.
3. **Remember** — `step` returns the new state. Your host keeps it with everything listed in [Host obligation 2](#host-obligations), and the next run starts from it, whichever agent runs it.

Action is optional and outside the core. The agent acts with its host's tools, or the host hands a routed Attention (a delivery) to another agent or a person. What they did comes back as observations.

The responsibilities are deliberately separated. **Your host observes, runs the agent and gives it its tools. The agent judges. The core checks each judgment and returns what the next run starts from.**

Responsibilities never calls an LLM, delivers a message, or stores data. Its decisions are deterministic: the same inputs produce the same outputs.

People can intervene through `command`, and `assess` checks whether a case achieved its expected outcome.

### Core concepts

- **Responsibility** (`Definition`) – what should stay true and who answers for it: `identity` (subject type and key names), `accountable` (who answers for it), `expectations` (words for the LLM), `include` (observation kinds the LLM sees and may cite), `closing` (when a case is over), `success` (what a good outcome is), `attention_types` (the kinds of attention a case can need). Versioned: every transition and event names its version.
- **Judgment** (`Evaluation`) – one run's proposals and Improvements, bound by `basis` to the view's inputs. It is valid without any action, even with no proposals at all.
- **Case** – one ongoing situation, followed across runs until it is over; here one inquiry. It is `open`, `resolved` or `dismissed` independently of its Attentions, with linked evidence, an `episode` that counts status changes, and its Attentions.
- **Attention** – action is needed in a case. It is neither the action nor a message: who acts — the agent with its host's tools, another agent, or a person — is the host's to decide. Its type may have `when` rules that must be met before it opens, and a `delivery` route. The LLM proposes opening, keeping or closing it; the core checks the opening.
- **Observation** – an immutable fact: `id`, `kind`, `occurred_at`, `rows`, and `complete` (the rows are everything the source had).
- **State** – what carries over between runs: the current record and earlier assessments. The host stores it.
- **Delivery** – the optional handoff of one opening or reopening of a routed Attention to its route, which can be a person, a team or an agent, with a stable id. The host hands it over; the core never sends anything.
- **Improvement** – an observation of a possible gap in how the work is done, citing the observations it rests on; not an instruction. Attentions identify where action is needed; Improvements identify where something could work better. An Improvement is independent of any one case, and a person decides what, if anything, to change.

## API at a glance

- `view` – prepares the LLM's context.
- `step` – validates the LLM's proposals and returns the new state and the deliveries.
- `command` – lets a person set a case's status directly.
- `assess` – checks whether a case met its success criteria.

**`view(definition, state, observations, now)` → `View`**
*What is going on?* Prepares the LLM's context: the included observations, every case with its current record (status, episode, evidence ids, first and last observed, open Attentions) and its earlier assessments (title, summary), the attention types (whether a check gates them and whether they are delivered, never the rules), the Improvements so far, the closing descriptions, `expectations`, and a `basis` that binds all of these inputs.

**`step(definition, state, observations, evaluation, now)` → `{spec, state, transitions, attention_events, deliveries, improvement_events, rejections, state_digest}`**
*Does the LLM's proposal hold?* `evaluation` is `{basis, evaluator, proposals, improvements?}`, with `basis` copied from the view. Each proposal and Improvement is taken, taken in part, or rejected with a [code](docs/reference.md#rejections); from what is taken follow the new state, the histories and the deliveries.

**`command(definition, state, {actor: "person:<id>", case_id, status, reason?}, now)` → same as `step`**
*Optional: a person decides.* Sets `open`, `resolved` or `dismissed` on an existing case without judgment gates; `reason` is required for `dismissed`. The loop does not need it; it is how a person steps in.

**`assess(definition, state, case_id, observations, now)` → `{spec, case_id, result: "met" | "not_met" | "unknown", criteria}`**
*Was it a success?* Reads the success criteria, with a trace per rule; no success criteria is `unknown`. Writes nothing.

`resolved` means the case is over. When the LLM proposes it, `step` accepts it only if the closing criteria with rules are met (without rules, it needs new evidence); a person's `command` sets it without that check. Whether the outcome was good is the separate question `assess` answers.

All four are synchronous. `state` is `null` before the first step. A contract violation throws `InputError` and returns nothing; a refused proposal is data, a `rejection`. `src/schema.json` (exported as `schema` and as `responsibilities-core/schema.json`) defines every input and output. Also exported: `digest` ([`H`](docs/reference.md#determinism-and-replay)), `canonical` (RFC 8785), `SPEC`, `InputError`, the types.

## See it in action

A customer inquiry has been waiting for an answer. The judge sees that it needs attention; the core checks the opening and returns one delivery for the support team, and the host posts it. When the inquiry is eventually answered, `assess` checks whether the 24-hour target was met.

The Responsibility: every customer inquiry gets a first answer within 24 hours. Both blocks run as one test, and `fixtures/example.json` is their recording.

### 1. An inquiry waits: `view` and `step`

One inquiry, one case, one proposal from the LLM, one Attention, one delivery.

```ts
import { step, view, type Definition } from "responsibilities-core";

const definition: Definition = {
  id: "inquiries-answered",
  version: 1,
  identity: { subject_type: "inquiry", subject_keys: ["inquiry"] },  // one case per inquiry
  accountable: "team:support",
  expectations: "Every customer inquiry gets a first answer within 24 hours.",
  include: ["waiting_for_us"],                                       // what the LLM sees
  closing: [],
  success: [],                                                       // part 2 adds one
  attention_types: [{
    key: "needs_answer",
    description: "A customer waits for a first answer.",
    when: [{ kind: "waiting_for_us", match: { inquiry: "inquiry" } }], // only while the helpdesk lists it
    delivery: { route: "#support" },
  }],
};

// The host loaded this from its helpdesk: the complete list of inquiries waiting for us.
const waiting = {
  id: "waiting-1", kind: "waiting_for_us", occurred_at: "2026-11-02T09:00:00.000Z",
  subjects: [{ type: "inquiry", keys: { inquiry: "T-1042" } }],
  rows: [{ inquiry: "T-1042", customer: "ACME" }], complete: true,
};
const now = "2026-11-02T09:01:00.000Z";

// view: what is going on? The host sends v to its LLM.
const v = view(definition, null, [waiting], now);

// The LLM answers with a proposal; step checks it and derives what follows.
const r = step(definition, null, [waiting], {
  basis: v.basis,                     // the answer is bound to exactly what the LLM saw
  evaluator: "llm",
  proposals: [{
    subject: { type: "inquiry", keys: { inquiry: "T-1042" } },
    status: "open",
    cites: ["waiting-1"],             // evidence must come from v
    attentions: [{ type: "needs_answer", intent: "open", reason: "ACME waits for an answer to T-1042." }],
  }],
}, now);

// r.transitions:      [{ kind: "opened", to: "open", actor: "judge:llm", … }]  a case for T-1042
// r.attention_events: [{ type: "needs_answer", event: "opened", gate_check: { result: "met", … }, … }]
// r.deliveries:       [{ route: "#support", type: "needs_answer", activation: 1, … }]  the host posts it, not the core
// r.state:            the host stores it; the next call starts from it
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

For a longer run, the [simulation](docs/simulation.md) takes a six-day scenario through the core, one day at a time, with a live LLM as the judge: a security fix that does not hold, or a customer case handed from Support to Engineering and then forgotten.

## Integration

What a host needs: the quickstart, one host step, the host obligations, history and lookback, and the scope. The [reference](docs/reference.md) specifies the rest: criteria, Attentions, Improvements, what `step` checks, rejection codes, derived ids and replay.

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
// Run on a schedule, or when relevant new evidence arrives.
const v = view(definition, state, observations, now);
const { proposals, improvements = [] } = await askYourLLM(v);  // validate against schema.json#/$defs/evaluation
const evaluation = { basis: v.basis, evaluator: "my-llm", proposals, improvements };
const r = step(definition, state, observations, evaluation, now);
// One transaction, and only if the stored state_digest is still `readDigest`:
await yourStore.commitIf(readDigest, { evaluation, state: r.state, state_digest: r.state_digest, transitions: r.transitions,
                                       attention_events: r.attention_events, improvement_events: r.improvement_events,
                                       rejections: r.rejections, outbox: r.deliveries });
// Then hand each delivery from the outbox to its route (see Host obligations); acting is optional and the host's.
```

### Host obligations

1. **Pass `step` exactly the inputs of its `view`**, `now` included. Another `now`, or a state saved in between, gives `BASIS_MISMATCH`. Pass the observations the closing and `when` rules read: the core has no lookback. A case's `evidence` in the view lists every observation it rests on; only those passed to this call can be cited.
2. **Compare and set.** Store the new state only if the stored `state_digest` is still the one read. Keep together, in one transaction: the state and its digest; the transitions, Attention events and Improvement events; the deliveries (the outbox); the rejections; and the evaluation, or for `command` the command itself. The evaluation is the judgment's record, kept also when it changed nothing. An Attention event's `proposal` is the hash of the proposal it follows from, in canonical form (the reference's [proposal ref](docs/reference.md#determinism-and-replay)), so the kept evaluation shows that proposal, its cites and its reason; transitions and Improvement events carry their evidence themselves (`added_evidence`). The state keeps no history.
3. **Deliver only stored deliveries** – never from a failed save, never from a replay. The core guarantees at most one delivery per `(case_id, type, activation)` along one state line, and a stable delivery `id`; nobody guarantees exactly-once effects. Choose per route:
   - *at most once*: durably mark the `id` as started before delivering; never deliver a started id again.
   - *at least once*: retry until confirmed; only where the target takes the `id` as an idempotency key, or a duplicate is acceptable.
4. **Feed effects back as observations.** The core never learns delivered, read, failed or skipped, nor what an agent did with its tools.
5. **Validate the LLM's raw output against the schema** first; a non-conforming evaluation makes `step` throw.
6. **Give canonical input.** Strings in NFC; times exactly `YYYY-MM-DDTHH:MM:SS.sssZ`; integers within ±(2^53−1); fractions only in observation rows. The core refuses, it does not normalize. Subject keys compare exactly: `173` ≠ `"173"`, `"Web"` ≠ `"web"`.
7. **Keep every observation, unchanged.** The core detects a changed observation only once it is linked as evidence.
8. **Keep one state per Responsibility.** `now` never goes back.
9. **Keep the prompt the judge was given.** `basis` binds the view's inputs, not what a host adds beside the view.

### History and lookback

**History is kept.** Every observation, every evaluation, every step and command result with its rejections, and every prompt are kept by the host (obligations 2, 7 and 9). The state keeps the current record; a lookback never deletes anything.

**Earlier assessments are history, not truth.** What a judge wrote earlier — a case's title and summary, an Attention's reason, Improvements and earlier evaluations — may be shown to the next judgment as a record of an earlier assessment.

- A host that shows them marks them as earlier assessments, with who and when where it knows.
- The core never takes them as evidence: a citation is an observation id.
- No closing, `when` or success rule and no status or Attention gate uses them as a fact: the rules read observations, the gates read the status and the evidence linked in the step.
- The core still validates them as text (an Attention's reason and an Improvement's title, change and rationale must not be blank; a title or summary must not be empty), digests them (through the state into `basis`) and compares them to detect a change.
- The current record — status and open Attentions — is what the core works from. It changes with new evidence through the judge, or by a person.

**Context beside the view** is optional. A host may add history from its store, within the lookback: transitions, Attention events, earlier evaluations. It marks any earlier assessment among them as above. Such context cannot be cited, and the host keeps the prompt (obligation 9).

**Lookback** is host configuration, per Responsibility. It bounds what the judge is shown, never what is stored. The host passes to `view` and `step`:

- (a) the observations of included kinds within the lookback;
- (b) whatever their age, the observations open cases rest on: at least the newest of each kind for every open case;
- (c) whatever their age, the newest observation of each kind a closing, `when` or success rule reads.

(b) and (c) are required. A rule reads the newest observation *passed*: if a newer snapshot is left out, an older one decides, and it can let a case resolve that the newest snapshot would keep open. A host that caps its input trims only (a) and the context beside the view, and says so in its prompt. If it cannot pass (b) and (c) in full, it does not run.

**Presenting the view within the lookback.** `view` and `step` always get the full stored state and the observations selected above. The host uses `basis` as `view` returns it, never recomputed from what it shows, and never prunes the stored state. What it renders for the judge may follow the lookback:

- It always shows every open case and every observation of (b) and (c) that `view` returns, which means those of included kinds. An observation of a kind outside `include` that a rule reads is an input of the core only: `view` does not return it and it cannot be cited.
- It may leave out resolved and dismissed cases whose `last_observed` lies before the lookback, and Improvements whose `updated_at` in the state does.
- The kept prompt (obligation 9) records what was shown.

### Determinism and replay

All ids are derived, not generated: the same case, attention type and activation always give the same delivery `id`. Applying the recorded inputs of each `step` and `command` in order reproduces every output byte for byte, and a replay must never deliver (Host obligation 3). The hash `H`, every derived id, the `basis` and the recorded fixtures are specified in the [reference](docs/reference.md#determinism-and-replay).

### Scope

**Outside the core, by design:** loading observations and choosing their time window (the lookback; see [History and lookback](#history-and-lookback)), storage, when a run happens (on a schedule, or when relevant new evidence arrives, for example an observation of a kind the Responsibility includes or its rules read), model calls, delivering, the clock. These belong to the host. Acting on an Attention is optional and belongs to the host: the agent with its host's tools, another agent, or a person. Deciding on an Improvement belongs to a person. Dismissal belongs to a person, never to the LLM.

**Not in v1:** Attentions opened by persons, decisions on Improvements, conditions and parameters for deliveries, globs and value lists in rules.

## License

MIT, see [LICENSE](LICENSE).
