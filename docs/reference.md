# Reference

The normative detail behind the [README](../README.md): how criteria are evaluated, what `step` checks, the transitions and rejections it returns, how every id is derived, and how the fixtures replay. Quickstart, the integration pattern, the host obligations and the scope are in the README's [Integration](../README.md#integration) section.

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

## What `step` checks

1. Every input, or it throws: schema, NFC, times (`now` ≥ `state.now`, nothing occurs after `now`), identity binding, observation conflicts.
2. `basis`. If `evaluation.basis` differs from the recomputed one, every proposal gets `BASIS_MISMATCH` and the state is returned unchanged, `now` included.
3. Order. Observations, proposals and action entries are ordered canonically; list order never matters.
4. Per proposal: whole-proposal gates; cited observations are linked as evidence (a new case is created `open`); the status gate; title and summary; action gates.
5. The limit. At most `max_requests` requests are accepted, the first by `(case_id, key)`.
6. One transition per proposal that changed something; then `state.now = now`.

### Transitions

A transition is `opened`, `status_changed` or `updated`. It names its actor (`judge:<evaluator>` or `person:<id>`), the evidence it linked, `title` and `summary` only if they changed, the `closing_check` that allowed a status change, the definition `version`, and `at`. Each request names the transition that produced it.

### Rejections

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

## Determinism and replay

`H(x)` is the SHA-256 hex of the RFC 8785 bytes of `x`, exported as `digest`. All ids are derived:

```
case_id       = H({definition_id, subject_type, keys})
transition id = H([case_id, seq])
request id    = H([case_id, key, episode])
basis         = H({spec, state_digest, definition_digest, observations_digest, offered_actions_digest, max_requests, now})
proposal ref  = H(proposal, with cites sorted and actions ordered by (key, H(arguments), H(action)))
```

The evaluation records the LLM's proposals, so applying the recorded inputs of each `step` and `command` in order reproduces every output byte for byte; each `state_digest` is checked. `test/replay.test.ts` replays the recordings in `fixtures/`: `example.json` is the [README example](../README.md#see-it-in-action); `actions.json` shows a request, the same key refused as `ACTION_REPEATED` in that episode, the request allowed again after a reopen, and a person's dismissal. Fixtures are bound to `SPEC` (`responsibility-core/0`); `npm run fixtures` re-records them.
