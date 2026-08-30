# opencode-effect-harness

Modular per-language verification packages + consolidated core for OpenCode v2.

Architecture: `docs/spec/01-architecture.md`
Normative implementation audit (append-only): `docs/spec/05-implementation-adversarial-audit-2026-08-23.md`
Benchmark store spec (REM-4 benchmark mode, DB-first): `docs/spec/06-benchmark-store-spec.md`

## Status

| Component | Status | Evidence |
|---|---|---|
| shared (Journal, Command, Errors, Refs, PathGuard) | done | `packages/shared/src/` |
| harness-kit (enforcement kernel) | done | `packages/harness-kit/src/` |
| verify-kit (verification engine) | done — bounded ChangeSet and scan-health errors wired | `packages/verify-kit/src/` |
| compound-kit (compound domain) | pure domain + explicit persistent Evolution adapter done; benchmark mode wired DB-first (TaskStore port + SQLite adapter `packages/bench-store` + runner, spec 06); mine-evolve NOT wired (tool returns explicit REM-4 error) | `packages/compound-kit/src/`, `packages/bench-store/src/` |
| effect-harness plugin composition root | done | `src/index.ts` |
| module-typescript (54 skills / 47 patterns / 4 guidance) | done — complete manifest with counts, sizes, fingerprints, and inventory | `packages/module-typescript/` |
| module-bend (own catalogs) | done | `packages/module-bend/` |
| Companion collector/CLI | done | `src/companion/` |
| Live session adapter | done | `src/session/Live.ts` |

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
appendices `AUDIT-EVENT-2026-08-26-01` and `AUDIT-EVENT-2026-08-26-02`
(fifth-pass findings and remediation):

- enforcement completeness: shell writes remain post-write-only by documented
  design; fake-context tests are still required for complete hook proof
- compound release proof: lock-abandonment recovery and end-to-end Store/Evolution
  execution through the currently unwired REM-4 tool
- adapter/release proof: authenticated live-server behavior and packed-artifact
  external install probe

External-dependency items: mine-evolve execution (needs a running server with
real sessions) and companion TUI (declared reduced scope; CLI shipped).

## Key constraints

- `effect` pinned to `4.0.0-rc.110`
- Zero imperative loops in src
- All code must pass our own migrated Effect-v4 pattern catalog
- Self-pattern baseline is shrink-only: new hits fail CI, stale entries fail too
