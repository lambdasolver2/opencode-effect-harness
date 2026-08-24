# opencode-effect-harness — Migration Spec (1/4): Overview & Reference Analysis

**Revision status:** This specification was adversarially reviewed. The
normative findings and corrections are in [`04-adversarial-audit.md`](04-adversarial-audit.md).
Earlier assumptions about dynamically adding agents/commands, automatic skill
registration, TUI omission, benchmark isolation, and compound approval are
superseded there.

**Goal:** Fully migrate [pi-effect-harness](https://github.com/mpsuesser/pi-effect-harness) to an installable **OpenCode v2 plugin**, preserving 100% of its features, written entirely in **Effect v4** (the version aligned with `@opencode-ai/plugin@beta`), and extend it with three new subsystems:

1. **Verifier** — a reviewer agent (hook-triggered or build-agent-invoked) that runs tests + `tsc` **and verifies code against the same Effect skill catalog pi-effect-harness ships** (the complete generated `effect-*` inventory — currently 53 files in the inspected source tree, e.g. `effect-ai-chat`, `effect-error-handling`, …). The skill catalog + pattern catalog are part of each pluggable **verification module**: the bundled TypeScript module owns the current upstream inventory/46 patterns; a "bend" module would own its own language-specific skills/patterns.
2. **Critic** — an independent reviewer agent the builder agent calls from time to time (especially after completing a new feature or plan). The builder hands over a short summary of what it did, the plan, and trace references; the critic uses its own reasoning to find major flaws, hallucinations, drift from the architecture/spec, and wrong domain/reference/architecture decisions. Read-only; never edits.
3. **Compound** — a client-side/TUI companion plus server plugin tools with two modes (fusion of pi-compound × effect-autoagent, informed by AVO — see below):
   - **Benchmark mode:** one run per configured OpenCode-available LLM on a selected task, then score. The user configures which models run.
   - **Mine & evolve mode:** walks all (or only new) OpenCode sessions, finds interesting parts — difficult problems solved, recurring LLM failures (e.g. user corrections like "remember that X", "that's wrong"), notable workflows — and captures them as **Blueprint markdown modules**: what the prompt is, the traces of runs, and scores. It then acts as a meta prompt engineer: multiple improvement attempts (better reasoning, more knowledge, exploration, better abstraction) are benchmarked, and only improvements that pass verification and beat the baseline are appended to the markdown. Over time this yields testable markdown modules of prompts + results that keep climbing as more sessions come in.

   The mine & evolve loop adopts the operator model of *AVO: Agentic Variation Operators for Autonomous Evolutionary Search* ([arXiv:2603.24517](https://arxiv.org/html/2603.24517v1), an attention-kernel optimization paper, not an ARC-AGI result): `Vary(P) = Agent(P, K, f)` — a self-directed agent consults the full scored lineage `P` of prompt versions, a knowledge base `K` (extracted session insights, skills, patterns), and a frozen train/holdout scoring function `f` (acceptance checks); commits only correctness-passing versions that strictly beat the baseline; persists failed attempts separately for learning; and uses stagnation detection to redirect exploration when improvements plateau.

Everything modular, reusable, FP-first, Effect v4.

---

## 1. Verified platform facts (OpenCode v2 plugin API)

Verified against docs (opencode.ai/v2/docs) and the actual package `@opencode-ai/plugin@0.0.0-beta-17898` (+ `@opencode-ai/client`, `@opencode-ai/schema`, `@opencode-ai/protocol`, all `0.0.0-beta-17898`).

### 1.1 Plugin shape & lifecycle
- Default export: `Plugin.define({ id: string, tui?: boolean, effect: (ctx) => Effect<void, never, Scope> })` from **`@opencode-ai/plugin/effect`** (Promise variant exists; we use the Effect one). The effect program is **scoped** → finalizers/fibers released on reload/unload.
- `ctx` domains (from `dist/effect/plugin.d.ts`): `app`, `options`, `agent`, `aisdk`, `catalog`, `command`, `event`, `integration`, `mcp`, `plugin`, `reference`, `session`, `shell`, `skill`, `storage`, `tool`, `websearch`.
- All ctx operations return **Effects / Streams** (`@opencode-ai/client/effect/api` shapes).
- Installable as npm package; `"exports": { ".": "./src/index.ts" }` — **TS source distribution is expected** (same as pi-effect-harness publishes raw `.ts`). Deps installed into an isolated cache by OpenCode; no lifecycle scripts run.
- Config: `plugins: ["opencode-effect-harness@x", { "package": "...", "options": {...} }]`; options arrive read-only on `ctx.options`.

### 1.2 Domains we rely on
| Domain | Key operations | Use in our design |
|---|---|---|
| `agent.transform(draft)` | `list/get/update/remove/default` | update an existing configured reviewer/worker profile; **does not create agents** |
| `skill.transform(draft)` | the docs currently promise `source/list`; the inspected beta declaration exposed a different shape | capability-probed native registration of bundled skills; no undocumented method is assumed |
| `tool.hook("execute.before")` | payload `{tool, sessionID, agent, messageID, id, input}` (input mutable) | **WriteIntent capture + skill gate blocking** (fail the hook to block) |
| `tool.hook("execute.after")` | adds `{status:"completed",result} \| {status:"error",error}` | pattern feedback, skill-read crediting, telemetry |
| `session.hook("context")` | `{sessionID, agent, model, system: SystemPart[], messages, tools}` mutable pre-dispatch | policy header injection (≈ pi's before_agent_start systemPrompt) |
| `event.subscribe()` | `Stream<OpenCodeEvent>` (durable events w/ seq) | triggers: verifier, compound, skill tracking, compaction resets |
| `ctx.session.*` | `create({agent,model,location})`, `get`, `prompt`, `wait`, `synthetic({sessionID,text,delivery})`, plus command/rename/interrupt | run configured worker sessions and inject feedback; the plugin context does **not** expose list/export/log |
| full `@opencode-ai/client` | `session.list({directory|project|workspace,cursor})`, `session.export({sessionID,sanitize})→{info,messages}`, `session.log({sessionID,after,follow})`, `message.list` | companion client/TUI collector for historical all-session mining |
| `command.transform` | `list/get/update/remove` | update only commands that already exist; canonical installable operations are plugin tools; TUI supplies its own slash/keymap commands |
| `storage.get/set/remove/scan` | JSON KV | mode state, indexes, cursors (replaces pi's file layout) |
| `catalog` | provider/model list/get/default | model resolution for benchmarking |

### 1.3 Event taxonomy (extracted from `@opencode-ai/schema/event-manifest.d.ts`)
Critical for us:
- `session.skill.activated` → data `{id, name, text, sessionID}` ⇒ **direct signal that a skill was loaded** (much cleaner than pi's read-file heuristics)
- `session.compacted` → `{sessionID}` after successful compaction ⇒ gate reset point; failed/started compactions do not reset it
- `session.execution.succeeded/.failed/.interrupted` → `{sessionID}` plus failure data where applicable ⇒ verifier/compound trigger candidates; fetch session metadata before acting
- `file.edited` → `{file}` plus optional location, **no session ID**, and ephemeral ⇒ only a location-keyed debounce signal
- `session.tool.called/.success/.failed`, `session.step.*`, `session.usage.updated` → trace/metrics extraction

### 1.4 Version alignment decision (D1)
`@opencode-ai/plugin@beta` depends on **`effect@4.0.0-rc.110`**. We pin our workspace to the same `effect` version so a single instance (and shared types) exist inside the plugin host. pi-effect-harness is on `4.0.0-beta.80` ⇒ a port audit for beta→RC deltas (Schema/Context/Effect.fn APIs) is an explicit task.

### 1.5 Semantics differences pi ↔ OpenCode v2 (migration mapping)
| pi mechanism | OpenCode v2 replacement |
|---|---|
| `pi.on('tool_call')` return `{block:true,reason}` | `ctx.tool.hook("execute.before")` — `Effect.fail(new Tool.Error({message}))` blocks; JavaScript throws are not used |
| `pi.on('tool_result')` side-effects | `ctx.tool.hook("execute.after")` |
| `before_agent_start` → `{systemPrompt}` | `ctx.session.hook("context")` mutating `system[]` |
| `pi.sendUserMessage` / steer | `ctx.session.synthetic({sessionID, text, delivery})` |
| `pi.appendEntry(custom)` session entries | durable events/messages + `storage`; loaded-skill state kept in a per-session `Ref`, rebuildable from exported messages by the full-client collector |
| read-tool-skills-dir credit heuristic | primary: `session.skill.activated`; fallback: `execute.after` of `read` targeting a catalogued skill dir (kept for parity) |
| `PI_SUBAGENT_CHILD=1` advisory gate | hook payload carries `agent: Agent.ID`; strict only for configured primary agents (default `["build"]`) |
| `registerCommand` handlers | custom plugin tools for the installable server surface, TUI keymap/slash commands, and optional user config for server-side slash commands |
| walking `~/.pi/agent/sessions/*.jsonl` | full-client/TUI collector `session.list` / `session.export` / `session.log(after)`; not `ctx.session` |
| ModePersistence file tree under session dir | `storage` KV keys (project-scoped) |

---

## 2. Reference architecture analysis (what we inherit)

### 2.1 pi-effect-harness (features to preserve 1:1)
Two packages:

**`packages/harness-kit`** — pure-Effect, host-agnostic kernel:
- Data schemas (Effect `Schema`): `Decision` (4 variants: BlockToolCall / InjectUserMessage / InjectSystemPrompt / AppendCustomEntry), `Rule.Definition` (id/description/action/severity/patternName/sourcePath), `Pattern.Value` (ast-grep or regex detectors + glob filters + level + suggestSkills), `WriteIntent` (`WriteFile{filePath,content}` | `EditFile{filePath,replacements}`), `EditReplacement.Resolution` (UniqueMatch/MissingMatch/AmbiguousMatch/OverlappingMatch/EmptyOldText), `ActiveBranch` (neutral conversation snapshot incl. CompactionEntry), `UserMessage`, `SkillIndexEntry {name, skillFilePath, skillDir}`, `MatcherInput`.
- Kernel services: `HarnessController` (phase dispatch: sessionStart/sessionTree/beforeAgentStart/toolCall/toolResult; hooks before rules), `HookSet`, `RuleCatalog`, `RuleSet` (mode gating inside `RuleSet.all`), `RuleEngine`, `PatternCatalog` (parses pattern `.md` frontmatter → detectors), `PatternMatcher` (@ast-grep/napi + RegExp + picomatch globs), `WriteProjection` (`prospective()` applies edits in-memory pre-write; `actual()` reads disk post-write, changed-span scoping).
- Atoms (pure fn + Effect-v4 Atom twins), `normalizePath`, frontmatter parsing.

**`harnesses/effect` upstream → our `packages/effect-harness`** — the Effect-v4-specific harness:
- Services: `SkillCatalog` (bundled skills self-discovery + longest-prefix path match), `GuidanceCatalog` (policy header + skill-gate reason texts), `PendingSkillReads` (in-flight read credits), `ReferenceClone` (clones Effect-TS/effect-smol → `~/.cache/effect-v4` for authoritative source reference), `SkillReadTelemetry` (JSONL at `<agentDir>/pi-effect-harness/skill-reads.jsonl`), `SkillReadBackfill`.
- Hooks: RebuildSkillCatalog, ClearPendingSkillReads, EnsureReferenceClone, TrackSkillRead (read tool), EmitSkillLoadedEntry (credit on success).
- Rules: `InjectEffectPolicyHeader`, `RequireLoadedSkillsForEffectWrites` (**gate**: block edit/write when projected content matches `/\bEffect\b|from\s+['"]effect(?:\/[^'"]*)?['"]/` and loaded+pending distinct `effect-*` skills < `MIN_EFFECT_SKILLS = 4`; advisory-off in subagent children), `SendPatternFeedbackAfterWrite` (never blocks).
- Assets in the inspected source tree: **53** bundled `skills/effect-*/SKILL.md`, **46** `patterns/*.md`, and **4** guidance documents (README counts are stale). Pattern frontmatter includes name/description/glob/detector(ast|regex)/pattern|rule/inside/constraints/level/suggestSkills.
- Tests: vitest + @effect/vitest; per-pattern test bijection enforced by `all-patterns-covered.test.ts`; `pattern-test-harness` DSL.

### 2.2 pi-compound (memory-mining workflow to absorb)
- Doc + sidecar pairs (`<name>.md` + `<name>.compound.yaml`: purpose/criteria/structure/style_examples/scope/model); append-only content docs; `.index.json` (approved/rejected hashes, `sessions_seen` cutoffs); run logs.
- Two-stage LLM pipeline: **Stage 1** cheap/high-recall extractor over transcripts (batched, all docs at once) → **Stage 2** premium/high-precision gate (null-bias, evidence quality = verbatim user quotes, principles-vs-mechanics, rewrite freely) → human review → append.
- Command-driven only (no hooks). Prompts quoted in appendix of repo; we reuse the *philosophy* (standards, null bias, evidence) but retarget output domain from "user preferences" → "task blueprints".

### 2.3 effect-autoagent (blueprint + benchmark machinery to absorb)
- `AgentBlueprint` (Schema.Class): declarative agent spec — systemPrompt, ModelConfig(provider/modelName/thinking), ToolSpec[], OrchestrationSpec, AgentConstraints(maxTurns/timeouts/budget).
- `BlueprintStore`: filesystem versioned store (`current.json`, `v-<millis>.json` history, rollback) behind `Context.Service`.
- `BlueprintPatch`: patch vocabulary + **pure `applyPatches` fold**.
- Trajectory pipeline: Chat history → **ATIF** (Agent Trajectory Interchange Format; `AtifTrajectory{schema_version, session_id, agent, steps[AtifStep{step_id,timestamp,source,message,model_name?,reasoning_content?,tool_calls?,observation?}], final_metrics}`) via pure converters (`EffectAiConverter`, `TrajectoryConverter`).
- `BenchmarkRunner`: task dirs (`task.toml`/`instruction.md`/`environment/Dockerfile`/`tests/test.sh`); container per task; verifier writes float reward to `/logs/verifier/reward.txt` (pass ≥ 1.0); `TaskResult{taskName,score,passed,…}` → aggregated report; concurrency.
- `MetaAgent`: `diagnose → propose patches → apply → benchmark → LLM-judge evaluate(keep|discard) → commit/rollback`; `ExperimentLog` TSV rows.
- Uses `effect/unstable/ai` (`Chat`, `LanguageModel`, `Prompt`, `Tool.dynamic`, `Toolkit`, `generateObject` for structured outputs), providers via `@effect/ai-openai` / `@effect/ai-anthropic` + FetchHttpClient. No streaming usage.

---

## 3. Decisions log (top-level)

| # | Decision | Rationale / alternative rejected |
|---|---|---|
| D1 | Pin `effect` = the exact version `@opencode-ai/plugin@beta` depends on (currently `4.0.0-rc.110`) | single runtime instance, type compatibility; reject: dual-effect hack |
| D2 | One distributable npm package with host-neutral internal modules and public subpath exports | preserves reusability without pretending `workspace:*` packages are bundled; separate packages can be published later |
| D3 | Ship TS source, but test the packed artifact in OpenCode's isolated cache | matches OpenCode's supported entrypoint style while validating dependencies and native assets |
| D4 | Map a blocked write to `Effect.fail(new Tool.Error({message}))` in `execute.before` | exact v2 failure channel; never throw from Effect code; after-hook feedback is supervised and non-blocking |
| D5 | Skill ledger persists observed activations/read fallbacks; resets on observed `session.compacted`; reloads reset conservatively unless the full-client collector reconciles messages | avoids over-crediting when the restricted plugin context missed history |
| D6 | Feedback uses a scoped asynchronous `session.synthetic` operation with `queue` delivery | closest v2 equivalent of pi steering; context hook is reserved for system parts and internal-session controls |
| D7 | Verifier separates deterministic language checks, Effect pattern/skill-evidence checks, and semantic review | a passing compiler/test run must not silently mean “reviewed” |
| D8 | Compound uses atomic composable BlueprintModules, explicit human approval, isolated benchmark environments, and swappable OpenCode/direct-AI executors | actually satisfies reusable modules and fair model comparison |
| D9 | Storage holds indexes/metadata; a configured artifact store holds large traces/reports; project identity comes from session location | avoids global-event collisions and uncontrolled project writes |
| D10 | ast-grep via `@ast-grep/napi` is required for parity, with a tested regex-only degraded mode | native loading is a release gate, not an unverified assumption |
| D11 | The documented v2 transforms do not create agents or commands | use configured worker IDs + plugin tools; TUI/config integration provides named UX |
| D12 | Full feature parity includes the TUI behaviors | add `./tui`, `tui: true`, mode footer/keymap, skill stats, and compound review |
| D13 | Historical session mining is opt-in and sanitized | use `session.export({sanitize:true})`, redact secrets, retain observable reasoning only, and never infer hidden chain-of-thought |
