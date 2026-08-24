# opencode-effect-harness

OpenCode v2 plugin harness for Effect v4 development. The **publishable plugin** — imports `@opencode-ai/*` and wires the kernel, verification engine, and compound domain to OpenCode's tool hooks, events, session API, and storage.

## What this is

The adapter layer. Takes the pure kernels (harness-kit, verify-kit, compound-kit) and connects them to OpenCode v2. Registers tools, hooks into `execute.before/after`, injects policy headers via context hook, listens to skill/compaction events, spawns child sessions for critic reviews and benchmark execution.

## Domain types (adapter-level)

### `Gate.rule`

Blocks Effect-code writes until enough skills are loaded. Consumes prospective projection to check if the would-be file contains Effect code (`/\bEffect\b|from\s+['"]effect/`). Blocks via `Effect.fail(new Tool.Error({message}))` — the only documented blocking mechanism in OpenCode v2. Advisory for non-strict agents.

### `Feedback.rule`

Runs all 46 pattern detectors against actual post-write content. Matches are de-duplicated, sorted by severity, and delivered as a single advisory message containing each pattern's full guidance body + suggested skill hints. Never blocks.

### `Header.rule`

Injects merged guidance docs (4 files: Effect-first spec, layers essay, parse-dont-validate essay, progressive disclosure rules) into the system prompt every turn while mode is enabled.

### `Ledger`

Per-session loaded-skill state. Marks on `session.skill.activated` events and successful read fallbacks; resets on observed `session.compacted`. Conservative reload: new plugin generations reset unreconciled sessions rather than over-crediting.

### `Pending`

In-flight skill reads keyed by tool-call ID. A read is pending between `execute.before` (read targeting a known skill dir) and `execute.after` success. Counting pending alongside confirmed loads avoids a race where the gate fires between call and result.

### `Catalog`

Discovers bundled effect-* skills by scanning the skills directory. Matches read paths against skill dirs using longest-prefix matching so reading any file in a skill directory credits that skill.

## Pipeline

```
Plugin.define({ effect })
  │
  ├→ Runtime.layer(root) provides:
  │     Kernel.layer(patternsDir)
  │     Guidance.layer(guidanceDir)
  │     Pending.layer · Ledger.layer · Catalog.layer(skillsDir)
  │
  ├─ tool.hook('execute.before')
  │    ├→ extract WriteIntent from tool input
  │    ├→ track pending skill reads
  │    └→ Gate.evaluate → BlockToolCall → Tool.Error fail
  │
  ├─ tool.hook('execute.after')
  │    ├→ credit successful reads → Ledger
  │    └→ Feedback.evaluate(actual content) → synthetic message
  │
  ├─ session.hook('context')
  │    └→ Header.evaluate → inject policy SystemPart
  │
  ├─ event.subscribe()
  │    ├→ skill.activated → Ledger.mark(sessionID, name)
  │    └→ session.compacted → Ledger.reset(sessionID)
  │
  └─ tool.transform → registers 5 tools:
       effect_harness_verify · harness_critic · harness_compound
       harness_skill_stats · harness_toggle
```
