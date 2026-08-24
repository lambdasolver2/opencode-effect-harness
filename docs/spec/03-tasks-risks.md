# opencode-effect-harness — Migration Spec (4/4): Effect v4 Compliance, Config, Testing, Tasks, Risks

**Canonical revision:** [`04-adversarial-audit.md`](04-adversarial-audit.md)
contains the adversarial findings. This document's corrected requirements
below supersede earlier task shorthand, especially around agent/command
creation, skill registration, verifier coverage, TUI parity, approval, and
benchmark isolation.

## 1. Effect v4 best-practices compliance checklist

Per the pi-effect-harness skill catalog, all code must satisfy:

- **Services**: `Context.Service` tags named `'ox-effect-harness/<pkg>/<Name>'`; interfaces as `namespace X { export interface Interface }`; layers via `Layer.effect`/`Layer.unwrap` with deps injected as plain interface params into rule/hook factories (upstream style).
- **Errors**: `Schema.TaggedErrorClass` only; no `throw` inside `Effect.gen`/`Effect.fn` (gate pattern `throw-in-effect-gen` is one of our own detectors — dogfood it); `Effect.catchTag` at boundaries.
- **No platform coupling in core packages**: FileSystem/Path/Clock via services; Node layers only in adapters/plugin (`use-filesystem-service`, `avoid-platform-coupling`, `avoid-node-imports` patterns).
- **No mutable state outside Ref/Atom**; pure derived values as atom functions + Atom twins (`effect/unstable/reactivity/Atom`) like upstream harness-kit.
- **Schema everywhere** at boundaries: plugin options, storage payloads, reports, blueprints, experiment rows. `Schema.Class` with decoding/constructor defaults as upstream does.
- **Concurrency** via `Effect.forEach(..., {concurrency})`, fibers supervised with scopes; no `Promise` in core (`require-effect-concurrency`, `effect-promise-vs-trypromise`).
- **Config**: `Config.redacted` for API keys in DirectAiExecutor (`prefer-redacted-config`).
- **Duration values**, `Match.exhaustive` over unions, `Option` over null (internal), `Arr`/`Str` modules, no non-null assertions, no `any`.
- **Dogfooding gate**: our own CI runs the migrated pattern catalog against our own source (the 46 detectors must pass on this repo).

## 2. Plugin options surface (`ctx.options`, Schema-validated)

```jsonc
{
  "plugins": [{
    "package": "opencode-effect-harness",
    "options": {
      "harness": {
        "enabled": true,                       // master switch (mode state default)
        "minEffectSkills": 4,
        "strictAgents": ["build"],             // gate strict only for these agents
        "referenceClone": true,                // effect-smol → ~/.cache/effect-v4
        "referenceMode": "compatible",        // compatible | latest (latest is non-reproducible)
        "telemetryPath": null                  // override skill-reads.jsonl location
      },
      "verify": {
        "trigger": "auto",                     // off | auto | manual
        "triggerAgents": ["build"],             // automatic runs originate here
        "debounceMs": 30000,
        "semanticReview": true,               // review passing and failing eligible runs
        "allowEdits": false,                   // verifier agent edit permission
        "workerAgent": "explore",              // existing read-only agent; plugin cannot add agents
        "modules": ["typescript"],             // built-in IDs only
        "moduleConfigs": [],                    // supported data-only argv checker modules, e.g. bend
        "failClosedForGate": true,
        "skillEvidence": true                  // verify changed files against the complete generated module skill catalog
      },
      "critic": {
        "workerAgent": "explore",              // existing read-only agent for independent review
        "model": null,                         // explicit independent model; null uses configured default and is labeled non-independent
        "autoEveryNBuildExecutions": 0,        // 0 = never infer a feature from an event
        "autoAfterExplicitCheckpoint": false,  // builder must send a structured feature/plan checkpoint
        "requireIndependentModel": false,      // true rejects same model as builder
        "maxFindings": 20,
        "checkReferences": true                // critic must open cited references before flagging them
      },
      "compound": {
        "enabled": false,                      // historical export/LLM mining requires opt-in
        "mode": "mine-evolve",                 // benchmark | mine-evolve
        "sessionScope": "project",             // project | all; all is explicit and authenticated
        "triggerAgents": ["build"],             // automatic compound runs originate here
        "autoEveryN": 0,                       // 0 = manual/command only
        "stage1Model": null,                   // explicit model; otherwise configured default, never guessed by name
        "gateModel": null,                    // explicit model; otherwise configured default
        "benchmark": {
          "enabled": false, "models": [],      // user-configured; ONE run per model, then score
          "executor": "opencode",              // opencode | direct-ai
          "tasksDir": ".effect-harness/tasks",
          "taskIds": [],                        // selected tasks; required when benchmark is enabled
          "blueprintIds": [],                   // selected blueprint modules
          "evaluationSet": { "train": ["task-train"], "holdout": ["task-holdout"] },
          "trials": 1,                          // fixed at 1 in benchmark mode per requirement
          "promotion": "manual"              // manual | deterministic | llm
        },
        "evolution": {
          "enabled": false,                     // explicit; never auto-triggered
          "improvementModel": null,             // variation-operator model
          "blueprintIds": [],                   // modules to evolve
          "evaluationSet": { "train": ["task-train"], "holdout": ["task-holdout"] },
          "maxVariationSteps": 10,
          "stagnationLimit": 3                  // consecutive non-improving attempts before redirect
        }
      },
      "data": {
        "allowHistoricalSessions": false,
        "retentionDays": 30,
        "maxTraceBytes": 400000
      },
      "agents": {
        "verifier": "explore",
        "critic": "explore",
        "compound": "explore"
      }
    }
  }]
}
```

Conditional validation is part of the options schema: benchmark mode requires
at least one model, task, and blueprint ID; evolution requires at least one
blueprint ID and a non-empty train/holdout evaluation set. Empty arrays above
are valid only while the corresponding mode is disabled.

## 3. Testing strategy

1. **Core**: `@effect/vitest` suites mirroring upstream layout — per-pattern test bijection, WriteProjection, Decision algebra, BlueprintModule composition/conflict tests, `BlueprintPatch` folds, cursor commit/rollback, command-argv safety, TriggerPolicy truth tables, scoring properties, **markdown blueprint module round-trip + AVO commit-rule property tests (reject regressions, gate verification failures, journal lessons)**, and CriticReport schema decode of fixture reviews.
2. **Adapters**: contract tests against recorded/fake v2 context operations (tool payload → location resolution → WriteIntent, `Tool.Error` blocking, event project filtering, recursion guard, compaction ledger rebuild, synthetic capture, capability probes).
3. **Plugin e2e smoke**: pack and load the exact npm artifact in an OpenCode2 server; assert plugin ID, tools, TUI entrypoint, native skill registration capability, and a verifier triggered once by a completed build session. Verify internal reviewer events do not retrigger it.
4. **Parity**: exercise mode/status, skill stats, policy header, four-skill gate, pattern feedback, reference clone, compound approve/edit/skip/reject, append-only docs with embedded solution-trace blocks, rescan cursor, isolated two-model benchmark fixtures with exactly one run per model, and non-code research/writing/planning fixtures scored by versioned rubrics.
5. **CI**: exact dependency lock, `@effect/tsgo` typecheck, lint, unit tests, asset parity, self-pattern check, packed-artifact install, and optional OpenCode2 e2e.

## 4. Task breakdown (phases; each phase independently mergeable)

### Phase 0 — Scaffolding & parity baseline
- T0.1 Workspace: one npm package, exact `@opencode-ai/plugin`/`@opencode-ai/client` beta and matching `effect` lock, `@effect/platform-node`, tsconfig/tsgo, oxlint+dprint, vitest+@effect/vitest. **AC:** `bun install && bun run check && bun test` green.
- T0.2 Copy assets verbatim: `assets/{skills,patterns,guidance}` from pi-effect-harness, then resolve the upstream 4-vs-5 threshold inconsistency deliberately and test that the policy header/gate/docs agree. **AC:** source assets are traceable to upstream and the selected threshold is one explicit compatibility decision.
- T0.3 API capability probe: compile/load the exact plugin package and assert tool registration, TUI loading, supported skill registration, hook failure mapping, and event subscription. **AC:** unsupported assumptions fail before feature-port work begins.

### Phase 1 — kernel port
- T1.1 Port data schemas + atoms + frontmatter + normalizePath (rename tags to `ox-effect-harness/*`). 
- T1.2 Port kernel services: PatternCatalog/PatternMatcher (@ast-grep/napi), RuleCatalog/RuleSet/RuleEngine, HookSet, WriteProjection, HarnessController.
- T1.3 API delta audit beta.80→rc.x (fix compile errors; keep semantics).
- **AC:** upstream kernel tests ported & green; zero host imports (lint-enforced boundary).

### Phase 2 — effect-harness feature port onto v2 seams
- T2.1 `adapters-opencode/context`: PluginContext service wrapping ctx domains plus `SessionLocationResolver` and project-scope filter.
- T2.2 ToolEventSnapshot analogs (`execute.before/after` → WriteIntent) + DecisionExecutor (block=Effect.fail w/ reason; inject=synthetic queue; entry=storage record).
- T2.3 Services: SkillCatalog (bundled assets + capability-probed native registration), GuidanceCatalog, PendingSkillRefs, persistent SkillLedger (activation/read journal, successful compaction reset, conservative reload), v2 client SkillReadBackfill, ReferenceClone, SkillTelemetry.
- T2.4 Hooks/rules ports wired through HarnessController; policy header via `session.hook('context')`.
- T2.5 Mode toggle server tool + TUI footer/keymap/slash command; storage persistence; capability-probed skill registration; telemetry/backfill.
- **AC:** full behavioral parity matrix from §1.5 verified by adapter contract tests; manual smoke in dev opencode session (gate blocks Effect write before 4 skills; feedback after write; toggle persists).

### Phase 3 — verify subsystem
- T3.1 verify-core schemas/services (module registry, checker runner, report, trigger policy).
- T3.2 `modules/verify-typescript` (tsc/test detection + parsers) **with the complete generated upstream skill catalog (53 SKILL.mds at the inspected commit) and 46 patterns wired in as its `ModuleSkillCatalog`/`ModulePatternCatalog`**; pattern findings carry full markdown guidance + suggestedSkills; semantic review checks the ChangeSet against loaded skills. Bend example module with its own skills/patterns dirs.
- T3.3 Adapter: argv-only CommandExecutor via ChildProcessSpawner; per-session ChangeLedger and bounded ChangeSetProvider from successful write/edit hooks/VCS; orchestrator delivery (storage+synthetic); configured worker session with read-only context restrictions; semantic review on every eligible run; `effect_harness_verify` tool; TUI/config command surfaces; recursion-safe event/debounce listeners.
- T3.4 Critic subsystem: `CriticRequest/CriticFinding/CriticReport` schemas; critic worker (read-only, reference-checking prompt: logical flaws, hallucinations, drift, domain/reference errors); `effect_harness_critic` tool; optional auto-invoke after an explicit builder checkpoint or configured build cadence; reports persisted under `.effect-harness/reports/`.
- **AC:** failing tsc/test produces fail-report + queued message; passing repo passes; pattern/skill findings cite catalog entries; bend example executes when binary present, else skipped-with-note; a seeded hallucinated claim in a fixture summary is flagged by the critic with evidence.

### Phase 4 — compound subsystem
- T4.1 compound-core: trace port (ATIF + provenance + bounded `TraceDigest`/`FailureLesson` with attempt/failure/detection/correction), LiveSessionSource + full-client HistoricalSessionSource adapters, LiveSessionTraceStore, visited-index store.
- T4.2 Distiller prompts-as-data + two-stage pipeline with sanitized observable traces and durable pending proposals.
- T4.3 Atomic declarative BlueprintModule domain + pure composition + typed BlueprintInterpreter + BlueprintStore versioning + append-only PlaybookDocs; never evaluate generated source.
- T4.4 BenchmarkRunner with mandatory isolated workspaces, acceptance CommandCheck/AgentJudgeCheck, trials/variance, scoring, ExperimentLog TSV, live-event trace capture for OpenCode sessions, and swappable OpenCode/direct-AI executors. **Benchmark mode: exactly one run per user-configured model, then scorecard.**
- T4.5 Human review queue (approve/edit/skip/reject/abort), MetaLoop keep/discard with manual promotion default; `compound_run/status/init/last/wire`, `blueprint_*`, skill stats tools; TUI/config command surfaces; recursion-safe optional auto-trigger.
- T4.6 Prompt-evolution loop (AVO operator model): `PromptEvolutionService` first establishes a baseline tied to the evaluator manifest, then maintains lineage P (committed + failed attempts w/ lessons), knowledge base K (approved insights + failure lessons + skills + reference clone), and frozen train/hidden-holdout scoring f; variation steps are autonomous agent runs with reverse-prompt diagnosis of missing knowledge/reasoning/exploration/abstraction followed by edit–evaluate–diagnose cycles; commit discipline (verification gate + train and holdout scores strictly beat the stored baseline) appends a version block with bounded solution traces to the blueprint markdown module; stagnation supervisor redirects after `stagnationLimit` failures; markdown module parser/serializer round-trip.
- **AC:** end-to-end on fixture sessions: traces extracted → pending proposal reviewed/approved → ≥1 blueprint module materialized → benchmark mode scores 2 configured models (one run per model/task case) in isolated workspaces → evolution loop commits ≥1 improved markdown version with strict train/holdout improvement and journals a failed attempt with lesson → rollback path demonstrated.

### Phase 5 — packaging & release
- T5.1 Single-package export map (`.` → server plugin, `./tui`, `./collector`, `./cli`, `./modules/*`), README (install via `opencode2 plugin add`, historical collector/CLI usage, options reference, module authoring guide incl. bend), CHANGELOG.
- T5.2 Isolated-cache install verification (pack + install into a scratch project; confirm @ast-grep/napi loads; regex-fallback documented if not).
- T5.3 Publish workflow (npm trusted publishing) + versioning policy tied to plugin beta bumps.
- **AC:** fresh project: `opencode2 plugin add opencode-effect-harness` → plugin active (`/api/plugin`), native skills visible through the supported v2 registration path, `effect_harness_verify` works, and the TUI entrypoint loads.

## 5. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Beta API drift (plugin/effect/rc effect) | rework | pin exact versions; thin adapter layer isolates drift; contract tests |
| `@ast-grep/napi` native binary in isolated cache | patterns dead | verify early (T5.2 spike in Phase 1); RegexDetector fallback flag; document |
| Hook failure UX for blocked writes | confusing errors | reason text = guidance-catalog gate message (same as upstream); advisory mode for subagents |
| Synthetic message spam from feedback | noisy sessions | batch findings per write; queue delivery; rate-limit option |
| Compound cost blowups | $$ | stage-1 cheap model default, `--limit/--since`, per-run budget cap option, dry-run mode |
| Benchmark flakiness (LLM-judged scores) | unreliable keep/discard | deterministic CommandCheck preferred; judge rubrics versioned; N-run median option |
| TUI/server capability mismatch during beta | parity regression | keep server tools authoritative, TUI thin, and require packed-artifact TUI smoke tests |

## 6. Corrected scope and platform limits

- TUI is **in scope** for feature parity: `./tui`, `tui: true`, mode status/keymap, skill stats, and interactive compound review. Its Promise/JSX API is isolated from core Effects.
- Docker is not required for the first benchmark executor, but workspace isolation is mandatory. A Docker executor may be added later; same `BenchmarkEnvironment` contract applies.
- Historical mining is opt-in, sanitized, bounded, and approval-gated. No hidden chain-of-thought reconstruction.
- Named server agents/commands are not auto-created by the plugin under the documented v2 transforms. Plugin tools are always installed; named server definitions require config, while TUI commands are plugin-owned.

## 7. Revised completion gates

The migration is not complete when the package merely loads. It is complete
only when:

- all pi-effect-harness behavioral capabilities have a v2 adapter or an
  explicitly tested v2 UI equivalent;
- the exact target plugin package supports the chosen native skill-registration
  path, or the release includes a documented supported catalog/source path;
- every automatic verifier/compound run is project-scoped, idempotent, and
  excludes plugin-owned child sessions;
- passing deterministic checks still report semantic review as separate,
  explicit state;
- compound materialization requires an approval record and benchmarks cannot
  share a mutable workspace;
- the packed npm artifact passes typecheck, pattern self-check, adapter tests,
  and OpenCode2 load/TUI smoke tests.
