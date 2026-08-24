# Changelog

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
