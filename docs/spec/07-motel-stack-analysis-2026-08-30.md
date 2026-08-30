# Motel + Stack Deep Analysis — Best Concepts for opencode-effect-harness

**Date:** 2026-08-30
**Sources:** `kitlangton/motel@0.2.7` (cloned to `/tmp/reference/motel`), `kitlangton/stack@0.4.6` (`/tmp/reference/stack`)
**Purpose:** Extract the best domain types and implementations from well-written Effect repos and decide what to steal, what to keep, and what to refactor in this plugin (which must have a TUI and bun SQL, per user request).

---

## 1. Motel — What Is Excellent

### Stack
- `effect@4.0.0-beta.90`, `@effect/platform-bun`, `@effect/opentelemetry`, `@effect/atom-react`, `bun:sqlite` raw (`new Database(path, {create, readonly})` + `Effect.acquireRelease`), `protobufjs`, `@opentui/core@0.4.2` + `@opentui/react@0.4.2` + `react@19`.

### Domain Types (`src/domain.ts`)
All `Schema.Struct` with `Schema.annotateKey({description})` + `.annotate({identifier: "..."})` — the single source of truth for HTTP API, DB, and TUI. Highlights:
- `TraceSpanItem` / `TraceItem` / `TraceSummaryItem` / `SpanItem` / `LogItem` / `FacetItem` / `StatsItem` with `DateFromString`, `StringRecord`, `TraceSpanStatus`.
- `AI_FTS_KEYS` (18 keys) + `isAiSpan(tags)` via `for (key of AI_FTS_KEYS) if (key in tags) return true` (O(n) cheap, no `Object.keys` allocation).
- `AiCallSummary` / `AiCallDetail` with `AiUsage` — normalized AI telemetry.

**Takeaway for harness:** Our `Task`/`Trial`/`History` domain already uses `Schema.Class` (good), but we should add `annotateKey` + `identifier` everywhere (currently only `Task`, `TrialRecord` have identifiers, not `HistoryRecord`). Also adopt `isAiSpan` pattern for `isBenchmarkSpan` etc. if we add AI telemetry.

### SQL — `src/services/TelemetryStore.ts` (2554 LOC, raw `bun:sqlite`)
**Writer vs Readonly divergence** (critical):
```ts
// Writer
PRAGMA cache_size=-65536 (64MB), mmap_size=268M, auto_vacuum=INCREMENTAL (before CREATE!), journal_mode=WAL, synchronous=NORMAL, temp_store=MEMORY, wal_autocheckpoint=4000, journal_size_limit=128MB
// Readonly
PRAGMA query_only=1, busy_timeout=15000, cache_size=-65536, mmap_size=268M
// Both: PRAGMA analysis_limit=1000; PRAGMA optimize; busy_timeout=15000
```
- Single-writer invariant via `RpcClient` pool `size:1` + `BunWorker` (`AsyncIngest` + `TelemetryQuery` off-thread workers) — HTTP loop never blocks on sync SQLite.
- Materialized `trace_summaries` + `trace_summary_cursor` in `motel_maintenance` — list/search never `GROUP BY spans`, reconciled incrementally via `rowid > cursor`.
- FTS5 `span_operation_fts`, `log_body_fts`, `span_attr_fts(content='span_attributes', tokenize='unicode61 remove_diacritics 2')` with triggers `WHEN new.key IN (AI_FTS_KEYS)` + incremental backfill `span_attr_fts_v1 = "cursor:max"` in 500-row /100ms slices.
- Two-phase `searchSpans` (lite columns + `candidateLimit` over-fetch when `parentOperation` post-filter, then bulk hydrate via `WHERE (trace_id,span_id) IN (VALUES...)`).
- Retention: 3 decoupled loops — `cleanupExpired` (time+size, BATCH_SIZE=500, `PRAGMA wal_checkpoint(RESTART)` + `incrementalFtsMerge`), `reclaimSpace` (adaptive `incremental_vacuum` 2k/20k/50k pages by freelist ratio), `planner refresh` (15m `PRAGMA optimize`).

**For harness `bench-store`:** We already use `@effect/sql-sqlite-node` (better than raw `bun:sqlite` for Effect — `SqlClient` + `Migrator` + `Reactivity` + `Layer.scoped`). Keep it, but **steal**:
- PRAGMA tuning (WAL, cache, mmap, busy_timeout) — currently we rely on defaults; should add explicit `PRAGMA` after `Migrator` (like motel).
- Writer/Readonly split (`BenchmarkStoreLive` vs `BenchmarkStoreReadonlyLive` via `SqliteClient.layer({filename, readonly:true})`) — currently single writer.
- `trace_summaries` cursor pattern for `listTasks`/`listHistory` if we grow.
- `CachedLoader` dedup factory (`Map + inflight Map` with `hash`, `ensure`/`refresh`/`invalidate`) for facets — we can use for `taskStore.listTasks` caching in TUI.

### TUI — `@opentui/react` + `@effect/atom-react`
- `createCliRenderer({exitOnCtrlC:false, screenMode:"alternate-screen"})` + `createRoot(renderer).render(<RegistryProvider><StartupGate/></RegistryProvider>)`.
- `StartupGate` handles daemon ensure + conflict screens before `<App/>`.
- `App.tsx` = `useTerminalDimensions` + `useAtom(Atom)` + `useAppLayout` (pure layout math) + `useTraceScreenData` (data layer) + `useKeyboardNav` (1000+ LOC central router) + virtual-windowed `TraceWorkspace`.
- `atoms.ts` as single state source (`Atom.make(val).pipe(Atom.keepAlive)`), `cachedLoader.ts` dedup, `aiChatModel.ts` pure chunk transforms, `waterfallModel.ts` pure layout.

**For harness TUI:** We have no TUI (declared reduced scope). Must add `src/tui.tsx` with `tui: true` in `Plugin.define`, using `@opentui/core` + `@opentui/react` + `@effect/atom-react` (or `@effect/atom`). Keep it minimal: header (harness mode + skill stats), tab for `verify` (last report), tab for `benchmark` (jobs list), footer hints. Use `useTerminalDimensions`, `useKeyboard`, `useRenderer`. Use `Atom` for selected tab, and `CachedLoader` for `benchStore.listHistory`.

### Effect Patterns (Motel)
- `Context.Service` + `Layer.effect` + `ManagedRuntime.make` for `TelemetryStore`/`AsyncIngest`/`Locator`.
- `Effect.fn("motel/...")` for named spans (we use `Effect.gen` without `Effect.fn` — should add).
- `Effect.acquireRelease` for DB lifecycle, `Effect.cachedInvalidateWithTTL(..., Infinity)` for lazy worker, `Effect.repeat(Schedule.spaced(...))` for retention, `Effect.retry(Schedule.spaced("50ms"))` for query worker.
- `HttpApi` (`HttpApi.make` + `HttpApiGroup` + `HttpApiEndpoint` with `Schema` + `OpenApi`) + `HttpApiBuilder` + `BunHttpServer` + `HttpMiddleware.tracer`.

**For harness:** Add `Effect.fn` everywhere, use `ManagedRuntime` for `queryRuntime`/`storeRuntime` (we currently use `Layer` directly), consider `HttpApi` for `BenchmarkTool` ops if we expose HTTP.

---

## 2. Stack — What Is Excellent

### Stack = Squash-safe stacked PR repair CLI (not LIFO)
- `effect@4.0.0-beta.64`, `@effect/platform-node`, `@effect/vitest@beta.64`, `vitest@4.1.7`, `Bun.build` esm.
- Domain `src/domain/model.ts` (418 LOC) — **exemplary**:
  - Branded primitives: `BranchName = Schema.String.pipe(Schema.brand("BranchName"))`, `PullUrl`, `PrNumber = Schema.Int.pipe(Schema.brand("PrNumber"))` + `branchName`/`pullUrl`/`prNumber` helpers.
  - `Schema.Class` entities: `BranchRef`, `PullRef`, `StackLink`, `StackState`, `UndoEntry`, `UndoState` (version 1|2 additive), `StatusNode`, `StatusReport`.
  - TaggedErrors with derived `message`: `ExecError`, `StateError`, `ReplayConflictError`, etc. (`Schema.TaggedErrorClass` with constructor).
  - Factories `stackState`, `branchRef`, `pullRef` hide branding.

- Pure modules: `stackGraph.ts` (pure `StatusReport` derivation, cycle detection via `ancestors` Set), `stackBlock.ts` (deterministic markdown splice), `format.ts` (tree rendering), `repairExecution.ts` (`Effect.fn` checkpoint-wrapped).

- Services: `Config`, `Git` (491 LOC, `Proc` + `StackConfig`, `replay` with worktree awareness), `Proc` (`effect/unstable/process` ChildProcessSpawner, concurrent drain), `Store` (113 LOC, `FileSystem` atomic `write .tmp` + `rename`, `Store.memory` via `Ref`), `CodeHost` + `GitHub`/`GitLab` adapters (Schema decoders, `retryRead` with `Schedule.exponential + jittered` for transient `i/o timeout|502|503|504`, `Cache` for GitLab project lookups), `Progress`.

- CLI `src/cli.ts` (433 LOC) via `effect/unstable/cli` (`Command.make`, `Flag`, `Argument`, `Command.runWith`), `live` layer via `Layer.unwrap` dynamic `git rev-parse` + `codeHost` detect.

### Testing — `vitest-effect` Gold Standard
- `vitest.config.ts` minimal: `include: ["tests/**/*.test.ts"]`.
- Imports: `import { describe, expect, it } from "@effect/vitest"` — gives `it.effect`/`it.live`/`it.scoped` + `TestClock`/`TestRandom`/`Fiber`.
  - `it.effect` (default for unit): provides `TestClock`, `TestRandom`, scoped.
  - `it.live` (for I/O): real clock, for `FileSystem`, `Proc`, `git`, `HTTP`.
  - `it.scoped` (implicit via `it.effect`): `acquireRelease` cleanup.

- Layer composition helper:
  ```ts
  const stackTestLayer = (opts) => Stack.layer.pipe(
    Layer.provideMerge(Progress.memory(...)),
    Layer.provideMerge(cfg),
    Layer.provideMerge(gitAndCodeHost(...)),
    Layer.provideMerge(Store.memory(state))
  );
  ```

- Determinism: `TestClock.adjust("500 millis")` for retry backoff without `setTimeout` flakiness.

**For harness:** We have `@effect/vitest@4.0.0-rc.110` installed but **mostly use** `import { it } from 'vitest'` + `Effect.runPromise` inside `async` it (e.g., `Scan.test.ts` with `async` + `walk` via `node:fs/promises`). Should migrate to `import { it } from '@effect/vitest'` + `it.effect`/`it.live`, use `FileSystem`/`Path` platform, `TestClock`, `Ref`-backed `memory` layers, `assert` for `Schema.Class` equality.

---

## 3. What to Keep vs Steal

| Area | Harness Current | Motel/Stack Better? | Decision |
|---|---|---|---|
| **SQL** | `@effect/sql-sqlite-node` + `SqliteClient` + `Migrator` + `Reactivity` + `Layer.scoped` + `DbFilename` union + `UNIQUE`/`CHECK` + `seal` hash + transactions | **Keep ours** — more Effect-idiomatic than motel's raw `bun:sqlite` + `Effect.acquireRelease`. **Steal** PRAGMA tuning, Writer/Readonly split, `CachedLoader`, FTS5 if we add search, `incremental_vacuum` loop | Refactor: add `PRAGMA` after migrator, add `BenchmarkStoreReadonlyLive`, add `CachedLoader` for TUI |
| **TUI** | None (CLI `src/companion/Cli.ts` + `Collector.ts` headless) | **Motel wins** — must add `src/tui.tsx` with `@opentui/core` + `@opentui/react` + `@effect/atom` | Add minimal TUI: header + tabs + footer, `tui: true` in plugin, `exports: {".": "./src/index.ts", "./tui": "./src/tui.tsx"}` |
| **Domain Types** | `Schema.Class` + `TaggedError` + `Slug` + `ModelReference` (we fixed to branded via `isPattern`) | **Stack wins on branded primitives** (`BranchName`), **Motel wins on `annotateKey`/`identifier`** | Keep ours but add `Schema.annotateKey` + `identifier` to all `Schema.Class`/`Struct`, add branded `SessionId`/`TaskId` if needed |
| **Testing** | `vitest` + `Effect.runPromise` + `async` + `node:fs` | **Stack wins** — `@effect/vitest` + `it.effect`/`it.live` + `TestClock` + `memory` layers | Migrate: change imports to `@effect/vitest`, replace `async` + `runPromise` with `it.effect`, use `FileSystem` platform in `Scan.test.ts` |
| **CLI** | `src/companion/Cli.ts` via `opencode` client + `Commander`? Actually `effect` + `Bun.spawn` | **Stack wins** — `effect/unstable/cli` (`Command` + `Flag` + `Argument`) + `Layer.unwrap` dynamic config | Keep companion CLI but refactor to `effect/unstable/cli` if we add more commands |
| **Scheduling/Retry** | No retry for `Opencode` API | **Stack wins** — `Schedule.exponential + jittered` for `retryRead` | Add `Schedule` retry for `Executor` `session.create`/`generate` if transient |

---

## 4. Refactoring Tasks (in order)

1. **TUI (P0 for plugin parity)** — Add `src/tui.tsx` + `@opentui/*` deps + `tui: true` + `package.json` `exports["./tui"]` + peerDeps. Minimal: `App` with `useTerminalDimensions`, `Atom` for tab, `useKeyboard` for `q`, `tab`, `r`, `h`. Data via `Effect` + `FileSystem` reading `benchmark.sqlite` (or via `MotelClient` if we add HTTP). Keep `src/index.ts` as composition root, TUI as separate entry.

2. **SQL Tuning (P1)** — In `packages/bench-store/src/Store.ts` after `Migrator`, add `PRAGMA` tuning (WAL, cache, mmap, busy_timeout) via `sql` `Effect` after `Migrator` layer. Add `BenchmarkStoreReadonlyLive` (`readonly: true`) for TUI/CLI reads. Add `CachedLoader` in `src/ui/cachedLoader.ts` for TUI facet caching.

3. **Domain Type Polish (P2)** — Add `Schema.annotateKey` + `identifier` to `Task`, `TrialRecord`, `HistoryRecord`, `ModelReference`, `Slug` etc. Add branded `TaskId`/`JobId` if desired (like `BranchName`).

4. **vitest-effect Migration (P1)** — Change `vitest.config.ts` to support `@effect/vitest` (already have `setupFiles: addEqualityTesters`), migrate `src/pattern/Scan.test.ts` from `async` + `node:fs` to `it.effect` + `FileSystem` + `Path`, migrate `packages/bench-store/src/Store.test.ts` to `it.live` (real SQLite) vs `it.effect` (retry), add `TestClock` example for `Runner`.

5. **Scheduling/Retry (P2)** — Add `Schedule.exponential` retry for `Executor` if we add `HttpClient`.

All changes must keep `bunx tsgo --noEmit`, `bunx tsc --noEmit`, `bunx vitest run` green and `src/pattern/Baseline.ts` shrink-only.

