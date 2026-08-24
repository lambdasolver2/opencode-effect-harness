# opencode-effect-harness — Migration Spec (3/4): Integration Seams, Verifier, Compound

**Canonical revision:** Read [`04-adversarial-audit.md`](04-adversarial-audit.md)
first. The corrected integration rules below supersede any earlier shorthand:
server transforms do not add agents or commands, skill registration is
capability-probed, event consumers are project-filtered and recursion-safe,
and compound proposals require human approval before materialization.

## 1. OpenCode integration seams (adapters-opencode)

### 1.1 Plugin entry (composition root)

```ts
// src/index.ts
import { Plugin } from '@opencode-ai/plugin/effect'
import { Effect } from 'effect'
import { decodeOptions, runtimeLayer, installTransforms, installHooks, runEventConsumers } from './layers.ts'

export default Plugin.define({
  id: 'opencode.effect-harness',
  tui: true,
  effect: (ctx) =>
    Effect.gen(function* () {
      const options = yield* decodeOptions(ctx.options)
      const runtime = runtimeLayer(ctx, options)
      yield* Effect.gen(function* () {
        yield* installTransforms(ctx, options)
        yield* installHooks(ctx, options)
        yield* runEventConsumers(ctx, options).pipe(Effect.forkScoped)
      }).pipe(Effect.provide(runtime))
    }).pipe(Effect.catchAllCause((cause) =>
      Effect.logError(`opencode-effect-harness setup failed: ${String(cause)}`)
    )),
})
```

`decodeOptions` must have a deliberate invalid-options policy before it reaches
the plugin boundary: either return validated defaults after logging, or stop
registration in a typed, logged way. All registration and consumer errors are
recorded with enough context to diagnose a partially active plugin. The final
plugin effect has a `never` error channel without using an unexamined defect
conversion.

### 1.2 Transforms (setup-time)

| Transform | What we register |
|---|---|
| `agent.transform` | update an existing configured worker only; it cannot add named agents under the documented v2 API. Child sessions use `verify.workerAgent`/`agents.verifier` and are restricted by the context hook. |
| `skill.transform` | capability-probed native registration of the complete generated upstream skill inventory (53 files at the inspected commit). The implementation follows the exact pinned API's documented registration operation and does not assume `draft.add`. |
| TUI keymap | `/verify`, `/compound`, status, skill stats, and review actions are registered by `./tui` using the documented TUI API. Server slash commands are a config fragment when the server API cannot add them. |
| `tool.transform` | Agent-callable tools (JSON-schema I/O, codemode default): `effect_harness_verify`, `effect_harness_critic`, `effect_harness_compound`, `effect_harness_skill_stats`, and blueprint query/evolve tools. |

### 1.3 Runtime hooks

```ts
ctx.tool.hook('execute.before', (e) => Effect.gen(...))  // e: {tool, sessionID, agent, messageID, id, input}
  • writeIntentFromToolCall(e) — edit/write inputs → WriteIntent ('before')
  • HarnessController.onToolCall analog → decisions; BlockToolCall ⇒ Effect.fail(new Tool.Error({message: reason}))
    (hook failure blocks execution in v2; reason becomes the tool error the model sees)
  • TrackSkillRead port: tool==='read' & path under a catalogued skill dir → PendingSkillRefs.remember(callId)

ctx.tool.hook('execute.after', (e) => ...)                // adds {status, result|error}
  • credit pending read when status==='completed' → SkillLoadedState.mark(sessionID, skill) + telemetry append
  • EmitSkillLoaded feedback: persist telemetry/ledger records; do not pretend storage is a conversation entry
  • SendPatternFeedbackAfterWrite port: project actual content (WriteProjection.actual), run PatternMatcher,
    format findings → ctx.session.synthetic({sessionID, text, delivery:'queue'}) — NEVER blocks

ctx.session.hook('context', (s) => ...)                   // {sessionID, agent, system[], messages, tools}
  • InjectEffectPolicyHeader port: append policy SystemPart when mode enabled (mirrors pi's before_agent_start)
```

### 1.4 Event-driven listeners (scoped fibers over selected Streams)

| Stream selector | Handler |
|---|---|
| `session.skill.activated` | `SkillLoadedState.mark(sessionID, name)` — primary loaded-skill signal |
| `session.compacted` | reset that session's loaded set after successful compaction; server reloads conservatively, full-client collector reconciles messages |
| `session.execution.succeeded/.failed/.interrupted` | TriggerPolicy.evaluate → maybe run verifier (auto mode); also compound outcome bookkeeping (success/failure signature) |
| `file.edited` | debounce window (options.verify.debounceMs, default 30s) → auto-verify touched files if `trigger:auto` |
| `session.usage.updated` | benchmark usage metrics capture during blueprint runs |

All listeners run as supervised fibers with per-event error containment (`Effect.catchAll` + log), never failing the stream.

### 1.5 Mode state & persistence

- `ModeState` = `Ref<boolean>` (session-lifetime) exactly like upstream.
- Persistence via `storage`: keys `ox-effect-harness/mode/<projectHash>` (replaces file-tree ModePersistence; scope concept collapsed to project).
- Telemetry JSONL kept at `<agentDir>/opencode-effect-harness/skill-reads.jsonl` (option-overridable).

---

## 2. Verifier subsystem

### 2.1 Triggers (TriggerPolicy, pure decision fn over inputs)

```
inputs: event kind (manual command/tool | execution.succeeded | file.edited debounce | session.idle)
config: trigger: 'off'|'auto'|'manual', debounceMs, minIntervalPerSessionMs, onlyWhenTouchedMatches?: glob[]
output: VerifyRequest{sessionId, touchedFiles?, scope}
```
Build-agent invocation path: the installed `effect_harness_verify` tool. It may
use the configured existing worker agent for semantic review; the server plugin
does not assume it can create a `verifier` agent through `agent.transform`.

### 2.2 Orchestration flow

```
VerifyRequest
 1. ModuleRegistry.resolve(touchedFiles ∪ changed-since-last-verify) → applicable modules
 2. For each module: checkers(ctx) → CommandExecutor.run each (Effect.forEach concurrency option, timeout, capture exit/stdout/stderr)
 3. parseDiagnostics (module-specific parsers: tsc pretty output, vitest/jest reporters, generic non-zero fallback)
 4. Aggregate VerifierReport(status pass|fail|error)
  5. If semanticReview enabled: spawn verifier worker for both pass and fail deterministic results, with report + diff context
    → skillsFindings appended (skills compliance review uses the same effect-* skill bodies)
 6. Deliver: storage record + synthetic summary message into triggering session (queue delivery) +
    machine-readable full report persisted to .effect-harness/reports/<ts>-<session>.json
```

Deterministic checks never invoke an LLM; semantic review is optional and clearly separated (fast CI-grade path vs agent judgment).

### 2.3 Skill-catalog verification (pi-effect-harness parity)

The verifier verifies code against **the same skill catalog pi-effect-harness runs** — the complete generated upstream `effect-*` inventory (currently 53 files in the inspected source tree: `effect-ai-chat`, `effect-ai-language-model`, `effect-error-handling`, `effect-layer-design`, …). This catalog lives inside the TypeScript verification module as its language knowledge base (`ModuleSkillCatalog`), alongside its pattern detectors:

1. **Pattern/skill-evidence pass (deterministic):** changed files are matched against the module's 46 detectors; findings carry their full markdown guidance and `suggestSkills` hints exactly like the harness's post-write feedback, but as part of a persisted report.
2. **Skill-compliance pass (semantic review):** the verifier service loads bounded relevant skill bodies through `ModuleSkillCatalog.load` and gives them to the reviewer worker, then checks the ChangeSet against their rules/checklists (e.g. tagged errors via `Schema.TaggedErrorClass`, layer composition per `effect-layer-design`). Findings cite the skill ID they violate; native OpenCode skill discovery is an additional UX, not the sole verification source.

Because catalogs are **per-module**, a future bend module ships its own skills/patterns directories and the identical verify flow applies to that language with zero core changes.

### 2.4 Bundled TypeScript module (`modules/verify-typescript`)

- typecheck: `tsc --noEmit` (project discovery: nearest tsconfig.json upward from touched files / root)
- test: detect runner from package.json (`vitest`/`jest`/`bun test`) with sensible args; glob-filter to affected packages when workspaces detected
- lint/build: optional, off by default
- parser: tsc diagnostics regex + vitest failure reporter

### 2.5 Third-language example (`modules/verify-bend-example`)

Documents the contract end-to-end: `{id:'bend', languages:['bend'], appliesTo:**/*.bend, checkers:[{kind:'typecheck', command:'bend check <root>'},{kind:'test', command:'bend test'}]}` plus its **own** `skills/` and `patterns/` directories — proving no TypeScript assumption anywhere in verify-core.

### 2.6 Critic agent (independent reasoning audit)

A second, distinct reviewer the builder agent calls from time to time — especially after completing a new feature or plan. Unlike the verifier (code correctness: deterministic checks + skills), the critic audits **thinking**:

- **Invocation:** builder calls `effect_harness_critic({ summary, planRef?, focus, checkpoint })`, handing over a short summary of what it did, the plan, and trace references. Automatic invocation is allowed only after an explicit structured builder checkpoint or a configured build-execution cadence; the plugin must not infer that an arbitrary execution is a completed feature (options.critic.autoAfterExplicitCheckpoint / `autoEveryNBuildExecutions`).
- **Inputs:** `CriticRequest` = builder summary + optional plan artifact ref + optional bounded ChangeSet + trace refs; plan-only checkpoints are valid.
- **Review passes (critic's own mind, read-only):**
  - *logical flaws* — contradictions between plan steps, unsound conclusions;
  - *hallucinations* — every factual/API/reference claim checked against the repo and reference clone; unsupported claims flagged with evidence;
  - *drift* — decisions diverging from the architecture spec or earlier accepted decisions without justification;
  - *domain expertise / reference correctness* — wrong Effect v4 idioms at design level, misread references (`checkedReferences` lists what it actually opened);
  - *missing considerations* — ignored edge cases, security, performance.
- **Output:** structured `CriticReport` (`verdict: sound | concerns | flawed`, findings with severity/kind/evidence/suggestion), delivered as a queued synthetic message to the builder session and persisted under `.effect-harness/reports/`.
- The critic never edits files and never runs the build; it is pure review. Its worker is a configured read-only agent like the verifier's semantic reviewer.

---

## 3. Compound subsystem

### 3.1 Data acquisition (SessionSource adapters)

- `LiveSessionSource` (server plugin): event-driven current/future session index and explicit session IDs. It does not call unavailable `ctx.session.list/export` operations.
- `HistoricalSessionSource` (full `@opencode-ai/client` in the TUI/companion client): paginated `session.list({directory|project|workspace,cursor})` using `compound.sessionScope` (`project` default, explicit `all`) → `SessionSummary{id,title,directory,updatedAt}` and sanitized `session.export`.
- Visited-tracking: storage key `ox-effect-harness/compound/index` ≈ pi-compound `.index.json`:
  `{sessions: Record<sessionID, {lastEventSeq, updatedAt, contentHash, state}>, approved[], rejected[](content-hash+reason), runs[]}`
  Repeated runs skip unchanged sessions unless `--rescan`; cursors commit only after successful extraction.
- Current session is included explicitly by ID in the live path and by the full client in the historical path.
- `HistoricalSessionSource` calls `session.export({sessionID, sanitize:true})` → `{info, messages[]}`; the server plugin receives explicit sanitized traces/proposals rather than pretending `ctx.session` can export history.

### 3.2 Operating modes

Compound runs in one of two explicit modes (`compound.mode`):

#### Mode A — `benchmark` (model comparison)

Exactly **one run per configured LLM**, then score — the user configures which models participate:

```
for task in options.compound.benchmark.taskIds:
  for model in options.compound.benchmark.models:    // both sets user-configured, never implicit
    runTask(task, blueprint, model) via LlmExecutor  // exactly one trial per (model, task)
    verify via AcceptanceCriterion (CommandCheck / AgentJudgeCheck)
Scoring.aggregate -> ExperimentLog row per model/task {score, passed, usage, duration, trial: 1}
```

Output: a ranked scorecard of the OpenCode-available models on the same selected benchmark cases and blueprint. There are no repeated trials; each model/task pair runs once in its own isolated environment. No evolution happens in this mode; it is the measurement instrument the evolve loop reuses.

For non-code cases, `AgentJudgeCheck` receives the trusted task prompt, fixed
versioned rubric, and the candidate's bounded final output as separately
delimited data. It returns a schema-validated score in `[0, 1]` plus reasons;
candidate text is never allowed to alter the rubric or judge instructions.

#### Mode B — `mine-evolve` (session mining + prompt self-improvement)

Two coupled loops:

**Mining loop** (pi-compound heritage):

```
Stage 0  TraceBuilder: export messages -> SessionTrace (+ provenance.outcome, error signatures)
Stage 1  Distiller.extract -- cheap/high-recall pass over new traces; hunts specifically for:
           - difficult problems that were solved (and how) -- IN ANY DOMAIN, not only
             programming: research/analysis, writing, planning, automation prompts,
             multi-step workflows
           - recurring LLM failures -- especially explicit user corrections
             ("remember that X", "that's wrong", "I told you...")
           - notable workflows worth reusing
         candidates = Insights{failure-pattern|recovery-strategy|task-blueprint|preference}
                      + domain tag + TraceDigest{attempt, failure, detection, correction,
                        transferableLesson}, with verbatim evidence
Stage 2  Distiller.gate -- premium/high-precision pass over candidates only (NULL BIAS default-reject,
         [user]-attributed quotes strongest, principles-vs-mechanics, rewrite-freely)
Stage 3  Review: durable PendingProposal queue -> user approves/edits/skips/rejects/aborts
         (TUI preferred; headless leaves proposals pending, never auto-approves)
Stage 4  Materialize approved insights into the knowledge base K:
           - failure-pattern / recovery-strategy -> append-only PlaybookDocs
           - task-blueprint -> BlueprintModule seeds (markdown-first, see below)
```

**Evolution loop** (AVO operator model, `Vary(P) = Agent(P, K, f)`):

```
first establish and persist a baseline for the fixed evaluator manifest and
train/holdout task sets; without it no candidate may be promoted
repeat up to maxVariationSteps:
  variation step = autonomous agent run that may:
    - consult lineage P  : every committed prompt version + its scores + failed-attempt lessons
    - consult knowledge K: mined insights, relevant effect-* skills, reference clone
    - reverse-prompt the solution traces: diagnose missing knowledge, missing reasoning,
      exploration failure, or abstraction gap, then propose a minimal prompt change
    - edit the candidate prompt (add reasoning, knowledge, exploration strategies, better abstraction)
    - self-test: execute f (benchmark tasks) against the candidate, diagnose failures, retry internally
  commit discipline (AVO):
    - verification must PASS (correctness gate; failing candidate => score 0)
    - train score AND hidden holdout score must strictly beat the best committed baseline
    - on commit: append the improved version to the Blueprint markdown module
      (prompt + bounded observable solution traces + score + what was added and why); update running-best
    - on reject: record VariationAttempt{outcome, lessonLearned} -- kept in P as learning
      material, never promoted
  stagnation supervisor:
    - after stagnationLimit consecutive non-improving attempts, redirect exploration with
      fresh optimization directions derived from the trajectory (AVO section 3.3)
```

Result: each blueprint is a **testable markdown module** -- current best prompt, its full trace/score history, and the accumulated lessons -- that measurably climbs as more sessions are mined and more variation steps run.

### 3.2.1 Blueprint markdown module format

Each blueprint lives as human-readable markdown under `.effect-harness/blueprints/<name>.md`, append-only. The identity frontmatter is immutable; every new candidate/commit is appended as a version block, and `BlueprintStore/current.json` points to the current best without rewriting old Markdown. Modules are **domain-tagged and not limited to programming**: a blueprint can capture, e.g., a deep-research prompt with its solution traces just as well as an Effect error-handling prompt.

````markdown
---
id: error-recovery-blueprint
domain: coding                  <!-- coding | research | writing | planning | automation | ... -->
---

## Version v7 (current best at time of append)
```yaml
score: 0.92
baselineScore: 0.71
taskRefs: [tasks/error-handling]
evaluatorVersion: checks-v3
holdoutScore: 0.89
```

### Prompt
<the distilled system prompt>

## Solution traces (v7)
### Task prompt
<the exact bounded task prompt used by the benchmark>

### Attempt and recovery
1. Attempted strategy: <what the model tried>
2. Failure observed: <what failed, including the observable output>
3. Detection: <how the failure was recognized>
4. Correction: <what changed and why it solved the failure>
5. Outcome: <final result, score, model, run ID>

Full sanitized ATIF trace: `artifacts/traces/<run-id>.json`

## Prior solution traces
- v6: score 0.88, model X, trace ref `artifacts/traces/<run-id>.json`

## Evolution log (append-only)
- v6->v7: added explicit failure-diagnosis checklist (lesson from attempts #12, #14)
- v5->v6: more domain knowledge from session S; attempt #9 regressed, lesson kept
````

The structured `Blueprint`/`BlueprintModule` schemas remain the machine-readable projection of this markdown (parsed with Effect `Schema`; parse failure is a typed error, never silent).

### 3.2.2 Why blueprints are "composable Effect AI modules"

A Blueprint is validated data composed from ordered `BlueprintModule` values; each module contributes a prompt fragment, failure modes, recovery strategy, and evidence. The Blueprint owns acceptance checks. Execution binds data ↔ engine:

- `OpenCodeSessionExecutor`: create child session, register `(sessionID, rendered blueprint prompt)` before prompting, let the context hook inject `SystemPart.make(renderedPrompt)`, feed task instruction, wait, and collect the trace from a scoped recorder fed by lifecycle/text/reasoning events plus tool hooks. `ctx.session` has no dynamic system-prompt or export field.
- `DirectAiExecutor`: `effect/unstable/ai` Chat/LanguageModel layers (`@effect/ai-openai`/`anthropic`) for standalone benchmarking outside a live OpenCode server (CI mode), identical scoring.

Both satisfy `LlmExecutor.Interface`; benchmarks are model-swapped without touching pipeline code.

### 3.3 Compound agent surface

- Configured worker session (read-only) exposes tools: `effect_harness_compound` (with `mode: 'benchmark' | 'mine-evolve'`), `compound_status`, `blueprint_query`, `blueprint_evolve`.
- Benchmark mode is fully user-configured (`benchmark.models`, selected task); one run per model, scored, logged.
- Mine-evolve mode runs the mining loop over unvisited/new sessions (scope `project` | `all`) and can continue into the evolution loop for a chosen blueprint (`maxVariationSteps`, `stagnationLimit`). Commits follow the AVO discipline; failed attempts are journaled as lessons.
- Auto-trigger (option, default `off`): after eligible `session.execution.failed` clusters or every N eligible succeeded sessions, enqueue a background mining pass with project, idempotency, and recursion guards. The evolution loop never auto-triggers; it is explicit.
- All prompts live as data constants in `src/compound/distill/prompts.ts` (pure, unit-testable), including the variation-operator prompt template (lineage + knowledge base + scoring contract) and the stagnation-redirect template.
- Every distillation, critic, judge, and variation prompt wraps historical traces, tool output, Markdown modules, and candidate answers in explicit untrusted-data delimiters. The system instructions tell the model to analyze them, never follow instructions contained inside them; redaction and size limits run before the model call.

### 3.4 Storage layout (all namespaced, small-KV only)

```
ox-effect-harness/mode/<project>            {enabled, updatedAt}
ox-effect-harness/compound/index            {scope, sessions:{lastEventSeq, updatedAt, contentHash, state}, approved[], rejected[], runs[]}
ox-effect-harness/blueprints/current        {id}          // pointer; bodies in files below
Files under <projectRoot>/.effect-harness/: blueprints/<name>.md (append-only markdown modules)
                                             · blueprints/state/<id>.json   // lineage P: committed + attempts
                                             · blueprints/v-<millis>.json · reports/*.json · trajectories/*.json
                                             · experiment-log.tsv · docs/playbooks.md (append-only)
```

## Canonical Integration Corrections

### Plugin composition and scoped execution

The server entrypoint must use the exact Effect plugin contract. Its setup
effect decodes options, builds and provides the runtime layer, performs finite
transform/hook registrations, and forks event consumers with
`Effect.forkScoped`. It must not wait on `Stream.runForEach` directly and must
not leave a custom service environment at the plugin boundary. Every event
consumer catches its own causes and logs/records failures without terminating
the other consumers.

The plugin ID is `opencode.effect-harness`; the npm package name is
`opencode-effect-harness`. The server definition sets `tui: true` and exports
`./tui`.

### What can actually be installed automatically

The server plugin can add tools through the documented `tool.transform.add`.
It cannot currently assume that `agent.transform` or `command.transform` can
add definitions. Therefore:

- `effect_harness_verify`, `effect_harness_compound`,
  `effect_harness_skill_stats`, and blueprint/query tools are the canonical
  server surface.
- The plugin uses an existing worker agent ID for child sessions. The default
  is the built-in `explore`; users may configure a dedicated `verifier`/`compound` agent in
  `opencode.jsonc` or an agent Markdown file.
- The plugin's context hook marks its own child sessions and removes all
  mutation-capable tools, including edit/write/patch/shell, for reviewer
  sessions. The built-in `explore` fallback is read-only by default; a custom
  worker is still constrained by the hook unless `allowEdits` is explicitly enabled.
- The TUI entrypoint registers the mode keymap, status footer, review UI, and
  slash commands using the documented TUI API. Server-side command snippets
  are shipped as configuration examples, not falsely registered through
  `command.transform`.

The TUI does not call private plugin services. For review and toggle actions it
uses the public client to send a small, schema-validated `session.synthetic`
control envelope with plugin metadata; the server event consumer validates the
envelope and performs the Effect operation. Server state remains authoritative
and the TUI remains a presentation boundary.

The envelope is versioned and contains only `{pluginId, protocolVersion,
requestId, projectKey, operation, proposalId?, payload?}`. It is never treated
as ordinary user evidence by the compound extractor, and request IDs make TUI
retries idempotent. If the control-envelope transport cannot be proven against
the pinned client/server pair, the TUI falls back to displaying the pending
protocol and the user invokes the server tool directly; it does not mutate
artifacts locally behind the server's back.

The server is the sole owner of mutable indexes, approvals, ledgers, and
promotion state. A scoped per-project `Mutex` serializes storage updates and
request IDs make retries idempotent. TUI/CLI collectors may compute traces and
proposals, but send them to the server protocol for mutation. Artifact files
are written atomically through a temp path and rename.

Bundled skills use a `SkillRegistrar` capability. The implementation is
selected only after a startup capability test against the exact pinned plugin
package: the current website documents `skill.transform` as `source/list`,
while one inspected beta declaration exposed `add/update/remove`. An
undocumented operation is never called. If no supported native registration
exists, installation must use a documented skills source/catalog or the build
fails the full-parity acceptance gate.

### Tool-hook adapter details

`execute.before` has no cwd. The adapter first resolves the session's
`Session.Info` and its location, normalizes the project directory, and only
then invokes `WriteIntentExtractor` and `WriteProjection`. The extractor is a
registry because built-in tool input shapes are host-specific; unknown tools
produce `Option.none`, not guessed writes.

The host-neutral kernel still emits `Decision.BlockToolCall`. The OpenCode
adapter maps it to `Effect.fail(new Tool.Error({ message: decision.reason }))`.
It never throws from `Effect.gen`/`Effect.fn`. Pattern feedback and telemetry
are forked in the scoped after-hook, bounded by output/rate limits, and use
`ctx.session.synthetic({ sessionID, text, delivery: 'queue' })` only after
expected failures have been caught.

### Event filtering and idempotency

The event stream is global. An event is eligible only when its location,
workspace, or resolved session belongs to the current project scope. Internal
session IDs are recorded before their first prompt and excluded from automatic
verifier/critic/compound triggers. The origin enum is
`verifier | critic | compound | benchmark`; the same exclusion applies to
configured worker agent IDs.

Use `session.compacted` as the successful compaction boundary. A
`session.compaction.failed` or `.started` event does not clear loaded skills.
Persist observed activations/read fallbacks in the server skill journal and
clear it on the observed successful boundary. Because the restricted server
context cannot replay message history, a new plugin generation resets
unreconciled sessions conservatively; the full-client collector can reconcile
`type: 'skill'` messages after the latest completed compaction.

`file.edited` has no session ID and is ephemeral. It may schedule a
location-keyed debounce, but the authoritative automatic verification trigger
is the completed tool/execution boundary with a resolved session. Deduplicate
by project + session + event ID/content hash and serialize or coalesce runs
per project.

`session.execution.succeeded` has no changed-file list. The tool hooks therefore
feed a per-session `ChangeLedger` of successful write/edit paths. The execution
trigger consumes and coalesces that ledger, then clears it only after the
verification report is persisted. This prevents no-op verifier runs and keeps
the report tied to the actual build-agent changes.

Mode-off semantics match pi: policy-header injection, write gating, and pattern
feedback are disabled, but skill activation/read telemetry remains installed
and records data for later statistics or a subsequent re-enable. Reference
clone maintenance is lazy and never runs inside the blocking write gate.

Reference metadata records the pinned Effect RC and source commit. The default
clone is version-compatible and atomically refreshed; a moving `latest` clone
is explicit, labeled non-reproducible, and never used as the verification
default.

`SkillReadBackfill` is a v2 client adapter, not a Pi JSONL parser: it reads
sanitized OpenCode exports and `skill`/observable read parts, applies successful
read and deduplication rules, and updates the v2 journal. The server plugin
only backfills from its own persisted journal.

### Verifier contract

A verification run always produces independent results for:

1. language checkers (`typecheck`, `test`, `lint`, `build`, or custom);
2. Effect pattern findings and required skill evidence for the changed files;
3. semantic review, when `semanticReview` is enabled.

Semantic review is not conditional on deterministic failure. A pass from
`tsc` and tests is still eligible for reviewer analysis. The default automatic
policy may disable semantic review for cost, but its report must say
`semantic: skipped`, not imply that a review happened. The verifier prompt
requires findings with file/line evidence, relevant skill IDs, and a clear
pass/fail/needs-review verdict. The result is parsed with an Effect `Schema`;
unparseable child output is a typed semantic-review error, not an implicit
pass.

### Compound protocol

Historical mining is opt-in. The full-client session source lists every
unvisited or changed session in the selected `project` or explicit `all` scope
plus the current session, using a
cursor `{ lastEventSeq, updatedAt, contentHash, state }`. A cursor is committed
only after export and extraction succeed. Export uses `sanitize: true`, then a
redaction pass and size limits. Only observable user/assistant text, reasoning
parts exposed by the API, tool calls, and tool results are extracted; hidden
chain-of-thought is never reconstructed.

Stage 2 produces `PendingProposal` values. The review queue supports approve,
edit-and-approve, skip, reject-with-reason, and abort. TUI is preferred;
headless mode leaves proposals pending and emits a machine-readable review
protocol. Append-only Markdown docs and BlueprintStore writes occur only after
an approval record. Rejected content hashes and reasons are retained.

For pi-compound parity, managed knowledge documents remain a content/sidecar
pair (`<name>.md` plus `<name>.compound.yaml`) with purpose, criteria,
structure, style examples, scope, and model policy. The TUI/config protocol
provides `compound:init`, `compound:status`, `compound:last`, and
`compound:wire` equivalents. `compound:init` never overwrites an existing
document; `compound:wire` only produces include references. Blueprint modules
are stored separately as validated versioned JSON plus human-readable Markdown
and are linked to the source proposal/run IDs.

Blueprint benchmarks acquire one isolated workspace per task/model/trial.
OpenCode child sessions are associated with their blueprint through a scoped
`BlueprintExecutionRegistry`; the context hook injects
`SystemPart.make(renderedPrompt)` after `session.create` and before
`session.prompt`, because `session.create` has no dynamic system-prompt field.
The direct-AI executor may use a native system prompt. Both executors return
the same `ExecutionOutcome` and feed the same verifier/scoring pipeline.

Blueprint promotion defaults to human approval. Deterministic acceptance
criteria are preferred; LLM judging is labeled subjective and cannot silently
replace deterministic evidence. Model comparisons run the same task and
acceptance checks in isolated environments, record trial variance, and retain
the baseline before applying a patch.
