# Benchmark Store Spec — DB-First Task Benchmarking (Compound REM-4, benchmark mode)

Status: normative for the benchmark-mode implementation. `docs/spec/05-…audit…` remains
the append-only audit; `AUDIT-EVENT-2026-08-29-01` records the plan re-audit that led
to this design. Mine-evolve remains REM-4-scoped and is NOT implemented by this spec.

## 1. Goals

- Benchmark LLM candidates on stored tasks and keep every run, score, and trace in one
  queryable SQLite database (append-only history), replacing the abandoned
  single-`task.json`-with-runs design (infeasible: pretty JSON rewrites contradict
  append-only; user edits can rewrite history — AUDIT-EVENT-2026-08-29-01 F-01).
- Preserve the house identity `(blueprint, model, task, trial)` with immutable
  revisions and full `ModelReference {provider, model, variant?}` identity
  (spec A34/A46; `Model.VariantID` is part of identity, never dropped from keys).
- Run candidates in parallel with bounded concurrency in isolation; never expose other
  candidates, scores, traces, or the reference solution to a candidate.
- Score independently, then select one leading solution per job deterministically.
- Use Motel (migrated OTLP+SQLite viewer) as the observability UI, not as a private DB.

## 2. Non-goals (this spec)

- Mine-evolve, approval queue UI, prompt evolution (still REM-4).
- Reusing Motel's private SQLite schema or importing Motel source (its tree still uses
  `Schema.TaggedErrorClass`, native Node APIs and direct JSON — incompatible with the
  repo's own detector catalog). Copy architecture, not code.
- A duplicate TUI in this plugin. Motel's TUI is the viewer; plugin tools are the
  read/write authority for tasks and results.

## 3. Storage — Effect SQL / SQLite (canonical)

Dependencies pinned to the repo Effect line: `@effect/sql`, `@effect/sql-sqlite-bun`
(`4.0.0-rc.110`). All persistence goes through `SqlClient` — no `bun:sqlite` imports
outside the driver layer, no raw JSON (Schema codecs at boundaries).

Layer shape (Motel-style separation, single process):

- `BenchmarkStoreLive` — writer service: migrations + writes (transactions, WAL default).
- `BenchmarkStoreReadonlyLive` — readonly connection for queries (tool `get/list/history`).
- Both derive from `SqliteClient.layer({ filename })` + `SqliteMigrator` (record loader)
  + `Reactivity.layer`; scoped via `Layer.scoped`.

Database path default: `.effect-harness/benchmark.sqlite` (runtime artifact, gitignored
via `.effect-harness/`), overridable through plugin options.

### 3.1 Schema (migration `0001_benchmark_store`)

```sql
CREATE TABLE model_profiles (         -- user-curated LLM pool (seeded from plugin options, upserted)
  id            TEXT PRIMARY KEY,     -- stable slug, e.g. 'zen-deep'
  provider      TEXT NOT NULL,        -- 'opencode' | 'opencode-go' | ...
  model         TEXT NOT NULL,
  variant       TEXT,                 -- Model.VariantID (exact catalog id, optional)
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,     -- slug
  title         TEXT NOT NULL,
  domain        TEXT NOT NULL,
  current_revision TEXT NOT NULL REFERENCES task_revisions(revision)
);

CREATE TABLE task_revisions (         -- immutable; update = insert new revision
  revision      TEXT PRIMARY KEY,     -- fnv1a hex over canonical spec JSON
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  problem       TEXT NOT NULL,
  evaluator_id  TEXT NOT NULL,        -- 'design-brief@1'
  rubric        TEXT NOT NULL,        -- judge rubric text (versioned by content)
  reference_solution TEXT,            -- evaluator-only; NEVER rendered into candidate prompts
  model_profile_ids TEXT NOT NULL,    -- JSON array of profile ids selected for this task
  constraints_json TEXT NOT NULL,     -- bounds: max sections, max snippet count, etc.
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE benchmark_jobs (
  job_id        TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  task_revision TEXT NOT NULL REFERENCES task_revisions(revision),
  blueprint_id  TEXT,                 -- nullable: 'none' strategy = task prompt only
  blueprint_hash TEXT,                -- content hash of composed prompt/policy
  evaluator_id  TEXT NOT NULL,
  rubric_hash   TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('running','completed','failed','cancelled'))
);

CREATE TABLE benchmark_trials (       -- append-only; one row per (job, blueprint, profile, task, trial)
  trial_id      TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES benchmark_jobs(job_id),
  blueprint_id  TEXT NOT NULL,        -- 'none' allowed
  blueprint_hash TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  task_revision TEXT NOT NULL,
  profile_id    TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  variant       TEXT,                 -- Model.VariantID — part of the identity key
  trial         INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN
                  ('pending','running','scored','contract-invalid','llm-error','timeout','interrupted','judge-unavailable')),
  output_text   TEXT,                 -- bounded canonical candidate output
  output_bytes  INTEGER,
  output_hash   TEXT,                 -- fnv1a content fingerprint (drift detection, NOT crypto)
  duration_ms   INTEGER,
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  session_id    TEXT,                 -- OpenCode child session id (provenance)
  error_reason  TEXT,
  started_at_ms INTEGER,
  finished_at_ms INTEGER,
  UNIQUE (job_id, blueprint_id, blueprint_hash, task_revision, profile_id, variant, trial)
);

CREATE TABLE trial_scores (           -- one row per scoring pass; never updated
  score_id      TEXT PRIMARY KEY,
  trial_id      TEXT NOT NULL REFERENCES benchmark_trials(trial_id),
  evaluator_id  TEXT NOT NULL,
  rubric_hash   TEXT NOT NULL,
  deterministic_json TEXT NOT NULL,   -- structural findings/bounds result
  dimensions_json    TEXT NOT NULL,   -- judge dimension scores {name: score} 0..1
  total         REAL NOT NULL CHECK (total >= 0 AND total <= 1),
  scored_at_ms  INTEGER NOT NULL
);

CREATE TABLE leading_solutions (      -- one per job; winner is recorded, reference_solution is NOT mutated
  job_id        TEXT PRIMARY KEY REFERENCES benchmark_jobs(job_id),
  trial_id      TEXT NOT NULL REFERENCES benchmark_trials(trial_id),
  total         REAL NOT NULL,
  selected_at_ms INTEGER NOT NULL
);

CREATE TABLE trace_events (           -- ordered observable events per trial (bounded)
  event_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  trial_id      TEXT NOT NULL REFERENCES benchmark_trials(trial_id),
  sequence      INTEGER NOT NULL,
  kind          TEXT NOT NULL,        -- 'lifecycle'|'output'|'score'|'error'
  payload_json  TEXT NOT NULL,
  previous_hash TEXT NOT NULL,
  hash          TEXT NOT NULL,        -- fnv chain: ordering/drift fingerprint only
  created_at_ms INTEGER NOT NULL,
  UNIQUE (trial_id, sequence)
);

CREATE TABLE benchmark_history (      -- append-only job-level event log (no UPDATE/DELETE path in code)
  event_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        TEXT NOT NULL,
  sequence      INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  previous_hash TEXT NOT NULL,
  hash          TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (job_id, sequence)
);
```

Integrity honesty (AUDIT-038 lesson applied to new code): the `previous_hash`/`hash`
chain is FNV-1a — an ordering/drift fingerprint, NOT a cryptographic signature
(`packages/shared/src/Hash.ts` documents this). It detects accidental corruption and
reordering; a determined writer with DB access can rewrite. The real guarantees are
SQLite constraints (UNIQUE identity keys, CHECK ranges), INSERT-only code paths, and
transactional job transitions. Tamper-evident security would require an external anchor
and is explicitly out of scope.

### 3.2 Identity and comparability

- Trial identity: `(job_id, blueprint_id, blueprint_hash, task_revision, profile_id, variant, trial)`.
- Runs are only comparable within the same `task_revision` + `evaluator_id` +
  `rubric_hash` + `blueprint_hash`. Summaries (`history`, `leading`) group by that
  compatibility set and label results `n=1` — never presented as statistically settled
  (A34).
- Model identity includes `variant`. `modelLabel` helpers gain a variant-aware key
  (`provider/model[@variant]`) in `opencode-harness-shared`; `Scorecard.Run` gains an
  optional `modelVariant` and aggregation keys include it (fixes the collision where
  two variants of one model merged — AUDIT-EVENT-2026-08-29-01 F-09).

## 4. Execution flow (benchmark job)

1. `benchmark.start {taskId, blueprintId?, modelProfileIds?, trials=1}`:
   - Load task revision; resolve `ModelProfile`s; validate each through the OpenCode
     catalog (`ctx.catalog.model.get`) including the exact `variant` (unknown variant
     fails resolution per V2 docs — fail BEFORE creating sessions).
   - Insert `benchmark_jobs` + one `pending` `benchmark_trials` row per
     `(blueprint, profile, trial)` with the full identity; append `job.started` history.
2. Run pending trials with `Effect.forEach(..., { concurrency: options.benchmark.concurrency })`
   (bounded; never unbounded). Each trial independently:
   - Render the candidate prompt from task revision ONLY (problem + output contract +
     constraints). `referenceSolution`, rubric, other trials, scores, and history are
     unreachable from the prompt by construction (pure render function, unit-tested).
   - Execute via the OpenCode adapter (§5) into an isolated location with a no-tool
     benchmark agent.
   - Persist outcome + bounded output + trace events in ONE transaction; status is
     explicitly one of `scored|contract-invalid|llm-error|timeout|interrupted` — a
     failed trial is recorded, never thrown away, and never folded into score 0
     (P1-4: failure modes are distinct).
3. Score every `scored` trial independently with the task evaluator
   (`design-brief@1`): deterministic structural checks (Schema-decoded `DesignBrief`,
   bounds, ast-grep syntax diagnostics over TS snippets) + judge dimension scores via
   the `Judge` port. Weighted total computed in code from bounded dimension scores.
   Judge unavailable ⇒ trial status `judge-unavailable`, never a silent pass.
4. Leader selection: pure deterministic fold over `trial_scores` (max total; tie-break:
   deterministic checks first, then profile id asc). Insert `leading_solutions`.
   `task_revisions.reference_solution` is NOT mutated (P0-9: reference solution stays
   canonical evaluator-only data; the job winner is a recorded result).
5. `job.status = completed` (+ partial-failure note when some trials failed); history
   events appended transactionally at every transition.

## 5. OpenCode V2 adapter (`src/session/Executor.ts`, `src/benchmark/Runner.ts`)

- Model reference: build `Model.Ref` via SDK schemas at the boundary:
  `{providerID: Provider.ID, id: Model.ID, variant?: Model.VariantID}` — the plugin
  task doc/config stores plain strings; branding happens only in `src/`.
- Session: `ctx.session.create({ agent: benchmarkAgent, model, location? })` returns
  `Session.Info` (typed; no `{id?: unknown}` cast for new code). For tool-less design
  tasks the session stays read-only via the existing origin registry
  (`origins.register({sessionID, origin: 'benchmark'})` + `registerPrompt(system)`;
  the `context` hook injects the system part; `execute.before` denies mutation tools).
- Output: pinned `session.generate({sessionID, prompt})` → `{text}` is the canonical
  answer. `LiveTraceSink.lastAssistantText` is NOT authoritative (the pinned protocol
  does not declare the `message.part.updated` event it filters on — F-04); observables
  recorded in `trace_events` are lifecycle events (`session.execution.*`) and the
  generate result. Trace unavailability is recorded as such, never fabricated.
- Timeouts/interruption: `Effect.timeout(Duration)` around generate; on timeout the
  trial is `timeout` + `ctx.session.interrupt` best-effort; origin unregistered in
  `Effect.ensuring` AFTER durable persistence (A43: clear origin only after the
  terminal trace is persisted).
- Isolation: candidate sessions get an isolated location (workspace dir under
  `.effect-harness/workspaces/`) that contains NO task/rubric/reference data.
  Prompt-rendering privacy is necessary but not sufficient (F-05).

## 6. Plugin options (`src/Options.ts`, V2 options shape)

```jsonc
{
  "plugins": [{
    "package": "./src/index.ts",
    "options": {
      "compound": {
        "enabled": true,
        "benchmark": {
          "dbPath": ".effect-harness/benchmark.sqlite",
          "concurrency": 2,
          "workerAgent": "explore",
          "judge": { "profileId": "judge-profile", "minScore": 0.0 },
          "models": [ { "id": "zen-deep", "provider": "opencode", "model": "MODEL_ID", "variant": "deep" } ],
          "otel": null
        }
      }
    }
  }]
}
```

- `options.compound.benchmark.models` are UPSERTED into `model_profiles` at startup;
  the DB table is the source of truth afterwards (user mutates via `profile.add`/DB).
- Variants are model-specific named overlays (`opencode.jsonc` `providers.*.models.*.variants`
  with `settings`, V2 shape — NOT the V1 `provider`/`options` form). IDs must exist in
  the catalog; the plugin never guesses `high`/`max`.
- Judge model is a `model_profiles` row referenced by id; judge prompts wrap candidate
  output as delimited UNTRUSTED data (A44) and never see scores/history/other
  candidates.

## 7. Tool surface (`effect_harness_compound`, typed ops)

```
task.create {id,title,domain,problem,evaluatorId,rubric,referenceSolution?,modelProfileIds,constraints?}
task.update {id, patch…}        → new immutable task_revision; old runs stay comparable
task.get {id} | task.list {cursor?} (bounded, cursor-paginated)
profile.add {id,provider,model,variant?} | profile.list
benchmark.start {taskId, blueprintId?, modelProfileIds?, trials?}
benchmark.status {jobId} | benchmark.history {taskId, cursor?}
benchmark.leading {jobId} | benchmark.trace {trialId, cursor?}
```

All list/query results are bounded and cursor-paginated (Motel `httpListPolicy` style).
No arbitrary SQL, no raw JSON output blobs. `mine-evolve` input still returns the
honest REM-4 error (AUDIT-037 semantics preserved for that mode).

### 7.1 File layout (01-architecture layout law)

Benchmark files live in a domain folder with short nouns:

```
src/session/Executor.ts      host session adapter (Model.Ref/Location/generate)
src/benchmark/Runner.ts      job orchestrator (pending→terminal state machine)
src/benchmark/Tool.ts        effect_harness_compound op surface (namespace
                             BenchmarkTool: bare Tool collides with host)
```

### 8. Motel visibility (OTLP) — IMPLEMENTED

- Motel stays a viewer. The plugin exports OTLP spans/logs via
  `effect/unstable/observability` (`OtlpTracer.layer` + `OtlpLogger.layer` with
  `OtlpSerialization.layerJson` + `FetchHttpClient.layer`) when
  `options.compound.benchmark.otel = { endpoint, serviceName? }` is set.
  Spans: `benchmark.run` (root, job attributes) and `benchmark.trial` per trial.
- Span/log attributes: `benchmark.task_id`, `benchmark.task_revision`,
  `benchmark.evaluator_id`, `benchmark.blueprint_id`, `benchmark.trial_id`,
  `benchmark.profile_id`, `benchmark.provider`, `benchmark.model`,
  `benchmark.variant`, `benchmark.trial`.
- Prompt/output content is NEVER exported (the `includeContent` flag only
  accepts `false` — a content opt-in would be a deliberate future decision).
  Canonical full outputs live in `benchmark_trials`; per-trial events in
  `benchmark_trace_events` (queryable via `benchmark.trial`).
- Trials are crash-resumable: pending rows are inserted at job creation and the
  terminal transition is a guarded `UPDATE … WHERE status='pending' RETURNING`
  (double completion is `Option.none`); the score (when present) is written in
  the SAME transaction; `completeJob` atomically persists status + leading +
  history; leading solutions are INSERT-only; the history chain is verified on
  read.

## 9. Enforcer catalog reconciliation (record of decision)

Compared against `mpsuesser/opencode-effect-enforcer@685718b`:

- Skills: current 53 vs upstream 54 — `effect-scheduling` is ADDED here (synced).
- Patterns: current 47 vs upstream 46 — `prefer-recursion-over-while.md` is RETAINED
  as a documented LOCAL addition (upstream folds `while` into `imperative-loops`; the
  local detector gives while-loops a dedicated, warning-level message). Inventory is
  therefore `54 skills / 47 patterns / 4 guidance` = "54 upstream skills + 47
  detectors (46 upstream + 1 local)".
- Content: `effect-schema-v4`, `avoid-data-tagged-error`, and the guidance docs are
  synced to the corrected `Schema.TaggedError` API (the repo previously taught the
  beta-era `Schema.TaggedErrorClass`; pinned `effect@4.0.0-rc.110` exports
  `Schema.TaggedError`). Effect source-reference paths keep the repo-native
  `~/.cache/effect-v4/` convention (both it and the enforcer's
  `~/.local/share/opencode/repos/...` path are user-environment clones; convention is
  unchanged deliberately).
- Behavior: the enforcer's `opencode-effect-enforcer: false` agent request-body opt-out
  is ported as `opencode-effect-harness: false` (agent `request.body` consumption via
  `ctx.agent.transform` + skill permission deny), honoring it in gate/header/feedback.
- NOT ported: enforcer's Promise/native-Node implementation (this repo's Effect-native
  kernel is strictly stronger), and its raw-node frontmatter/pattern loaders (here:
  strict typed `Catalog`, manifest integrity).

## 10. Validation plan

- Every change ends with `bunx tsgo --noEmit`, `bunx tsc --noEmit`, `bunx vitest run`
  (mandatory gates; self-pattern scan stays shrink-only).
- New tests: migrations/transactions on `:memory:` SQLite; trial identity uniqueness;
  leader selection incl. ties; task revision immutability; prompt-privacy (rendered
  prompt contains no reference/solution/score substrings); variant-preserving keys;
  executor contract with a fake host context (Session.Info typing, origin ensure/
  unregister ordering, timeout → `timeout` status); syntax diagnostics (valid/invalid
  snippets); evaluator bounds; tool dispatch contract via `src/plugin/Contract.test.ts`
  extension.
- Live smoke (requires authenticated server): one job, two profiles, one task; verify
  DB rows, leading selection, and honest statuses.
