# Simulation

The simulation runs one Responsibility through the core for six days, one day at a time, with a live LLM as the judge. It shows what the core decides and what it leaves to the model: cases, Attentions and their deliveries, and an Improvement the model finds on its own.

```sh
npm run simulation -- --judge claude|codex [--model <name>] [--pause]
```

- `--judge` — `claude` runs `claude -p`, `codex` runs `codex exec`. Each CLI uses its own login; the simulation reads no secrets.
- `--model` — passed to the CLI; without it the CLI's default model judges.
- `--pause` — waits after each day: Enter goes on, `q` stops, and the journal records the run as stopped. It needs an interactive terminal and exits before D1 without one.

There is no other option: no replay judge on the command line, no resume, no stopping at a given day. A run that crashed is started again from D1, in a new run directory.

## A day

Each day's observations arrive at 09:00Z and the judge answers at 18:00Z. Every day, `view` and `step` get **every observation from D1 through that day**, so the closing and `when` rules can read an earlier day's facts.

1. The day's observations join the earlier ones, and each is journaled as a `signal`.
2. `view`, then the prompt: the View rendered as text with general rules only (`simulation/prompt.ts`). It names nothing of the scenario and shows no rule, only each attention type's description and whether it is checked and routed.
3. The judge answers in the structured format of `simulation/judge-schema.json`.
4. `simulation/parse.ts` maps the answer to an `Evaluation` and validates it with the core's schema. An answer that cannot be used gets one retry, with the error. If that fails too, the day is `judge_failed`: `step` is not called, the state stays as it was, and the day shows FAILED. There is no scripted fallback.
5. `step`, then each delivery is written to the inbox.
6. A trace check: all evidence of every case and Improvement must be a journaled `signal`, byte for byte, and every Attention event and delivery must belong to a case. A violation fails the day.
7. The day's report: the context sent, the judge's answer, each proposal taken or refused with its code and trace, Attention events with each rule's result, deliveries and Improvements.

## The scenario: `simulation/scenario/security-fix/`

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
| D6 | Pre-release scan DAST-301 of `3.2.0-rc1` at `d00d2b7`: same CWE, location, parameter and sink, payload `<svg/onload=…>`, executed on page view, `open` | Opening `release_review` on DAST-301 passes with both rules `met`; one delivery to `release-review`. Reopening F-17 is refused (`REOPEN_WHILE_CLOSING_MET`): its source still says resolved | Open case DAST-301 citing the scan, and `release_review`. Infer that the build contains the fix and the same sink is still exploitable. Propose an Improvement, citing the scan and F-17's earlier evidence |

A refusal is audit context only: the report shows it, and nothing cites it. An Improvement cites observations only, never a case or a refusal; which change it proposes is the model's.

`scripted.json` holds a judge's answers written by hand, one per day. Only the tests use it.

## What a run leaves: `simulation/runs/<run id>/`

- `journal.jsonl` — the one append-only journal: `run_started` (judge, model, flags, digests of the prompt template, the judge schema and the scenario), `signal`, `context` (basis and the full prompt), `judge_output` (raw output, parsed evaluation, duration, exit code, the no-tool proof, CLI version and model), `judge_failed`, `step` (every list of the step result, refusals with their traces), `delivery`, `trace_check`, `run_stopped`, `run_finished` (status, failed days, checks). Every history and check result is a view over it.
- `inbox.md` — the single delivery sink, one block per delivery, labelled with its route. Nothing is posted anywhere else: no Slack, no webhook.
- `report.md` — what the console showed, and the checks.

Everything written or printed is redacted first: the exact values of environment variables whose names contain `KEY`, `TOKEN`, `SECRET` or `PASSWORD` (8 characters or more), as they stand in text and as they stand escaped inside JSON, up to four levels deep (a CLI's event line carrying a message whose text is JSON, kept as a raw string in the journal), and common key patterns. Journal entries are redacted string by string before they are serialized. Each run plants a random value in `RESPONSIBILITIES_SIMULATION_CANARY_TOKEN` and fails if it, or any such value, appears in the run directory, in either form or in the decoded journal.

**Deliveries, exactly.** The core returns a delivery only for an opening or reopening of a routed type, with id `H([case_id, type, activation])`. The simulation writes each id to the inbox once per run, using an in-memory set. There is no crash safety and no at-most-once claim across process restarts.

## The checks

At the end of a run, `simulation/scenario/security-fix/checks.ts` decides what code can:

- D1: case F-17 opens; `security_review` opens with its check `met`; exactly one delivery, to `security-oncall`.
- By D4: `security_review` is closed.
- D4: F-17 is resolved with its closing check met; `assess` is `unknown`.
- D5: quiet.
- D6: case DAST-301 opens citing the scan; `release_review` opens on it with both rules `met`; exactly one delivery, to `release-review`; an Improvement cites the scan and an F-17 observation from D1–D4.
- Every day: a usable answer, trace checks pass, no tool ran; all six days ran; no secret value in the run directory.

Whether the Improvement proposes a sensible, evidence-backed change is for a person to judge from the report. A failed check or day makes the run FAILED and the exit code 1.

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

### `codex` (codex-cli 0.160.0, not yet verified)

```
codex exec --skip-git-repo-check --sandbox read-only --ephemeral --ignore-user-config --ignore-rules \
  -c project_doc_max_bytes=0 -c 'history.persistence="none"' --json --color never [-m <m>] \
  --output-schema <file> --output-last-message <file> -C <empty dir> -      # rules and prompt on stdin
```

These flags are the ones `codex exec --help` lists for codex-cli 0.160.0. Their behaviour is **not verified**: in the environment this was built in, every `codex` command needs an approval that was not available, and a nested probe from another Codex session failed in its sandbox before any model call ("failed to initialize in-process app-server client"). The judge's no-tool proof is that the JSONL events carry no item other than `agent_message` or `reasoning`; the answer is read from `--output-last-message`.

No flag stops Codex from reading an `AGENTS.md` or `AGENTS.override.md` in its home (`CODEX_HOME`, else `~/.codex`), and its login lives in that home too, so the judge does not swap in an empty one. Instead it refuses to start while either file exists there, before D1, and names the file. `project_doc_max_bytes=0` keeps project documents out; it is documented, but unproved here.

The tests check both judges against fake `claude` and `codex` executables first on `PATH`: the arguments, stdin, the empty temporary directory, the no-tool proof, timeouts and failures.

## Tests

`npm test` runs the simulation's tests with the core's, with no network and no real CLI: the scripted six-day arc through the replay judge (every check above passes, D5 is quiet, D6's refusal is recorded, two runs give identical state digests), the prompt (every observation so far, no rule, no scenario word in the template), parsing and the retry, the judges against fakes, redaction and `--pause`.

## Live results

Each live run is one row; a criterion is PASS or FAIL as `report.md` gives it. The columns are the checks above; "every day" is a usable answer, trace checks and no tool, on all six days; "secrets" is the planted value absent from the run directory.

| Date | Judge | CLI | Model | D1 | By D4 | D4 | D5 quiet | D6 | Every day | Secrets | Time, cost | Improvements cited on D6 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-09 | claude | 2.1.319 | claude-opus-5-5 | PASS | PASS | PASS | PASS | PASS | PASS | PASS | 112 s, not recorded | `hold-release-on-unverified-security-fix`, `verify-xss-fix-before-resolve` |
| 2026-11-09 | claude | 2.1.319 | claude-opus-5-5 | PASS | PASS | PASS | PASS | PASS | PASS | PASS | 104 s, $0.28 | `xss-fix-verification` |
| 2026-11-09 | claude | 2.1.319 | claude-opus-5-5 | PASS | PASS | PASS | PASS | PASS | PASS | PASS | 98 s, $0.28 | `xss-fix-verification`, `reopen-original-on-fix-bypass` |
| 2026-11-09 | claude | 2.1.319 | claude-opus-5-5 | PASS | PASS | PASS | PASS | PASS | PASS | PASS | 92 s, $0.26 | `verify-fix-before-resolving-at-source`, `xss-fix-at-sink-with-variant-tests`, `release-gate-covers-unverified-resolutions` |
| — | codex | 0.160.0 | — | not run | | | | | | | | every `codex` command needs an approval that was not available |

A day took 5–35 seconds and $0.01–0.10; the first run predates cost in the journal, and the fourth ran after the review fixes (redaction, no-tool proof, process groups). Whether each Improvement proposes a sensible change is still for a person to judge from the runs' reports.

What the runs showed beyond the checks:

- The model saw the weak fix before the scan did. In every run it proposed a first Improvement on D3, because PR #88 only strips `<img>` and CI ran no security test, and refined or added Improvements on D4 and D5; on D6 it updated them with the scan as new evidence, or proposed another (reopen the original finding when a scan bypasses its fix). The D6 check therefore accepts an update as well as a new Improvement. The changes it proposed: encode output at the sink instead of filtering tags, a regression test with bypass payloads, no resolving at the source before a security sign-off or retest, and release review for candidates that carry an unchecked security fix.
- It never proposed reopening F-17. On D5 every run linked the release candidate to the resolved F-17 as evidence, which leaves the day quiet.
- On D6 every run also asked for `security_review` on DAST-301. The core refused it with `ATTENTION_GATE_NOT_MET`, the rule `unknown` because no Bugcrowd row lists DAST-301, and the report shows the refusal as audit context.

## Out of scope

API adapters and real Slack or webhook delivery; resume, until or from; a person's decision on an Improvement; a multi-file store or compare-and-set; a website for the simulation; other scenarios; delivery to an agent.
