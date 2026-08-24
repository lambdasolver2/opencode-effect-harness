# opencode-effect-harness

An [OpenCode v2](https://opencode.ai/v2/) plugin harness for Effect v4 development.

## Architecture

```
packages/
  shared/              neutral primitives (Journal, Command contract, Model refs)
  harness-kit/         enforcement kernel (Intent, Projection, Matcher, Rules, Controller)
  verify-kit/          verification engine (Checker, Orchestrator, Critic, Evidence)
  compound-kit/        compound domain (Blueprint, Distill, Benchmark, Evolution, Store)
  module-typescript/   TS verification module (53 skills / 47 patterns / 4 guidance)
  module-bend/         Bend verification module (own catalogs)

src/                   plugin composition root + OpenCode adapter
src/companion/         headless CLI for session collection
```

## Install (source)

Packaging/publishing is still pending (audit AUDIT-043): the repo is a private
workspace and cannot yet be installed as a published artifact. Install from a
local clone:

```jsonc
// opencode.jsonc
{ "plugins": ["./src/index.ts"] }
```

## Tools

| Tool | Description |
|---|---|
| `effect_harness_verify` | Deterministic checks + pattern findings + skill evidence |
| `effect_harness_critic` | Independent read-only reasoning audit |
| `effect_harness_compound` | Planned — returns an explicit not-wired error (REM-4) |
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
`write`/`edit` are fully gated pre-write; `patch`-style tools rely on post-write
feedback plus ledger recording.

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
