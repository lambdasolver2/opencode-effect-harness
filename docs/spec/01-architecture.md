# opencode-effect-harness — Migration Spec (2/4): Architecture, Packages, Domain Model

**Canonical revision:** The implementation mirrors the upstream
[pi-effect-harness](https://github.com/mpsuesser/pi-effect-harness) layout but
with **every part as its own package under `packages/`** (user decision — all
workspace members are siblings; there is no separate `harnesses/` tree):

```text
packages/harness-kit/     opencode-harness-kit     1:1 port of pi-harness-kit
packages/verify-kit/      opencode-verify-kit      verification engine + critic core
packages/compound-kit/    opencode-compound-kit    traces/blueprints/evolution/scoring
packages/effect-harness/  opencode-effect-harness  the publishable plugin
                                                   (skills/, patterns/, guidance/, src/)
modules/                  additional verification modules (e.g. bend example)
```

### Naming convention (Effect-TS style)

Files are short PascalCase domain nouns matching their primary exported type:
`gate.ts`, `feedback.ts`, `header.ts`, `Guidance.ts`, `ledger.ts`,
`catalog.ts`, `Runtime.ts`, `checker.ts`, `module.ts`, `report.ts`,
`evidence.ts`, `reviewer.ts`, `Exec.ts`, `orchestrator.ts`,
`trace.ts`, `insight.ts`, `blueprint.ts`, `evolution.ts`,
`store.ts`, `Benchmark.ts`, `log.ts`, `llm.ts`, `distill.ts`, `source.ts`.

Related types grouped in a domain folder with short file names:
`Harness/hook.ts` + `Harness/rule.ts` (was HarnessHook/HarnessRule).

Shortened domain names (migration renames):
- `Activebranch.ts` → `branch.ts`
- `Writeintent.ts` → `intent.ts`
- `EditReplacement.ts` → `edit.ts`
- `SkillIndexEntry.ts` → `skill.ts`
- `Usermessage.ts` → `message.ts`

Atoms folded into their domain modules (no separate atom files):
`Pattern.globMatchesFilePath`, `Intent.contentRaw`,
`Message.isEmpty/normalized`, `Edit.resolution/resolvedSpan/isApplicable`.


Files are short domain nouns (`gate.ts`, `feedback.ts`, `Guidance.ts`,
`ledger.ts`, `Runtime.ts`, `catalog.ts`, `Pending.ts`). Functions live inside
their domain namespace so call sites read `Gate.rule(...)`,
`Feedback.rule(...)`, `Header.rule(...)`, `Guidance.layer(dir)`,
`Ledger.Service.use(...)`. Long names appear only as qualified paths, never
as standalone identifiers (no `sendPatternFeedbackAfterWriteRule`).

## Provenance map — what is taken from each reference

### From pi-effect-harness → `packages/harness-kit` (port, tags renamed `ox-effect-harness/*`)
| Upstream file | Ours | Status |
|---|---|---|
| `src/decision.ts` | same | ported |
| `src/Usermessage.ts` → `src/message.ts` | shortened domain name | ported+renamed |
| `src/SkillIndexEntry.ts` → `src/skill.ts` | broader domain | ported+renamed |
| `src/EditReplacement.ts` → `src/edit.ts` | shorter domain noun | ported+renamed |
| `src/Writeintent.ts` → `src/intent.ts` | context implies "write" | ported+renamed |
| `src/rule.ts`, `src/pattern.ts`, `src/constants.ts` | same | ported |
| `src/Activebranch.ts` → `src/branch.ts` | shorter domain noun | ported+renamed |
| `src/constants.ts`, `src/frontmatter.ts` | same paths | ported |
| `src/kernel/Harnesshook.ts` + `Harnessrule.ts` | grouped as `src/Harness/{Hook,Rule}.ts` (domain folder + short type files) with the filter helpers lifted into each module | ported+renamed |
| `src/kernel/Matcherinput.ts`, path helper | `src/kernel/Matcherinput.ts`, `src/kernel/normalize.ts` | ported |
| `src/kernel/services/{HookSet,RuleSet,RuleEngine,HarnessController,PatternCatalog,PatternMatcher,WriteProjection,RuleCatalog}.ts` | same paths | ported |
| `src/kernel/layers/KernelLayer.ts` | same path | ported |
| `src/atoms/**` (14 files) | folded into their domain modules (`Pattern.globMatchesFilePath`, `WriteIntent.contentRaw`, `UserMessage.isEmpty/normalized`, `EditReplacement.resolution/resolvedSpan/isApplicable`) — no separate atom files | ported+merged |
| Write-intent phase literals `'tool_call'/'tool_result'` | renamed `'before'/'after'` per spec §2.1 | adapted |

### From pi-effect-harness → `packages/effect-harness`
| Upstream | Ours | Status |
|---|---|---|
| `skills/` (53 SKILL.md), `patterns/` (46), `guidance/` (4) | copied verbatim into packages/effect-harness | done |
| `src/index.ts` (pi ExtensionAPI wiring) | OpenCode `Plugin.define` entry | in progress |
| `src/constants.ts`, `src/layers/EffectHarnessLayer.ts` | same names, v2 seams | next |
| `src/services/*`, `src/hooks/*`, `src/rules/*`, `src/atoms/*` | same names | next |
| `test/helpers/kernel.ts`, pattern-test-harness DSL | colocated under test/ | started |

### From effect-autoagent → `packages/compound-kit`
| Upstream | Ours |
|---|---|
| `Atif.ts` (AtifTrajectory/AtifStep/FinalMetrics/StepBuilder) | `src/index.ts` ATIF schemas (wire-compatible) |
| `Agentblueprint.ts`, `Blueprintstore.ts`, `BlueprintPatch.ts` (pure fold) | blueprint domain + versioned store + rollback |
| `AgentRunResult.ts`, `Metrics.ts`, `UsageMetrics.ts`, `Experimentlog.ts` (TSV codecs) | benchmark run/report/experiment-log codecs |
| `MetaAgent.ts` diagnose→propose→benchmark→evaluate(keep/discard) loop | MetaLoop service |
| AVO ([arXiv:2603.24517](https://arxiv.org/html/2603.24517v1)) as design analogy only: `Vary(P)=Agent(P,K,f)`, correctness-gated commits, scored lineage, stagnation redirect | `PromptEvolutionService` |

### From pi-compound → compound mining loop
Two-stage distiller prompts (Stage-1 recall / Stage-2 gate with null bias,
verbatim user evidence), doc+sidecar pairs, `.index.json` approved/rejected
hashes + `sessions_seen` cursors, append-only docs, human review queue
(approve/edit/skip/reject/abort).

Core imports are host-neutral. Only the harness entry (`packages/effect-harness/src/index.ts`),
the TUI entrypoint, and the full-client collector/CLI may import
`@opencode-ai/*`.

The manifest shape is pinned and tested rather than inferred:

```json
{
  "name": "opencode-effect-harness",
  "type": "module",
  "bin": { "opencode-effect-harness": "./src/cli.ts" },
  "exports": {
    ".": "./src/index.ts",
    "./tui": "./src/tui.tsx",
    "./kernel": "./src/kernel/index.ts",
    "./verify": "./src/verify/index.ts",
    "./compound": "./src/compound/index.ts",
    "./collector": "./src/collector.ts",
    "./cli": "./src/cli.ts",
    "./modules/*": "./modules/*.ts"
  },
  "dependencies": {
    "@opencode-ai/plugin": "<one exact beta version>",
    "@opencode-ai/client": "<the same exact beta version>",
    "effect": "<the exact compatible v4 RC>",
    "@effect/platform-node": "<the matching effect v4 version>",
    "@ast-grep/napi": "<pinned compatible version>",
    "yaml": "<pinned compatible version>"
  },
  "peerDependencies": {
    "@opencode-ai/theme": "<matching beta version>",
    "@opentui/core": ">=0.5.6",
    "@opentui/solid": ">=0.5.6",
    "solid-js": ">=1.9.0"
  }
}
```

The literal version placeholders are replaced by the compatibility probe's
selected versions before publishing. `@opencode-ai/plugin/effect` is the only
server plugin import; the legacy OpenCode plugin API is not used.

## 1. Original Port Inventory (Non-Authoritative)

The following inventory preserves the mapping from the first draft for
traceability only. The canonical one-package layout above is the implementation
plan; do not create the unpublished workspace packages described below.

```
opencode-effect-harness/
├── package.json                     # single npm package; exact plugin/effect versions
├── opencode.json                    # dev harness config (loads ./src/index.ts)
├── packages/
│   ├── kernel/                      # @effect-harness/kernel   (host-agnostic; NO @opencode-ai imports)
│   │   └── src/
│   │       ├── decision/            # Decision schema (4 variants) + executor algebra
│   │       ├── rule/                # Rule.Definition, RuleSet, RuleCatalog, RuleEngine
│   │       ├── pattern/             # Pattern.Value, PatternCatalog, PatternMatcher (@ast-grep/napi|regex|picomatch)
│   │       ├── write/               # WriteIntent, EditReplacement, WriteProjection
│   │       ├── branch/              # ActiveBranch snapshot schema (+ compaction semantics)
│   │       ├── skill/               # SkillIndexEntry, path matching helpers
│   │       ├── hook/                # HarnessHook phases, HookSet
│   │       ├── controller/          # HarnessController (phase dispatch: hooks→rules)
│   │       ├── atom/                # pure derived-value fns + Effect Atom twins
│   │       ├── frontmatter.ts       # YAML frontmatter parser for pattern/skill md
│   │       └── errors.ts
│   ├── verify-core/                 # @effect-harness/verify-core (host-agnostic verification engine)
│   │   └── src/
│   │       ├── module/              # VerificationModule domain + registry service
│   │       ├── checker/             # Checker spec → CommandExecutor invocation → Diagnostics parsing
│   │       ├── report/              # VerifierReport schemas (machine-readable verdicts)
│   │       ├── policy/              # TriggerPolicy (when to verify: events/debounce/manual)
│   │       └── orchestration/       # VerifyOrchestrator.Interface (pure workflow; host supplies effects)
│   ├── compound-core/               # @effect-harness/compound-core (host-agnostic blueprint machinery)
│   │   └── src/
│   │       ├── trace/               # SessionTrace, ATIF port (AtifTrajectory etc.), converters
│   │       ├── insight/             # Insight/Candidate schemas (Stage-1 output)
│   │       ├── blueprint/           # Blueprint, BlueprintPatch (pure applyPatches), BlueprintStore iface+fs layer
│   │       ├── distill/             # Distiller.Interface (two-stage pipeline contract), prompts as data
│   │       ├── benchmark/           # TaskSpec, BenchmarkRunner.Interface, Scoring, ExperimentLog (TSV codec pure)
│   │       └── meta/                # MetaLoop.Interface: diagnose→propose→benchmark→evaluate(keep/discard)
│   └── adapters-opencode/           # @effect-harness/adapters-opencode (ONLY package importing @opencode-ai/*)
│       └── src/
│           ├── context/             # PluginContext service wrapping ctx domains as Context.Tag services
│           ├── tool-events/         # execute.before/after payloads → WriteIntent / ToolEventSnapshot analogs
│           ├── decisions/           # Decision → v2 effects (throw-to-block, synthetic inject, storage entry)
│           ├── sessions/            # LiveSessionSource; historical full-client source lives in TUI/CLI
│           ├── skills/              # SkillCatalogSource: skill.transform add() of bundled catalog + event tracking
│           ├── agents/              # configured worker IDs and internal-session restrictions
│           ├── commands/            # TUI/config command protocol; no undocumented server add
│           ├── events/              # typed Stream<Event> selectors (skill.activated, compaction, execution…)
│           ├── storage/             # KV-backed ModePersistence / IndexStore implementations
│           └── llm/                 # LlmExecutor: runs a Blueprint either via spawned OpenCode session or @effect/ai provider layer
├── modules/
│   ├── verify-typescript/           # bundled VerificationModule: tsc --noEmit + test-runner detection (vitest/jest/bun)
│   └── verify-bend-example/         # documented example third-language module (not installed by default)
├── assets/
│   ├── skills/effect-*/SKILL.md     # migrated verbatim from pi-effect-harness (~50)
│   ├── patterns/*.md                # migrated verbatim (46 detectors)
│   ├── guidance/*.md                # migrated verbatim
│   └── blueprints/seed/             # seed benchmark tasks (hello-world style, from effect-autoagent format)
├── plugin/
│   └── src/
│       ├── index.ts                 # Plugin.define({ id:"ox.effect-harness", effect }) — composition root ONLY
│       ├── options.ts               # PluginOptions Schema (decode/validate ctx.options)
│       ├── layers.ts                # EffectHarnessRuntime layer graph assembly
│       ├── rules/                   # InjectEffectPolicyHeader, RequireLoadedSkillsForEffectWrites, SendPatternFeedbackAfterWrite (ports)
│       ├── hooks/                   # RebuildSkillCatalog, TrackSkillRead, EmitSkillLoaded, EnsureReferenceClone, ClearPending ports
│       ├── verifier/                # verifier agent wiring: trigger listeners → orchestrator → report delivery
│       └── compound/                # compound agent wiring: triggers → distiller/benchmark pipelines
└── test/                            # per-package tests colocated like upstream (test/*.test.ts)
```

**Dependency direction (enforced by review/lint):** `src/opencode` and the four
host entrypoints depend on `{kernel, verify, compound} → effect`; core modules
never import adapters or host SDK. Assets are data-only.

**Distribution (historical sketch superseded):** the canonical package boundary
above is the authoritative export map. It uses `./src/index.ts`, `./src/tui.tsx`,
and public core subpaths; it does not ship unpublished `workspace:*` runtime
dependencies. `opencode2 plugin add opencode-effect-harness` must work from the
packed artifact.

---

## 2. Domain model (Effect `Schema.Class`, all in core packages)

Naming convention mirrors upstream: namespace + `Value` schema type + `Context.Service` tags `'ox-effect-harness/<pkg>/<Name>'`.

### 2.1 kernel (ported, renamed tags only)

```ts
// decision/decision.ts — unchanged semantics
Decision.Value = BlockToolCall{reason} | InjectUserMessage{content, deliverAs?}
               | InjectSystemPrompt{content} | AppendCustomEntry{customType, data}

// write/Writeintent.ts
WriteIntent.Phase = 'before' | 'after'                    // was tool_call|tool_result
WriteIntent.Value = WriteFile{phase, filePath?, content} | EditFile{phase, filePath?, replacements: EditReplacement.Value[]}

// pattern/pattern.ts — detector union preserved
Pattern.Detector = AstDetector{patterns|rule|inside|constraints} | RegexDetector{pattern, matchInComments}
Pattern.Value    = { name, description, level, glob?, ignoreGlobs?, suggestSkills[], detector, guidance }

// branch/Activebranch.ts — neutral snapshot; CompactionEntry remains the reset marker.
// In v2 we synthesize entries from durable events; shape kept for kernel compatibility.
// skill/SkillIndexEntry.ts = {name, skillFilePath, skillDir}
// rule/Rule.Definition action stays 'blockToolCall'|'injectUserMessage'|'injectSystemPrompt'|'appendCustomEntry'
```

### 2.2 verify-core

```ts
export class CheckerSpec extends Schema.Class<CheckerSpec>('CheckerSpec')({
  kind: Schema.Literals(['typecheck', 'test', 'lint', 'build', 'custom']),
  label: Schema.String,
  command: Schema.String,                    // argv template, e.g. "bunx tsc --noEmit -p ."
  cwd: Schema.optional(Schema.String),       // relative to project root
  timeoutMs: Schema.Number.pipe(withDefault(120_000)),
  globFilter: Schema.optional(Schema.Array(Schema.String)), // run only if touched files match (picomatch)
}) {}

export class Diagnostic extends Schema.Class<Diagnostic>('Diagnostic')({
  checkerLabel: Schema.String, severity: Schema.Literals(['error','warning']),
  file: Schema.optional(Schema.String), line: Schema.optional(Schema.Number),
  column: Schema.optional(Schema.Number), message: Schema.String,
}) {}

export class VerifierReport extends Schema.Class<VerifierReport>('VerifierReport')({
  sessionID: Schema.String,                  // session that triggered it
  status: Schema.Literals(['pass','fail','error','skipped']),
  checks: Schema.Array(CheckerResult),       // {spec, exitCode, durationMs, diagnostics[]}
  skillsFindings: Schema.optional(Schema.Array(Schema.String)), // semantic-review findings when enabled
  startedAt: Schema.Number, finishedAt: Schema.Number,
}) {}

export interface VerificationModule {
  readonly id: string;                                  // e.g. "typescript", "bend"
  readonly languages: ReadonlyArray<string>;            // ["ts","tsx"] / ["bend"]
  readonly appliesTo: (filePath: string) => boolean;     // picomatch-based, pure
  readonly checkers: (ctx: ProjectContext) => Effect.Effect<ReadonlyArray<CheckerSpec>, ModuleError>;
  readonly skills: ModuleSkillCatalog;
  readonly patterns: ModulePatternCatalog;
  readonly parseDiagnostics?: (checker: CheckerSpec, stdout: string, stderr: string) => ReadonlyArray<Diagnostic>;
}

// Services
moduleRegistry: { register(module), resolve(filePath): Effect<Option<VerificationModule>>, all }
verifyOrchestrator: {
  verify(input: { projectRoot, touchedFiles?: string[], sessionId }): Effect<VerifierReport, VerifyError>,
  // fast deterministic path; spawns no LLM
}
semanticReviewer: { review(report): Effect<Array<Finding>> }   // optional; delegates to verifier subagent (adapter impl)
criticService: { review(request: CriticRequest): Effect<CriticReport, CriticError> }
```

**Extensibility contract (user requirement):** modules are plain values implementing `VerificationModule`. Built-in `typescript` ships in `modules/verify-typescript` with the migrated 53-skill/46-pattern Effect catalog. JSON options select built-in IDs and define additional data-only command modules; rich executable modules must be bundled or installed through an explicit package boundary. A bend module owns its own skills/patterns and only needs checkers whose commands exist in the user's environment.

### 2.3 compound-core

```ts
// trace — ported from effect-autoagent/Atif.ts (schemas kept wire-compatible)
AtifStep, AtifTrajectory, FinalMetrics, AgentInfo, StepBuilder        // as upstream
SessionTrace = AtifTrajectory + provenance:
export class TraceProvenance extends Schema.Class('TraceProvenance')({
  sessionID: Schema.String, projectDir: Schema.optional(Schema.String),
  capturedAt: Schema.Number, outcome: Schema.Literals(['success','failed','interrupted','unknown']),
  errorSignature: Schema.optional(Schema.String),      // normalized first-error fingerprint
}) {}

SessionEvent = {
  sessionID: string
  sequence: Option<number>
  kind: 'text' | 'reasoning' | 'tool' | 'usage' | 'execution' | 'compaction'
  timestamp: number
  payload: Schema.Json
}

TraceDigest = {
  taskPrompt: string
  attemptedStrategy: string
  observableSteps: ReadonlyArray<string>       // bounded user/assistant/tool trace excerpts
  failure: Option<string>
  detection: Option<string>                    // how the failure was noticed
  correction: Option<string>                   // what solved or improved it
  transferableLesson: string
  score: Option<number>
  fullTraceRef: Option<string>                 // sanitized ATIF artifact when too large to embed
}

FailureLesson = {
  sourceTrace: string
  attempt: string
  failure: string
  detection: string
  resolution: string
  invariant: string
}

PromptDiagnosis = {
  trace: TraceDigest
  failureMode: string
  missingKnowledge: ReadonlyArray<string>
  missingReasoning: ReadonlyArray<string>
  abstractionGap: Option<string>
  reversePrompt: string                 // reconstructed instruction/strategy that would have prevented the failure
  proposedChange: string
}

// insight — Stage-1 candidate
export class Insight extends Schema.Class('Insight')({
  id: Schema.String,                                   // cand_<hex10>
  kind: Schema.Literals(['failure-pattern','recovery-strategy','task-blueprint','preference']),
  domain: Schema.String,                               // 'coding' | 'research' | 'writing' | 'planning' |
                                                       // 'automation' | 'analysis' | free-form; mined
                                                       // from session content, NOT limited to programming
  anchor: Schema.String,                               // target section in playbook docs
  content: Schema.String,                              // markdown body
  evidence: Schema.String,                             // [role]: "verbatim quote" from transcript
  trace: TraceDigest,                                   // solution trace, not just a citation
  confidence: Schema.Literals(['low','medium','high']),
  sourceSession: Schema.String,
}) {}

// blueprint — the reusable composable module (specialized AgentBlueprint)
export class ModelRef extends Schema.Class('ModelRef')({
  provider: Schema.String, model: Schema.String, variant: Schema.optional(Schema.String),
}) {}                                                  // "anthropic/claude-sonnet-4-5#high" ↔ structured

// Canonical shared domain name is ModelReference; ModelRef is a compatibility alias.

export class AcceptanceCriterion extends Schema.Class('AcceptanceCriterion')({
  description: Schema.String,
  checker: Schema.Union(CommandCheck, AgentJudgeCheck), // command reward-style (code/shell tasks)
                                                       // OR LLM-judge rubric 0..1 — this is what makes
                                                       // NON-code domains (writing, research, planning,
                                                       // analysis) verifiable and scoreable
}) {}

export class Blueprint extends Schema.Class('Blueprint')({
  id: Schema.String, name: Schema.String, version: Schema.String,
  description: Schema.String,
  domain: Schema.String,                               // mirrors Insight.domain; blueprints are
                                                       // prompt+trace modules for ANY difficult task,
                                                       // not only programming
  systemPrompt: Schema.String,                         // the distilled prompt module
  procedure: Schema.Array(Schema.String),              // ordered steps/heuristics mined from traces
  pitfalls: Schema.Array(Schema.String),               // where the original LLM went wrong + detection
  acceptance: Schema.Array(AcceptanceCriterion),       // how executions are verified & scored
  appliesWhen: Schema.optional(Schema.String),         // routing hint for retrieval
  origin: Schema.Array(Schema.String),                 // source session IDs
  createdAt: Schema.Number,
}) {}

export class BlueprintPatch …  // same patch vocabulary + pure applyPatches fold as upstream

// benchmark
TaskSpec        — task dir {name, instruction, domain, files?, verifier: CommandCheck | AgentJudgeCheck, constraints}
                  // domain-agnostic: a task may be a coding exercise, an essay brief, a research
                  // question, or a planning problem; verification is CommandCheck (code) or
                  // AgentJudgeCheck rubric (everything else)
BenchmarkRun    — {blueprintId, modelRef, suiteId, taskResults[], aggregateScore, trial:1, trajectoryPath, usage, durationMs, verdict?{better,worse,equal,why}}
ExperimentLog   — TSV rows identical in spirit to upstream (pure codecs)
```

**Domain scope:** the compound pipeline is deliberately **not limited to programming code**. It mines whatever OpenCode sessions contain — coding, research/analysis, writing, planning/decision-making, automation prompts — because `SessionTrace` is a generic message stream (user prompts, assistant reasoning/text, tool calls + results). Blueprint markdown modules capture the distilled prompt plus its solution traces for any difficult task kind; scoring works through `AgentJudgeCheck` rubrics where no executable check exists.

**Service interfaces** (all `Context.Service`, fs layers provided separately):

```ts
LiveSessionSource { explicit(id): Effect<SessionSummary, SourceError>
                   ; follow(): Stream<SessionEvent> }                     // neutral event projection
HistoricalSessionSource { list(scope: 'project' | 'all', filter?): Effect<ReadonlyArray<SessionSummary>, SourceError>
                         ; export(id): Effect<{info, messages}, SourceError> } // full client/TUI/CLI
TraceBuilder    { fromExport(info, messages): Effect<SessionTrace> }       // pure-ish converter
Distiller       { extract(traces, docs): Effect<ReadonlyArray<Insight>>    // stage 1 (cheap model)
                ; gate(insights, docs): Effect<GateDecision[]> }           // stage 2 (premium model, null-bias)
BlueprintStore  { current, save, history, rollback }                       // as upstream, fs layer under project dir
PlaybookDocs    { append(blueprintId, section, content): … }               // append-only markdown knowledge base
BenchmarkRunner { runAll(opts?), runTask(taskSpec, blueprint, modelRef): Effect<BenchmarkRun> }
Scoring         { aggregate(runs): BenchmarkReport; compare(a, b): Comparison }  // pure
MetaLoop        { diagnose(): Effect<Diagnosis>; evaluatePatches(patches, desc): Effect<EvaluationResult>
                ; state: Effect<OptimizerState> }                          // keep/discard with rollback
LlmExecutor     { execute(prompt, toolkitOpts, modelRef): Effect<ExecOutcome> }
                // two impls: OpenCodeSessionExecutor (adapter: create/prompt/wait + live event recorder)
                 // and DirectAiExecutor (opencode adapter/optional executor package)

// --- Compound operating modes -------------------------------------------------
CompoundMode = Schema.Literals(['benchmark', 'mine-evolve'])

// Mode A — "benchmark": exactly one run per configured model, then score.
BenchmarkRequest = {
  blueprintRef: BlueprintModuleRef
  taskIds: NonEmptyReadonlyArray<string>  // selected benchmark cases
  models: ReadonlyArray<ModelReference>  // user-configured; never implicit all-model spend
  trialsPerModel: 1                      // exactly one agent run per (model, task)
}

BenchmarkRun = {
  model: ModelReference
  taskId: string
  taskResult: TaskResult
  trial: 1
}

// Mode B — "mine & evolve": session mining feeding the prompt-evolution loop.
PromptEvolutionConfig = {
  blueprintRef: BlueprintModuleRef
  evaluationSet: EvaluationSet                  // frozen scoring function f
  maxVariationSteps: number
  stagnationLimit: number                      // consecutive non-improving attempts before redirect
  improvementModel: Option<ModelReference>     // the variation operator's model
}

EvaluationSet = {
  trainTaskIds: NonEmptyReadonlyArray<string>
  holdoutTaskIds: NonEmptyReadonlyArray<string> // never shown to the variation agent
  evaluatorVersion: string                      // task/rubric/checker manifest hash
}

// AVO operator model: Vary(P) = Agent(P, K, f)
EvolutionLineage = {
  blueprintId: string
  committed: ReadonlyArray<CommittedVersion>   // only correctness-passing, strict-improvement versions
  attempts: ReadonlyArray<VariationAttempt>    // failed/rejected attempts — kept for learning, never promoted
}

CommittedVersion = {
  version: string
  markdownPath: string                // appended to the Blueprint markdown module
  score: number
  baselineScore: number
  holdoutScore: Option<number>
  evaluatorVersion: string
  solutionTraces: ReadonlyArray<TraceDigest>
  diffSummary: string                 // what reasoning/knowledge/abstraction was added and why
  committedAt: number
}

VariationAttempt = {
  id: string
  proposedChange: string              // better reasoning / more knowledge / exploration / abstraction
  outcome: Schema.Literals(['failed-verification', 'score-regression', 'abandoned'])
  score: Option<number>
  verification: 'passed' | 'failed' | 'unavailable'
  lessonLearned: string               // fed back into K for future variation steps
}

PromptEvolutionService = {
  establishBaseline(blueprint, evaluationSet): Effect<CommittedVersion, BaselineError>
  vary(lineage, knowledgeBase): Effect<VariationAttempt>   // agent loop: consult P, K; edit candidate prompt; self-test via f
  commit(attempt): Effect<Option<CommittedVersion>>        // default: verification passes AND train + holdout scores strictly beat baseline
  redirect(lineage): Effect<VariationDirection>            // stagnation supervisor: fresh optimization directions
  lineage(blueprintId): Effect<EvolutionLineage>
}
```

The evolution service uses AVO ([arXiv:2603.24517](https://arxiv.org/html/2603.24517v1), an attention-kernel optimization paper) as a design analogy, not as evidence for this project's domains: the compound agent is elevated from "prompt generator" to **variation operator** — it autonomously consults the scored lineage `P`, the knowledge base `K` (mined insights, skill/pattern catalogs, reference clone), and the fixed scoring function `f` (train + hidden holdout task set); it runs an edit–evaluate–diagnose cycle inside one step; commits follow the stricter migration policy (correctness gate + train and holdout score strictly better than the best committed score); and a supervisor redirects exploration on stagnation instead of letting unproductive cycles accumulate.

---

## 3. Runtime layer graph (composition root)

```
PluginOptions (decoded ctx.options)
   │
PlatformLayer (NodeFileSystem + NodePath + NodeChildProcessSpawner from @effect/platform-node)
   │
 ├─ kernel: PatternCatalog(patternsDir) · WriteProjection · RuleCatalog/RuleSet(rules below) · HookSet(hooks below) · RuleEngine · HarnessController
 ├─ effect-harness: SkillCatalog(bundled assets + skill.transform list merge) · GuidanceCatalog(guidanceDir,skillsDir)
 │                  · PendingSkillRefs(per-session Ref map) · SkillLoadedState(events-seeded) · ReferenceClone(cacheDir option)
 │                  · SkillTelemetry(jsonl path option)
 ├─ verify: ModuleRegistry(typescript builtin + options.modules) · CommandExecutor(platform) · VerifyOrchestrator
+│          · CriticService(independent review worker; read-only)
 │          · TriggerPolicy(debounce config) · SemanticReviewer(adapter → verifier subagent)
 ├─ compound: LiveSessionSource + client-side HistoricalSessionSource · TraceBuilder · Distiller · BlueprintStore(projectDir/.effect-harness/blueprints)
 │            · PlaybookDocs · BenchmarkRunner(LlmExecutor + Scoring + verifier reuse) · ExperimentLog · MetaLoop
 │            · PromptEvolutionService(AVO lineage/commit/redirect)
 └─ host: PluginContext(ctx domains as services) · StorageStore(keys namespaced "ox-effect-harness/*") · EventStream(selectors)
```

Ruleset composition (identical gating semantics to upstream, with agent-aware advisory mode):

```ts
RuleSet.all = modeEnabled ? [injectPolicyHeader, requireLoadedSkillsForEffectWrites(isAdvisory(agent)), sendPatternFeedbackAfterWrite] : []
isAdvisory(agent) = !(options.harness.strictAgents ?? ['build']).includes(agent)
```

## Canonical Domain Corrections

The following replaces the schematic definitions above where they were
underspecified.

### Verification command and module domains

Checker commands are argv values, never interpolated shell strings:

```ts
CommandSpec = {
  executable: string
  args: ReadonlyArray<string>
  cwd: string
  timeout: Duration
  env: ReadonlyMap<string, string>
  maxOutputBytes: number
}

CheckerSpec = {
  id: string
  kind: 'typecheck' | 'test' | 'lint' | 'build' | 'custom'
  command: CommandSpec
  appliesTo: ReadonlyArray<string>
}

VerificationModule = {
  id: string
  languages: NonEmptyReadonlyArray<string>
  appliesTo: (path: string) => boolean
  checks: (context: ProjectContext) => Effect.Effect<ReadonlyArray<CheckerSpec>, ModuleError>
  parse: (checker: CheckerSpec, output: CommandResult) => ReadonlyArray<Diagnostic>
  // Language-specific knowledge base (per-module, not global):
  skills: ModuleSkillCatalog      // e.g. TypeScript module ships the 53 effect-* SKILL.mds
  patterns: ModulePatternCatalog  // e.g. TypeScript module ships the 46 pattern detectors
}

ModuleSkillCatalog = {
  root: string                                   // package-relative skills dir for this module
  entries: ReadonlyArray<SkillIndexEntry>        // {name, skillFilePath, skillDir}
  manifest: SkillCatalogManifest                 // source commit + content hash + generated count
  load: (name: string) => Effect.Effect<string, SkillLoadError>
  reviewPolicy: SkillReviewPolicy                // which skills the verifier must check evidence for
}

SkillCatalogManifest = {
  source: string                                  // upstream repository/commit
  contentHash: string
  skillCount: number                              // generated from the asset tree; currently 53 at the inspected commit
}

SkillReviewPolicy = {
  requireEvidenceFor: 'touched-effect-files' | 'all-changed' | 'off'
  minLoadedSkills: number                        // informational in verify context (gate owns enforcement)
  suggestSkillsOnFindings: boolean               // pattern findings cite their suggestedSkills
}

ModulePatternCatalog = {
  root: string                                   // package-relative patterns dir for this module
  detectors: ReadonlyArray<PatternDetector>      // same schema as the harness kernel Pattern.Value
}
```

The bundled **TypeScript module** is the pi-effect-harness knowledge base: its `skills/` holds the complete generated upstream `effect-*/SKILL.md` inventory (53 files at the inspected commit) and its `patterns/` the 46 detectors. A future bend module would ship its own `skills/` + `patterns/` directories with the same interfaces — no TypeScript assumption anywhere in verify-core. The verifier's semantic review and the deterministic pattern/skill-evidence checks both read these per-module catalogs (including bounded body loading); this is "pi-effect-harness running its skill catalog to verify", generalized per language.

```ts
ChangeSetProvider = {
  fromLedger: (ledger: ChangeLedger) => Effect.Effect<ChangeSet, ChangeSetError>
  fromVcs: (root: string, paths: ReadonlyArray<string>) => Effect.Effect<ChangeSet, ChangeSetError>
}

CriticRequest = {
  builderSessionID: string            // neutral session identifier; host adapters brand/validate it
  summary: string                     // builder's short summary of what it did
  planRef: Option<string>             // plan/spec artifact reference when a new feature/plan landed
  changeSet: Option<ChangeSet>        // absent for a plan-only checkpoint
  traceRefs: ReadonlyArray<string>    // live/historical trace IDs for evidence
  checkpoint: CriticCheckpoint
}

CriticFocus = Schema.Literals(['feature', 'plan', 'architecture', 'drift', 'full'])

CriticCheckpoint = {
  kind: CriticFocus
  explicit: boolean                    // automatic invocation requires an explicit builder checkpoint
}

CriticFinding = {
  id: string
  severity: 'critical' | 'major' | 'minor' | 'note'
  kind: Schema.Literals([
    'logical-flaw',        // reasoning contradictions, unsound conclusions
    'hallucination',       // claim contradicts repo/reference evidence
    'domain-error',        // wrong domain expertise / API misuse at design level
    'reference-mismatch',  // cited reference does not say what is claimed
    'architecture-drift',  // decision diverges from spec/architecture without justification
    'missing-consideration'
  ])
  claim: string                       // what the builder asserted/did
  evidence: string                    // file/line or reference citation that supports the finding
  suggestion: Option<string>
}

// src/shared/ModelReference.ts — shared by verify, compound, and adapters
ModelReference = {
  provider: string
  model: string
  variant: Option<string>
}

CriticReport = {
  request: CriticRequest
  builderModel: Option<ModelReference>
  criticModel: Option<ModelReference>
  verdict: 'sound' | 'concerns' | 'flawed'
  findings: ReadonlyArray<CriticFinding>
  checkedReferences: ReadonlyArray<string>   // references the critic actually opened/verified
  workerSessionID: Option<string>
}
```

`ProjectContext`, `CommandResult`, `Diagnostic`, and every error type are
defined as `Schema.Class`/`Schema.TaggedErrorClass`; the displayed shape is a
domain summary, not a substitute for those declarations. JSON plugin options
can select built-in IDs or provide data-only command modules. Rich executable
modules are bundled or installed as a separate package with explicit
dependencies; JSON cannot install or carry functions.

Verification modules are executable values loaded by a `ModuleLoader` service;
their serializable configuration is separate from the value itself. A module
does not receive a raw shell string. `ProjectContext` contains the resolved
project root, normalized touched paths, package-manager command, and an
allowlisted environment.

### Verification and acceptance schemas

```ts
CheckVerdict = 'passed' | 'failed' | 'error' | 'skipped'

CheckerResult = {
  checker: CheckerSpec
  verdict: CheckVerdict
  exitCode: Option<number>
  stdout: string
  stderr: string
  diagnostics: ReadonlyArray<Diagnostic>
  duration: Duration
}

SemanticReviewResult = {
  status: 'passed' | 'failed' | 'error' | 'skipped'
  findings: ReadonlyArray<ReviewFinding>
  workerSessionID: Option<string>
}

VerifierReport = {
  request: VerifyRequest
  language: ReadonlyArray<CheckerResult>
  patterns: ReadonlyArray<PatternFinding>
  skillEvidence: SkillEvidenceResult
  semantic: SemanticReviewResult
  overall: 'passed' | 'failed' | 'error' | 'skipped'
}

CommandCheck = {
  _tag: 'command'
  command: CommandSpec
  success: SuccessPredicate
}

AgentJudgeCheck = {
  _tag: 'agent-judge'
  rubric: string
  scoreRange: { min: number; max: number }
}

AcceptanceCriterion = {
  id: string
  description: string
  check: CommandCheck | AgentJudgeCheck
}
```

These are `Schema.Class`/`Schema.TaggedUnion` declarations in code. The
`overall` verdict is derived from the component verdicts and never hides a
skipped or errored semantic review behind a deterministic pass.

### Composable blueprint domain

Blueprints are a graph-free ordered composition of independently versioned
modules. This keeps execution deterministic and avoids turning composition
into an implicit mutable dependency graph:

```ts
BlueprintModule = {
  id: string
  version: string
  description: string
  prompt: string
  appliesWhen: ReadonlyArray<string>
  provides: ReadonlyArray<string>
  conflicts: ReadonlyArray<string>
  failureModes: ReadonlyArray<FailureMode>
  recovery: ReadonlyArray<string>
  evidence: ReadonlyArray<EvidenceRef>
  solutionTraces: ReadonlyArray<TraceDigest>
}

Blueprint = {
  id: string
  version: string
  name: string
  modules: NonEmptyReadonlyArray<BlueprintModuleRef>
  execution: BlueprintExecutionSpec
  acceptance: NonEmptyReadonlyArray<AcceptanceCriterion>
  origins: NonEmptyReadonlyArray<string>
}

BlueprintModuleRef = {
  id: string
  version: string
  required: boolean
}

BlueprintExecutionSpec = {
  workerAgent: string
  tools: ReadonlyArray<string>
  maxTurns: number
  timeout: Duration
  budget: Option<number>
}

composeBlueprints = (
  modules: ReadonlyArray<BlueprintModule>,
  refs: ReadonlyArray<BlueprintModuleRef>
) => Effect.Effect<ComposedPrompt, CompositionError>

BlueprintInterpreter = {
  render: (module: BlueprintModule, context: RenderContext) => Effect.Effect<PromptFragment, ModuleError>
  verify: (criterion: AcceptanceCriterion, context: VerificationContext) => Effect.Effect<Score, ModuleError>
}
```

`composeBlueprints` is pure with respect to the environment: it resolves refs,
deduplicates by stable `(id, version)`, preserves declared order, and fails on
declared `provides`/`conflicts` keys instead of silently concatenating them. `Blueprint`
and `BlueprintModule` are serializable; `LlmExecutor`, `AcceptanceCriterion`
implementations, and module loaders are services.

LLM-produced modules are declarative data interpreted by
`BlueprintInterpreter`; generated source is never evaluated. Human-authored
modules may provide typed implementations and their own `Layer`, but those
implementations remain outside persisted blueprint data.

### Layer and lifecycle law

Every live service is constructed in one layer graph and provided before the
plugin effect reaches its boundary. Registrations are finite setup effects.
Every event consumer is explicitly `Effect.forkScoped` around a stream
consumer with `Effect.catchAllCause`, so unload interrupts it. No core service
starts a daemon, calls `Effect.runPromise`, or stores mutable module-global
state. TUI Promise calls are allowed only in `tui.tsx`, at the host boundary,
and delegate into the same core Effects.

### Layout & naming law (2026-08-29 correction)

1. **Very short file names.** Source files are short PascalCase domain nouns
   (`gate.ts`, `runner.ts`, `tool.ts`, `executor.ts`) — compound
   `SubjectVerb`/`DomainPart` names (`Sessionexecutor.ts`,
   `Benchmarkrunner.ts`) are avoided at the top level.
2. **Composed domains live in a folder.** When a concept composes multiple
   other types/services, the related files move into a domain folder named
   after the domain (short noun): `src/session/` (`sessions.ts` location
   resolver, `origins.ts` child-origin registry, `executor.ts` host session
   adapter) and `src/benchmark/` (`runner.ts` job orchestrator, `tool.ts`
   op surface). The folder — not a long filename — carries the domain.
3. **File matches the primary exported namespace**, with one documented
   exception: the namespace may stay domain-prefixed when the bare noun
   collides with a host or other-domain name (`Benchmark/tool.ts` exports
   `BenchmarkTool`, because bare `Tool` collides with the host schema `Tool`
   in the composition root).
4. Tests stay colocated next to the file they test
   (`Benchmark/runner.test.ts`).

### Type-driven design law (2026-08-29 correction)

Illegal states are made unrepresentable by types and Schema — a runtime `if`
guarding "can't happen" shapes is a design smell and gets replaced by:

1. **Union types over string-mode checks.** A database filename is
   `{ _tag: 'Memory' } | { _tag: 'File'; path }`; the store layer is
   overloaded so a File database REQUIRES the platform layer at compile
   time. No `if (filename !== ':memory:')`.
2. **Schema refinements at the boundary.** Slugs, bounded numbers, and
   non-empty lists are enforced by Schema (`makeFilter` slug check,
   `Finite.check(isBetween(...))`, `NonEmptyArray`) — e.g. a task without
   candidate profile ids, or `trials: 9`, cannot be decoded.
3. **Total Record maps over if-chains on Literal unions.**
   `ExecutorOperation` is a Literal union; its status mapping is
   `Record<ExecutorOperation, TrialStatus>` — exhaustiveness is checked by
   the compiler, not by a final `else`.
4. **Exhaustive `Match.value` over tagged op unions.** The benchmark tool
   dispatch covers every op via `Match.when` + `Match.exhaustive`; a new op
   without a handler is a compile error.
5. **`Option` getters over `undefined` checks.** Single-entity store getters
   return `Option<T>`; "not found" is a value handled with `Option.match`.
6. **Boundary decode through Schema classes with `NonEmptyString`.** Host
   session-create/generate responses are decoded — an empty session id or
   generation is a typed decode failure, never `if (text.length === 0)`.
7. **Guarded state transitions in SQL, not read-check-write in code.**
   A trial's terminal transition is
   `UPDATE … WHERE status='pending' RETURNING` — double completion is
   `Option.none`; the leading solution is INSERT-only; the history chain is
   re-verified on read and a mismatch fails typed.
8. **Typed error channels instead of undefined smuggling.** `Model.Ref.parse`
   failures are mapped to a typed `ExecutorError`; nothing "becomes
   undefined" to keep the compiler quiet.

Where a residual `if` remains, it guards genuine runtime data flow (e.g.
branching on an already-validated Option inside `Option.match` callbacks),
not representable-in-type state.
