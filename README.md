# opencode-effect-harness

An [OpenCode v2](https://opencode.ai/v2/) plugin harness for Effect v4 development.

## Architecture

```
packages/
  shared/              neutral primitives (Journal, Command contract, Model refs)
  harness-kit/         enforcement kernel (Intent, Projection, Matcher, Rules, Controller)
  verify-kit/          verification engine (Checker, Orchestrator, Critic, Evidence)
  compound-kit/        compound domain (Blueprint, Distill, Benchmark, Evolution, Store)
  module-typescript/   TS verification module (54 skills / 47 patterns / 4 guidance,
                       assets pinned by assets/manifest.tsv)
  module-bend/         Bend verification module (own catalogs)

src/                   plugin composition root + OpenCode adapter
  Session/             host session domain (location resolver, child origins, executor)
  Benchmark/           DB-first benchmark domain (Runner, Tool) — spec 06
src/companion/         headless CLI for session collection
```

## Install (one-line)

### Option A — GitHub (works today, no npm publish needed)

From any project:

```sh
bun add github:lambdasolver2/opencode-effect-harness
```

```jsonc
// opencode.jsonc — bun resolves the GitHub checkout automatically; plugin loads via package name
{
  "plugins": [
    {
      "package": "opencode-effect-harness",
      "options": {
        "compound": { "enabled": true }
      }
    }
  ]
}
```

CI (GitHub Action) validates every push to `main` in `.github/workflows/ci.yml` (bun install → tsgo/tsc → vitest → Scan/Catalog); no token required. A tagged `v*` push optionally publishes to npm if `NPM_TOKEN` is set.

### Option B — npm (after first `v*` tag)

Once the workflow publishes:

```sh
bun add opencode-effect-harness
```

```jsonc
// opencode.jsonc — same shape, package from npm
{ "plugins": [{ "package": "opencode-effect-harness" }] }
```

### Local clone (development)

```jsonc
// opencode.jsonc
{ "plugins": ["./src/index.ts"] }
```

> Skills (`assets/skills/*.md`) and guidance (`assets/guidance/*.md`) are **auto-registered** by the plugin at startup (`src/index.ts:377` `ctx.skill.transform` + `src/index.ts:1758` `guidanceHeader` injected via `session.hook('context')`). You do **not** need to copy the repo's `AGENTS.md` for skills to work — it is project instructions for *this* repo. To enforce the same 4-gate policy in a consumer project, copy the `AGENTS.md:3` Mandatory validation gates section (tsgo/tsc/vitest + `effect_harness_verify`) into that project's `AGENTS.md`; OpenCode reads `AGENTS.md` automatically at session start, while the plugin enforces the gate and injects the header regardless of where `AGENTS.md` lives.

## Tools

| Tool | Description |
|---|---|
| `effect_harness_verify` | Deterministic checks + pattern findings + skill evidence |
| `effect_harness_critic` | Independent read-only reasoning audit |
| `effect_harness_compound` | Benchmark store ops (spec 06): tasks, model profiles, benchmark jobs with scored trials + leading solution. mine-evolve: honest REM-4 error |
| `harness_skill_stats` | Show loaded effect-* skills for this session |
| `harness_toggle` | Toggle harness mode per-project |

## Enforcement hooks

| Hook | Behaviour |
|---|---|
| `execute.before` | Skill gate blocks unprepared Effect writes; read tracking; pre-write snapshots with project-root containment |
| `execute.after` | Credits skill reads; diff-based changed spans -> kernel pattern feedback appended INLINE to the tool result; change ledger for auto-verify |
| `session.hook('context')` | Injects policy header; restricts internal worker tools |

Shell coverage: narrow DESTRUCTIVE signatures are BLOCKED pre-write for strict
agents — fork bombs, `mkfs`, `dd if=`, `git reset --hard`, `git clean -fd`,
`chmod -R 777`, relative-path `rm`/`mv` escapes, and any flagged `rm`
targeting filesystem root. Other `bash`/`shell` writes remain post-write-only
by design (detection, not prevention).

Pre-write gating: `write`/`edit`/`multiedit` are fully gated. Patch-style tools
(`apply_patch`/`patch`) route their patch text through the same gate for every
extracted target path; unparseable patches are fail-closed for strict agents.
Every extracted path — including patch-embedded ones — is snapshot-captured
with symlink-realpath containment and recorded in the change ledger.

### Honest verification semantics

- Reports carry `patternScanStatus` (`ok` / `error` / `skipped`) and optional
  `patternScanError`; an errored deterministic scan makes `overall: "error"`.
- Semantic review enabled-but-unavailable ⇒ explicit report `error`, never a
  silent skipped→passed fold.
- Auto-run dedupe persists a bounded processed-event-id set per project/session;
  successful events are at-least-once and out-of-order replays within the
  retained window are suppressed.
- Module construction failures are logged and represented in
  `VerifierReport.moduleLoadFailures`.
- Asset integrity: `manifest.tsv` pins every shipped file, semantic counts,
  byte sizes, and content fingerprints; unlisted files fail construction.

Release limitations: the compound tool intentionally returns an explicit
REM-4 not-wired error; the root package is a private workspace and is not yet
validated as an externally installable artifact. Cross-process lock contention
fails closed, while abandoned locks require operator inspection. The fake
OpenCode composition-root contract is covered; an authenticated live-server
smoke test remains partial because the server exposes no custom tool-list API.

## Development

```sh
bun install
bun run typecheck:tsgo    # tsgo --noEmit (Go-based TypeScript compiler)
bunx tsc --noEmit         # fallback typecheck
bun test                  # or bunx vitest run
bun run check             # typecheck + tests
```

## Adding a language module

Create `packages/module-yourlang/` with:

```text
package.json     deps: effect, opencode-verify-kit (workspace:*)
assets/
  skills/        your-language SKILL.md files
  patterns/      your-language .md detector files
src/index.ts     exports createModule(): VerificationModule
```

Register the module ID in `src/opencode/Options.ts` and add the loader entry
in the composition root. No core changes needed.
