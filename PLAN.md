# opencode-effect-harness

Modular per-language verification packages + consolidated core for OpenCode v2.

Architecture: `docs/spec/05-implementation-adversarial-audit-2026-08-23.md`

## Status

| Component | Status | Evidence |
|---|---|---|
| shared (Journal, Command, Errors, Refs) | done | `packages/shared/src/` |
| harness-kit (enforcement kernel) | done | `packages/harness-kit/src/` |
| verify-kit (verification engine) | done | `packages/verify-kit/src/` |
| compound-kit (compound domain) | done | `packages/compound-kit/src/` |
| effect-harness (plugin composition root) | done | `packages/effect-harness/src/index.ts` |
| module-typescript (53 skills / 46 patterns / 4 guidance) | done | `packages/module-typescript/` |
| module-bend (own catalogs) | done | `packages/module-bend/` |
| Companion collector/CLI | done | `effect-harness/src/companion/` |
| LiveSessions adapter | done | `effect-harness/src/LiveSessions.ts` |

## Validation

```sh
bun install
bunx tsc --noEmit     # 0 errors
bunx vitest run       # 32/32 passing
```

## Remaining (blocked on external dependencies)

| Item | Blocker |
|---|---|
| Mine-evolve execution | needs running server with real sessions to mine |
| Packed-artifact e2e probe | needs npm publish or local tarball install into scratch project with running server |
| Companion TUI | declared reduced scope; CLI shipped instead |
| effect-tsgo diagnostics | @effect/tsgo installed; native TS-Go binary unavailable in this container |

## Key constraints

- `effect` pinned to `4.0.0-rc.110`
- Zero imperative loops in src
- All code must pass our own migrated Effect-v4 pattern catalog
