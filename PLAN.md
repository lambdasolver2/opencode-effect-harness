# opencode-effect-harness — Implementation Plan

Consolidated single-package plugin (`packages/opencode-effect-harness`) with
bounded contexts `shared / enforcement / verification / compound / opencode`,
plus the reusable append-only Journal abstraction. Normative contract:
[`docs/spec/04-adversarial-audit.md`](docs/spec/04-adversarial-audit.md).
Implementation audit + remediation log:
[`docs/spec/05-implementation-adversarial-audit-2026-08-23.md`](docs/spec/05-implementation-adversarial-audit-2026-08-23.md)
(append-only; see AUDIT-EVENT-2026-08-23-07 for the current state).

## Status (truthful, evidence-backed)

| Area | Status | Evidence |
|---|---|---|
| Shared contracts + append-only Journal | done | `src/shared/*`, `test/Journal.test.ts` |
| Enforcement kernel (strict catalog, degraded projection, full layer graph) | done | `src/enforcement/*` (legacy parity suites still green) |
| Verification engine + Orchestrator + per-module catalogs | done | `src/verification/*` |
| Critic contract + append-only findings journal wiring | core done | `src/verification/Critic.ts`, critic tool persists review events |
| Compound domain (blueprints, distill, proposals, benchmark, evolution, store) | core done | `src/compound/*`, `test/Remediation.test.ts` |
| OpenCode adapter (options, exec, sessions, origins, mode, ledger, change ledger, capability-probed skills, tools/hooks, auto-verify) | implemented, **live-server gate open** | `src/opencode/*`, `src/index.ts` |
| Legacy four-package tree | frozen baseline (tests still run) | `packages/harness-kit` etc. |
| Companion collector / TUI | **deferred** (declared reduced scope) | port defined in `compound/Source.ts` |
| Packed-artifact install probe | **blocked** on packaging/bundling step | REM-5 |
| Live OpenCode2 e2e smoke | **blocked** (no server here) | REM-5 |
| tsgo toolchain | **blocked** (bare `tsgo` 404) — plain tsc used | META-PROMPT §2.4 |

## Commands

```sh
bun install
bunx tsc --noEmit      # 0 errors required
bunx vitest run        # 77/77 passing required
```

After ANY major change also run: catalog check (53/46/4), boundary grep for
imperative loops, and append results to the audit journal.

## Remaining work

1. Migrate remaining high-value legacy fixtures into new test tree, then delete legacy packages.
2. Consolidate assets (move or bundle) to remove `../effect-harness` default path.
3. Companion collector implementation + packed-artifact probe.
4. Live-server smoke test once an OpenCode2 server is reachable.

## Key constraints

- `effect` pinned to `4.0.0-rc.110` exactly (matches pinned plugin beta).
- Host imports confined to `src/index.ts` + `src/opencode/`.
- Zero imperative loops in source; Effect combinators only (grep-enforced).
- All code must pass our own migrated Effect-v4 pattern catalog.
