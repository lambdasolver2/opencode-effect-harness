# opencode-effect-harness

Modular per-language verification packages + consolidated core for OpenCode v2.

Architecture: `docs/spec/01-architecture.md`
Normative implementation audit (append-only): `docs/spec/05-implementation-adversarial-audit-2026-08-23.md`

## Status

| Component | Status | Evidence |
|---|---|---|
| shared (Journal, Command, Errors, Refs, PathGuard) | done | `packages/shared/src/` |
| harness-kit (enforcement kernel) | done | `packages/harness-kit/src/` |
| verify-kit (verification engine) | done — known honesty gaps tracked | `packages/verify-kit/src/` |
| compound-kit (compound domain) | pure domain done; execution NOT wired (tool returns explicit REM-4 error) | `packages/compound-kit/src/` |
| effect-harness plugin composition root | done | `src/index.ts` |
| module-typescript (53 skills / 47 patterns / 4 guidance) | done — assets pinned by `assets/manifest.tsv` (counts + byte sizes; content hashes landing) | `packages/module-typescript/` |
| module-bend (own catalogs) | done | `packages/module-bend/` |
| Companion collector/CLI | done | `src/companion/` |
| LiveSessions adapter | done | `src/LiveSessions.ts` |

## Validation

```sh
bun install
bunx tsgo --noEmit     # Effect-aware typecheck — must pass
bunx tsc --noEmit      # fallback typecheck — must pass
bunx vitest run        # full suite incl. whole-repo 47-detector self-scan
```

Last recorded at `2cc6817`: both typechecks clean; vitest 20 files / 53 tests
green, including `SelfPatternScan.test.ts` (baseline shrink-only enforcement)
and `Catalog.test.ts` (47-pattern inventory integrity). Test count grows as
coverage grows; the gates above are the source of truth, not this number.

## Remaining (tracked in the normative audit)

Open remediation items are listed with evidence in
`docs/spec/05-implementation-adversarial-audit-2026-08-23.md`,
appendix `AUDIT-EVENT-2026-08-26-01` (fifth pass):

- verification truthfulness: pattern-scan health and absent-reader states must
  influence `overall`; bounded ChangeSet must reach the semantic reviewer;
  module-load failures must appear in reports
- enforcement completeness: multi-file patch gating; session-scoped snapshots
- asset integrity: content fingerprints + extra-file detection in the manifest
- durable auto-run dedupe window (out-of-order replays)
- compound remainders (cross-process locks, Evolution→Store persistence),
  required only if compound becomes product scope
- adapter/release proof: fake-context contract suite, live-server smoke,
  packed-artifact install probe

External-dependency items: mine-evolve execution (needs a running server with
real sessions) and companion TUI (declared reduced scope; CLI shipped).

## Key constraints

- `effect` pinned to `4.0.0-rc.110`
- Zero imperative loops in src
- All code must pass our own migrated Effect-v4 pattern catalog
- Self-pattern baseline is shrink-only: new hits fail CI, stale entries fail too
