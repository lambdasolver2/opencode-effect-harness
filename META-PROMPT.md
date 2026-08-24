# Expert Meta-Prompt: Build a Verified Agent Engineering Control Plane

## How To Use This Prompt

You are a staff-level software architect and implementation agent. Build the
system described below from an empty repository. Treat this document as a
product contract and implementation specification, not as a request for a
design essay or a partial prototype.

The system is instantiated for an OpenCode v2 Effect plugin whose target
framework is Effect v4. The prompt is intentionally domain-first: derive the
types, state transitions, ports, adapters, and tests from the invariants below.
Do not copy an existing repository layout, assume undocumented APIs, or infer
requirements from a prior implementation.

When an official API, installed declaration file, and example disagree, the
exact pinned dependency plus a compile/runtime capability probe is the source
of truth. Record the result in an ADR and make unsupported capabilities an
explicit release decision. Never hide an assumption behind a type cast or a
best-effort stub.

---

## 1. Mission

Build a modular agent-engineering control plane with four cooperating
capabilities:

1. **Framework enforcement**: teach an agent a target framework's authoritative
   skills and prevent unprepared framework code from being written when policy
   requires preparation.
2. **Verification**: run deterministic language checks, structural/pattern
   checks, required-skill evidence checks, and optional semantic review as
   separate report components.
3. **Independent criticism**: let a builder request a read-only second opinion
   about its reasoning, references, architecture, and domain decisions.
4. **Compound learning**: mine sanitized session evidence into approved,
   reusable prompt modules; benchmark them; and evolve them under strict
   correctness and train/holdout promotion rules.

The result must be a working OpenCode v2 plugin, not merely a collection of
domain interfaces. Every public capability needs an executable implementation,
typed failure behavior, tests, documentation, and a release acceptance test.

### 1.1 Fixed target values

Use these values unless the implementation documents a deliberate, tested
replacement:

| Item | Value |
|---|---|
| Server plugin API | OpenCode v2 Effect plugin API |
| Plugin entrypoint | `@opencode-ai/plugin/effect` |
| Historical client boundary | `@opencode-ai/client/effect` in the companion only |
| Plugin ID | `opencode.effect-harness` |
| Package name | `opencode-effect-harness` |
| Runtime | Bun, ESM TypeScript |
| Target framework | Effect v4 |
| Skill-gate default | four distinct loaded target-framework skills |
| Full-parity companion | TUI/client surface is required; headless operation remains supported |
| Public verification tool | `effect_harness_verify` |
| Public critic tool | `effect_harness_critic` |
| Public compound tool | `effect_harness_compound` |
| Public telemetry tool | `effect_harness_skill_stats` |
| Public mode tool | `harness_toggle` |

The skill, pattern, and guidance inventories are data inputs, not prose claims.
Acquire them from the authoritative Effect v4 source used by the target
framework, preserve their bodies, emit a manifest with source revision and
hashes, and derive their counts in CI. At the reference source revision for
this instantiation, the expected baseline is 53 skill files, 46 pattern files,
and 4 guidance files. A changed upstream revision requires an updated manifest
and ADR; it is not permission to omit assets or silently rewrite them.

For this instantiation, the source reference is
`https://github.com/mpsuesser/pi-effect-harness/tree/main/harnesses/effect/skills`.
The checked-in destination is `packages/effect-harness/skills/effect-*/SKILL.md`.
The corresponding pattern and guidance directories are siblings of `skills/`.
If the destination is absent, acquire the catalog from the pinned upstream
commit before implementing framework-specific behavior. If network access is
unavailable and no complete checked-in copy exists, stop with a blocked
preflight; do not invent replacement skills or claim parity.

---

## 2. Non-Negotiable Engineering Rules

### 2.1 Implementation integrity

- Build in small, reviewable phases. Keep the repository type-safe after each
  phase.
- Inspect the actual installed OpenCode and Effect declarations before writing
  adapters. Compile a minimal probe for every uncertain API.
- Do not delete, skip, weaken, or rewrite tests merely to obtain a green run.
  The test inventory may only decrease with a documented replacement and an
  explicit approval record.
- Do not replace a real workflow with a shortcut such as "run `tsc` directly"
  when the contract requires module resolution, pattern findings, evidence,
  reports, or review.
- Do not use `as never`, `as any`, non-null assertions, or unchecked casts to
  silence a boundary mismatch. Validate and convert at the boundary instead.
- Do not claim feature parity from compilation, unit tests, or a capability
  probe alone. Separate unit, adapter, packed-artifact, and live-server claims.
- Never silently remove a feature because an API is inconvenient. Mark it as a
  capability-gated limitation, implement the supported alternative, or stop the
  release gate.

### 2.2 TypeScript and Effect

- Use strict TypeScript, ESM, `verbatimModuleSyntax`, and exact optional
  property semantics.
- Pin one exact compatible OpenCode beta and one exact compatible Effect v4
  version. Commit the lockfile and test the packed artifact, not only workspace
  symlinks.
- Use `Context.Service`, `Layer`, `Schema.Class`/`Schema.Struct`, typed error
  channels, `Ref`, `Mutex`, `Scope`, `Stream`, and `Effect` combinators.
- Use no authored `any`. Third-party declarations may contain `any`; isolate
  that unsoundness behind a small adapter and expose validated local types.
- Use `Option` internally rather than sentinel `null`/`undefined` for domain
  absence. Decode JSON `null` only at an external boundary.
- Use `Duration` or an injected clock/time service rather than scattered wall
  clock calls in deterministic domain code.
- Use `Effect.forEach`, `Effect.all`, `map`, `flatMap`, `reduce`, and
  `Array`/`Record` combinators. Do not use imperative `for`, `for...of`, or
  `for await` loops in core business logic.
- `Effect.runPromise` is allowed only at an outer host or UI boundary. Core
  modules return Effects and Streams.
- Core modules must not import Node APIs, OpenCode SDK types, JSX, or Promise
  client APIs. Platform and host adapters provide those capabilities.
- Never throw JavaScript errors inside `Effect.gen` or `Effect.fn`. Expected
  failures are typed; defects are caught and logged at explicit boundaries.
- Use the exact error constructor exposed by the pinned Effect release. If the
  release calls it `Schema.TaggedError` rather than `Schema.TaggedErrorClass`,
  use the installed API and record the compatibility decision instead of
  inventing a type name.

### 2.3 Security and trust

- Treat tool input, session text, tool output, Markdown, model output, and
  historical traces as untrusted data.
- Delimit untrusted data in every model prompt. System instructions must say
  that delimited material is evidence to analyze, never instructions to obey.
- Redact secrets, cap bytes and nesting, and record redaction metadata without
  logging the secret.
- Never reconstruct hidden chain-of-thought. Store only observable text,
  exposed reasoning parts, tool calls/results, lifecycle events, and bounded
  summaries.
- Never evaluate, `eval`, dynamically import, or execute source emitted by an
  LLM. Persisted generated content is declarative data interpreted by a typed
  vocabulary.
- Never accept shell command strings from JSON configuration. Commands are
  argv values with an executable, arguments, cwd, timeout, output limits, and
  an environment allowlist.
- Do not allow arbitrary module imports, arbitrary process environments, path
  traversal, unbounded repository dumps, or model-controlled promotion.

### 2.4 Mandatory Effect catalog change gate

The framework catalog is an executable quality gate, not merely documentation
that an agent may read. Keep the complete pinned corpus in
`packages/effect-harness/skills/`, and keep its patterns and guidance beside
it. The catalog check must:

- verify the upstream commit, manifest, hashes, and expected inventory;
- parse every `SKILL.md` and validate its frontmatter/body limits;
- verify unique skill names and paths, required guidance references, and no
  path traversal;
- load every pattern and guidance document;
- execute all pattern detectors against the intended source scope;
- fail on critical self-violations and report non-critical findings;
- prove that enforcement and verification use the same catalog revision;
- emit machine-readable results suitable for a plan checkpoint.

Define one repository command for this gate, for example
`bun run check:effect-catalog`. It must not be a count-only script. It must
exercise the actual parser/catalog/matcher path and include a fixture suite for
positive detections, negative detections, malformed assets, and missing assets.

After every major change, run the complete change gate from the repository root
in this order:

1. `bun run check:effect-catalog`
2. `bun test`
3. `bunx tsgo --noEmit`
4. the full repository test command used by the Effect test integration (for
   example `bun run test` or `bunx vitest run`) if it is distinct from `bun test`;
5. the package/type boundary and packed-artifact checks when package, layer,
   dependency, or public API files changed.

"Major change" includes changes to source under the kernel, adapter,
verification, critic, or compound contexts; Effect layers or service tags;
OpenCode hooks/tools/events; schemas/errors; persistence/journals; skill,
pattern, or guidance assets; package manifests/lockfiles; public exports; or
the technical specification and acceptance plan.

The project must install and pin a compatible `tsgo`/Effect TypeScript
toolchain before declaring this gate available. A successful `tsc` fallback is
useful for diagnosis but does not satisfy the `tsgo` gate. If `tsgo` or the
catalog command cannot run, record the failure as a blocked acceptance gate in
the plan and final report; never convert it to success with `|| true`, a silent
fallback, or a reduced test selection.

The normal Bun test command must execute real tests and must not report success
because no tests were discovered. If `@effect/vitest` is required for Effect
semantics, keep its complete suite as an additional explicit command and make
the distinction visible in CI; do not claim that `bun test` covered a suite it
did not run.

Append each change-gate result to the plan checkpoint with command, dependency
lock, catalog revision, test inventory, exit status, and artifact/probe hashes.

---

## 3. Discovery Before Coding

Before implementation, produce repository-local documents under `docs/spec/`:

1. `00-overview.md`: goals, non-goals, user-visible contracts, terminology.
2. `01-architecture.md`: bounded contexts, dependency graph, layer graph, and
   ports/adapters.
3. `02-integration.md`: verified OpenCode API facts, capability probes, and
   adapter behavior.
4. `03-tasks-risks.md`: phased work, acceptance criteria, risks, and rollback.
5. `04-adversarial-audit.md`: skeptical findings, corrections, and unresolved
   release gates.
6. `05-threat-model.md`: trust boundaries, abuse cases, privacy, and mitigations.
7. `06-acceptance-matrix.md`: requirement -> implementation -> test -> evidence
   mapping.

Add `PLAN.md` at the root linking these documents. Plans and specifications are
versioned in the repository; never write them to a user-global plan directory.

The discovery pass must answer, with evidence:

- Which exact OpenCode package version is targeted?
- Which operations exist on `ctx`, and which exist only on the full client?
- What is the exact tool registration shape in the installed declaration?
- What is the exact `skill.transform` shape in that version?
- Can the target package register package-owned skills natively?
- Which agent/command transforms can add definitions, if any?
- How are session locations resolved from tool hooks?
- How are internal child sessions prevented from recursively triggering work?
- How will historical session collection occur without using restricted context
  APIs?
- Which features are release-blocked if a capability probe fails?

Do not proceed from an unverified assumption merely because an example appears
on a website. Keep a table of `assumption`, `evidence`, `version`, `probe`, and
`fallback/release policy`.

### 3.1 Documentation authority and revision rules

Documentation is part of the product's control plane. It is not a post-hoc
summary and it is not allowed to silently drift from the implementation.
Establish this authority order and record conflicts rather than guessing:

1. verified behavior of the exact pinned host/dependency version;
2. accepted ADRs and normative specification revisions;
3. executable schemas, service contracts, and tests;
4. implementation comments and non-normative examples.

Every technical-spec page has machine-readable metadata, at minimum:
`docId`, `kind`, `revision`, `status`, `normative`, `effectiveAt`, and
`supersedes`. Accepted requirements are never erased. A correction appends a
revision/change record with the old claim, new claim, reason, evidence, impact,
and affected tests. If a human-readable current view is regenerated, its
revision and source event range are visible.

Use a metadata shape like this, adapting only to the repository's chosen
frontmatter schema:

```yaml
docId: integration
kind: technical-spec
revision: 3
status: accepted
normative: true
effectiveAt: 2026-01-01T00:00:00Z
supersedes: integration@2
sourceEvents: plan-events@41..57
```

The implementation must validate this metadata and reject duplicate revisions,
unknown statuses, missing supersession links, and references to unavailable
source events. A document's prose may be rendered as a current view, but the
revision record and evidence remain the authority.

Use stable requirement IDs such as `REQ-ENF-001`, `REQ-VER-004`, and
`REQ-CMP-012`. Use stable decision IDs such as `ADR-0007`. References in code,
tests, critic findings, plans, and reports point to these IDs plus a document
revision, not only to a paragraph that may move.

The repository must distinguish these artifacts:

- **normative specification**: what must be true;
- **ADR**: why an architectural choice was made and what it supersedes;
- **plan**: ordered work and acceptance gates;
- **critic journal**: immutable challenges, evidence, and dispositions;
- **runbook**: how operators recover or diagnose the system;
- **projection**: generated current status derived from append-only records.

A critic, benchmark worker, or generated model may propose a correction, but it
must not edit a normative specification, ADR, plan, or prior audit record. A
human or authorized planner records the decision as a new revision/event.

### 3.2 Required documentation tree

Create a repository-local documentation system with this minimum shape:

```text
PLAN.md                              # links to the current plan projection
docs/
  spec/
    00-overview.md                   # scope, glossary, requirements
    01-architecture.md               # contexts, dependencies, layers
    02-integration.md                # verified host/API contracts
    03-tasks-risks.md                # milestones, risks, rollback
    04-adversarial-audit.md          # normative corrections and gates
    05-threat-model.md                # trust boundaries and abuse cases
    06-acceptance-matrix.md          # requirement-to-evidence traceability
    revisions/                        # immutable accepted spec snapshots/events
  adr/
    ADR-0001-*.md                    # one decision per file
  plan/
    README.md                        # plan protocol and status projection
    events.ndjson                    # append-only plan events
    revisions/                        # immutable plan snapshots
  critic/
    README.md                        # critic protocol and finding lifecycle
    events.ndjson                    # append-only critic/audit event stream
    runs/<run-id>.json                # immutable schema-validated report
    runs/<run-id>.md                  # human-readable immutable projection
  runbooks/
    recovery.md
    capability-failure.md
    release.md
```

The exact filenames may be adapted, but every category and its ownership must
remain present. `docs/spec/04-adversarial-audit.md` is the normative place for
skeptical corrections; a later correction is appended with a new revision and
must update the acceptance matrix.

---

## 3.3 Planning Protocol

Planning is an executable process with evidence, not a checklist written after
the code. The implementation agent must follow this order:

### Planning stage P0: requirements ledger

- translate the mission into uniquely identified requirements;
- mark each as functional, safety, compatibility, operational, or quality;
- define user-visible behavior and explicit non-goals;
- identify assumptions requiring probes;
- define acceptance evidence before selecting implementation details.

### Planning stage P1: domain and architecture

- derive bounded contexts, domain nouns, invariants, state transitions, and
  ownership from the requirements;
- draw the dependency and Effect layer graphs;
- identify every host/platform/LLM/filesystem port and its adapter;
- choose package topology and persistence ownership in an ADR;
- document alternatives rejected and the reason for rejection.

### Planning stage P2: dependency DAG and vertical slices

Create a directed acyclic task graph. Every task record contains:

```text
taskID, objective, requirementIDs, boundedContext, dependencies,
invariants, affected contracts, implementation scope, tests,
documentation updates, acceptance evidence, rollback, risks, owner,
status, blockedBy
```

Prefer vertical slices that finish one usable capability across domain, adapter,
tests, and docs. Do not create a task named "finish the system" or mix an
unverified rename, API migration, feature addition, and test rewrite into one
opaque change.

### Planning stage P3: execution checkpoints

At the start and end of every phase, append a plan event containing:

- the plan revision and source snapshot hash;
- tasks started/completed/blocked;
- commands and probes run;
- tests added and total test inventory;
- changed requirements and decisions;
- unresolved risks and next action.

A task may enter `done` only when its acceptance criteria, tests, docs, boundary
checks, and review state are evidenced. `blocked`, `deferred`, and
`not-applicable` are explicit states, never disguised as success.

### Planning stage P4: adversarial review and release

Before implementation of a high-risk boundary and before release, run an
independent critic against a pinned repository/spec/plan snapshot. The critic
checks requirement coverage, API assumptions, error semantics, security,
concurrency, persistence, test adequacy, and plan drift. The builder responds
with a new plan/spec event that accepts, fixes, disputes, or defers each finding.
No finding is closed by editing its original text.

The plan's append-only event stream is the source of truth. `PLAN.md` and status
tables are projections; if they are regenerated or edited for readability, they
must contain the source revision/event range and must never be treated as the
only history. The planner validates dependency cycles, duplicate IDs, illegal
status transitions, missing acceptance evidence, and stale requirement links.

Use an event shape similar to:

```text
PlanEvent {
  schemaVersion, eventID, planID, sequence, recordedAt, actor,
  repositorySnapshot, planRevision, type, taskID?, requirementIDs[],
  payload, previousHash, entryHash
}
```

The minimum plan event types are `PlanCreated`, `RequirementAdded`,
`DecisionLinked`, `TaskProposed`, `TaskStarted`, `TaskBlocked`, `TaskUnblocked`,
`TaskCompleted`, `TaskDeferred`, `TaskSuperseded`, `CheckpointRecorded`,
`RiskRaised`, `RiskAccepted`, and `PlanClosed`. A task status is a projection
of events, never a freely mutable field. Allowed transitions and their evidence
must be tested; for example, `TaskCompleted` requires all linked acceptance
criteria to have evidence, while `TaskDeferred` requires a reason and a next
review condition.

---

## 4. Architecture

### 4.1 Bounded contexts

Use these bounded contexts and keep their responsibilities distinct:

| Context | Responsibility | May depend on |
|---|---|---|
| Shared | neutral IDs, model references, time, trust metadata, common errors | Effect |
| Enforcement kernel | intent, projection, matching, rules, decisions, hooks | Shared, Effect |
| Host adapter | OpenCode hooks, tools, events, sessions, storage, platform | all cores, OpenCode |
| Verification | modules, command execution ports, pattern/evidence checks, reports | Shared, Enforcement types only where explicitly mapped |
| Critic | independent reasoning audit contract and report | Shared, Verification report types only through neutral summaries |
| Compound | traces, insights, blueprints, distillation, benchmark, evolution | Shared, Verification contracts |
| Companion UI/client | TUI, historical collection, user review, client protocol | Shared, Compound, full OpenCode client |

The dependency graph is acyclic:

```text
                         +-------------------+
                         |  OpenCode server  |
                         +---------+---------+
                                   |
                           host/opencode adapter
                                   |
      +----------------------------+-----------------------------+
      |                            |                             |
 enforcement kernel          verification core             compound core
      |                            |                             |
      +----------------------------+-----------------------------+
                                   |
                                shared
                                   |
                                Effect

 companion client/TUI uses neutral core ports and the full client API;
 it is not imported by server core code.
```

### 4.2 Packaging decision

Use one publishable package with logical internal modules and public subpath
exports. This is the default because `workspace:*` dependencies are not a
publication mechanism and a raw multi-package workspace can pass local tests
while failing in OpenCode's isolated cache.

Recommended development tree:

```text
src/
  index.ts                 # server composition root only
  tui.tsx                  # companion UI composition root only
  shared/
    Id.ts
    Model.ts
    Trust.ts
    Error.ts
  kernel/
    Decision.ts
    Intent.ts
    Edit.ts
    Pattern.ts
    Rule.ts
    Branch.ts
    Message.ts
    Skill.ts
    Normalize.ts
    services/
      Catalog.ts
      Matcher.ts
      Projection.ts
      Engine.ts
      HookSet.ts
      RuleSet.ts
      Controller.ts
  verify/
    Checker.ts
    Module.ts
    Report.ts
    Evidence.ts
    Reviewer.ts
    Orchestrator.ts
    Trigger.ts
    ChangeSet.ts
    services/
      Registry.ts
      Executor.ts
  compound/
    Trace.ts
    Insight.ts
    Blueprint.ts
    Acceptance.ts
    Benchmark.ts
    Evolution.ts
    Distill.ts
    Source.ts
    Store.ts
    Log.ts
    services/
      Runner.ts
      Promoter.ts
  opencode/
    Options.ts
    Runtime.ts
    Events.ts
    Tools.ts
    Sessions.ts
    Storage.ts
    Capability.ts
  tui/
    App.tsx
    Protocol.ts
    Review.tsx
assets/
  skills/
  patterns/
  guidance/
docs/
tests/
```

If a workspace is used for development, it must either be bundled into the
single artifact or each package must have real versioned dependencies and its
own release contract. Never publish a package that contains unresolved
`workspace:*` runtime dependencies.

The publishable manifest must expose the server entrypoint and, for full
parity, the companion surfaces through explicit exports such as:

```jsonc
{
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./tui": "./src/tui.tsx",
    "./collector": "./src/collector.ts",
    "./cli": "./src/cli.ts",
    "./kernel": "./src/kernel/index.ts",
    "./verify": "./src/verify/index.ts",
    "./compound": "./src/compound/index.ts",
    "./modules/*": "./src/modules/*.ts"
  },
  "files": ["src", "assets", "skills", "patterns", "guidance"]
}
```

Use the actual chosen asset paths and bundling strategy, but test every
published export from the packed artifact. The full OpenCode client belongs
only to the collector/CLI/TUI boundary; server core code must not import it to
work around restricted plugin context APIs.

### 4.3 File and symbol naming

- Source files use short PascalCase domain nouns: `Gate.ts`, `Feedback.ts`,
  `Projection.ts`, `Orchestrator.ts`, `Blueprint.ts`.
- Group related files in lowercase domain folders such as `kernel/services/`.
- A file has one primary domain concept. Related schemas and functions live in
  that concept's namespace; do not create files named after implementation
  verbs such as `SendFeedbackAfterWrite.ts`.
- Public barrels may be named `index.ts`; business logic may not hide in a
  barrel.
- Keep names stable and meaningful. Do not rename a file and change its
  semantics in the same unverified patch.

---

## 5. Domain Modeling Rules

Before implementing each bounded context, write a domain glossary containing:

- nouns and identifiers;
- commands and observed events;
- legal state transitions;
- invariants and idempotency keys;
- trust level of every input;
- persistence owner and recovery behavior;
- effect requirements and failure types;
- pure functions that can be property-tested;
- adapter responsibilities.

Use `Schema.Class`/`Schema.Struct` for serialized values and
`Schema.TaggedUnion` or equivalent tagged schemas for variants. Use plain
interfaces only for internal service ports whose values are never decoded from
untrusted data. Keep serializable configuration separate from executable
functions.

All persistent records carry a schema version. Decode before use. A decode
failure is a typed error or an explicit recovery state, never an empty default
that silently loses data.

### 5.1 Shared types

Define neutral values that do not import OpenCode-branded types:

```text
ProjectKey       = stable project/workspace identity
SessionID        = validated string at the host boundary
ToolCallID       = validated string at the host boundary
ModelReference   = { provider, model, variant? }
TimePoint        = validated epoch/instant value
TrustLabel       = trusted-system | user-data | tool-data | model-data | artifact
ArtifactRef      = bounded path/key plus content hash and size
```

Host-specific IDs are converted to these values only after validation. The
core never imports `Session.ID`, `Agent.ID`, or an OpenCode event type.

### 5.2 Effect service pattern

Use a consistent service shape:

```ts
export namespace Ledger {
  export interface Interface {
    readonly mark: (sessionID: string, skill: string) => Effect.Effect<void, LedgerError>
    readonly loaded: (sessionID: string) => Effect.Effect<ReadonlySet<string>, LedgerError>
  }

  export class Service extends Context.Service<Service, Interface>()(
    "opencode-effect-harness/enforcement/Ledger"
  ) {}

  export const layer: Layer.Layer<Service> = Layer.effect(
    Service,
    Effect.gen(function* () {
      const state = yield* Ref.make(new Map<string, ReadonlySet<string>>())
      return Service.of({
        mark: (sessionID, skill) =>
          Ref.update(state, (current) => {
            const next = new Set(current.get(sessionID) ?? [])
            next.add(skill)
            return new Map(current).set(sessionID, next)
          }),
        loaded: (sessionID) =>
          Ref.get(state).pipe(Effect.map((current) => current.get(sessionID) ?? new Set()))
      })
    })
  )
}
```

Adapt syntax to the exact pinned Effect release and compile it in a probe.
Every mutable service state is owned by a `Ref`, `SynchronizedRef`, `Mutex`,
or a persistence service. Never use mutable module-level state.

Dependent layers must acquire dependencies with `yield*` and be provided in one
composition graph. The composition root must not leak an unprovided `R` type.

### 5.3 Error policy

Define typed errors for invalid input, unavailable capability, path resolution,
command execution, timeout, parse failure, persistence conflict, privacy
redaction, review failure, and promotion rejection. Preserve the distinction
between:

- expected operational failure;
- unavailable optional capability;
- policy rejection;
- malformed/untrusted data;
- programmer defect.

Map errors only at boundaries. A blocked OpenCode tool call becomes the exact
host error required by the hook; a semantic-review parse failure becomes an
explicit `error`/`unavailable` review state, never a pass.

---

## 6. Enforcement Kernel

The kernel is host-neutral and deterministic. It must be usable in tests with
no OpenCode server.

### 6.1 Core values

Define these schemas and preserve their algebra:

- `Decision`: `BlockToolCall`, `InjectUserMessage`, `InjectSystemPrompt`, and
  `AppendCustomEntry` with explicit payloads and delivery metadata.
- `Intent`: a write or edit at `before` or `after` phase, with a normalized
  optional path and content/replacement values.
- `Edit`: old/new text plus typed resolution states for unique, missing,
  ambiguous, overlapping, and empty-old-text cases.
- `Pattern`: name, description, severity/level, file filters, detector kind,
  guidance, suggested skills, and source metadata.
- `Rule`: stable ID, phase, predicate/action, severity, source, and policy
  metadata.
- `Branch`: a neutral conversation snapshot with explicit compaction markers.
- `Message`: content plus `steer`, `followUp`, or `nextTurn` delivery.
- `Skill`: name, directory, file path, content hash, and catalog provenance.

The union tags must be exhaustive. Use `Match.exhaustive` or the equivalent
compiler-checked pattern match when interpreting them.

### 6.2 Catalog and matching

`Catalog` loads immutable pattern documents through an injected file system,
parses frontmatter and body, validates each record, and derives rules. It must:

- reject malformed required metadata with a typed error;
- handle regex-hostile YAML values safely without changing semantic content;
- ignore non-pattern documentation files by an explicit rule;
- retain source paths and content hashes;
- expose a manifest used by reports and CI.

`Matcher` must support the declared detector types, including ast-grep and
regex, file globs, ignore globs, tool filters, phases, and changed-span
scoping. It must deduplicate findings deterministically and provide evidence
locations. Native matcher loading is a release probe; regex-only operation is
only a documented degraded mode.

### 6.3 Projection

`Projection` has two explicit operations:

- `prospective`: apply an edit to the pre-write content in memory and return
  projected content plus changed spans;
- `actual`: read post-write content and locate the changed/new spans for
  after-write feedback.

Edit application is a pure operation. Resolve all replacements before changing
content, reject overlapping or ambiguous replacements according to policy, and
apply valid replacements in a deterministic offset order. A missing/ambiguous
old text must not produce a fabricated full-file success. If the host cannot
provide exact content, return an explicitly degraded projection state.

The skill gate uses prospective content. A deletion-only edit that leaves no
target-framework code must not be blocked. Unknown/non-write tools produce no
write intent and are not guessed into one.

### 6.4 Rule engine and controller

`Engine` evaluates matching rules in registration order and concatenates
decisions without hiding errors. `HookSet` runs lifecycle observers before
rules. `RuleSet` owns mode and agent policy. `Controller` routes only relevant
phases, preserves typed results, and skips write rules when there is no intent.

The enforcement rules are:

1. **Policy header**: inject target-framework guidance when mode is enabled.
2. **Skill gate**: if projected content introduces target-framework code and
   the distinct loaded-plus-pending relevant skill count is below the configured
   threshold, block strict agents.
3. **Pattern feedback**: after successful writes, report structural findings as
   advisory feedback; it never blocks the write.

Framework-code detection must be a named, tested policy rather than a broad
substring search. For the Effect instantiation, detect real Effect imports and
framework identifiers with conservative word/import boundaries, document known
false positives, and test comments/strings, deletion-only edits, new files,
and edits that move code without introducing it. The policy may be extended by
module, but a random occurrence of the framework name must not trigger a gate.

The enforcement and verification paths must consume the same immutable
framework catalog and manifest for a given module. They may expose different
views or policies, but must not carry two hand-maintained copies that can drift.

Subagents and plugin-owned workers are advisory or excluded according to
configuration. Do not use an environment variable or an inferred agent role as
the only recursion guard.

---

## 7. OpenCode v2 Adapter

### 7.1 Composition root

The server entrypoint must export the Effect plugin definition as the default
export. It must:

1. decode and validate `ctx.options` from `unknown`;
2. construct one scoped runtime layer graph;
3. install finite transforms and hooks;
4. start long-running event consumers with `Effect.forkScoped`;
5. catch and log setup failures according to an explicit invalid-options policy;
6. return `Effect<void, never, Scope>` at the plugin boundary.

Do not await an infinite stream from setup. Do not call `runPromise` in the
server entrypoint. Every fiber and resource must be owned by the plugin scope
and released on reload/unload.

### 7.2 Verified API facts and capability gates

The v2 plugin context is a restricted server client. Verify the exact version,
but design for these constraints:

- `ctx.tool.hook("execute.before")` can fail with the host's `Tool.Error` and
  therefore is the write-blocking seam.
- `ctx.tool.hook("execute.after")` observes success/error and cannot block the
  already completed operation.
- `ctx.session.hook("context")` can mutate system parts, messages, and the
  tool record before model dispatch.
- `ctx.event.subscribe()` is a global public event stream, not a project-local
  stream.
- `ctx.session` supports live session operations but does not necessarily
  expose historical `list`, `export`, `log`, or message enumeration.
- `agent.transform` and `command.transform` must not be assumed to create new
  definitions. Use configured existing worker IDs.
- `skill.transform` is version-sensitive. The implementation must probe the
  exact installed operation and use only that operation. If package-owned
  skills cannot be registered through a documented/supported path, fail the
  full-parity release gate or require an explicit supported skills source.
- Tool registration examples and declarations may differ in beta. Compile a
  probe against the installed `Tool.Info`/draft types and test one runtime
  registration before selecting the implementation.

### 7.3 Tool hooks

`execute.before` behavior:

- resolve session metadata and its absolute project location before applying
  any project-scoped write policy; the hook payload does not guarantee cwd;
- recognize only registered write/edit input shapes;
- construct a neutral `Intent` and use `Projection.prospective`;
- evaluate the gate with loaded and pending skill state;
- map `BlockToolCall` to `Effect.fail(new Tool.Error({ message }))` at the
  adapter boundary;
- remember successful candidate skill reads by tool-call ID while the read is
  in flight;
- fail closed or fail open on resolver failure only according to the validated
  `failClosedForGate` option.

`execute.after` behavior:

- credit a pending skill read only when the read completed successfully;
- record activation/read telemetry with project/session/call correlation;
- add successful writes to a per-session `ChangeLedger`;
- run bounded actual projection and feedback in a supervised, scoped fiber;
- send one batched advisory message through the supported synthetic-session
  operation after expected failures have been contained;
- never block the completed tool and never perform an unbounded LLM call inline.

Context-hook behavior:

- inject one deduplicated policy system part while mode is enabled;
- for registered internal reviewer/benchmark sessions, remove mutation-capable
  tools unless an explicit, validated option allows edits; enforce the same
  restriction again in `execute.before` because tool removal is not a security
  boundary;
- inject a registered blueprint system prompt for child execution sessions;
- never trust a child prompt or a synthetic control envelope as ordinary user
  evidence.

The critic is always read-only. A verifier `allowEdits` option, if retained,
must be a separate explicit execution mode with its own authorization and
tests; it must never grant editing ability to the critic or silently turn
verification into auto-fix.

### 7.4 Skill state and lifecycle

Use `session.skill.activated` as the primary loaded-skill signal when available.
Retain a successful-read fallback for parity. Pending reads count during the
race between `execute.before` and `execute.after`, but failed reads never earn
credit.

Persist observed skill events in a project/session journal. Reset the loaded set
only on a successful compaction event. On plugin reload, reset unreconciled
sessions conservatively; do not over-credit stale in-memory state. A companion
full-client collector may reconcile exported skill messages.

Mode-off semantics are precise: policy header, gate, and feedback are disabled;
telemetry remains active. Reference-clone maintenance is lazy and never runs in
the blocking gate.

### 7.5 Events, scope, and recursion

Every event consumer is a scoped supervised fiber with per-event error
containment. Filter global events by project/workspace/session location and
configured agent.

Register plugin-owned child sessions before their first prompt with an origin:
`verifier`, `critic`, `compound`, or `benchmark`. Automatic triggers exclude
all such origins and maintain idempotency by project, session, event ID, and
content hash. Do not infer that an arbitrary successful execution means a
feature is complete.

`file.edited` has no reliable session ID and is ephemeral. It may initiate a
location-keyed debounce, but it cannot be the authoritative attribution source.
Execution events identify the session but not changed files; consume the
coalesced `ChangeLedger` built by tool hooks.

---

## 8. Enforcement Services and Reference Knowledge

Implement these host-specific services behind Effect ports:

- `Guidance`: loads merged guidance documents and renders policy/gate text using
  the same configured threshold.
- `Ledger`: per-session loaded skill state and persistent journal.
- `Pending`: in-flight reads keyed by call ID with terminal cleanup.
- `SkillCatalog`: discovers skills, performs longest-prefix path matching, and
  exposes manifest/hash metadata.
- `ReferenceClone`: lazily obtains a version-compatible source reference,
  refreshes atomically, and records the pinned Effect version/source revision.
- `Telemetry`: bounded, privacy-safe JSONL or structured artifact records.
- `ChangeLedger`: successful write/edit paths and projected spans for later
  verification.
- `BlueprintExecutionRegistry`: child session ID -> rendered prompt, origin,
  project, and expiration.

The reference clone must match the pinned Effect contract. A moving `latest`
reference is explicit and labeled non-reproducible; it is never the default
verification source.

---

## 9. Verification Subsystem

### 9.1 Host-neutral module contract

Use an executable module contract separate from serializable module
configuration:

```ts
interface VerificationModule {
  readonly id: string
  readonly languages: ReadonlyArray<string>
  readonly appliesTo: (path: string) => boolean
  readonly checkers: (
    context: ProjectContext
  ) => Effect.Effect<ReadonlyArray<CheckerSpec>, ModuleError>
  readonly parseDiagnostics?: (
    checker: CheckerSpec,
    result: CommandResult
  ) => ReadonlyArray<Diagnostic>
  readonly skills: ModuleSkillCatalog
  readonly patterns: ModulePatternCatalog
}
```

`moduleConfigs` may define only validated data-only argv checkers, globs,
parsers, timeouts, output bounds, and environment policy. JSON cannot carry
functions and cannot install arbitrary packages. Rich executable modules must
be bundled or separately installed with explicit dependencies.

### 9.2 Command execution

`CommandSpec` contains at least:

```text
executable: string
args: ReadonlyArray<string>
cwd: absolute validated path
timeout: Duration
environment: allowlisted key/value data
maxStdoutBytes: number
maxStderrBytes: number
shell: false by default
```

`CommandExecutor` is a platform service. It must support cancellation,
timeouts, bounded output, exit-code/termination distinction, and redacted
diagnostic capture. Shell mode, if supported at all, is a separately enabled
policy with no string interpolation.

### 9.3 Report model

Every run preserves independent components:

```text
CheckerResult       = checker + verdict + exitCode? + bounded output + diagnostics + duration
PatternFinding      = pattern + severity + location/evidence + guidance + suggestedSkills
SkillEvidence       = status + distinctLoadedSkills + requiredCount + reason
SemanticReview      = passed | failed | error | skipped + findings + worker/session metadata
VerifierReport      = request + checks + patterns + skillEvidence + semantic + overall
```

`overall` is derived by a pure, documented policy. It must not relabel a
skipped review as passed, hide an error, or imply semantic review when only
deterministic checks ran. A missing ChangeSet for a required semantic review is
`error`/`unavailable`, not a pass.

### 9.4 Orchestrator flow

The orchestrator must perform these stages in order, using Effect collection
combinators rather than imperative loops:

1. Validate a `VerifyRequest` with project, session, trigger, touched paths,
   loaded skills, and policy.
2. Resolve applicable modules from touched paths and coalesced changes.
3. Obtain checker specs and execute them through `CommandExecutor`.
4. Parse bounded outputs with module-specific parsers and retain raw status.
5. Run deterministic pattern and required-skill-evidence checks for the module
   catalog, not a global framework singleton.
6. Build a bounded/redacted `ChangeSet` for semantic review.
7. Run the configured reviewer for both deterministic pass and failure when the
   policy enables semantic review.
8. Persist the full report atomically before clearing the change ledger.
9. Deliver a bounded machine-readable summary to the triggering session.

The default automatic policy may disable semantic review for cost, but the
report must explicitly say `semantic: skipped`. Deterministic checks never call
an LLM.

The bundled TypeScript module must provide typecheck and test-runner checks,
safe project discovery, diagnostic parsing, and the complete target-framework
skill/pattern catalogs. A third-language example module must prove that the
core has no TypeScript assumption and can carry a different catalog.

---

## 10. Independent Critic

The critic is not the verifier's semantic reviewer. Keep the contracts and
reports distinct:

- verifier review asks whether a bounded ChangeSet complies with framework
  skills/patterns;
- critic asks whether the builder's reasoning and claims are sound.

### 10.1 Request

`CriticRequest` contains:

- builder session and model references;
- short builder summary, explicitly marked untrusted;
- optional plan/spec reference;
- optional bounded ChangeSet;
- trace references;
- typed checkpoint kind: `feature`, `plan`, `architecture`, `drift`, or `full`;
- whether the checkpoint is explicit.

Automatic critic invocation is allowed only after an explicit checkpoint or a
clearly named configured cadence. Never infer feature completion from a generic
execution event.

### 10.2 Review contract

The read-only worker independently opens the repository, plan, reference clone,
and every cited reference required by policy. It reports:

- logical flaws;
- hallucinated or unsupported claims;
- wrong domain decisions;
- reference/API mismatches;
- architecture drift;
- missing security, edge-case, performance, or test considerations.

`CriticReport` contains a verdict, bounded findings with severity/kind/claim/
evidence/suggestion, checked references, builder/critic models, and worker
session metadata. A critic may not edit files, run builds, approve its own
changes, or omit a required reference check. Unparseable output is a typed
review error.

`requireIndependentModel` must reject equal model references when enabled. A
different prompt alone is not independence.

### 10.3 Critic evidence protocol

Each critic run begins by taking a stable review snapshot. The snapshot records
the repository commit/tree or content hash, project key, plan revision, all
normative spec revisions, relevant artifact hashes, builder model, critic
model, and invocation reason. The critic report is valid only against that
snapshot. If the repository changes while the review is running, the report
must say so and may not pretend to review the newer tree.

Every finding is evidence-led and has at least:

```text
findingID, runID, severity, category, claim, observation, evidence,
location/reference, referenceHash, confidence, impact, recommendation,
requirementIDs, status
```

Keep `claim`, `observation`, `evidence`, and `recommendation` separate. A
critic must distinguish a verified fact from an inference, state uncertainty,
and avoid raising a finding from an unchecked reference. Findings without
reproducible evidence are `needs-evidence`, not asserted as facts.

### 10.4 Append-only critic journal

Critic agents write through a `CriticJournal` service. They do not edit files or
write directly to the journal. The journal is an append-only event stream and
the authoritative audit history for critic activity. A minimum event algebra is:

```text
ReviewStarted
ReviewCompleted
FindingRaised
FindingDuplicated
BuilderResponded
FindingAcknowledged
FindingDisputed
FindingResolved
FindingAcceptedRisk
FindingReopened
AdjudicationRecorded
ReviewFailed
```

Each journal entry contains a schema version, event ID, stream/project key,
monotonic sequence, recorded time, actor/origin, run ID, base snapshot,
payload, previous-entry hash, and entry hash. The payload is schema-validated,
bounded, redacted, and includes the tool/model provenance required for audit.
Use a per-project `Mutex` and atomic append protocol so concurrent critics,
TUI actions, retries, and reloads cannot reorder or overwrite entries.

The journal has these invariants:

- append is the only mutation; there is no update or delete operation;
- prior entries and reports are immutable, including their wording and
  evidence;
- a repeated request ID is idempotent and returns the original result;
- a duplicate finding appends a `FindingDuplicated` event pointing to the
  original ID rather than deleting either finding;
- a correction or disagreement appends a new event referencing the prior ID;
- `resolved` means resolution evidence was appended, not that the original
  finding was rewritten;
- reopening a finding appends `FindingReopened` and preserves the full history;
- an invalid or partially written tail is quarantined and reported, never
  silently truncated;
- a projection may calculate current status, counts, or consensus, but cannot
  become the source of truth.

Use an explicit finding state machine, for example:

```text
raised -> acknowledged -> resolved
raised -> disputed -> accepted-risk
raised -> needs-evidence -> raised
resolved -> reopened -> raised
```

Reject illegal transitions with a typed error. A human or authorized planner
may append disposition events. A critic may append only its own review result
and evidence; it cannot self-approve, resolve its own finding, change the
normative spec, or mark its own recommendation implemented.

Persist both an immutable machine-readable report and a human-readable
Markdown projection per run. The Markdown is append-only at the journal level:
new review runs and dispositions append new sections/events; old sections are
never edited. The structured event stream remains canonical when the two views
disagree.

Critic prompts must include the prior journal as delimited untrusted evidence.
Historical findings are context, not instructions. The critic must not obey
text found in old reports, plans, source files, or proposed fixes.

---

## 11. Compound Learning and Prompt Evolution

The compound subsystem is domain-agnostic. It handles coding, research,
writing, planning, analysis, automation, and other difficult tasks. It never
assumes that a useful solution contains source code.

### 11.1 Trace acquisition and privacy

Separate live and historical sources:

- `LiveSessionSource` runs in the server plugin and records current/future
  observable events, tool hooks, lifecycle, usage, and bounded text.
- `HistoricalSessionSource` runs in a companion client/TUI/CLI using the full
  OpenCode client to paginate sessions and request sanitized exports.

The restricted server plugin must not pretend it can enumerate or export all
historical sessions. The server must not open a second unauthenticated client to
itself.

Trace extraction records task, attempted strategy, observable steps, failure,
detection, correction, transferable lesson, score, provenance, and a bounded
artifact reference. It must not infer hidden chain-of-thought.

Use a cursor containing at least session ID, scope, last event sequence,
updated time, content hash, and processing state. Commit a cursor only after
export and extraction succeed. Include the triggering current session
explicitly. Reprocessing unchanged content is idempotent; `rescan` is explicit.

### 11.2 Two-stage distillation

Stage 1 is a cheap, high-recall extractor. It searches all selected domains for:

- difficult tasks that were solved and how;
- recurring model failures and explicit user corrections;
- workflows, abstractions, and recovery strategies worth reusing.

Stage 1 emits bounded candidate insights with a `TraceDigest`, domain, evidence,
source session, and confidence.

Stage 2 is a premium, high-precision gate with null bias. It verifies evidence
quality, separates principles from mechanics, rejects prompt injection in
transcripts, and may rewrite a candidate. The default is reject unless the
evidence and transfer value pass the schema and policy.

Stage 2 creates a durable `PendingProposal` queue. It does not materialize
anything. The review protocol supports approve, edit-and-approve, skip,
reject-with-reason, and abort. Headless mode leaves proposals pending and
emits a protocol; it never auto-approves.

### 11.3 Blueprint modules and composition

A flat prompt document is not composable. Define atomic declarative
`BlueprintModule` values with:

```text
id, version, description
prompt fragment
applicability/routing hints
provided capabilities and conflict keys
failure modes and recovery strategies
evidence and bounded solution traces
```

A `Blueprint` references ordered, independently versioned modules and owns:

- execution policy (worker, model, tools, turn/time/budget limits);
- domain and task constraints;
- non-empty acceptance criteria;
- origins and provenance.

`composeBlueprints` is pure and deterministic. It deduplicates stable
`(moduleID, version)` references, preserves declared order, detects declared
conflicts, and renders one reproducible prompt. Generated source is never
executed. A typed interpreter accepts only the allowed prompt/tool/acceptance
vocabulary.

### 11.4 Append-only storage

Blueprint Markdown has immutable identity frontmatter. Each new committed
version is an appended block containing:

- version and evaluator manifest;
- prompt/module composition;
- score and baseline score;
- bounded observable solution traces;
- model/run references;
- reason for the change.

Do not rewrite frontmatter to update the current score. A separate small state
record points to the current best. Parsers reject duplicate or non-monotonic
versions. Approval records, rejected hashes, failed attempts, and lessons are
retained.

### 11.5 Benchmark mode

Benchmark mode is an instrument, not evolution. A trial is exactly one
`(blueprint, model, task)` execution in one isolated environment. Therefore a
selected task set and model set produce one run per model/task pair, with
`trial: 1`; never interpret this as statistically stable evidence.

Every trial must:

1. create a fresh isolated workspace using a worktree or scoped copy;
2. create/register the child session or direct-AI execution context;
3. inject the composed system prompt through the supported execution seam;
4. execute the task with bounded tools and budgets;
5. run deterministic `CommandCheck` or a versioned, trusted `AgentJudgeCheck`;
6. record usage, duration, trace availability, acceptance details, and
   environment provenance;
7. destroy or retain the workspace according to policy without sharing mutable
   state with another trial.

For a child OpenCode session, register its prompt and internal origin after
`session.create` but before `session.prompt`; the context hook supplies the
dynamic system part. Waiting does not export the transcript, so the live trace
recorder must observe events and tool hooks before execution begins.

Provide two interchangeable executor ports where supported: an OpenCode
session executor for live-server runs and a direct-AI executor for isolated
client/CI runs. Both return the same validated `ExecutionOutcome` and feed the
same acceptance/scoring pipeline. The direct-AI implementation may use the
Effect AI APIs and provider packages, but those imports remain in an adapter;
the compound domain must not depend on one provider SDK.

### 11.6 Mine-and-evolve mode

Evolution is explicit and never triggered by a generic session event. Model it
as `Vary(P, K, f)`:

- `P`: complete committed lineage plus failed/rejected attempts and lessons;
- `K`: approved insights, relevant skills/patterns, and compatible references;
- `f`: frozen evaluator manifest with visible train tasks and hidden holdout
  tasks.

Before the first variation, persist a baseline tied to the exact evaluator
manifest, task split, model policy, and environment policy. Missing, stale, or
incomparable baselines block promotion.

Each variation step may diagnose missing knowledge, reasoning, exploration, or
abstraction; propose a minimal declarative prompt/module change; execute the
candidate against train; and record the result. The variation agent must not
see hidden holdout examples or labels.

Promotion requires all of the following:

- deterministic verification passes;
- train score is strictly greater than the best committed baseline;
- hidden holdout score is strictly greater than the best committed baseline;
- evaluator and environment manifests match;
- artifact and trace persistence succeeds;
- required approval policy passes.

Otherwise create a permanent `VariationAttempt` with outcome, score,
verification state, and lesson learned. Never promote a regression. After the
configured stagnation limit, redirect exploration with a fresh, logged
direction. Apply per-run budgets, maximum steps, cancellation, and rate limits.

The cited AVO work is a design analogy for agentic variation, lineage,
execution feedback, correctness-gated promotion, and stagnation redirection. It
does not prove results for this product's domains; all performance claims must
come from this system's own versioned evidence.

---

## 12. Persistence, Concurrency, and Operations

- Keep small metadata/indexes in namespaced OpenCode storage. Keep large
  reports, traces, and Markdown artifacts in a configured project artifact
  store.
- The server is the sole owner of mutable ledgers, indexes, approval state,
  cursors, and promotion state.
- Treat plan events and critic/audit events as append-only application data.
  Git history alone is not an append-only protocol. Expose `append`, `read`,
  and projection operations, but never expose an update/delete operation for
  audit records.
- Serialize per-project mutations with a scoped `Mutex`; deduplicate retries
  by request/event ID; make report and artifact writes atomic.
- Never rely on storage `get/set` as compare-and-swap.
- Use cancellation and timeouts for every external operation. Retry only
  idempotent operations and record retry metadata.
- Add correlation IDs containing project/session/request/origin where safe.
  Logs must be structured, bounded, redacted, and useful for diagnosing partial
  activation.
- On corruption, preserve the original artifact, emit a typed recovery state,
  and require explicit repair. Never silently truncate history.
- Validate journal sequence and hash continuity on startup and before a
  promotion/release decision. A broken audit chain is an operational error,
  not an empty history.
- On plugin reload, scoped fibers stop, registrations are released, and
  resources close. No daemon survives the plugin scope.

---

## 13. Configuration Contract

Decode a schema-validated configuration with explicit defaults. The external
JSON form may use `null`; internal code uses `Option`. Conditional validation
must reject impossible configurations before registration.

The configuration must cover at least:

```jsonc
{
  "harness": {
    "enabled": true,
    "minEffectSkills": 4,
    "strictAgents": ["build"],
    "failClosedForGate": true,
    "referenceClone": true,
    "referenceMode": "compatible",
    "telemetryPath": null
  },
  "verify": {
    "trigger": "manual",
    "triggerAgents": ["build"],
    "debounceMs": 30000,
    "semanticReview": true,
    "allowEdits": false,
    "workerAgent": "explore",
    "moduleIds": ["typescript"],
    "moduleConfigs": []
  },
  "critic": {
    "workerAgent": "explore",
    "model": null,
    "autoAfterExplicitCheckpoint": false,
    "autoEveryNBuildExecutions": 0,
    "requireIndependentModel": false,
    "maxFindings": 20,
    "checkReferences": true
  },
  "compound": {
    "enabled": false,
    "mode": "mine-evolve",
    "sessionScope": "project",
    "allowHistoricalSessions": false,
    "benchmark": {
      "models": [],
      "taskIds": [],
      "blueprintIds": [],
      "executor": "opencode",
      "trials": 1,
      "promotion": "manual"
    },
    "evolution": {
      "enabled": false,
      "blueprintIds": [],
      "trainTaskIds": [],
      "holdoutTaskIds": [],
      "maxVariationSteps": 10,
      "stagnationLimit": 3
    }
  },
  "data": {
    "retentionDays": 30,
    "maxTraceBytes": 400000
  }
}
```

Validation rules include:

- benchmark enabled -> at least one model, task, and blueprint;
- evolution enabled -> at least one blueprint and non-empty train/holdout sets;
- trials must remain exactly one for the single-run benchmark mode;
- holdout IDs must not overlap train IDs;
- worker agents must be configured existing IDs;
- historical mining requires explicit opt-in;
- direct-AI credentials use redacted configuration and never appear in logs;
- unknown fields and impossible combinations follow a documented policy.

---

## 14. Tools and User Surfaces

Register agent-callable tools through the exact supported tool transform. Use
validated input and output schemas. Every tool has a deterministic response
shape containing machine-readable output and bounded model-visible content.

Required behavior:

| Tool | Required behavior |
|---|---|
| `effect_harness_verify` | manual verification request; returns independent check, pattern, evidence, semantic, and overall states |
| `effect_harness_critic` | explicit checkpoint plus untrusted summary; runs a read-only independent audit and persists the report |
| `effect_harness_compound` | explicit benchmark or mine/evolve request with policy validation |
| `effect_harness_skill_stats` | current loaded-skill/telemetry status, never secret content |
| `harness_toggle` | persist and report mode state; telemetry remains active when disabled |

The TUI/companion client is required for full parity. The server remains fully
usable headlessly, but omitting the companion surface is a declared reduced
scope and cannot be reported as complete parity. It provides status, mode
control, skill statistics, compound proposal review, and blueprint history. It
is a presentation boundary:

- Promise/JSX APIs are isolated there;
- the server remains authoritative for mutable state;
- control messages are versioned, schema-validated, bounded, and idempotent;
- the UI never writes server artifacts behind the server's back;
- if the control transport cannot be proven against the pinned client/server
  pair, display the pending protocol and use the server tool rather than
  silently mutating local state.

Named server agents and slash commands are configuration/TUI concerns when the
v2 transform API cannot add them. Never claim they are automatically created.

---

## 15. Testing and Verification Strategy

### 15.1 Unit and property tests

Cover every pure domain operation:

- decision interpretation and exhaustive unions;
- path normalization and catalog matching;
- frontmatter parsing and asset manifests;
- projection replacement resolution, immutability, offsets, and overlap;
- gate truth tables, pending-read races, mode/agent policy;
- matcher deduplication, changed-span scope, and detector failures;
- evidence truth tables and report aggregation;
- command argv construction, output truncation, timeout mapping;
- blueprint composition, stable ordering, deduplication, and conflicts;
- append-only Markdown parse/serialize round trips;
- cursor commit/retry/idempotency rules;
- isolated benchmark run-key uniqueness;
- baseline comparison and strict train/holdout promotion properties;
- rejected variation journaling and stagnation redirection;
- schema decoding of valid, malformed, oversized, and injection fixtures.
- plan-event status transitions, dependency-cycle rejection, and projection
  rebuilds;
- critic-journal append ordering, idempotent retries, hash-chain validation,
  duplicate findings, resolution/reopen transitions, and crash-tail recovery;
- immutable snapshot references proving a finding remains anchored to the
  reviewed source/spec/plan revision.

### 15.2 Adapter contract tests

Use fake/recorded v2 context operations to test:

- tool input -> location resolution -> neutral intent;
- `Tool.Error` blocking and after-hook non-blocking behavior;
- policy context injection and internal worker tool removal;
- event project filtering and recursion exclusion;
- skill activation/read credit and successful compaction reset;
- conservative reload behavior;
- synthetic message delivery and idempotency;
- storage serialization and atomic artifact writes;
- capability-probe outcomes and unsupported-feature policy;
- no historical calls through restricted `ctx.session`.

### 15.3 Integration and release tests

The CI/release matrix must include:

1. exact lockfile install;
2. required Effect-aware `tsgo` typecheck (`bunx tsgo --noEmit`); plain
   `tsc --noEmit` is an additional diagnostic, never a substitute;
3. lint/format and authored-`any`/unsafe-cast checks;
4. full unit/property suite;
5. complete asset manifest/hash/parity check;
6. migrated pattern self-check against the project's own source;
7. package boundary import check (core cannot import host SDK/Node);
8. packed-artifact install in a scratch project;
9. native ast-grep load probe and documented regex fallback;
10. plugin load and tool registration against the exact OpenCode package;
11. live OpenCode v2 smoke test: plugin ID, hooks, tool, context injection,
    child-session recursion guard, and one verifier run;
12. TUI load/control smoke test when `tui: true` is shipped;
13. two-model fixture benchmark with one isolated run per model/task;
14. compound proposal approval/edit/reject fixtures;
15. prompt-injection, secret-redaction, path-traversal, and output-limit tests;
16. documentation validation, append-only journal checks, and traceability
    coverage.

Tests requiring a running OpenCode server must be marked separately from tests
that prove core behavior. A missing server is a blocked e2e gate, not evidence
of success.

---

## 16. Documentation and Traceability

Write professional docs as part of implementation, not after it. Include:

- architecture and dependency diagrams;
- domain type tables and state-transition diagrams;
- OpenCode API evidence and capability-probe output;
- configuration reference with defaults and conditional rules;
- tool protocol and TUI/control-envelope reference;
- module authoring guide for another language;
- benchmark scoring and statistical limitations (`n=1` clearly labeled);
- privacy/threat model and retention policy;
- append-only Blueprint Markdown format and migration rules;
- operations/runbook for reload, corruption, unsupported capabilities, and
  failed promotion;
- ADRs for package topology, skill registration, session sources, benchmark
  isolation, error policy, and holdout evaluation;
- changelog and a feature parity matrix.

Maintain a traceability matrix where every requirement points to at least one
domain type, implementation module, test, and documentation section. Every
unsupported or deferred feature must have a reason, probe/evidence, and owner.

### 16.1 Technical-spec quality bar

Each normative specification must answer the following questions explicitly:

- What problem and user contract does this capability solve?
- What is in scope, out of scope, and intentionally deferred?
- Which bounded context owns each state and mutation?
- What are the input/output schemas and typed failure channels?
- What are the legal state transitions and invariants?
- Which operations are pure, and which require a service/environment?
- What is the Effect layer dependency graph and lifecycle ownership?
- What happens on timeout, cancellation, partial failure, retry, reload, and
  corrupted persistence?
- What data is trusted, untrusted, redacted, bounded, or retained?
- Which API facts are proven by a versioned probe and which remain conditional?
- How is concurrency serialized and how are idempotency keys formed?
- Which tests and artifacts prove each acceptance criterion?

Use sequence diagrams for hook/tool flows, state diagrams for ledgers,
proposals, findings, and evolution, dependency diagrams for layers/packages,
and data-flow diagrams for trust boundaries. Diagrams must name the owner of
each mutation and the failure path, not only the happy path.

### 16.2 ADR quality bar

Every non-trivial decision gets one ADR with:

```text
ID, title, status, date, decision owner, context, forces,
decision, alternatives rejected, consequences, invariants,
evidence/probe, affected requirements, migration/rollback
```

An accepted ADR is immutable. Reversing it requires a new ADR that explicitly
supersedes it; never edit the old decision into a different decision. Conflicts
between an ADR and observed API behavior produce a new audit entry and block
the affected release gate until adjudicated.

### 16.3 Documentation checks

Add automated checks for:

- required document IDs, metadata, headings, and links;
- unique and monotonic spec/plan/critic revisions;
- requirement IDs referenced by code/tests/docs;
- task dependency cycles and missing acceptance evidence;
- ADR supersession and unresolved conflicts;
- critic journal sequence/hash continuity and legal finding transitions;
- append-only fixtures proving old reports and plan events are never rewritten;
- schema-valid examples in technical specs;
- asset counts, hashes, and source revision;
- no claims of live-server success when the live gate did not run.

Documentation examples that describe an Effect or OpenCode API should either
be compiled as doctests/probes or be labeled as pseudocode. Never present an
uncompiled API sketch as verified behavior.

---

## 17. Ordered Implementation Plan

Execute these phases without skipping acceptance gates:

### Phase 0: Preflight and baseline

- initialize the package and exact dependency lock;
- run OpenCode/Effect/API capability probes;
- capture the asset source revision and manifest;
- establish the initial test and check commands;
- write the requirement ledger, discovery docs, initial plan revision, and
  ADRs before production implementation;
- initialize append-only plan and critic journal schemas plus their validators.

### Phase 1: Shared and kernel

- implement schemas, errors, pure atoms, projection, catalog, matcher, rules,
  hooks, and controller;
- port behavior with semantic tests before adding host code;
- enforce core import boundaries.

### Phase 2: Server adapter

- decode options and build the layer graph;
- implement skill catalog, guidance, ledger, pending reads, reference clone,
  telemetry, location resolver, and change ledger;
- wire before/after/context hooks, events, tools, scope, and recursion guards;
- prove mode-off and reload semantics.

### Phase 3: Verification and critic

- implement module/command/report/evidence domains;
- add the TypeScript module and an independent third-language fixture;
- implement deterministic orchestration and bounded ChangeSet creation;
- implement semantic reviewer and separate critic contracts;
- persist and deliver reports;
- implement the immutable critic snapshot, append-only journal, finding state
  machine, dispositions, and audit projections before enabling automatic runs.

### Phase 4: Compound

- implement live/historical source ports and sanitized trace conversion;
- implement two-stage distillation and pending approval queue;
- implement declarative blueprint composition and append-only storage;
- implement isolated benchmark executors and scoring;
- implement baseline-bound train/holdout evolution and failed-attempt journal.

### Phase 5: Companion surfaces and packaging

- implement TUI/client boundaries and control protocol;
- export only documented public subpaths;
- test packed artifact in an isolated OpenCode cache;
- run all release gates and adversarial review.

After each phase, run typecheck, tests, asset checks, and boundary checks. Keep
the changes small enough that a failure has one obvious cause.

The implementation agent must append a phase checkpoint to the plan event log
before moving to the next phase. If a critic raises a release-blocking finding,
pause the affected phase, append the builder response, and either fix it or
record an authorized risk acceptance; do not simply mark the task complete.

---

## 18. Explicit Anti-Patterns

Do not:

- assume website examples match the installed beta declaration;
- call unavailable `ctx.session.list/export/log` methods;
- create agents or commands through unsupported transforms;
- register a skill operation without a capability probe;
- share a benchmark checkout between tasks or models;
- run one session for an entire benchmark suite and call it one trial;
- expose hidden holdout tasks to the variation agent;
- update append-only Markdown frontmatter to move a current pointer;
- materialize a proposal before explicit approval;
- let a critic approve or edit its own findings;
- collapse skipped/error semantic review into deterministic pass;
- infer feature completion from every successful execution event;
- let plugin-owned child sessions recursively trigger automation;
- pass unsanitized transcripts or model output as instructions;
- reconstruct hidden chain-of-thought;
- execute generated source or arbitrary JSON predicates;
- interpolate shell strings or inherit the full process environment;
- put Node/OpenCode imports in core;
- put mutable state in module globals;
- use direct wall clock/randomness in pure logic;
- start unsupervised daemon fibers;
- swallow typed errors with `Effect.ignore` where the report needs the outcome;
- use `as never` to force incompatible host/core types together;
- let a critic overwrite a prior report, finding, plan event, or ADR;
- use a mutable checkbox/status table as the only plan history;
- close a finding by editing its original text instead of appending resolution
  evidence;
- let a generated current-view document replace the canonical event stream;
- cite a file/line without pinning the reviewed snapshot or content hash;
- mix trusted system instructions with untrusted critic reports, transcripts, or
  proposed fixes;
- call a critic independent when it shares the builder's model/context without
  recording that limitation;
- delete tests or reduce test coverage to make a migration appear complete;
- report "done" when only typecheck/unit tests pass and live gates are blocked.

---

## 19. Definition Of Done

The implementation is complete only when all applicable statements are true:

- the exact package installs and the plugin loads in OpenCode v2;
- the server Effect boundary has a fully provided, scoped runtime;
- core packages are host-neutral and pass dependency-boundary checks;
- the enforcement gate uses prospective projection, pending reads, explicit
  threshold, agent policy, and correct blocking error behavior;
- feedback is advisory, bounded, supervised, and non-blocking;
- mode, telemetry, compaction, reload, and recursion semantics are tested;
- verification reports deterministic checks, pattern findings, skill evidence,
  and semantic review independently;
- the critic is read-only, independently challenges claims, and records checked
  references;
- historical mining is opt-in, sanitized, cursor-safe, and approval-gated;
- blueprints are declarative, composable, versioned, and append-only;
- technical specs, ADRs, plans, and critic reports have stable revisions and
  traceable evidence;
- plan and critic histories are append-only, schema-validated, serialized, and
  recoverable without rewriting prior events;
- critic findings have evidence, immutable snapshot references, legal
  dispositions, and independently auditable resolution history;
- benchmark trials are isolated and labeled `n=1`;
- evolution has a stored evaluator-bound baseline, hidden holdout, strict
  promotion rule, budgets, stagnation redirect, and failed-attempt lessons;
- the packed artifact, asset manifest, probes, adapter tests, and live smoke
  tests pass, or every blocked gate is explicitly reported with evidence;
- the last major-change checkpoint includes a passing catalog gate, real
  `bun test` results, and `bunx tsgo --noEmit` results;
- documentation, ADRs, threat model, runbook, traceability matrix, and
  changelog match the shipped behavior.

The final engineering report must list exact commands run, test counts, package
artifact tested, capability-probe results, live-server status, known gaps, and
which acceptance gates remain blocked. Never use "all done" as a substitute for
that evidence.
