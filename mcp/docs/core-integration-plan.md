# Plan: responsibilities-core als einzige Decision Engine im Responsibilities MCP

Status: **Umgesetzt (P0–P3), Schnitt (P4) steht aus.** Version 3, 2026-11-23, freigegeben als
`39cd0ee`. Umsetzung: Branch `responsibilities-core-mcp-integration`; was der Plan offen ließ,
steht in §13. Keine Produktionsmigration, kein Deployment.

**Produktentscheidung des Auftraggebers (2026-11-23):** Der MCP wurde bisher nur einmal für zwei
Responsibilities genutzt. Alle bisherigen Domänendaten (Responsibilities, Versionen, Runs, Fälle,
Beobachtungen, Entscheidungen) sind unwichtig und werden beim Schnitt verworfen. **Clean Slate**
statt Alt-Migration (§5, §9). Workspaces, Mitgliedschaften, OAuth und die Migrations-Historie
bleiben unverändert.

Version 2 (`1c84c15`) war freigegeben. Version 3 ändert Migration, Schnitt und Rückweg materiell.

Zielrepository: `vicox/responsibilities` auf `origin/main` = `84f47dd`. Alle Pfade unten sind
relativ zu diesem Repository (`src/` = Core, `mcp/` = MCP-Server). Diese Datei ersetzt
Entscheidung D11 (`mcp/docs/implementation-plan.md`, §14). Zeilenangaben beziehen sich auf den
Stand `84f47dd` vor der Umsetzung.

Grundlage sind die vorangegangenen Analysen: Nutzung des Core (keine), Integrationsweg, und die
Prüfung Tool für Tool. Kennzeichnung: **[F]** = im Code belegt, ohne Kennzeichnung = Entscheidung
dieses Plans.

---

## 0. Ziel, Grenzen, Nicht-Ziele

**Ziel.** Der MCP ist **Host** im Sinne von `README.md:173–202`. Er verantwortet Auth,
Workspaces, Runs, Speicherung, Lookback, Uhr und die Tool-Oberfläche. Jede fachliche Entscheidung
über Fälle, Status und Attentions trifft ausschließlich `responsibilities-core` (`view`, `step`).
Der Judge ist echt an die View gebunden (`basis`). Die eigene Entscheidungssemantik des MCP
verschwindet vollständig.

**Nicht-Ziele (v1).**
- Keine Improvements, Deliveries, `command` oder `assess` über Tools. Der Core kann sie; sie werden
  nicht freigeschaltet.
- Kein Kompatibilitätsmodus für die alten Tool-Verträge.
- Keine Übernahme, Konvertierung, Archivierung oder Auswertung alter Domänendaten. Sie werden beim
  Schnitt verworfen (Produktentscheidung, siehe oben).
- Keine neuen Run-Regeln über den heutigen Lebenszyklus hinaus.

**Fakten, auf denen der Plan beruht [F]:**
- **Der MCP importiert den Core nicht.** `mcp/package.json:21–30`, Plan D11.
- **Core-API:** `view`/`step` (`src/core.ts:120–143`, `:164–403`); `basis`-Bindung (`:107–115`,
  `:185–194`); Evidenz nur als Beobachtungs-id (`:197`, `:222–224`); Status-Gate (`:247–280`);
  Attention-Gates (`:288–335`).
- **Host-Pflichten:** `README.md:190–202`. Lookback (b) und (c) sind Pflicht (`:218–224`). Die
  `basis` wird so genutzt, wie `view` sie liefert (`:226`).
- **Run-Lebenszyklus auf `main`:** Übernahme nach 10 min Inaktivität, Obergrenze 2 h, `supersede`
  (`mcp/lib/responsibilities/store.ts:452–477`, `:624–705`; `model.ts:12`, `:19`).
- **Packaging:** Der Core ist `private`, exportiert nur `dist` (`package.json:2–16`). Der MCP ist
  ein eigenes Paket. `mcp/next.config.ts` setzt `turbopack.root` und `outputFileTracingRoot`
  **bewusst auf `mcp/`**. Vercel Root Directory ist `mcp` (`mcp/README.md:111–112`).

---

## 1. Festgelegte Entscheidungen

| ID | Entscheidung | Begründung |
| --- | --- | --- |
| C1 | Der Core ist die einzige Decision Engine. Aus `mcp/lib/responsibilities/model.ts` fallen `checkDecision`, `transition`, `carryUnknowns`, `diffFacts`, `checkAssessments`, `contentHash`, `canonicalJson`/`sameJson`, `normaliseSources`, `groupOf`, `subjectKey`, `checkUniqueSubjects` weg. | kein Doppelmodell |
| C2 | Acht Tools: die sieben heutigen plus `view_run`. | echte `basis`-Bindung (`README.md:108`, `:192`) |
| C3 | Semantischer Bruch: neue Verträge für `put_responsibility`, `record_observations`, `complete_run` und die Lese-Ausgaben. Kein Adapter, der alte Felder abbildet. | Ein Adapter müsste MCP-Regeln nachbauen (Analyse Tool für Tool) |
| C4 | Run-Lebenszyklus und Berechtigung bleiben wie auf `main`. `view_run` erneuert die Lease. `complete_run` verlangt eine vorherige View. | Host-Sache; schon getestet |
| C5 | Bindung über einen gespeicherten View-Snapshot (`runs.view_now`, `runs.view_basis` = die ausgelieferte `basis`). Jede ändernde Aufzeichnung macht den Snapshot ungültig. `complete_run` verlangt `evaluation.basis = view_basis` und prüft, dass dieselbe View aus den aktuellen Eingaben wieder genau `view_basis` ergibt, bevor `step` läuft. | Echo der ausgelieferten `basis`; Änderungen nach der View werden erkannt; leere Proposal-Liste ist abgedeckt (4.3, 4.4, 4.6) |
| C6 | Lookback (a) = nur der aktuelle Run. (b) und (c) aus dem Speicher, wie verlangt. | kleinster zulässiger Umfang (`README.md:218–224`) |
| C7 | **Clean Slate.** Migration `responsibilities` v3 verwirft die sechs Domänentabellen des Moduls und legt das neue Schema leer an (§5.2). Unverändert bleiben die Module `workspace` und `oauth` sowie `schema_migrations` (§5.1). Kein Bestandscheck, keine Konvertierung, kein Produktionsklon. Die bisherigen zwei Responsibilities legt eine Person nach dem Schnitt mit Core-Definition neu an. | Produktentscheidung: alte Domänendaten sind unwichtig. Das Schema bleibt frei von Alt-Spalten und Übergangsfällen. |
| C8 | Geroutete Attention-Typen (`delivery`) und Erfolgskriterien (`success`) werden in v1 verweigert. | ohne Outbox ist Pflicht 3 nicht erfüllbar; ohne `assess` wären Erfolgskriterien tote Konfiguration |
| C9 | Packaging: erster Kandidat ist der Import der Core-**Quellen** über eine einzige Importstelle. Ausweichvariante ist eine Build-Kopie. Entscheidung in Phase P0 nach festen Kriterien. | `turbopack.root` ist heute auf `mcp/` festgelegt |
| C10 | Eine CI-Prüfung für Core und MCP gemeinsam. | Core-Änderungen wirken künftig ohne Versionsgrenze in der Produktion |

---

## 2. Zielarchitektur und Modulgrenzen

```
agent ──MCP──► mcp/lib/mcp/server.ts          8 Tools, Zod, Limits, Refusals
                 │
                 ▼
               mcp/lib/responsibilities/store.ts   Host: Transaktionen, Sperren, Run-Lebenszyklus,
                 │                                  Compare-and-Set, Lesemodelle
                 ├─► mcp/lib/responsibilities/host.ts   NEU, rein: Zeilen → Observation,
                 │                                      Lookback-Auswahl, Definition prüfen,
                 │                                      Ausgaben aus Core-Typen formen
                 ▼
               mcp/lib/core.ts                    NEU: einzige Importstelle für den Core
                 │
                 ▼
               src/index.ts (responsibilities-core) view, step, digest, InputError, Typen
```

- `host.ts` enthält **keine** Fachregel. Er formt Daten um und wählt Beobachtungen nach
  `README.md:218–224` aus.
- `model.ts` schrumpft auf Limits, `Refusal` und die Prüfung der Zeilen (Größe, Typen, NFC).

---

## 3. Tool-API v2

Gemeinsames:
- `answer()`/`attempt()` bleiben (`server.ts:307–326`).
- `DATA_RULES` bleibt, ergänzt um: „`title`/`summary` sind frühere Einschätzungen, keine Wahrheit“.
- Das neue Refusal `invalid_input` übersetzt einen `InputError` des Core.

### 3.1 `get_server_info()`

Unverändert (`server.ts:142–158`).

### 3.2 `put_responsibility`

```ts
{ key, title,                                   // title: Anzeige auf Host-Seite
  definition: {
    identity: { subject_type, subject_keys: string[1..3] },
    accountable: string, expectations: string,  // expectations Pflicht (1–8000)
    include: string[1..10],                     // Beobachtungsarten
    closing: Criterion[],                       // Core-Schema
    success: [],                                // v1: nur leer
    attention_types: [{ key, description, when?: Rule[] }]   // v1: ohne delivery
  } }
→ { key, version, changed, previous_version }   // unverändert
```

**Prüfung:**
1. Zod für Form und Limits auf Host-Seite.
2. `delivery` ⇒ `delivery_unsupported`; `success.length > 0` ⇒ `success_unsupported`.
3. Fachliche Gültigkeit über `view(fullDefinition, null, [], now)` aus dem Core. Ein `InputError`
   wird zu `invalid_definition`. Das deckt Schema, `match` auf unbekannte Schlüssel und doppelte
   Typen ab (`src/core.ts:39–70`).

**Identität:** Gibt es bereits eine Version, müssen `identity.subject_type` und die Menge von
`subject_keys` gleich bleiben, sonst `identity_change` (Folge aus `src/core.ts:74`). Nach dem Clean
Slate ist jede Version eine Core-Version; Alt-Versionen gibt es nicht.

**Gespeichert wird:**
- `definition = {...input, id: responsibility.id, version}`
- `content_hash = digest({ title, definition ohne id und version })` mit `digest` aus dem Core.
  `title` gehört zum Vergleich, wie heute (`model.ts`, `contentHash`). Eine reine Titeländerung
  ergibt eine neue Version mit `changed: true`, nicht einen stillen No-op. Die Core-Definition ist
  dabei bis auf `version` gleich, also gibt es keine Auswirkung auf den State.

**Berechtigung:** jedes Mitglied (D7, unverändert).

### 3.3 `get_responsibility({ key })`

```ts
→ { responsibility: { key, title, version, definition, version_created_at },
    last_run, in_progress,                     // RunSummary wie heute, ohne sources
    cases: [{ case_id, subject: {type, keys}, status, episode,
              title, summary,                  // frühere Einschätzung
              attentions: [{ type, opened_at, activation }],   // nur offene
              evidence: string[], first_observed, last_observed }],
    open_case_count, truncated }
```

- **Fälle:** nur `status = open`. Zuerst die mit offener Attention, sortiert nach ältestem
  `opened_at`, dann nach `canonical(subject.keys)`. Höchstens 1000.
- `include_facts` entfällt.
- Vor dem ersten Step gibt es keinen State: `cases: []`.

### 3.4 `start_run({ responsibility, agent, supersede? })`

- Eingabe und Lebenszyklus sind unverändert (`server.ts:204–226`, `store.ts:624–705`).
- Ausgabe: `{ run_id, started_at, expires_at, run_limit, expectation_changed_since_last_run, include,
  attention_types, cases }`. Das ist Orientierung für das Sammeln, **keine View und keine
  `basis`**.

### 3.5 `record_observations`

```ts
{ run_id,
  observations: [{ kind, complete: boolean, replace?: boolean,
                   rows: Array<Record<column, Scalar | null | string[]>> }] }
→ { run_id, observations: [{ kind, id: "<run_id>:<kind>", rows: number, complete }] }
```

- `kind` muss in `include` der Run-Version stehen, oder in einer Regel der Definition vorkommen.
  Sonst `unknown_kind`.
- `complete` ist pro `(run, kind)` mit der ersten Angabe festgelegt. Weicht es ab:
  `observation_conflict`. Das ist das heutige `sources_conflict`, nur pro Art.
- **Zeilen werden als Menge geführt**, Schlüssel ist `digest(row)`. Ein Retry mit denselben Zeilen
  ändert nichts: weder Zeilen noch `recorded_at` noch den View-Snapshot. `replace: true` leert
  vorher die Zeilen dieser Art in diesem Run.
- `run_observation_kinds.recorded_at` wird nur gesetzt, wenn sich Zeilen oder die Art dieser
  Beobachtung tatsächlich ändern.
- **Limits:**
  - höchstens 200 Zeilen pro Aufruf, 1000 pro Art und Run, 10 Arten pro Run;
  - höchstens 50 Spalten pro Zeile, Spaltenname `^[a-z][a-z0-9_]{0,59}$`;
  - Werte: String ≤ 500, endliche Zahl, boolean, `null`, `string[]` ≤ 50 Einträge;
  - **NFC wird verweigert, nicht normalisiert** (Core-Prinzip, `README.md:199`): `not_nfc`.
- Eine Spalte für jeden Subjektschlüssel ist nicht Pflicht. Zeilen ohne alle Schlüsselspalten
  verbinden sich nur nicht mit einem Subjekt (`src/criteria.ts:40–41`).
- Run-Prüfungen und Lease-Erneuerung wie heute (`lockOwnRun`, `renew`).
- **Ein ändernder Aufruf nach `view_run` ist erlaubt.** Er setzt in derselben Transaktion
  `runs.view_now` und `runs.view_basis` auf `NULL`. Ein danach mit der alten `basis` eingereichtes
  `complete_run` wird verweigert (4.4). Ein Retry ohne Änderung lässt den Snapshot stehen.

### 3.6 `view_run({ run_id })` (neu)

```ts
→ View   // exakt core.view(definition(run.version), state, observations, view_now)
```

- Nur der Eigentümer des Runs darf es aufrufen (`lockOwnRun`).
- Speichert den Snapshot `runs.view_now` und `runs.view_basis` (die ausgelieferte `basis`) und
  erneuert die Lease.
- **Idempotent mit stabilem `view_now`:** Ist ein Snapshot gespeichert und ergibt dieselbe View
  mit dem gespeicherten `view_now` wieder `view_basis`, wird genau diese View erneut geliefert,
  ohne neue Uhrzeit. Nur ohne gültigen Snapshot wird ein neues `view_now` bestimmt (4.3).

### 3.7 `complete_run`

```ts
{ run_id, outcome: "completed" | "partial" | "failed", summary?, report?,
  evaluation?: { basis, proposals: Proposal[] } }      // Proposal = Core-Schema, ohne improvements
→ { run_id, outcome, completed_at, basis, transitions, attention_events, rejections,
    state_digest, already_completed? }
```

- Die Proposal-Form folgt `src/schema.json:166–190`, mit Limits auf Host-Seite:
  - höchstens 1000 Proposals, `cites` ≤ 20, `title` ≤ 120, `summary` ≤ 1000;
  - `attentions` ≤ 20, `reason` ≤ 300.
- `evaluator` setzt der Host aus `run.agent.name`.
- `evaluation` ist Pflicht für `completed` und `partial`, verboten bei `failed`. Bei `failed` ist
  `summary` Pflicht; es läuft kein `step`.
- **Refusals:**
  - `view_required`: kein gültiger Snapshot (nie `view_run`, oder danach geändert);
  - `basis_mismatch` mit `{expected: view_basis, received}`: Echo passt nicht zur ausgelieferten
    `basis`; der Run bleibt offen;
  - `view_stale`: dieselbe View ergibt aus den aktuellen Eingaben nicht mehr `view_basis`
    (Absicherung); der Run bleibt offen;
  - `invalid_input`;
  - `state_conflict` (Compare-and-Set fehlgeschlagen);
  - dazu die bestehenden `unknown_run`, `run_not_yours`, `run_abandoned`, `run_expired`.
- **Rejections des Core** sind Daten im Ergebnis und kein Refusal.
- Replay über `runs.completion` wie heute.

### 3.8 `get_case({ responsibility, keys, limit? })`

```ts
→ { case_id, subject, status, episode, title, summary, attentions, evidence,
    history: [{ run: RunSummary, at, transitions, attention_events,
                proposal: Proposal | null, cited: string[] }] }   // neueste zuerst
```

`case_id = digest({definition_id, subject_type, keys})` (`docs/reference.md:98`). Unbekannt:
`unknown_case`.

### 3.9 Beispiel eines Agenten-Runs (Bugcrowd)

Definition: `include: ["bugcrowd", "review", "implement", "recently_closed"]`, Identität
`{subject_type: "bugcrowd_submission", subject_keys: ["submission"]}`, Attention-Typen
`needs_work`, `review` (mit `when` auf `review`), `verify`, `ready_to_close`. Als Closing eine
Regelliste aus vier `absent`-Regeln (`scope: all`). Das ist zulässig; nur eine `any_of`-Route darf
`absent` tragen (`src/core.ts:60–63`).

```jsonc
// 1 start_run → { run_id: "r9", cases: [{ case_id: "c1…", subject: { keys: { submission: "7f3c" } },
//                 attentions: [{ type: "review", opened_at: "2026-11-24T09:00:00.000Z", activation: 1 }] }] }
// 2 record_observations
{ "run_id": "r9", "observations": [
  { "kind": "bugcrowd", "complete": true, "rows": [{ "submission": "7f3c", "state": "TRIAGED" },
                                                   { "submission": "91aa", "state": "NEW" }] },
  { "kind": "review", "complete": true, "rows": [] },
  { "kind": "implement", "complete": false,
    "rows": [{ "submission": "7f3c", "ticket": "ABC-1", "status": "In Progress" }] },
  { "kind": "recently_closed", "complete": true, "rows": [] } ] }
// 3 view_run → { basis: "5e1…", observations: [r9:*, r8:review (b)], cases: [c1 …],
//               attention_types: [{ key: "review", checked: true, routed: false }, …], closing: […] }
// 4 complete_run
{ "run_id": "r9", "outcome": "partial", "summary": "implement search incomplete",
  "evaluation": { "basis": "5e1…", "proposals": [
    { "subject": { "type": "bugcrowd_submission", "keys": { "submission": "7f3c" } }, "status": "open",
      "cites": ["r9:review", "r9:implement"], "summary": "FIND-12 left Review; ABC-1 in progress",
      "attentions": [{ "type": "review", "intent": "close", "reason": "FIND-12 no longer in Review" },
                     { "type": "needs_work", "intent": "open", "reason": "Fix ABC-1 (Ann)" }] },
    { "subject": { "type": "bugcrowd_submission", "keys": { "submission": "91aa" } }, "status": "open",
      "cites": ["r9:bugcrowd"], "attentions": [{ "type": "needs_work", "intent": "open", "reason": "Triage 91aa" }] } ] } }
// → transitions: c1 updated, c2 opened; attention_events: c1 review closed, c1/c2 needs_work opened; rejections: []
```

Hätte der Judge `resolved` für `7f3c` vorgeschlagen, käme `CLOSING_NOT_MET` zurück: `bugcrowd`
listet `7f3c` noch, und `implement` ist unvollständig, also `unknown` (`src/criteria.ts:44–45`).

---

## 4. Host-Abläufe

### 4.1 Beobachtungen aus den Zeilen eines Runs (rein, `host.ts`)

```ts
buildRunObservations(run, kinds, rows, def, stored): Observation[] =
  kinds.map(k => ({
    id: `${run.id}:${k.kind}`, kind: k.kind,
    // Monotone Host-Zeit: strikt nach der neuesten gespeicherten Beobachtung derselben Art,
    // auch bei rücklaufender Uhr oder gleichem Zeitstempel.
    occurred_at: maxIso(iso(k.recorded_at), plusMs(newestStored(stored, k.kind)?.occurred_at, 1)),
    subjects: subjectsFromRows(rows[k], def.identity),  // sortiert, eindeutig; im Core nur Schema
    rows: sortByDigest(rows[k]),                     // deterministische Reihenfolge
    complete: k.complete }))
```

Während der Run die Sperre hält, kommen keine gespeicherten Beobachtungen hinzu (4.2). Das
Ergebnis ist zwischen `view_run` und `complete_run` daher gleich.

`Observation.subjects` ist im Schema Pflicht, wird von `src/core.ts` und `src/criteria.ts` aber
nicht gelesen [F]. Die Ableitung ist deshalb keine fachliche Entscheidung.

### 4.2 Lookback (rein plus eine Abfrage)

```ts
// newest = Maximum nach Core-Ordnung: occurred_at, bei Gleichstand id
// (exakt wie src/criteria.ts:18–23: String-Vergleich der ids)
selectLookback(state, def, runObs, stored) =
  runObs                                                                 // (a) nur dieser Run
  ∪ { newest(evidenceObs(c, kind)) : c ∈ openCases(state), kind ∈ kinds(evidenceObs(c)) }   // (b)
  ∪ { newest(runObs ∪ stored | kind) : kind ∈ kindsReadByRules(def) ∪ def.include }        // (c)
```

- Die Auswahl setzt **nicht** voraus, dass die Beobachtung des Runs die neueste ist. Sie bestimmt
  die tatsächlich neueste über Run plus gespeicherte Beobachtungen. Dank 4.1 ist das im Normalfall
  die des Runs.
- `stored` = `core_observations` dieser Responsibility. Sie sind unveränderlich, und es kommen
  keine neuen hinzu, solange der Run die Sperre hält.
- **SQL für „neueste pro Art“:** `ORDER BY occurred_at DESC, id COLLATE "C" DESC`. `COLLATE "C"`
  entspricht dem Vergleich in Code-Einheiten des Core; die ids sind ASCII.

### 4.3 `view_run`

```ts
tx: run = lockOwnRun(); refuse abandoned/expired/completed
    def = definitionOf(run.version_id); st = loadState() (state, digest)
    obs = selectLookback(st, def, buildRunObservations(...), stored)
    if run.view_basis != null:                                     // gültiger Snapshot
       v = core.view(def, st, obs, run.view_now)
       if v.basis == run.view_basis: renew(run); return v          // stabil, keine neue Uhrzeit
    view_now = maxIso(clock(), st?.now, max(o.occurred_at for o in obs))
    v = core.view(def, st, obs, view_now)
    update runs set view_now = view_now, view_basis = v.basis; renew(run)
    return v
```

`view_now` ist mindestens `state.now` und mindestens jedes übergebene `occurred_at`. Die Prüfungen
des Core `now ≥ state.now` (`src/core.ts:75`) und „keine Beobachtung nach `now`“ (`:96`) können
deshalb nicht an einer abweichenden Host-Uhr scheitern.

### 4.4 `complete_run`

```ts
tx: run = lockOwnRun(); if run.completion return replay; refuse abandoned/expired
    if outcome = failed: store run completion (ohne step); return
    if run.view_basis == null: refuse view_required
    if evaluation.basis != run.view_basis:                          // Echo der ausgelieferten basis
       refuse basis_mismatch {expected: run.view_basis, received: evaluation.basis}
    def, st0 = loadState() FOR UPDATE (state, digest)
    obs = selectLookback(st0, def, buildRunObservations(...), stored)   // dieselben Funktionen wie 4.3
    v = core.view(def, st0, obs, run.view_now)
    if v.basis != run.view_basis: refuse view_stale                  // Eingaben ohne Invalidierung geändert
    r = core.step(def, st0, obs, { basis: run.view_basis, evaluator: run.agent.name,
                                   proposals: evaluation.proposals }, run.view_now)
    insert core_observations(runObs)                               // eingefroren, unveränderlich
    CAS responsibility_states: update … where state_digest = st0.digest  (insert, falls keiner)
        → 0 Zeilen: refuse state_conflict (Rollback der Transaktion)
    insert core_steps(run_id, version_id, now: view_now, basis, observation_ids, evaluation,
                      result, digest_before, digest_after)
    insert core_step_cases(je case_id aus Transitions, Events und Proposals)
    completion = { …, transitions, attention_events, rejections, state_digest }
    update runs set completed_at, outcome, summary, report, completion
```

### 4.5 Berechtigung (Host)

| Aufruf | Wer |
| --- | --- |
| `put_responsibility`, Lese-Tools | jedes aktive Mitglied des Workspace |
| `record_observations`, `view_run`, `complete_run` | nur der Eigentümer des Runs (Mitglied + Client, `store.ts:427ff`) |

Workspace-Isolation über die Bindung der Sitzung, wie heute. Keine neuen Rollen.

### 4.6 Warum Echo- und Snapshot-Prüfung vor `step` laufen müssen

1. **Leere Proposal-Liste.** Mit leerer Liste und falscher `basis` liefert `step` keine Rejection,
   weil alle Ablehnungen pro Proposal entstehen, und gibt den State unverändert zurück
   (`src/core.ts:187–193`) [F]. Der Host würde das als Erfolg werten. Deshalb vergleicht er
   `evaluation.basis` selbst mit der **ausgelieferten** `view_basis`.
2. **Änderungen nach der View.** Ändernde Aufzeichnungen löschen den Snapshot (3.5), also
   `view_required`. Andere Änderungen (State, gespeicherte Beobachtungen) erkennt der Vergleich
   der wieder erzeugten View mit `view_basis`, also `view_stale`.
3. Beides ist keine Neuberechnung anstelle des Echos. Der Judge muss die ausgelieferte `basis`
   zurückgeben, und der Host prüft zusätzlich, dass sie noch die aktuellen Eingaben bindet.

---

## 5. Datenmodell und Migration (Clean Slate)

### 5.1 Was bleibt, was verworfen wird (Schema auf `main`)

Module in dieser Reihenfolge: `oauth`, `workspace`, `responsibilities` (`mcp/lib/db/schemas.ts:14–18`),
dazu die Tracking-Tabelle `schema_migrations (module, version)` [F].

| Modul | Tabellen | Inhalt | Beim Schnitt |
| --- | --- | --- | --- |
| Tracking | `schema_migrations` | Migrations-Historie | **bleibt**; `('responsibilities', 3)` kommt hinzu |
| `workspace` | `workspaces`, `members` | Workspaces, Mitgliedschaften inklusive gebundener `google_sub` | **bleibt unverändert** |
| `oauth` | `oauth_clients`, `oauth_pending_logins`, `oauth_authorization_codes`, `oauth_refresh_families`, `oauth_refresh_tokens`, `oauth_rate_limits` | registrierte Clients, laufende Logins, Codes, Refresh-Token-Familien | **bleibt unverändert** |
| `responsibilities` | `responsibilities`, `responsibility_versions`, `runs`, `cases`, `observations`, `decisions` | alle Domänendaten (v1, `runs.last_active_at` aus v2) | **verworfen** und mit neuem Schema leer angelegt (5.2) |

Eine eigene Benutzertabelle gibt es nicht. Die Identität ist die Mitgliedschaft (`members`, mit
`google_sub`) [F].

**Fremdschlüssel [F]** (`mcp/lib/responsibilities/schema.ts`):
- Die sechs Domänentabellen verweisen nur untereinander sowie auf `workspaces (id)` (`:15`) und auf
  `members (workspace_id, id)` (`:37`, `:60`). Kein `ON DELETE CASCADE`.
- Keine Tabelle eines anderen Moduls verweist auf sie. OAuth speichert die Mitglieds-id als `text`
  ohne Fremdschlüssel (`mcp/lib/oauth/store/sql.ts:138`, `:152`).
- Das Verwerfen berührt daher weder Workspaces noch Mitgliedschaften noch OAuth.
- **Folge:** Bestehende Verbindungen der Agenten bleiben gültig. Access- und Refresh-Tokens nennen
  die unveränderten Mitglieds-ids; eine erneute Anmeldung ist nicht nötig.

### 5.2 Migration `responsibilities` v3

Datei `mcp/lib/responsibilities/schema.ts`, an `migrations` anhängen. v1 und v2 bleiben unverändert;
ausgelieferte Einträge werden nie geändert.

**Migrationsframework [F]** (`mcp/lib/db/migrate.ts:77–95`): pro Modul und Version wird der
Eintrag geschnappt oder übersprungen, in einer Transaktion zusammen mit der DDL. v3 läuft daher pro
Datenbank genau einmal und ganz oder gar nicht. Eine frische Datenbank durchläuft v1 → v2 → v3 und
endet im selben Schema wie eine aktualisierte.

```sql
-- Clean Slate: verwirft alle Domänendaten des Moduls. Reihenfolge nach Fremdschlüsseln, bewusst
-- ohne CASCADE: Eine unerwartete Abhängigkeit lässt die Migration scheitern, statt still mitzulöschen.
DROP TABLE decisions;
DROP TABLE observations;
DROP TABLE cases;
DROP TABLE runs;
DROP TABLE responsibility_versions;
DROP TABLE responsibilities;

CREATE TABLE responsibilities (                                     -- wie v1
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  key          text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, key));
CREATE TABLE responsibility_versions (                              -- ohne Alt-Spalten
  workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  responsibility_id uuid NOT NULL, version integer NOT NULL CHECK (version >= 1),
  title text NOT NULL, definition jsonb NOT NULL, content_hash text NOT NULL,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, responsibility_id, version),
  FOREIGN KEY (workspace_id, responsibility_id) REFERENCES responsibilities (workspace_id, id),
  FOREIGN KEY (workspace_id, created_by) REFERENCES members (workspace_id, id));
CREATE TABLE runs (                                                 -- ohne sources, mit View-Snapshot
  workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  responsibility_id uuid NOT NULL, version_id uuid NOT NULL, member_id uuid NOT NULL,
  client_id text NOT NULL, client_name text, agent jsonb NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(), last_active_at timestamptz,
  view_now timestamptz, view_basis text,
  completed_at timestamptz,
  outcome text CHECK (outcome IN ('completed', 'partial', 'failed', 'abandoned')),
  summary text, report text, completion jsonb,
  CHECK ((completed_at IS NULL) = (outcome IS NULL)),
  CHECK ((completion IS NOT NULL) = (outcome IN ('completed', 'partial', 'failed'))),
  CHECK ((view_now IS NULL) = (view_basis IS NULL)),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, responsibility_id) REFERENCES responsibilities (workspace_id, id),
  FOREIGN KEY (workspace_id, version_id) REFERENCES responsibility_versions (workspace_id, id),
  FOREIGN KEY (workspace_id, member_id) REFERENCES members (workspace_id, id));
CREATE UNIQUE INDEX runs_one_open ON runs (workspace_id, responsibility_id) WHERE completed_at IS NULL;
CREATE INDEX runs_recent ON runs (workspace_id, responsibility_id, started_at DESC);

CREATE TABLE run_observation_kinds (
  workspace_id uuid NOT NULL, run_id uuid NOT NULL, kind text NOT NULL,
  complete boolean NOT NULL, recorded_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, run_id, kind),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs (workspace_id, id));
CREATE TABLE run_rows (
  workspace_id uuid NOT NULL, run_id uuid NOT NULL, kind text NOT NULL,
  row_digest text NOT NULL, row jsonb NOT NULL,
  PRIMARY KEY (workspace_id, run_id, kind, row_digest),
  FOREIGN KEY (workspace_id, run_id, kind) REFERENCES run_observation_kinds (workspace_id, run_id, kind));
CREATE TABLE core_observations (
  workspace_id uuid NOT NULL, responsibility_id uuid NOT NULL, id text NOT NULL,
  kind text NOT NULL, occurred_at timestamptz NOT NULL, body jsonb NOT NULL, digest text NOT NULL,
  run_id uuid NOT NULL,
  PRIMARY KEY (workspace_id, responsibility_id, id),
  FOREIGN KEY (workspace_id, responsibility_id) REFERENCES responsibilities (workspace_id, id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs (workspace_id, id));
CREATE INDEX core_observations_kind
  ON core_observations (workspace_id, responsibility_id, kind, occurred_at DESC, id COLLATE "C" DESC);
CREATE TABLE responsibility_states (
  workspace_id uuid NOT NULL, responsibility_id uuid NOT NULL,
  state jsonb NOT NULL, state_digest text NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, responsibility_id),
  FOREIGN KEY (workspace_id, responsibility_id) REFERENCES responsibilities (workspace_id, id));
CREATE TABLE core_steps (
  workspace_id uuid NOT NULL, run_id uuid NOT NULL, version_id uuid NOT NULL,
  now timestamptz NOT NULL, basis text NOT NULL, observation_ids text[] NOT NULL,
  evaluation jsonb NOT NULL, result jsonb NOT NULL,
  state_digest_before text, state_digest_after text NOT NULL,
  PRIMARY KEY (workspace_id, run_id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs (workspace_id, id),
  FOREIGN KEY (workspace_id, version_id) REFERENCES responsibility_versions (workspace_id, id));
CREATE TABLE core_step_cases (
  workspace_id uuid NOT NULL, case_id text NOT NULL, run_id uuid NOT NULL,
  PRIMARY KEY (workspace_id, case_id, run_id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES core_steps (workspace_id, run_id));
```

- `runs.last_active_at` bleibt wie in v2 nullable. Der Code für den Run-Lebenszyklus
  (`store.ts:452–477`) bleibt damit unverändert.

**jsonb-Rundreise.** `body` und `state` sind jsonb, die Digests werden aus dem geparsten Wert
berechnet. `canonical` sortiert die Schlüssel (`src/canonical.ts:28`), jsonb erhält Strings und
Zahlenwerte. Ein Test sichert, dass `digest(parse(store(x))) = digest(x)` (P2-T7).

### 5.3 Cutover-Gate

- **Das Gate ist genau eine Handlung:** `DATABASE_URL=<direct> npm run db:migrate` gegen die
  Produktion. Sie läuft erst, wenn der neue Build deployt ist, kein altes Deployment mehr über Skew
  Protection erreichbar ist und der Drain abgewartet wurde (9.2, Schritte 1–3). Sie wendet
  `responsibilities` v3 an. Davor geht nichts verloren. Danach sind die Domänendaten weg, gewollt und unumkehrbar.
- **Einmalig:** Der Eintrag `('responsibilities', 3)` in `schema_migrations` wird geschnappt; jeder
  weitere Lauf ist ein No-op (`mcp/lib/db/migrate.ts:77–95`) [F].
- **Kein Auslösen aus Versehen:** Die Produktion migriert nie aus einer Anfrage heraus, sie prüft
  nur (`requireSchema`, `mcp/lib/db/migrate.ts:45–70`) [F].
- **Entwicklung und Tests:** Datenbanken dort (PGlite, `.devdb`) wenden v3 beim Öffnen automatisch
  an (`prepareSchema`). Lokale Domänendaten werden dabei ebenfalls zurückgesetzt; das ist gewollt.

---

## 6. Packaging, CI, Betrieb

### 6.1 Core in den MCP bringen (Phase P0, Entscheidung nach Kriterien)

**Variante A (bevorzugt): Quellen-Import.**
- `mcp/lib/core.ts`: `export { view, step, digest, canonical, InputError } from "../../src/index.ts"; export type * from "../../src/types.ts";`
- `mcp/next.config.ts`: `turbopack.root` und `outputFileTracingRoot` auf das Repository-Root
  setzen, statt auf `mcp/`. PGlite bleibt per `serverExternalPackages` und
  `outputFileTracingExcludes` ausgeschlossen.
- Vercel: Die Einstellung „Include source files outside of the Root Directory“ muss aktiv sein.

**Variante B (Ausweichvariante): Build-Kopie.**
- `mcp/scripts/sync-core.ts` kopiert `src/*.ts` und `src/schema.json` nach `mcp/lib/core-src/`
  (in `.gitignore`), als Vorstufe von `dev`, `build`, `test` und `typecheck`.
- CI prüft, dass die Kopie aktuell ist.

**Entscheidungskriterien für A:**
- `npm run check` und `npm run build` in `mcp/` grün.
- Ein Vercel-Preview-Build grün; die Function-Größe wächst nicht über das Maß der Core-Quellen
  hinaus; PGlite liegt weiterhin nicht im Trace.
- `tsc` in `mcp/` (TS 5, `moduleResolution: bundler`) akzeptiert die Core-Quellen: Import-Attribut
  `with { type: "json" }` (`src/index.ts:4`, `src/validate.ts:1`) und `export type *`.

Scheitert ein Kriterium, gilt B.

### 6.2 CI

Neue Datei `.github/workflows/check.yml`. Läuft bei `push`/`pull_request` auf `src/**`, `test/**`,
`mcp/**`, `package*.json`:
- Root: `npm ci && npm test`
- `mcp/`: `npm ci && npm run check`
- `test:pg` gegen einen leeren Postgres-Service-Container (Wegwerf-DB)

Mehr nicht.

---

## 7. Änderungen pro Datei

| Datei | Änderung |
| --- | --- |
| `mcp/lib/core.ts` | **neu**, einzige Importstelle (Variante A oder B) |
| `mcp/lib/responsibilities/host.ts` | **neu**: `buildRunObservations`, `selectLookback`, `validateDefinition` (über `core.view`), `caseIdOf`, Ausgabe-Former |
| `mcp/lib/responsibilities/model.ts` | **entfernen**: alle Funktionen aus C1. **Bleiben**: Limits, `RUN_*`, `Refusal`. **Neu**: `normaliseRows` (Limits, NFC-Prüfung) |
| `mcp/lib/responsibilities/store.ts` | **behalten**: `startRun`-Lebenszyklus (`:624–705`), `lockOwnRun`, `renew`, `reclaimableAt`, `refuseIfExpired`/`refuseIfAbandoned`. **Neu schreiben**: `putResponsibility`, `getResponsibility`, `recordObservations`, `viewRun` (neu), `completeRun`, `getCase`. **Entfernen**: `mapSubjects`, `inBaseline`, `notObserved` und alle SQL-Abfragen auf `cases`/`observations`/`decisions` |
| `mcp/lib/responsibilities/schema.ts` | Migration v3 (5.2): Domänentabellen verwerfen und neu anlegen |
| `mcp/lib/mcp/server.ts` | 8 Tools nach Abschnitt 3; Zod für Definition, Zeilen und Proposal; `MAX_TOOL_INPUT_ELEMENTS` (`:64–67`) neu berechnen (größter Eingang: `record_observations` mit 200 Zeilen × 50 Spalten × ≤ 51 Elementen) |
| `mcp/lib/mcp/limits.test.ts`, `endpoint.test.ts` | Erwartung 8 Tools, neue Elementgrenze |
| `mcp/lib/responsibilities/fixtures.ts`, `store.test.ts`, `two-runs.test.ts`, `model.test.ts`, `concurrency.pg.test.ts` | neu bzw. umgeschrieben (Abschnitt 8) |
| `mcp/next.config.ts` | nur bei Variante A: Wurzeln |
| `mcp/package.json` | nur bei Variante B: Sync-Vorstufe |
| `.github/workflows/check.yml` | **neu** |
| `mcp/README.md`, `mcp/docs/implementation-plan.md` | Tool-Tabelle, D11 geschlossen, Verweis auf diesen Plan |
| `src/**` (Core) | **keine Änderung** |

---

## 8. Tests

Bestehende Muster: PGlite in-memory, `node --test`. **`test:pg` läuft ausschließlich gegen eine
leere Wegwerf-Datenbank** (lokales Docker oder der CI-Service-Container), nie gegen die Produktion
oder einen Produktionsklon. Die Suites legen Schemas an und löschen sie, und
`mcp/lib/oauth/store.test.ts` leert Tabellen [F].

| ID | Datei | Beweist |
| --- | --- | --- |
| P1-T1 | `host.test.ts` | `buildRunObservations`: deterministische ids, Sortierung, `subjects`; Zeilenmenge (gleiche Zeile zweimal = eine); `occurred_at` strikt nach der neuesten gespeicherten Beobachtung derselben Art, auch bei rücklaufender Uhr und bei gleichem Zeitstempel |
| P1-T2 | `host.test.ts` | `selectLookback` wählt nach Core-Ordnung (`occurred_at`, bei Gleichstand `id`) über Run plus gespeicherte Beobachtungen, auch wenn eine Art im Run fehlt. Gegenprobe über `step`: die Beobachtung, die eine Closing-Regel laut `closing_check`-Trace (`RuleTrace.observation`) liest, ist die vom Host gewählte |
| P1-T3 | `host.test.ts` | `validateDefinition`: ungültiges `match`, doppelte Typen, `delivery`, `success` werden verweigert |
| P2-T1 | `store.test.ts` | `put_responsibility`: Version +1, gleicher Inhalt ist ein No-op, **reine Titeländerung ergibt eine neue Version mit `changed: true`**, `identity_change` |
| P2-T2 | `store.test.ts` | Lebenszyklus unverändert (die heutigen Tests für Übernahme nach Inaktivität, `supersede`, `run_not_yours`, 2 h); `view_run` erneuert die Lease |
| P2-T3 | `store.test.ts` | `record_observations`: `unknown_kind`, `observation_conflict`, `replace`, Limits, `not_nfc` |
| P2-T4 | `store.test.ts` | **Snapshot:** zweimal `view_run` ohne Änderung → gleiche `basis`, gleiches `view_now`; ein Retry von `record_observations` ohne Änderung lässt den Snapshot stehen; eine ändernde Aufzeichnung löscht ihn → `complete_run` gibt `view_required`; neues `view_run` → neues `view_now` und neue `basis`; `complete_run` mit alter `basis` → `basis_mismatch`, mit neuer gelingt; eine gespeicherte Eingabe, die im Test direkt verändert wird → `view_stale` |
| P2-T5 | `store.test.ts` | leere Proposal-Liste: falsche `basis` → `basis_mismatch`; richtige `basis` → Run abgeschlossen, `state.cases` unverändert (bzw. `{}` beim ersten Step), keine Transitions, Attention-Events oder Rejections. Persistiert wird exakt der von `step` zurückgegebene State samt `state_digest`, einschließlich Initialisierung (`state` war `null`) und fortgeschriebenem `state.now` (`src/core.ts:196`, `:401`); `core_steps.state_digest_after` ist gleich dem zurückgegebenen Digest (4.6) |
| P2-T13 | `store.test.ts` | **Uhr:** Die Host-Uhr läuft zwischen `record_observations` und `view_run` zurück und liegt vor `state.now` → kein `InputError`; `view_now` ≥ `state.now` und ≥ jedes übergebene `occurred_at` |
| P2-T6 | `store.test.ts` | Rejections des Core kommen als Daten zurück (`NO_EVIDENCE`, `UNKNOWN_EVIDENCE`, `CLOSING_NOT_MET`, `ATTENTION_GATE_NOT_MET`); der Run ist trotzdem `completed` |
| P2-T7 | `store.test.ts` | Rundreise über jsonb: Digest von `core_observations.body` und `responsibility_states.state` stabil |
| P2-T8 | `store.test.ts` | Replay: alle `core_steps` dieser Responsibility mit den gespeicherten Eingaben (Definition der Version, Beobachtungen aus `observation_ids`, `now`, Evaluation) erneut durch `step` → jeder `state_digest_after` Byte für Byte gleich |
| P2-T9 | `store.test.ts` | Workspace-Isolation: gleiche Keys und Subjekte in zwei Workspaces sehen nichts voneinander |
| P2-T10 | `two-runs.test.ts` (neu) | Bugcrowd-Szenario, drei Runs, über die Tools: Fall öffnen mit Attention `review` (Gate erfüllt); Attention schließen und `needs_work` öffnen; `resolved` mit unvollständigem `implement` → `CLOSING_NOT_MET`; vollständige Listen ohne das Subjekt → `resolved`; `get_case` zeigt alle drei Runs |
| P2-T11 | `migrate.test.ts` | **Clean Slate:** (a) frische DB v1 → v2 → v3 ergibt dasselbe Schema (Spalten, Constraints laut `information_schema`) wie (b) eine DB auf v2 mit Zeilen in allen sechs Domänentabellen sowie in `workspaces`, `members` und allen `oauth_*`-Tabellen, nach v3. In (b) sind die Domänentabellen danach leer; `workspaces`, `members`, `oauth_*` und die bisherigen `schema_migrations`-Zeilen sind unverändert (Zeilen und Inhalt gleich); `('responsibilities', 3)` steht genau einmal da, ein zweiter Lauf ist ein No-op. Danach funktionieren für ein bestehendes Mitglied `mcpSession` und die Rotation seines Refresh-Tokens, und `put_responsibility` legt eine Version an |
| P2-T12 | `endpoint.test.ts`, `limits.test.ts` | genau 8 Tools mit `DATA_RULES`; `MAX_TOOL_INPUT_ELEMENTS` passt zum größten gültigen Aufruf und verweigert größere |
| P3-T1 | `concurrency.pg.test.ts` | auf echtem Postgres (Wegwerf-DB): zwei `start_run` gleichzeitig; `record_observations` gegen `complete_run`; der fixierte Deadlock-Test (Übernahme gegen Schreiben, inklusive `run_observation_kinds`/`run_rows`); zwei `complete_run` desselben Runs → ein Ergebnis, ein Replay |
| P3-T2 | Root `npm test` | Core-Fixtures und Replay unverändert grün (`test/replay.test.ts`) |

---

## 9. Rollout und Rollback

### 9.1 Vorbereitung

1. **Ein Implementierungs-PR** (P0–P3 als Arbeitsreihenfolge) mit grünem `npm run check` in Core
   und MCP und grünem `test:pg` auf einer Wegwerf-DB. Das Packaging wird über `next build` lokal und
   einen Vercel-**Preview**-Build geprüft. Es gibt keinen separaten Produktions-Deploy vorab.
2. Es gibt **keinen Produktionsklon und keinen Bestandscheck**. Die Migration ist durch P2-T11
   (PGlite) und durch die `test:pg`-Suites auf echtem Postgres (Wegwerf-DB, `migrateAll`)
   abgedeckt. Die Daten, die sie verwirft, sind laut Produktentscheidung unwichtig.

### 9.2 Schnitt mit Schreibpause

Der alte Build darf nach dem Gate nicht mehr gegen das neue Schema laufen. Seine
Schema-Prüfung würde passieren, weil v1 und v2 eingetragen sind, aber seine Abfragen träfen
Tabellen in neuer Form. Für den Schnitt gilt deshalb **erst deployen, dann das Gate**. Die Pause
ergibt sich aus der vorhandenen Schema-Prüfung:

1. **Neuen Build in die Produktion bringen.** Er prüft in der Produktion das Schema
   (`prepareSchema` → `requireSchema`, `mcp/lib/db/migrate.ts`, aufgerufen beim Öffnen in
   `mcp/lib/db.ts`). Weil v3 fehlt, scheitert dort das Öffnen der Datenbank. Jede Anfrage mit
   Datenbankzugriff (MCP und OAuth) endet mit HTTP 500 und schreibt nichts; ein Refresh-Token wird
   dabei nicht verbraucht. Die Discovery-Dokumente brauchen keine Datenbank und antworten weiter.
   - Ohne Deployment-Pinning bedient der alte Build den kanonischen Host nicht mehr. Seine
     `*.vercel.app`-Adresse beantwortet `wrongOrigin` mit 404 (`mcp/lib/oauth/origin.ts`) [F].
     Mit Pinning bleibt er erreichbar, siehe Schritt 2.
2. **Skew Protection ausschließen und prüfen (manuell, vor Drain und Gate).** Vercel Skew
   Protection leitet eine Anfrage an den kanonischen Host, die `x-deployment-id: <id>` oder
   `?dpl=<id>` trägt, an das genannte Deployment weiter. Ein solches Deployment kann auch der alte
   Build sein. Der alte Build bestünde die Schema-Prüfung und liefe nach dem Gate gegen die neuen
   Tabellen.
   1. *Projektkonfiguration prüfen:* Im Vercel-Projekt unter Settings → Advanced → Skew Protection
      ablesen, ob die Funktion aktiv ist und welche Höchstdauer eingestellt ist. Außerdem die ID des
      bis eben produktiven Deployments notieren (`dpl_…`, Deployments-Liste).
   2. *Pinning ausschließen,* wenn Skew Protection aktiv ist. Entweder den Skew Protection
      Threshold auf das neue Produktions-Deployment setzen, sodass kein älteres Deployment mehr
      gepinnt wird, oder Skew Protection abschalten. Wer abschaltet, schaltet nicht wieder ein,
      solange das alte Deployment innerhalb der Höchstdauer liegt.
   3. *Verifizieren*, auch wenn Skew Protection als inaktiv angezeigt wird. Die Probe ist ein
      `POST https://<kanonischer Host>/oauth/token` mit dem Formular
      `grant_type=refresh_token&client_id=skew-probe&refresh_token=<zufällig>`. Sie wird zweimal
      geschickt: einmal mit dem Header `x-deployment-id: <alte ID>`, einmal mit
      `?dpl=<alte ID>` an der URL.
      - Antwortet der neue Build in der Pause, kommt HTTP 500 zurück, weil das Öffnen der Datenbank
        scheitert (Schritt 1).
      - Antwortet der alte Build, kommt HTTP 400 `invalid_grant` zurück. Ein unbekannter Token
        wird nur gelesen, nicht geschrieben (`mcp/lib/oauth/store/sql.ts:453–464`,
        `mcp/lib/oauth/exchange.ts:251–252`) [F].
   4. **Nur wenn beide Proben 500 liefern, geht es weiter.** Liefert eine 400, wird nicht
      migriert; zurück zu 2.2.
3. **Laufende Anfragen des alten Deployments abwarten**, mindestens die maximale Function-Dauer.
   Die Wartezeit beginnt erst, wenn Schritt 2 bestanden ist.
4. **Cutover-Gate (5.3):** `DATABASE_URL=<direct> npm run db:migrate`. Es wendet nur
   `responsibilities` v3 an; `oauth` und `workspace` sind aktuell und bleiben unberührt.
5. **Der neue Build bedient ab der nächsten Anfrage.** Ein fehlgeschlagenes Öffnen der Datenbank
   wird nicht zwischengespeichert (`mcp/lib/db.ts`) [F]. Agenten bleiben angemeldet (5.1).
6. **Smoke-Test, nur lesend:** Discovery, `POST /mcp` ohne Token → 401, `tools/list` → 8 Tools.
7. **Neuanlage:** Eine Person legt die bisherigen zwei Responsibilities mit `put_responsibility`
   und Core-Definition neu an; die alten Keys können wiederverwendet werden. Die Abnahme ist der
   erste echte Run.

### 9.3 Rückweg

- **Grenze ist das Gate** (Schritt 4).
  - **Davor:** Der neue Build verweigert nur, das Schema ist unverändert. Den vorherigen Build
    erneut deployen genügt.
  - **Danach:** kein Rückweg. Der alte Build passt nicht zum neuen Schema. Nur Korrektur nach vorn.
    Eine Wiederherstellung der verworfenen Daten ist nicht vorgesehen (Produktentscheidung).

---

## 10. Risiken

1. **Bindung und Sperre.**
   - Die Gleichheit der View zwischen `view_run` und `complete_run` setzt voraus, dass niemand
     sonst den State ändert. Garantiert ist das durch die Run-Sperre plus den Compare-and-Set.
   - Jeder künftige Schreibweg (z. B. ein Admin-`command`) muss dieselbe Sperre nehmen.
   - Gegenmittel: `responsibility_states` wird ausschließlich in `completeRun` geschrieben.
2. **Prompt-Aufbewahrung.** Pflicht 9 (`README.md:202`) bleibt beim Agenten. Der Server
   reproduziert die View aus den gespeicherten Eingaben, kennt aber nicht, was der Agent darüber
   hinaus sah. Dokumentierte Grenze.
3. **Kopplung an den Core.** Core-Änderungen wirken ohne Versionsgrenze. Gegenmittel: CI (6.2),
   P2-T8 (Replay) und P3-T2. Eine Änderung der Spec (`SPEC`, `src/core.ts:11`) macht gespeicherte
   States unlesbar und braucht einen eigenen Migrationsplan.
4. **Größe und Laufzeit.**
   - Die View enthält jeden Fall, auch erledigte (`src/core.ts:130–137`).
   - `view` und `step` hashen State und Beobachtungen in reinem JS (`src/canonical.ts:51–82`), und
     `complete_run` ruft `view` und `step` auf.
   - Keine feste Grenze in v1. Wird die Größe im Betrieb zum Problem, ist das Kürzen erledigter
     Fälle bei der Darstellung nach `README.md:226–229` zulässig. Es wird erst dann umgesetzt.
5. **Uhr.** `now` muss monoton sein und `occurred_at ≤ now` (`src/core.ts:75`, `:96`). Abgefangen
   durch die monotone Host-Zeit (4.1) und `view_now` (4.3); Tests P1-T1, P1-T2, P2-T13.
6. **NFC und exakte Identität.** Agenten mit nicht-NFC-Eingaben oder anderer Schreibweise bekommen
   Refusals bzw. getrennte Fälle. Das ist gewollt (`README.md:199`), muss aber in
   Tool-Beschreibungen und Skill dokumentiert sein.
7. **Packaging.** Variante A hängt an der Vercel-Einstellung und an einer Änderung von
   `turbopack.root`. P0 entscheidet nach Kriterien, B ist ausgearbeitet.
8. **Bruch für Agenten.**
   - Teilerfolge statt Alles-oder-nichts; ein Schritt mehr (`view_run`); Zitate als ids.
   - Es gibt keinen bekannten Nutzer (lokal keine Treffer in `claude-plugins`). Trotzdem sind die
     Tool-Beschreibungen sorgfältig nachzuziehen.
9. **Verworfene Domänendaten.** Das Gate löscht alle Responsibilities, Versionen, Runs, Fälle,
   Beobachtungen und Entscheidungen unumkehrbar. Das ist gewollt (Produktentscheidung). Die
   bisherigen zwei Responsibilities müssen neu angelegt werden (9.2, Schritt 7).
10. **Schreibpause.** Zwischen Deploy und Gate (9.2) sind MCP und OAuth nicht verfügbar. Agenten
    sehen 500. Deshalb den Schnitt in eine Zeit ohne geplante Runs legen.

---

## 11. Phasen und Akzeptanzkriterien

Die Phasen sind Arbeitsreihenfolge innerhalb **eines** Implementierungs-PR mit dem üblichen
Review. Es gibt keine Pflicht-Reviews pro Phase.

| Phase | Inhalt | Akzeptanzkriterien | Aufwandstreiber |
| --- | --- | --- | --- |
| **P0** | Packaging A oder B, `mcp/lib/core.ts`, CI | Kriterien aus 6.1 erfüllt (lokaler `next build`, Vercel-Preview-Build); CI grün auf Core und MCP; ein MCP-Test spielt `fixtures/example.json` über `mcp/lib/core.ts` ab und erhält denselben `state_digest` | Turbopack/Vercel-Verhalten |
| **P1** | `host.ts`, `normaliseRows`, Zod für Definition, Zeilen und Proposal | P1-T1 bis T3 grün; `host.ts` ohne Datenbank und ohne Status-, Attention- oder Schließlogik | Lookback-Auswahl nach Core-Ordnung |
| **P2** | Migration v3 (Clean Slate), `store.ts`-Umbau, 8 Tools, Entfernen von C1 | P2-T1 bis T13 grün; Suche in `mcp/lib` findet keine der Funktionen aus C1; `npm run check` grün | Snapshot-Logik, Lesemodelle, Test-Umbau |
| **P3** | `test:pg` (Wegwerf-DB), Doku | P3-T1/T2 grün; README und Plan nachgezogen | — |
| **P4** | Schnitt nach 9.2 mit Gate (5.3) | Skew Protection geprüft und beide Proben mit der alten Deployment-ID vor dem Gate 500; Gate einmal angewendet; Smoke-Test nur lesend grün; die zwei Responsibilities neu angelegt; erster echter Run abgeschlossen | Zeitfenster für die Schreibpause |

**Definition of Done:**
- `mcp/` enthält keine eigene Entscheidungslogik mehr.
- Jede Statusänderung eines Falls in der Produktion stammt aus `core.step` und lässt sich per
  Replay reproduzieren (P2-T8).
- Die Tool-Oberfläche entspricht Abschnitt 3.
- Workspaces, Mitgliedschaften, OAuth-Daten und die bisherige Migrations-Historie sind unverändert;
  die Domänentabellen haben das Schema aus 5.2.

---

## 12. Vor der Umsetzung zu klären

1. **Vercel-Einstellung** „Include source files outside of the Root Directory“: aktueller Wert des
   Projekts.
2. **Status-Skill** (`claude-plugins`, INF-Ticket). Er folgt nach dem Schnitt mit den neuen
   Verträgen: Zeilen pro Quelle, `view_run`, Zitate, Closing-Regeln statt „letzte Entscheidung
   `nothing_due`“ (`mcp/docs/implementation-plan.md:566–570`). Er ist nicht Teil dieses Plans.

---

## 13. Umsetzung: was der Plan offen ließ

Festgelegt bei der Umsetzung, im Rahmen der Abschnitte oben:

- **Packaging:** Variante A (Quellen-Import über `mcp/lib/core.ts`, `turbopack.root` und
  `outputFileTracingRoot` auf dem Repository-Root). `tsc` und lokaler `next build` grün; der Core
  wird in die Chunks gebündelt, im Trace liegt keine Datei außerhalb von `mcp/`, PGlite nur als
  Externals-Link ohne Paketdateien. **Offen:** Vercel-Preview-Build und die Einstellung „Include
  source files outside of the Root Directory“ (§6.1, §12.1); bei Fehlschlag gilt Variante B.
- **`view_run`** liefert die `View` des Core unverändert.
- **`record_observations`:** Mehrere Einträge derselben Art in einem Aufruf werden der Reihe
  nach angewendet. Die 200 Zeilen gelten für den ganzen Aufruf (`call_too_large`). Die Grenzen
  von 1000 Zeilen pro Art und 10 Arten pro Run melden `run_too_large`. Zeilen, die eine Grenze
  verletzen, U+0000 oder ungepaarte Surrogate enthalten (Postgres speichert sie nicht, `digest`
  hasht sie nicht), werden mit `invalid_row` verweigert; nicht-NFC mit `not_nfc`.
- **`Observation.subjects`** werden aus Spalten gebildet, die genau wie ein Subjektschlüssel
  heißen und einen Text oder eine ganze Zahl tragen (beschreibend; der Core liest sie nicht).
- **Text, den Postgres nicht speichern kann** (U+0000, ungepaarte Surrogate), in Titel,
  Definition, Zusammenfassung, Bericht oder Evaluation: `invalid_text`, bevor etwas geschrieben
  wird.
- **`complete_run`:** fehlende Evaluation bei `completed`/`partial` → `evaluation_required`,
  Evaluation bei `failed` → `evaluation_forbidden`. Ein `failed`-Ergebnis hat `basis: null` und
  `state_digest: null`. Abgeschlossene Runs verweigern `record_observations` und `view_run` mit
  `run_completed` wie bisher.
- **`core_steps.result`** ist das `StepResult` ohne `state`; der State steht in
  `responsibility_states`, Replay fädelt ihn neu (P2-T8).
- **`start_run`:** `run_limit` = Zeilen pro Art und Run (1000). Ausgabe sonst wie §3.4.
- **`get_case`:** `attentions` wie bei `get_responsibility` (nur offene); `cited` = die `cites`
  des Vorschlags für diesen Fall, sortiert.
- **Lookback (b):** Zuerst werden `id`, `kind` und `occurred_at` aller Evidenz offener Fälle
  gelesen, dann nur die Rümpfe der gewählten Beobachtungen.

Tests: P0 `mcp/lib/core.test.ts`; P1 `host.test.ts`, `model.test.ts`; P2 `store.test.ts`,
`two-runs.test.ts` (über den MCP-Endpunkt), `mcp/lib/db/migrate.test.ts`, `endpoint.test.ts`,
`limits.test.ts`; P3 `concurrency.pg.test.ts` (Wegwerf-Postgres) und Root `npm test`. CI:
`.github/workflows/check.yml`.
