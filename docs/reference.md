# Reference

The normative detail behind the [README](../README.md): how criteria are evaluated, how Attentions and Improvements are checked, what `step` checks, the transitions, events and rejections it returns, how every id is derived, and how the fixtures replay. Quickstart, the integration pattern, the host obligations and the scope are in the README's [Integration](../README.md#integration) section.

## Criteria

```js
{ description: "…", rules: [rule, …] }               // all rules must hold
{ description: "…", any_of: [{ rules: […] }, …] }    // one route must hold
{ description: "…" }                                 // closing only: words for the LLM, gates nothing
// rule:
{ kind, match: { column: subject_key }, where: { column: value } }   // where is optional
{ kind, match: { column: subject_key }, condition: "absent", scope: "all" }
```

A rule reads the latest observation of its `kind` (by `occurred_at`, then `id`) among the observations passed to this call, included or not. `match` joins 1–3 row columns to subject keys, exactly. A presence rule is `met` when a joined row has every `where` value, `not_met` only when the observation is complete and every joined row has another non-null value, otherwise `unknown`: a missing row is never an answer. An `absent` rule (`scope: all`: the observation lists every subject) is `not_met` when a row joins, `met` when the observation is complete and no row could be the subject, otherwise `unknown`. Rules combine as a three-valued AND, routes as OR, criteria as AND. Only one route of an `any_of` may use `absent`. Rules compare values and never compute; a derived fact such as `within_24h` arrives in the observation.

## Attentions

```js
// definition.attention_types[]:
{ key, description, when: [rule, …], delivery: { route } }   // when and delivery are optional
// proposal.attentions[]:
{ type, intent: "open" | "keep" | "close", reason }
```

An Attention says that action is needed in a case. It is neither the action nor a message: the core records it and, for a routed type, returns a delivery; who acts is the host's. A case holds at most one Attention per type, `open` or `closed`, with its `activation`: 1 for the first opening, one more for each reopening. Keys are unique; their order in the definition is not an input. The LLM sees each type's key, description, whether a check gates it (`checked`) and whether it is delivered (`routed`), never its rules.

Each entry of a proposal is checked in this order; the first that applies decides:

1. A proposal rejected as a whole carries its entries with it; they get no rejection of their own.
2. `ATTENTION_REPEATED`: the proposal names the type more than once; every such entry is refused.
3. `ATTENTION_NO_REASON`: the reason is blank.
4. `ATTENTION_NOT_DECLARED`: `open` or `keep` of a type this version does not declare. `close` of an undeclared type the case already has is allowed.
5. `keep`: nothing changes and nothing is recorded.
6. `close`: an open Attention closes, with a `closed` event; otherwise nothing happens. It never reads the case's status or the `when` rules, so it works on a resolved or dismissed case.
7. `open` of an Attention that is already open: nothing happens.
8. Only an actual opening (the case has no Attention of that type) or reopening (it has a closed one) goes further: `ATTENTION_CASE_NOT_OPEN` if the case is not open after this step's status change; then the `when` rules, read like a criterion for the case's Subject, must be `met`, or `ATTENTION_GATE_NOT_MET` with the trace in `detail.gate_check`. Both passed: an `opened` or `reopened` event with the trace in `gate_check`, and a delivery if the type names a route.

A status change leaves the case's Attentions as they are: only the LLM's `close` closes one.

## Improvements

```js
// evaluation.improvements[]:
{ key, title, change, rationale, cites: [observation id, …] }
```

An Improvement identifies where something could work better: a possible gap in how the work is done, not an instruction. `title` states the gap, `change` what could work better, `rationale` what in the evidence shows it. It belongs to the Responsibility, not to a case, and it rests on the observations it cites. An entry is refused with `IMPROVEMENT_CONFLICT` if the evaluation names its key more than once (every such entry), `IMPROVEMENT_INCOMPLETE` if `title`, `change` or `rationale` is blank, `NO_EVIDENCE` if it cites nothing, and `UNKNOWN_EVIDENCE` if a citation is not among this step's included observations. Otherwise the first entry with a key is `proposed`; a later one with the same key is `updated` if it cites something new or changes the text, and records nothing if not. Cited observations are kept as evidence, immutable like a case's. The core decides nothing about an Improvement beyond this; a person does.

## What `step` checks

1. Every input, or it throws: schema, NFC, times (`now` ≥ `state.now`, nothing occurs after `now`), identity binding, observation conflicts.
2. `basis`. If `evaluation.basis` differs from the recomputed one, every proposal and every Improvement gets `BASIS_MISMATCH` and the state is returned unchanged, `now` included.
3. Order. Observations, proposals, Attention entries and Improvements are ordered canonically; list order never matters.
4. Per proposal: whole-proposal gates; cited observations are linked as evidence (a new case is created `open`); the status gate; title and summary; the Attention entries.
5. One transition per proposal that changed the case's status, evidence or text.
6. The Improvements; then `state.now = now`.

No closing, `when` or success rule and no status or Attention gate uses a case's title or summary, an Attention's reason or an Improvement's text as a fact. These are earlier assessments: validated as text, digested and compared to detect a change, but never decisive.

### Transitions and events

A transition is `opened`, `status_changed` or `updated`. It names its actor (`judge:<evaluator>` or `person:<id>`), the evidence it linked, `title` and `summary` only if they changed, the `closing_check` that allowed a status change, the definition `version`, and `at`.

An Attention event is `opened`, `reopened` or `closed`, with the case, the type, the activation, the actor, the reason, the ref of the proposal that asked for it, the `gate_check` that allowed an opening, `version` and `at`. A delivery names the case and its Subject, the type, the activation, the route, the reason and the event it follows from.

An Improvement event is `proposed` or `updated`, with the evidence it added and the text it set or changed.

### Rejections

| Code | Part | When |
|---|---|---|
| `BASIS_MISMATCH` | proposal, improvement | the evaluation was made for other inputs |
| `IDENTITY_MISMATCH` | proposal | subject type or key names are not the declared ones |
| `CONFLICTING_PROPOSALS` | proposal | more than one proposal names the subject; all are rejected |
| `NO_EVIDENCE` | proposal, improvement | `cites` is empty |
| `UNKNOWN_EVIDENCE` | proposal, improvement | a cited id is not among this step's included observations |
| `STATUS_NOT_ALLOWED` | proposal | a new case proposed as anything but `open` |
| `CLOSING_NOT_MET` | status | `resolved` while closing criteria with rules are not all `met` |
| `REOPEN_WHILE_CLOSING_MET` | status | `open` while they are all `met` |
| `STATUS_UNCHANGED_NO_NEW_EVIDENCE` | status | `open` again, or `resolved` without closing rules, and nothing new is cited |
| `ATTENTION_REPEATED` | attention | the proposal names the type more than once |
| `ATTENTION_NO_REASON` | attention | `reason` is blank |
| `ATTENTION_NOT_DECLARED` | attention | `open` or `keep` of an undeclared type, or `close` of an undeclared type the case does not have |
| `ATTENTION_CASE_NOT_OPEN` | attention | an opening or reopening while the case is not open after the step |
| `ATTENTION_GATE_NOT_MET` | attention | an opening or reopening while the type's `when` rules are not all `met` |
| `IMPROVEMENT_CONFLICT` | improvement | the evaluation names the key more than once; all are rejected |
| `IMPROVEMENT_INCOMPLETE` | improvement | `title`, `change` or `rationale` is blank |

Part `proposal`: nothing of it was taken. Part `status`: status, title and summary were not taken (they are in `detail.proposed_title` and `proposed_summary`); new evidence stays linked. Part `attention`: only that entry was not taken; `ref.key` is its type. Part `improvement`: that Improvement was not taken; `ref.improvement` is its ref and `ref.key` its key.

## Determinism and replay

`H(x)` is the SHA-256 hex of the RFC 8785 bytes of `x`, exported as `digest`. All ids are derived:

```
case_id           = H({definition_id, subject_type, keys})
transition id     = H([case_id, seq])
attention event   = H([case_id, type, activation, event])
delivery id       = H([case_id, type, activation])
improvement_id    = H({definition_id, key})
improvement event = H([improvement_id, seq])
basis             = H({spec, state_digest, definition_digest, observations_digest, now})
proposal ref      = H(proposal, with cites sorted and attentions ordered by (type, H(entry)))
improvement ref   = H(improvement, with cites sorted)
```

The definition is digested with its `attention_types` sorted by key. Outputs are ordered: transitions by case, Attention events by `(case_id, type, activation, event)`, deliveries by `(case_id, type, activation)`, Improvement events by `improvement_id`. Applying an evaluation again to the state it produced records nothing twice: an open Attention is not opened again, and an Improvement with nothing new emits no event.

The evaluation records the LLM's proposals and Improvements, so applying the recorded inputs of each `step` and `command` in order reproduces every output byte for byte; each `state_digest` is checked. `test/replay.test.ts` replays the recordings in `fixtures/`: `example.json` is the [README example](../README.md#see-it-in-action); `attention.json` shows an Attention opened and delivered, closed, the case resolved and reopened, the Attention reopened with a new activation and a new delivery id, and a person's dismissal. Fixtures are bound to `SPEC` (`responsibility-core/1`); `npm run fixtures` re-records them.
