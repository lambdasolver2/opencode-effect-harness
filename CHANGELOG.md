# Changelog

## Unreleased

### Benchmark store (compound benchmark mode, spec 06)

- DB-first benchmark workflow: SQLite store (`packages/bench-store`, Effect SQL) with
  immutable task revisions, pending→terminal trial state machine (guarded UPDATE …
  RETURNING, crash-resumable), atomic job completion (status + INSERT-only leading
  solution + hash-verified history in one transaction), per-trial trace events.
- `effect_harness_compound` benchmark ops: `task.create/update/get/list`,
  `profile.add/list`, `benchmark.start/status/leading/history/trial`;
  `mine-evolve` remains an explicit REM-4 error.
- OpenCode candidate/judge executor: catalog + exact `Model.VariantID` validation,
  isolated per-trial `location`, origin-registered read-only children,
  `session.generate` as the canonical output path, interrupt only on timeout.
- Evaluator registry (`design-brief@1`): Schema-decoded DesignBrief contract,
  bounds checks, ast-grep snippet syntax diagnostics, schema-validated judge
  dimensions (every rubric dimension bounded to [0,1]).
- Motel/OTLP visibility (opt-in `compound.benchmark.otel`): `benchmark.*` span/log
  attributes; prompt/output content is never exported.
- Per-agent opt-out via agent `request.body` key `opencode-effect-harness: false`.

### Catalog

- TypeScript module: **54 skills / 47 patterns / 4 guidance** (upstream sync adds
  `effect-scheduling`; `prefer-recursion-over-while` is a documented local extra).
- API corrections: `Schema.TaggedError` / `Schema.Error` (was beta-era
  `TaggedErrorClass` / `ErrorClass` naming), manifest regenerated.

## 0.1.0

Initial release.

### Migrated from pi-effect-harness

- Skill gate: blocks Effect-code writes until 4 `effect-*` skills are loaded
- Pattern feedback: 46 ast-grep/regex detectors with full guidance + suggested skills
- Policy header: merged guidance docs + runtime policy lines
- Reference clone: shared user-level `effect-smol` clone at `~/.cache/effect-v4/`
- Skill telemetry: JSONL metrics log + `/effect-skill-stats` tool
- Mode toggle: per-project persistence via OpenCode storage

### New: Verifier subsystem

- `effect_harness_verify` tool: language checkers + Effect pattern/skill-evidence + optional semantic review
- Per-language verification modules (TypeScript bundled, bend example)
- Deterministic checks never invoke an LLM; semantic review is explicitly separated

### New: Critic subsystem

- `harness_critic` tool: independent read-only reviewer for builder reasoning
- Detects logical flaws, hallucinations, architecture drift, domain/reference errors

### New: Compound subsystem

- Benchmark mode: one run per configured model on a task suite, scored
- Mine & evolve mode: session mining → two-stage distillation → AVO-style prompt evolution
- Blueprint markdown modules: testable prompts with solution traces and scores
