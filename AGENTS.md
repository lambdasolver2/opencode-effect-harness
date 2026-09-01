# Project instructions

## Mandatory validation gates

After EVERY change (even minor), run these **in order** from the repo root — no change is done until all four are green:

```sh
bunx tsgo --noEmit          # 1. Effect-aware typecheck (Go compiler) — MUST pass
bunx tsc --noEmit           # 2. fallback typecheck — MUST pass
bunx vitest run             # 3. full test suite — MUST pass
# 4. effect-verified: call effect_harness_verify — MUST be overall:passed
```

4 is `effect_harness_verify` (`src/index.ts:389` → `Orchestrator.verify` `packages/verify-kit/src/Orchestrator.ts:86`): deterministic checkers + pattern scan (`findPatternMatches` on touched files) + `skillEvidence` + `overall` `packages/verify-kit/src/Report.ts:110`, persisted to `.effect-harness/reports/*-verify.json` `src/index.ts:1689`. Trigger it manually after 1-3 are green — `verify.trigger` is `manual` (`src/Options.ts:145`), so no auto-run. Omit `touchedFiles` to verify the session ledger; on `overall:failed|error` fix and re-call (ledger retained `src/index.ts:1614`). Do not claim done/push/PR without a `verify overall:passed` report path.

If any gate (1-4) fails, fix before continuing. Never skip or ignore failures. The per-write pattern advisory `src/index.ts:1419` is **advisory only** and does not replace gate 4.

## Pattern catalog self-check

The repo ships its own Effect-v4 anti-pattern detectors in
`packages/module-typescript/assets/patterns/*.md`. These use ast-grep
(structural code matching) and regex to detect code smells.

Key patterns to watch for when writing code:

- **No imperative loops** — use `Arr.map/filter/reduce`, `Effect.forEach`
- **No throw inside Effect.gen** — use `Effect.fail` with typed errors
- **No native fetch** — use Effect HTTP client
- **No direct JSON.parse/stringify** — use Schema codecs at boundaries
- **No process.env** — use Config service
- **No mutable state outside Ref** — use Ref/SynchronizedRef
- **No node: imports** — use platform services (FileSystem, Path, etc.)
- **No as any / as never** — validate at boundaries with Schema

Whole-repository self-scan against ALL shipped detectors (new violations fail;
the `src/pattern/Baseline.ts` debt list must shrink, never grow):

```sh
bunx vitest run src/pattern/Scan.test.ts
```

Catalog integrity check (loads every shipped detector/skill and fails loudly
on malformed or missing assets):

```sh
bunx vitest run packages/harness-kit/src/Catalog.test.ts
```

## Planning & documents

- Never write plans or specs to `~/.opencode/plan/`. Keep all planning documents
  inside the repository under `docs/spec/`. `PLAN.md` at the repo root links them.
- The canonical migration spec lives in `docs/spec/`. Treat
  `docs/spec/05-implementation-adversarial-audit-2026-08-23.md` as the
  normative implementation audit (append-only).

## How the pattern detection works

Each pattern is a Markdown file with YAML frontmatter defining:
- `detector: ast` — uses ast-grep structural query (matches code shape)
- `detector: regex` — uses a regex pattern (with optional comment-skipping)
- `glob` — which files to match (e.g. `'**/*.{ts,tsx}'`)
- `level` — severity (`critical`, `high`, `medium`, `warning`, `info`)
- `suggestSkills` — effect-* skill IDs to load for guidance

After each successful write/edit, the plugin runs every detector against the
post-write content. Matches are sent back as a single advisory message with
the pattern's full guidance body and suggested skills. This is **advisory only** — it does not replace the gates below.

## Harness — manual verification & adversary review

The plugin (`src/index.ts:165` `opencode.effect-harness`) exposes two manual tools. `verify.trigger` defaults to `manual` (`src/Options.ts:145`), so agents **must** call them explicitly — no auto-run after tests.

### 1. Deterministic verifier — `effect_harness_verify` (`src/index.ts:389`)

Runs the full pipeline `packages/verify-kit/src/Orchestrator.ts:86`: applicable checkers (`typecheck`/`test`/`build` via `module-typescript` etc.), deterministic pattern scan (`findPatternMatches` on touched files), `skillEvidence` (`minEffectSkills:4`), optional semantic review, then `overall: passed|failed|error` (`packages/verify-kit/src/Report.ts:110`). Report is persisted atomically to `.effect-harness/reports/<ts>-verify.json` (`src/index.ts:1689`).

**Manual trigger:**

```json
{ "touchedFiles": ["src/foo.ts", "packages/bar/src/index.ts"] }
```

Omit `touchedFiles` to verify the session's change ledger (`ChangeLedger` `src/index.ts:428` + `src/change/Ledger.ts`). Containment-checked — paths escaping the project root fail closed (`src/index.ts:415`).

**When to call:**
- After **every** validation gate pass (`tsgo`/`tsc`/`vitest` green) and before claiming a task is done.
- After completing a feature, fix, or refactor that touches `src/` or `packages/`.
- Before opening a PR or pushing — attach the `report:` path from the tool output.
- On `overall:failed|error` — fix, then re-call (failed runs retain the ledger for retry `src/index.ts:1614`).

### 2. Adversary critic — `effect_harness_critic` (`src/index.ts:493`)

Spawns a **read-only** `explore` worker (`src/Options.ts:152` `critic.workerAgent`) in an isolated child session (`src/index.ts:548` + `Origins` guard `src/session/Origin.ts`). It audits **reasoning**, not code: `logical-flaw | hallucination | domain-error | reference-mismatch | architecture-drift | missing-consideration` (`packages/verify-kit/src/Critic.ts:29`). Findings that cite a reference the critic did not open are dropped (`filterUnverifiedFindings` `Critic.ts:220`). Output is strictly decoded (`decodeWorkerOutput` `Critic.ts:111`); undecodable output is returned as `UNVERIFIED`, never as `passed`.

**Manual trigger:**

```json
{ "summary": "Implemented X, chose Y because Z, touched A/B, plan ref docs/spec/01-*.md", "focus": "full" }
```

- `summary` **required**, `>=10 chars` (`src/index.ts:516`).
- `focus` enum `feature|plan|architecture|drift|full` default `full` (`Critic.ts:10`, `src/index.ts:501`).

**When to call:**
- After finishing a plan/spec item or multi-file feature — set `focus:"plan"` and include the plan ref in `summary`.
- When you made an architecture/domain decision — `focus:"architecture"`.
- When drift/hallucination is suspected or before marking audit findings as closed — `focus:"drift"`.
- At explicit checkpoints — the only safe auto-triggers are `critic.autoAfterExplicitCheckpoint` / `autoEveryNBuildExecutions` (`src/Options.ts:273`), off by default.

**Reading results:** `verdict: sound|concerns|flawed` + `findings[]` with `severity`/`kind`/`claim`/`evidence`/`suggestion` and `checkedReferences[]`. Also persisted to `.effect-harness/critic-reports/*-critic.json` (`src/index.ts:1728`). Treat `unavailable` / `decoded:false` as **not passed** (`src/index.ts:588`).

### Quick reference

| Tool | Purpose | Auto? | Must-read output |
|---|---|---|---|
| `harness_skill_stats` | `loaded effect-* skills` for session | — | `src/index.ts:738` |
| `harness_toggle` | enable/disable harness per-project | — | `src/index.ts:761` |
| `effect_harness_verify` | deterministic checks+patterns+skills | only if `verify.trigger:"auto"` `src/index.ts:1533` | `.effect-harness/reports/` |
| `effect_harness_critic` | adversary reasoning audit | only on explicit checkpoint/cadence | `.effect-harness/critic-reports/` |
