# opencode-verify-kit

Host-neutral verification engine: language modules, checker execution, skill-evidence assessment, and report assembly. **Zero host dependencies.**

## What this is

Runs deterministic checks (typecheck, tests, lint) against touched files using per-language verification modules. Each module carries its own skill/pattern knowledge base. An optional semantic `Reviewer` can be plugged in for LLM-based review. The orchestrator composes these into a single `VerifierReport`.

## Domain types

### `VerificationModule`

The central extension point. A per-language module that knows:

- **Which files it applies to** (`appliesTo`: e.g. `*.ts`, `*.bend`)
- **What checkers to run** (`checkers(ctx)` → typecheck / test / lint / build specs)
- **How to parse diagnostics** (`parseDiagnostics(spec, output)` → structured issues)
- **What its knowledge base is** (`skills`: catalog of SKILL.md entries with min-required threshold; `patterns`: ast-grep/regex detectors)

The bundled TypeScript module ships all 53 migrated `effect-*` skills and 46 detectors. A bend module would provide its own catalogs — no TypeScript assumption in the engine.

Modules are executable values loaded by a `ModuleLoader` service. JSON options can select built-in IDs or define data-only command modules; rich logic requires an explicitly installed package.

### `CheckerSpec` + `CommandSpec`

A checker is a single deterministic validation step. Commands are **argv values** (`{executable, args[], cwd?, timeoutMs, maxOutputBytes}`) — never interpolated shell strings (spec A12). This prevents injection attacks and makes timeouts and output boundaries explicit.

Kinds: `typecheck` (tsc --noEmit), `test` (vitest/jest/bun), `lint`, `build`, `custom`. Each kind has a different diagnostic parser.

### `CheckerResult`

One checker's execution outcome: verdict (`passed`/`failed`/`error`/`skipped`), exit code, collected diagnostics, duration. A verdict of `error` means the checker itself failed (e.g. tsc crashed), not that the code has errors.

### `Evidence`

Deterministic skill-evidence assessment. Answers: "did this session have enough relevant skills loaded when it wrote Effect code?" Pure decision from `{codeDetected, loadedSkills, minRequired}`:

- No Effect code detected → `skipped`
- `minRequired ≤ 0` → `skipped` (policy off)
- Distinct loaded skills ≥ minRequired → `sufficient`
- Otherwise → `insufficient`

`insufficient` fails the overall report even if all language checks pass.

### `SemanticReview`

Optional LLM-based review of reasoning quality (not just code correctness). Produced by a pluggable `Reviewer.Service` that spawns a read-only worker session. Status is one of `passed`/`failed`/`error`/`skipped` — a skipped review is explicit, never folded silently into a pass (spec A5).

Findings include severity, kind (logical-flaw/hallucination/domain-error/reference-mismatch/architecture-drift/missing-consideration), claim, evidence, and suggestion.

### `VerifierReport`

Assembled report combining all channels. The `overall` verdict is derived from component verdicts and never hides a problem:

```
overall = error    if any check errored
        | failed   if any check failed OR evidence insufficient OR semantic failed
        | passed   if all channels pass
```

## Pipeline

```
VerifyRequest {sessionID, projectRoot, touchedFiles, trigger}
  │
  ├─ Registry.resolve(touchedFiles) ──→ applicable VerificationModules
  │
  ├─ for each module:
  │    checkers(context) → [CheckerSpec]
  │    for each spec:
  │      Exec.run(command) → {exitCode, stdout, stderr}
  │      parseDiagnostics(spec, output) → Diagnostic[]
  │      → CheckerResult{verdict, exitCode, diagnostics, duration}
  │
  ├─ Evidence.assess(loadedSkills, minRequired) → SkillEvidence
  │
  ├─ Reviewer.review(request, checks) → SemanticReview     [optional]
  │
  └─ VerifierReport {language, patterns, skills, semantic, overall}
```
