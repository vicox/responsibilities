# Simulation

The simulation runs one Responsibility through the core for six days, one day at a time, with a live LLM as the judge. It shows what the core decides and what it leaves to the model: cases, Attentions and their deliveries, and an Improvement the model finds on its own. There are two scenarios, with the same core, loop, prompt and judges: [`security-fix`](#scenario-security-fix-simulationscenariosecurity-fix) and [`support-handoff`](#scenario-support-handoff-simulationscenariosupport-handoff).

```sh
npm run simulation -- --judge claude|codex [--scenario security-fix|support-handoff] [--model <name>] [--pause]
```

- `--judge` — `claude` runs `claude -p`, `codex` runs `codex exec`. Each CLI uses its own login; the simulation reads no secrets.
- `--scenario` — which scenario runs; `security-fix` without it.
- `--model` — passed to the CLI; without it the CLI's default model judges.
- `--pause` — waits after each day: Enter goes on, `q` stops, and the journal records the run as stopped. It needs an interactive terminal and exits before D1 without one.

There is no other option: no replay judge on the command line, no resume, no stopping at a given day. A run that crashed is started again from D1, in a new run directory.

## A day

Each day's observations arrive at 09:00Z and the judge answers at 18:00Z. Every day, `view` and `step` get **every observation from D1 through that day**, so the closing and `when` rules can read an earlier day's facts.

1. The day's observations join the earlier ones, and each is journaled as a `signal`.
2. `view`, then the prompt: the View rendered as text with general rules only (`simulation/prompt.ts`). It names nothing of the scenario and shows no rule, only each attention type's description and whether it is checked and routed. The README asks a host to mark earlier assessments as such; this prompt lists each case's title, an earlier assessment by the judge, without that mark, and is left as it is so that the live results below stay comparable.
3. The judge answers in the structured format of `simulation/judge-schema.json`.
4. `simulation/parse.ts` maps the answer to an `Evaluation` and validates it with the core's schema. An answer that cannot be used gets one retry, with the error. If that fails too, the day is `judge_failed`: `step` is not called, the state stays as it was, and the day shows FAILED. There is no scripted fallback.
5. `step`, then each delivery is written to the inbox.
6. A trace check: all evidence of every case and Improvement must be a journaled `signal`, byte for byte, and every Attention event and delivery must belong to a case. A violation fails the day.
7. The day's report: the context sent, the judge's answer, each proposal taken or refused with its code and trace, Attention events with each rule's result, deliveries and Improvements.

## Scenario `security-fix`: `simulation/scenario/security-fix/`

The Responsibility `security-fixes-ship`: every security finding in our apps is triaged promptly and fixed before it reaches customers. One case per `finding`, keyed by `app` and `finding_id`.

- **Closing:** "The report is resolved at its source" — the Bugcrowd finding is `resolved`, or the pre-release scan says `fixed`.
- **Success:** none. Closing is procedural, so `assess` stays `unknown`: the report calls it closed at source, outcome not verified.
- **Attention types:** `security_review` (when the Bugcrowd finding is `triaging`; delivered to `security-oncall`) and `release_review` (when a release candidate of the app is `awaiting_release` **and** the pre-release scan lists the finding `open`; delivered to `release-review`).

Nothing in the Responsibility mentions re-testing a fix.

| Day | New observations | What the core decides | What the model must see |
|---|---|---|---|
| D1 | Bugcrowd F-17: stored XSS (CWE-79), `POST /rest/macro/preview`, parameter `title`, rendered on page view, payload `<img src=x onerror=…>`, `triaging` | Opening `security_review` passes its check; one delivery to `security-oncall` | Open case F-17 and `security_review` |
| D2 | F-17 `accepted`; ticket SEC-42 `In Progress` | — | Close `security_review` |
| D3 | PR #88 merged as `c0ffee1`: "remove `<img>` elements from macro title before rendering"; CI on `c0ffee1` passed | — | Update F-17 |
| D4 | SEC-42 `Done`; F-17 `resolved` | Resolving F-17 passes the closing check; success stays `unknown` | Resolve F-17 |
| D5 | Release candidate `3.2.0-rc1` at `d00d2b7`, contains `c0ffee1`, `awaiting_release` | Quiet: no Attention event, no delivery, no case opened or reopened | Nothing, or new evidence on F-17 |
| D6 | Pre-release scan DAST-301 of `3.2.0-rc1` at `d00d2b7`: same CWE, location, parameter and sink, payload `<svg/onload=…>`, executed on page view, `open` | Opening `release_review` on DAST-301 passes with both rules `met`; one delivery to `release-review`. Reopening F-17 is refused (`REOPEN_WHILE_CLOSING_MET`): its source still says resolved | Open case DAST-301 citing the scan, and `release_review`. Infer that the build contains the fix and the same sink is still exploitable. Propose an Improvement, a possible gap rather than a prescription, citing the scan and F-17's earlier evidence |

A refusal is audit context only: the report shows it, and nothing cites it. An Improvement cites observations only, never a case or a refusal; which possible gap it identifies, and in what words, is the model's.

`scripted.json` holds a judge's answers written by hand, one per day. Only the tests use it. Its D6 Improvement is worded as the user chose, an observation rather than a remedy:

- title: "Security fixes may be closed without sufficient verification"
- change: "How the effectiveness of a security fix is verified before its finding is closed."
- rationale: "A previously resolved security finding was detected again during a pre-release scan. This suggests a potential gap in how the effectiveness of security fixes is verified before findings are closed."
- cites: the scan, and F-17's report, fix and resolution.

## Scenario `support-handoff`: `simulation/scenario/support-handoff/`

The Responsibility `customer-support-quality` (Customer Support Quality): every customer case keeps moving until the customer's problem is solved, whichever team is working on it, and the customer never goes more than three days without an update from us. Accountable: `team:support`. One case per `customer_case`, keyed by `case`.

- **Observations:** `support_cases`, the helpdesk's view of the case (status, linked ticket, last reply to the customer), and `engineering_tickets`, Engineering's ticket for it. Both are daily snapshots, and both list the customer case as their subject: when the case moves to Engineering, the Responsibility follows it there, and it stays one case.
- **Closing:** "The customer's problem is solved and the case is solved in the helpdesk" — the helpdesk lists the case `solved`. It is not reached in six days.
- **Success:** none.
- **Attention type:** `escalation` (when the helpdesk lists the case `waiting_on_engineering`; delivered to `support-lead`). The rule confirms only that the case still waits on another team. Whether it has stalled, with nothing moving and no update for more than three days, is the model's to see.

Nothing in the Responsibility mentions handoffs.

| Day | New observations | What the core decides | What the model must see |
|---|---|---|---|
| D1 | Case SUP-1042 from Northwind Logistics: PDF export fails with error 500 for large spaces; `open`; Support replied the same morning | — | Open case SUP-1042, no Attention |
| D2 | SUP-1042 `waiting_on_engineering`, handed over as ENG-311; the customer told "passed to our engineering team … we will keep you updated"; ENG-311 `To Do`, no assignee | — | Link the handoff, so Engineering's ticket is the case's evidence; no Attention yet |
| D3, D4 | The same snapshots: ENG-311 unchanged since the handoff, no reply to the customer since D2 | Quiet: no Attention event, no delivery | Nothing, or new evidence on SUP-1042 |
| D5 | The same snapshots, now more than three days after the handoff and the last update | Opening `escalation` passes its check; one delivery to `support-lead` | Open `escalation`: the case has stalled and a person must act now. Propose an Improvement, a possible gap in follow-up after a handoff, citing the handoff and the days without progress |
| D6 | ENG-311 `In Progress`, assigned, commented "Picked up after the support lead's escalation"; the customer updated | No delivery | Close `escalation`. SUP-1042 stays open: the problem is not solved yet |

**Attention now, Improvement structural.** The escalation is about this one case, now: a person must get it moving, and once someone has, it closes. The Improvement is about how the work is done: it outlives the escalation, rests on what the observations show, and stays in the state for a person to decide what, if anything, changes. It changes nothing by itself. The Responsibility, its rules and its observation kinds stay as they are, and nothing configures a Responsibility or adds a signal.

This scenario's `scripted.json` holds the hand-written answers the tests use. Its Improvement, proposed on D5:

- title: "Customer cases handed to another team may lose follow-up"
- change: "How a case's progress and the customer's updates are followed up after the case is handed to another team."
- rationale: "SUP-1042 was handed from Support to Engineering as ENG-311 on 2026-11-03. In the three days after that, ENG-311 had no assignee and no activity, and the customer received no update. This suggests a potential gap in how follow-up is owned once a case moves from Support to Engineering. It rests on one case, so how often this happens is not known."
- cites: the handoff on D2 and the snapshots of D5, from both the helpdesk and Engineering.

## What a run leaves: `simulation/runs/<run id>/`

The run id is the start time, the scenario and the judge, as in `2026-11-09T23-10-00-000Z-support-handoff-claude`. Runs from before `--scenario` existed are named without the scenario, and all of them ran `security-fix`.

- `journal.jsonl` — the one append-only journal: `run_started` (judge, model, flags, the scenario's name, digests of the prompt template, the judge schema and the scenario), `signal`, `context` (basis and the full prompt), `judge_output` (raw output, parsed evaluation, duration, exit code, the no-tool proof, CLI version and model), `judge_failed`, `step` (every list of the step result, refusals with their traces), `delivery`, `trace_check`, `run_stopped`, `run_finished` (status, failed days, checks). Every history and check result is a view over it.
- `inbox.md` — the single delivery sink, one block per delivery, labelled with its route. Nothing is posted anywhere else: no Slack, no webhook.
- `report.md` — what the console showed, and the checks.

Everything written or printed is redacted first: the exact values of environment variables whose names contain `KEY`, `TOKEN`, `SECRET` or `PASSWORD` (8 characters or more), as they stand in text and as they stand escaped inside JSON, up to four levels deep (a CLI's event line carrying a message whose text is JSON, kept as a raw string in the journal), and common key patterns. Journal entries are redacted string by string before they are serialized. Each run plants a random value in `RESPONSIBILITIES_SIMULATION_CANARY_TOKEN` and fails if it, or any such value, appears in the run directory, in either form or in the decoded journal.

**Deliveries, exactly.** The core returns a delivery only for an opening or reopening of a routed type, with id `H([case_id, type, activation])`. The simulation writes each id to the inbox once per run, using an in-memory set. There is no crash safety and no at-most-once claim across process restarts.

## The checks

At the end of a run, the scenario's `checks.ts` decides what code can. For `security-fix`:

- D1: case F-17 opens; `security_review` opens with its check `met`; exactly one delivery, to `security-oncall`.
- By D4: `security_review` is closed.
- D4: F-17 is resolved with its closing check met; `assess` is `unknown`.
- D5: quiet.
- D6: case DAST-301 opens citing the scan; `release_review` opens on it with both rules `met`; exactly one delivery, to `release-review`; an Improvement cites the scan and an F-17 observation from D1–D4.

For `support-handoff`:

- D1: case SUP-1042 opens; no Attention event, no delivery.
- D2–D4: quiet (no Attention event, no delivery, no case opened or status changed). An escalation before three days have passed fails the run.
- D5: `escalation` opens on SUP-1042 with its check `met`; exactly one delivery, to `support-lead`.
- Every day: one case only, SUP-1042. By D5 it has an `engineering_tickets` observation as its evidence.
- D6: `escalation` closes, with no delivery; SUP-1042 stays open.
- By D6: an Improvement cites the handoff (a D2 observation) and a day without progress (one from D3–D5).

For both:

- Every day: a usable answer, trace checks pass, no tool ran; all six days ran; no secret value in the run directory.

Whether an Improvement observes a plausible gap, no more certainly than its evidence allows and without prescribing how to close it, is for a person to judge from the report. A failed check or day makes the run FAILED and the exit code 1.

## The judges

Each judge runs without a shell, in a new empty temporary directory that is removed afterwards, with the prompt on stdin and a 180-second timeout. The CLI leads its own process group: a timeout kills it with everything it started, and the call returns at most a second later even if a descendant still holds its output; an interrupted run (Ctrl+C) kills the group too. Every answer must carry the CLI's proof that no tool ran; an answer without it is unusable like any other (one retry, then `judge_failed`), and one that shows a tool fails the day at once.

### `claude` (Claude Code 2.1.319, verified)

```
claude -p --safe-mode --tools "" --strict-mcp-config --no-session-persistence \
  --output-format stream-json --verbose --max-budget-usd 2 [--model <m>] \
  --json-schema <judge schema> --system-prompt <rules>          # prompt on stdin
```

Checked by running it on this machine (Phase 0):

1. **Structured output.** With `--json-schema`, the answer is the `structured_output` of the final `result` event; the CLI validates it through a `StructuredOutput` tool. `parse.ts` and the core's schema validate it again.
2. **No tool runs.** With `--tools ""` the `init` event lists `tools: ["StructuredOutput"]` and `mcp_servers: []`. Asked to read `package.json` from its working directory, it gave the answer the prompt allowed for "cannot read files", and the stream shows no tool use but `StructuredOutput`. The judge requires both in the `init` event, and that every `tool_use` is `StructuredOutput`. The `init` event still lists installed skills and plugins; with no tool on offer, none of them can run.
3. **Isolation.** A `CLAUDE.md` planted in an otherwise empty working directory named a project marker. Asked for the marker, `claude -p` without `--safe-mode` answered with it; with `--safe-mode` it answered that there was none. The `CLAUDE.md` of a parent directory (this workspace has one) was not loaded under `--safe-mode` either. The judge's own working directory is new and empty for every call.
4. **No session written.** With `--no-session-persistence`, no transcript of the probe sessions appeared under `~/.claude/projects/`.
5. **Failures.** An exceeded budget exits 1 with `is_error: true` and `subtype: "error_max_budget_usd"`; the budget is checked after a turn, so a turn can overspend once. An invalid API key exits 1 with `is_error: true` and `api_error_status: 401`.
6. **Latency and cost.** See the results below.

### `codex` (codex-cli 0.160.0, verified)

```
codex exec --skip-git-repo-check --sandbox read-only --ephemeral --ignore-user-config --ignore-rules \
  -c project_doc_max_bytes=0 -c 'history.persistence="none"' \
  --disable shell_tool --disable unified_exec --disable apps --disable plugins --disable remote_plugin \
  --disable browser_use --disable browser_use_external --disable in_app_browser --disable computer_use \
  --disable image_generation --disable multi_agent --disable view_image --disable hooks --disable sleep_tool \
  --disable skill_search --disable skill_mcp_dependency_install --disable tool_suggest --disable goals \
  --disable workspace_dependencies \
  --json --color never [-m <m>] \
  --output-schema <file> --output-last-message <file> -C <empty dir> -      # rules and prompt on stdin
```

Checked by running it on this machine (Phase 0). Codex has no flag that turns all tools off; the `--disable` list is every feature of this version (`codex features list`) that gives the model a tool.

1. **Structured output.** With `--output-schema`, the answer is the JSON in the `--output-last-message` file (the final `agent_message` carries the same text). The judge schema's nullable fields (`"type": ["string", "null"]`) are accepted. `parse.ts` and the core's schema validate the answer again.
2. **No tool runs.** `--sandbox read-only` is not enough: with it alone, asked to read a planted `note.txt`, the model ran `/bin/zsh -lc 'cat note.txt'` and returned the file's contents, and an MCP server from the account's apps was started. With the features above disabled, the same request got the answer the prompt allowed for "cannot read files", the events showed no `command_execution`, no MCP server started, and the input fell from 28,410 to 10,968 tokens. The judge's proof is that the JSONL events carry no item other than `agent_message`, `reasoning` or `error` (a warning Codex reports, shown in the report).
3. **Isolation.** An `AGENTS.md` planted in the working directory named a project marker. Without `project_doc_max_bytes=0`, Codex answered with the marker; with it, that there was none. `--ignore-user-config` skips `config.toml`. No flag keeps out an `AGENTS.md` or `AGENTS.override.md` in Codex's home (`CODEX_HOME`, else `~/.codex`), and the login lives in that home, so the judge does not swap in an empty one: it refuses to start, before D1, while either file exists there. The home on this machine has neither. Codex's own built-in skill list (image generation, OpenAI docs, skill creation and installation) stays in its developer instructions; with no tool, none of those skills can be read or run.
4. **No session written.** With `--ephemeral`, `codex exec resume <thread id>` of a probe thread failed with "no rollout found". `history.persistence="none"` is set as documented; it was not checked separately.
5. **Failures.** A failed turn exits 1 with `error` and `turn.failed` events on stdout and nothing on stderr; the judge reports the failed turn's message. Authentication: pointed by `-c` overrides at a provider with an invalid bearer token, Codex retried five times (each an `error` event, "401 Unauthorized: Incorrect API key provided") and then failed the turn with the same 401 and exited 1. An unknown model fails the same way, with `model_not_found`. Codex has no budget flag; the 180-second timeout bounds a call.
6. **Latency and cost.** See the results below. Codex reports tokens, not cost, and does not name the model in its output; with `--ignore-user-config` the model is the CLI's default.

The tests check both judges against fake `claude` and `codex` executables first on `PATH`: the arguments, stdin, the empty temporary directory, the no-tool proof, timeouts and failures.

## Tests

`npm test` runs the simulation's tests with the core's, with no network and no real CLI: the scripted six-day arcs of both scenarios through the replay judge (every check above passes; for `security-fix`, D5 is quiet, D6's refusal is recorded and two runs give identical state digests; for `support-handoff`, one case across the handoff, one escalation that closes once a person acted while the Improvement stays, and an escalation on D4 or a second case for ENG-311 fails the run), the prompt (every observation so far, no rule, no word of either scenario in the template, Improvements framed as observed possible gaps without remedies), parsing and the retry, the judges against fakes, redaction, the command line and `--pause`.

## Live results

Each live run is one row; a criterion is PASS or FAIL as `report.md` gives it. The columns are the checks above; "every day" is a usable answer, trace checks and no tool, on all six days; "secrets" is the planted value absent from the run directory.

### `security-fix`

| Date | Judge | CLI | Model | D1 | By D4 | D4 | D5 quiet | D6 | Every day | Secrets | Time, cost | Improvements cited on D6 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-09 | claude | 2.1.319 | claude-opus-5-5 | PASS | PASS | PASS | PASS | PASS | PASS | PASS | 112 s, not recorded | `hold-release-on-unverified-security-fix`, `verify-xss-fix-before-resolve` |
| 2026-11-09 | claude | 2.1.319 | claude-opus-5-5 | PASS | PASS | PASS | PASS | PASS | PASS | PASS | 104 s, $0.28 | `xss-fix-verification` |
| 2026-11-09 | claude | 2.1.319 | claude-opus-5-5 | PASS | PASS | PASS | PASS | PASS | PASS | PASS | 98 s, $0.28 | `xss-fix-verification`, `reopen-original-on-fix-bypass` |
| 2026-11-09 | claude | 2.1.319 | claude-opus-5-5 | PASS | PASS | PASS | PASS | PASS | PASS | PASS | 92 s, $0.26 | `verify-fix-before-resolving-at-source`, `xss-fix-at-sink-with-variant-tests`, `release-gate-covers-unverified-resolutions` |
| 2026-11-09 | codex | 0.160.0 | CLI default, not reported | PASS | PASS | PASS | PASS | PASS | PASS | PASS | 43 s, not reported | `macro-title-xss-verification` |
| 2026-11-09 | codex | 0.160.0 | CLI default, not reported | PASS | PASS | PASS | PASS | PASS | PASS | PASS | 44 s, not reported | `xss-fix-validation` |
| 2026-11-09 | codex | 0.160.0 | CLI default, not reported | PASS | PASS | PASS | PASS | PASS | PASS | PASS | 49 s, not reported | `macro-title-xss-regression` |
| 2026-11-09 | codex | 0.160.0 | CLI default, not reported | PASS | PASS | PASS | PASS | PASS | PASS | PASS | 44 s, not reported | `macro-title-xss-fix-validation` (draft of the reframed rule 6) |
| 2026-11-09 | claude | 2.1.319 | claude-opus-5-5 | PASS | PASS | PASS | PASS | PASS | PASS | PASS | 73 s, $0.25 | `fix-scope-vs-reported-payload` (draft of the reframed rule 6) |
| 2026-11-09 | claude | 2.1.319 | claude-opus-5-5 | PASS | PASS | PASS | PASS | PASS | PASS | PASS | 79 s, $0.26 | `fix-covers-vulnerability-class` (reframed rule 6) |
| 2026-11-09 | codex | 0.160.0 | CLI default, not reported | PASS | PASS | PASS | PASS | PASS | PASS | PASS | 44 s, not reported | `macro-title-xss-fix-coverage` (reframed rule 6) |
| 2026-11-09 | codex | 0.160.0 | CLI default, not reported | PASS | PASS | PASS | PASS | PASS | PASS | PASS | 47 s, not reported | `macro-title-xss-remediation-coverage` (rule 6 without remedies) |
| 2026-11-09 | claude | 2.1.319 | claude-opus-5-5 | PASS | PASS | PASS | PASS | PASS | PASS | PASS | 79 s, $0.25 | `fix-scope-vs-reported-payload` (rule 6 without remedies) |

With `claude`, a day took 5–35 seconds and $0.01–0.10; the first run predates cost in the journal, and the fourth ran after the review fixes (redaction, no-tool proof, process groups). With `codex`, a day took 5–12 seconds; all three runs used the judge with the tool features disabled. The last four rows ran after the Improvements were reframed (below).

**A person's verdict (2026-11-09).** The user reviewed the Improvements of the first seven runs and accepted their wording and content: independent verification of a security fix before the finding is marked resolved at its source. The user also confirmed the scenario as it is, with its two cases, F-17 and DAST-301.

What the first seven runs showed beyond the checks:

- `claude` saw the weak fix before the scan did. In every run it proposed a first Improvement on D3, because PR #88 only strips `<img>` and CI ran no security test, and refined or added Improvements on D4 and D5; on D6 it updated them with the scan as new evidence, or proposed another (reopen the original finding when a scan bypasses its fix). The changes it proposed: encode output at the sink instead of filtering tags, a regression test with bypass payloads, no resolving at the source before a security sign-off or retest, and release review for candidates that carry an unchecked security fix.
- `codex` was terser. Twice it proposed its Improvement only on D6, from the scan; once on D3, updated on D6 with the scan. All three ask for regression tests with executable markup beyond `<img>` (SVG named); two ask for the fix to be checked against the original sink, or by security, before the report is resolved at its source; one asks for escaping or sanitizing for the rendering context.
- The D6 check therefore accepts an update as well as a new Improvement.
- No run proposed reopening F-17. On D5 every `claude` run linked the release candidate to the resolved F-17 as evidence; every `codex` run proposed nothing. Both leave the day quiet.
- On D6 every run of both judges also asked for `security_review` on DAST-301. The core refused it with `ATTENTION_GATE_NOT_MET`, the rule `unknown` because no Bugcrowd row lists DAST-301, and the report shows the refusal as audit context.

**Improvements reframed (2026-11-09).** After that verdict the user set the principle: Attentions identify where action is needed; Improvements identify where something could work better. An Improvement is an evidence-grounded observation of a possible gap in how the work is done, not a confident prescription or a redesign of the workflow. Rule 6 of the prompt now says so, and asks for the gap in how the work is done, not what happened in one case, stated no more certainly than the evidence. The scripted D6 Improvement went from "re-test the fixed build against the reported sink … before resolving" to "Security findings may be closed before fixes are independently verified", citing F-17's report, fix and resolution and the DAST-301 scan. The core, the scenario, the Attentions and the checks are unchanged.

What the last four runs showed:

- With the reframed rule, `claude` proposed one Improvement on D3 and updated it on D4–D6: "Security fixes may be checked only against the reported payload, not the whole vulnerability class", and on D6, with the scan, "Injection fixes can count as done and be resolved at source without being checked against the whole vulnerability class". Its change says what could be checked before a report is resolved, with "could", but still gives an example of how ("For example, check any element or attribute that can run script where the title is displayed").
- With the reframed rule, `codex` proposed one Improvement on D6: "Macro title XSS fixes may cover too few payload forms", change "Security fixes could cover the range of executable markup accepted in macro titles more completely". Hedged, but about the one sink rather than how findings are closed.
- The two draft runs used rule 6 without "not what happened in one case". Both hedged ("may", "could"), and both titled the Improvement after the one case: "The F-17 fix may cover only the reported payload, not the whole XSS weakness" (`claude`, D3; its updates on D4–D6 stayed about F-17) and "Macro title XSS validation may miss alternative payloads" (`codex`, D6). That clause was added for it.

**The user's wording, and no remedies (2026-11-09).** The user then chose the wording of the scripted D6 Improvement: "Security fixes may be closed without sufficient verification", because "a previously resolved security finding was detected again during a pre-release scan. This suggests a potential gap in how the effectiveness of security fixes is verified before findings are closed." Its change names only what could work better. Because the reframed runs still said how ("For example, check…"), rule 6 now also asks for what could work better, not how, and to propose no new step, check, tool, workflow, rule, signal or Responsibility; it calls Attentions action needed now, in one case, and Improvements how the work is done. The scenario, its two cases F-17 and DAST-301, the Attentions, the lifecycle and the checks are unchanged.

What the last two runs showed, with that rule:

- `claude` proposed one Improvement on D3 and updated it on D4–D6. On D6, with the scan: "Fixes for findings can cover only the reported payload, not the whole weakness class"; change "Before a finding counts as fixed, and before its fix ships in a release, there could be more confidence that the merged change covers the whole weakness class … not just the exact payload the reporter sent"; rationale ending "This suggests a finding can be counted as fixed, and its fix put in a release candidate, while the weakness class is still exploitable." It no longer says how to check.
- `codex` proposed one on D6: "XSS remediation coverage may miss alternate payloads"; change "Completeness of remediation for script execution through macro titles could work better"; rationale ending "This suggests remediation coverage may have been narrower than the underlying vulnerability." No remedy, but still about the one sink.
- Both still asked for `security_review` on DAST-301 on D6, refused as before.

### `support-handoff`

| Date | Judge | CLI | Model | D1 | D2–D4 quiet | D5 | One case, with Engineering's ticket | D6 | Improvement | Every day | Secrets | Time, cost | Improvements |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-09 | codex | 0.160.0 | CLI default, not reported | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | 52 s, not reported | `handoff-progress-and-customer-updates` (D6) |
| 2026-11-09 | claude | 2.1.319 | claude-opus-5-5 | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | 70 s, $0.27 | `handover-pickup-visibility` (D4), `customer-updates-while-waiting-on-other-team` (D5), both updated through D6 |

Both runs used the rule 6 above. They ran when the one-case check looked at D5 only; it now holds on every day, and both journals show the same: one case opened, SUP-1042 on D1, and no other. What they showed beyond the checks:

- Both held back on D2–D4 and escalated on D5, each giving the reason in the case's own terms: `codex` "The engineering ticket remains unassigned and unchanged, and the customer has gone more than three days without an update"; `claude` "ENG-311 has had no assignee and no change since 2026-11-03, and the customer hasn't heard from us since 2026-11-03 08:40, more than three days ago". Both closed the escalation on D6 because the case was moving again and the customer had been updated, and left SUP-1042 open.
- Both linked Engineering's ticket to SUP-1042 on D2, and neither opened a second case for ENG-311. The core refused nothing in either run.
- `codex` proposed one Improvement on D6: "Continuity after engineering handoff may be falling short"; change "Maintaining case progress and timely customer updates while engineering owns the investigation could work better"; rationale ending "suggesting a gap in continuity after handoff". It names no remedy.
- `claude` proposed one on D4, before the escalation, and a second on D5, and updated their rationale with each new day: "Cases handed to engineering may sit without an owner on the engineering side, and support may not see it", and "Customer updates may pause while a case waits on another team". Each rationale says what the snapshots show, then what that suggests ("This suggests …"; on D4, "This is one case, but it suggests …"). Their changes say what could work better ("Support could see more clearly, and sooner, whether a case handed to engineering has been picked up"); neither proposes a step, tool, rule, signal or Responsibility.

## Out of scope

API adapters and real Slack or webhook delivery; resume, until or from; a person's decision on an Improvement; a multi-file store or compare-and-set; a website for the simulation; scenarios beyond these two; delivery to an agent; acting on an Improvement, such as changing a Responsibility or adding a signal.
