# Adversarial Audit and Corrections

This document records the skeptical review of the original migration plan. The
corrections here are normative. Where an earlier document conflicts with this
one, this document wins.

## Findings

### A1. Agent and command transforms were overstated

The v2 plugin API documents `agent.transform` as `list/get/default/update/remove`
and `command.transform` as `list/get/update/remove`. There is no documented
`add` operation for either. Therefore an npm plugin cannot assume it can create
named `verifier`, `compound`, `/verify`, or `/compound` definitions merely by
loading.

**Correction:**

- The plugin always registers agent-callable tools. These are the canonical
  installable surface.
- Programmatic child sessions use a configured existing agent ID, defaulting to
  the built-in `explore`, with an explicit read-only tool restriction installed by the
  plugin's context hook for internal reviewer sessions.
- Named `verifier` and `compound` agents and server-side slash commands are
  supplied as an optional configuration fragment/documentation, not falsely
  claimed as automatically created by the server plugin.
- The TUI entrypoint can register its own keymap and slash commands using the
  documented TUI API. Those commands call the server tool/protocol.

### A2. Native skill registration is version-sensitive

The current v2 website lists `skill.transform` operations as `source/list`,
while the inspected beta package declaration exposed `add/update/remove`.
Those contracts are inconsistent and the plugin API is explicitly beta.

**Correction:** native skill registration is a release-blocking capability
probe. The implementation must compile and test against one exact
`@opencode-ai/plugin` version and verify the supported registration operation.
It must not silently depend on an undocumented method. If that exact target
cannot register package-owned skills, the release must either require a
documented `skills` source configuration or ship a supported HTTP catalog; a
custom fallback tool is not called feature parity.

### A3. The plugin effect must own its runtime and scoped fibers

`Plugin.define({ effect })` requires the returned program to be successful at
the plugin boundary. Long-running event streams must not be awaited directly
from setup. `ctx.event.subscribe()` must be run in `Effect.forkScoped`, and
errors must be contained at the stream boundary. Core services must be provided
inside the plugin effect; they cannot leak an unprovided environment.

**Correction:** the composition root is a scoped `Effect` that constructs and
provides all layers, installs finite registrations, and forks supervised event
consumers. TUI code is a Promise-based host boundary only; it delegates to the
same Effect services.

### A4. Event scope and recursive automation were missing

`ctx.event.subscribe()` observes server events, not only the current project.
`file.edited` is ephemeral and contains a file/location, not a session ID.
Execution events contain `data.sessionID`, but the plugin must fetch session
metadata to resolve agent and location. A verifier child also emits execution
events, so naïve auto-triggering loops forever.

**Correction:** every event is filtered by project/workspace/location, internal
session IDs, and configured agent IDs. Child sessions are registered before
their first prompt with an internal origin (`verifier`, `compound`, or
`benchmark`). Auto-verification is keyed by `(project, session, execution
event ID)` and has an in-flight/idempotency guard. `file.edited` is only a
debounce signal keyed by location; it is never treated as the source of a
session ID.

### A5. The verifier did not actually verify every change

The earlier flow spawned semantic review only when deterministic checks failed.
That means a passing change received no reviewer/skills review. The four-skill
write gate is also not equivalent to checking that relevant skills and patterns
were applied.

**Correction:** a verification run has three independent parts:

1. deterministic language checks;
2. deterministic Effect pattern and required-skill-evidence checks;
3. optional semantic reviewer, invoked according to policy for both passing and
   failing deterministic results.

The report preserves each verdict separately. The default automatic policy may
run only deterministic checks for cost reasons, but this is explicitly not
called semantic review; `semanticReview: true` runs it on every eligible run.

### A6. Hook failure and error-channel handling must be exact

`execute.before` expects the failure type `Tool.Error`. A custom error cannot
be returned as that hook's failure channel without mapping. The Effect v4
implementation must use `Effect.fail(new Tool.Error({ message }))`, not a
JavaScript throw. The after hook should not perform a long filesystem scan and
LLM call inline.

**Correction:** the adapter maps the host-neutral `BlockToolCall` decision to
`Tool.Error`; after-hook feedback is forked, supervised, and non-blocking.

### A7. Session location/cwd was assumed to exist in tool-hook payloads

The v2 `execute.before/after` payload includes tool, session, agent, message,
call ID, and input, but no cwd. Write projection and project filtering therefore
require a `SessionLocationResolver` using `ctx.session.get(sessionID)` (or the
cached session metadata).

**Correction:** no write rule runs until the resolver supplies a normalized
absolute project directory. Resolver failure follows an explicit
`failClosedForGate` option; it is never hidden behind an undefined cwd.

### A8. Blueprint execution could not set a dynamic system prompt as written

`session.create` accepts agent/model/location but no arbitrary system prompt.
The earlier `OpenCodeSessionExecutor` claim that it creates a session with the
blueprint's system prompt was therefore inaccurate.

**Correction:** before prompting a benchmark child, register its session ID and
blueprint prompt in a scoped `BlueprintExecutionRegistry`. The context hook
adds `SystemPart.make(renderedBlueprint)` only for that registered session.
The registry entry is installed immediately after `session.create` and before
`session.prompt`. Direct AI execution can use a native system prompt directly.

### A9. Benchmarks need isolated workspaces

Running multiple model sessions against the current checkout is unsafe: models
can edit each other's files and verifiers can observe contaminated state.

**Correction:** `BenchmarkEnvironment` is mandatory. It creates an isolated
directory per `(task, model, trial)` using a git worktree when possible or a
scoped copy otherwise. The OpenCode session location and all checkers point to
that directory. Parallelism is allowed only across isolated environments.

### A10. Compound omitted human review and append-only semantics

The earlier pipeline materialized Stage 2 approvals immediately. pi-compound's
core behavior is Stage 1 extraction, Stage 2 gate, then user-by-user approve,
edit-and-approve, skip, or reject-with-reason. Without this, rejected ideas are
not learned and user-owned documents are not protected.

**Correction:** Stage 2 creates a durable `PendingProposal` queue. Nothing is
materialized until an explicit approval. TUI review is the preferred interface;
headless mode emits a review protocol and leaves proposals pending. Approved
content is append-only, content-hash deduplicated, and every rejection/skip is
recorded.

### A11. Blueprints were not genuinely composable

A single `systemPrompt` plus arrays of strings is a document, not a composable
Effect-AI module. It cannot be independently versioned, selected, ordered, or
benchmarked.

**Correction:** introduce atomic `BlueprintModule` values and a pure
`composeBlueprints` operation. A Blueprint references ordered modules and owns
task-specific acceptance criteria. A module has a stable ID/version, prompt
fragment, applicability predicate, failure modes, recovery strategy, and
evidence. Composition deduplicates IDs, detects conflicting instructions, and
renders a deterministic prompt. `BlueprintPatch` remains a pure fold over
validated values.

### A12. Shell command strings were an unsafe module contract

`CheckerSpec.command: string` invites shell interpolation and makes timeout,
environment, and argument boundaries ambiguous.

**Correction:** use an argv-based `CommandSpec` with executable, args, cwd,
timeout, environment allowlist, and output limits. Shell scripts remain
possible only through an explicit `shell` checker kind and opt-in policy.

### A13. Privacy and chain-of-thought boundaries were absent

OpenCode session messages can include user text, assistant reasoning parts,
tool inputs/results, paths, and secrets. “Reasoning traces” must not mean
reconstructing hidden chain-of-thought.

**Correction:** compound extracts only observable transcript fields exposed by
the API, labels provider reasoning as optional, uses sanitized export plus a
redaction pass, applies retention limits, and requires explicit opt-in before
sending historical sessions to an LLM. Hidden reasoning is never inferred.

### A14. “All features” conflicted with the no-TUI non-goal

The earlier spec explicitly excluded a TUI while pi-effect-harness/pi-compound
use status UI, a toggle, skill stats, and an interactive compound review.

**Correction:** add the documented `./tui` entrypoint and `tui: true` server
flag. Implement the mode status/footer, key binding, skill stats view, and
compound proposal review protocol there. Keep the server tools and headless
protocol as the functional source of truth. TUI-specific Promise/JSX code is
isolated at the host boundary.

### A15. Workspace packages were not publishable as described

Workspace packages referenced through `workspace:*` are not automatically
bundled into one npm package. “All workspace packages as dependencies” is not a
packaging mechanism.

**Correction:** publish one package with internal relative imports and public
subpath exports (`./kernel`, `./verify`, `./compound`, `./modules/*`). The
host-neutral boundaries remain enforced by directory/package lint rules. If
separate packages are desired later, they become separately published packages
with real versioned dependencies; no fake workspace dependency is shipped.

### A16. Session cursors were too weak

An ID-only `sessionsSeen` map misses new messages added to an existing session
and can lose work if a run crashes after marking a session seen.

**Correction:** store per-session `lastObservedEventSeq`, `updatedAt`, content
hash, and run state. Commit the cursor only after successful export and
distillation. Always include the current session when it has new content, and
include all unvisited sessions in the configured project scope by default.

### A17. The plugin context cannot enumerate or export historical sessions

The inspected `@opencode-ai/plugin/effect` `SessionDomain` is a restricted
`Pick<SessionApi>`: it exposes `create/get/prompt/command/synthetic/interrupt/
rename/wait` and hooks, but not `list`, `export`, `log`, or `message.list`.
Those operations exist on the full `@opencode-ai/client`, not on `ctx.session`.
Therefore a server plugin tool cannot honestly promise to walk every historical
session by calling `ctx.session.list()`.

**Correction:** split session acquisition into two explicit adapters:

- `LiveSessionSource` in the server plugin, which indexes the current/future
  sessions from the public event stream and accepts explicit session IDs;
- `HistoricalSessionSource` in the companion client/TUI worker, which uses the
  full `@opencode-ai/client` API to paginate `session.list` and call
  `session.export({sanitize:true})`. The CLI uses
  `@opencode-ai/client/effect` plus `FetchHttpClient`/the documented service
  layer; the TUI's Promise client is wrapped only at its UI boundary.

The TUI/CLI sends only validated proposals/control envelopes back through the
public session API, or runs the pure compound pipeline locally and asks the
server to materialize an approved result. The server plugin must not create a
second unauthenticated client connection to itself. If a plugin-only historical
scan is a hard requirement, it is impossible on the documented v2 context and
must be tracked as an upstream API request rather than hidden in the
implementation.

### A18. The upstream threshold is internally inconsistent

The inspected `pi-effect-harness` source defines `MIN_EFFECT_SKILLS = 4`, while
its README and guidance describe a threshold of 5. Migrating without resolving
this would make the gate, policy header, and documentation disagree.

**Correction:** treat the executable upstream constant as the compatibility
baseline (`4`) and add a contract test that asserts the chosen default in every
port. Make the threshold an explicit option for the new plugin, and render the
same value into the policy header and gate reason. Do not silently change the
default to 5 while claiming behavioral parity. During implementation, either
update copied guidance to the selected default or record a deliberate upstream
compatibility decision.

### A19. A server child session cannot be exported through `ctx.session`

The earlier OpenCode benchmark executor called `session.export` after
`session.wait`, but the plugin context does not expose `export` either. Waiting
only returns completion; it does not return the child transcript.

**Correction:** the server executor registers an internal session with a
`LiveSessionTraceStore` before creating it and records its observable text,
reasoning, lifecycle, and usage events from the already-running public event
stream, while tool hooks provide tool names and exact results.
`session.execution.succeeded/failed/interrupted` closes the live trace.
Historical export remains a full-client TUI/CLI operation.
If a complete live trace is unavailable because the plugin was reloaded, the
benchmark result is explicitly `traceUnavailable`, not a fabricated pass.

### A20. Tool event payloads do not guarantee the tool name in the durable event

The inspected `session.tool.called` event contains the call ID, assistant
message ID, input, execution state, and session ID, but not a guaranteed tool
name. A live ATIF recorder built only from `ctx.event.subscribe()` would lose
the function name needed for a faithful trajectory.

**Correction:** feed `LiveSessionTraceStore` from both sources: session text,
reasoning, execution, and usage events, plus the `execute.before/after` hook
payloads, whose `tool` and call ID are available. Deduplicate by session/call
ID. Treat the event stream as the lifecycle/timing source and hooks as the
tool-name/result source. Historical exports use their `AssistantTool.name`
fields directly.

### A21. A server plugin cannot reconstruct the current branch after a reload

The v2 plugin context has no historical message/log operation. If the plugin
is reloaded after skills were activated, it cannot recover the current
branch's loaded-skill set or a missed ephemeral compaction boundary from
`ctx.session` alone. Blindly trusting a stale in-memory set would weaken the
write gate.

**Correction:** persist a per-project/per-session skill journal in `storage`
for every activation and successful fallback read observed by the plugin, and
clear it when `session.compacted` is observed. On a new plugin generation, a
session without a verified compaction boundary is reset conservatively to zero
(or reconciled by the full-client TUI/CLI collector); it is never over-credited.
The full-client collector can reconcile exported messages after reload. This
is an intentional v2 limitation and must be covered by gate tests.

### A22. Upstream README asset counts are stale

The inspected source contains 53 `SKILL.md` files, 46 pattern files, and 4
guidance files, while the README mentions 41 skills and inconsistent threshold
documentation.

**Correction:** derive parity counts from the checked-out asset tree in CI, not
from README prose. The migration must assert the exact 53/46/4 inventory and
keep the threshold decision from A18 explicit.

### A23. A prompt-only Blueprint would drop effect-autoagent semantics

The first Blueprint sketch contained prompt/procedure/pitfall text but omitted
the execution configuration carried by `effect-autoagent` (`ModelConfig`, tool
set, orchestration/turn limits, timeouts, and budget).

**Correction:** keep prompt composition separate from execution policy, but
include a validated `BlueprintExecutionSpec` on each Blueprint. The
`LlmExecutor` receives the composed prompt, model reference, tool policy,
limits, and isolated environment. Patches can change either module composition
or execution policy, and benchmark reports record both.

### A24. LLM-generated executable code would make Blueprint composition unsafe

The user wants reusable Effect-AI modules, but evaluating arbitrary TypeScript
or Effect code emitted by an LLM would be an unsafe and non-reproducible
interpreter boundary.

**Correction:** Stage 2 emits validated declarative `BlueprintModule` data. A
pure composer renders it, and a typed `BlueprintInterpreter` service executes
only the allowed prompt/tool/acceptance vocabulary. Human-authored executable
modules may implement a separate typed interface and layer, but generated
modules are never `eval`ed, dynamically imported from generated text, or given
unrestricted process access.

### A25. “All sessions” needs an explicit scope, not an accidental project filter

The first plan narrowed compound mining to the current project for safety, but
the stated goal says all sessions plus the current session. These are different
policies, especially when OpenCode has sessions in multiple projects.

**Correction:** add `compound.sessionScope: 'project' | 'all'`, with
`'project'` as the safe default and an explicit `--scope all`/option for every
session visible to the authenticated full client. Both scopes always include
the triggering current session and use the same cursor/idempotency rules. The
scope is part of the project/index key so changing it cannot silently mark
global sessions as processed for a project run.

### A26. Execution completion does not identify changed files

`session.execution.succeeded` identifies the session but does not carry a diff
or touched-file list. Triggering a full verifier on every successful turn would
be wasteful and could verify unrelated changes; relying only on `file.edited`
loses the originating session.

**Correction:** maintain a per-session/project `ChangeLedger` from successful
write/edit tool hooks, keyed by call/event ID and normalized file path. At the
execution boundary, the verifier consumes the coalesced ledger and clears it
only after the run is recorded. A manual full-scope request may use a git diff
or explicit paths. A location-only `file.edited` signal can schedule a
project-level run, but it cannot be attributed to a particular agent session.

### A27. Pi JSONL backfill cannot be reused as an OpenCode backfill

The upstream `SkillReadBackfill` understands Pi's private JSONL session record
format. OpenCode v2 sessions are exposed through different client message and
event schemas; copying that parser would silently produce false telemetry.

**Correction:** port the behavior, not the parser. The full-client collector
backfills from `session.export`/message `type: 'skill'` and observable tool
parts, with the same successful-read and deduplication rules. The server plugin
backfills only from its persisted journal and never reads Pi session files.

### A28. A changed-file list is not enough context for a reviewer

The verifier plan passed paths to the reviewer but did not define how the
reviewer obtains the actual changed lines. The restricted worker cannot rely
on a git command, and a non-git directory has no diff at all.

**Correction:** add a `ChangeSetProvider` service. Write hooks capture
before/after projected spans when available; a VCS implementation may enrich
that with a git diff; and a filesystem implementation provides bounded
before/after content for non-git projects. The reviewer receives a redacted,
bounded `ChangeSet`, never an unbounded whole-repository dump. If no change
context can be produced, semantic review is `error`/`unavailable`, not pass.

### A29. Storage writes need serialization and an authoritative owner

`storage.get/set` does not provide a compare-and-swap transaction in the
documented plugin surface. Concurrent verifier runs, TUI actions, and client
retries could otherwise lose cursor or review decisions.

**Correction:** the server plugin owns all mutating index/approval operations,
serializes them with a scoped per-project `Mutex`, and deduplicates by
request/event ID. TUI/CLI workers send validated control/proposal envelopes and
never write the server index directly. Large artifact writes use atomic temp
file + rename operations. Cross-process client runs must use the same server
protocol rather than independently updating shared state.

### A30. The reference clone must match the selected Effect contract

The upstream harness refreshes `effect-smol` to its latest source, while the
plugin must compile against one pinned Effect RC. A moving reference clone can
teach an agent APIs that are newer than the installed package.

**Correction:** record the pinned Effect version and reference commit in the
policy/telemetry metadata. The default clone target is the compatible
`effect-smol` ref for that version; refreshes are atomic and fail-silent. A
`latest` reference mode is explicit and labeled non-reproducible, never the
default for verification or benchmarking.

### A31. JSON plugin options cannot install arbitrary executable modules

OpenCode installs the plugin and its declared production dependencies into an
isolated cache. A module package named only inside `ctx.options.modules` is not
automatically installed, and JSON cannot carry a `VerificationModule` function.

**Correction:** make data-only `moduleConfigs` the supported user extension
path for additional languages: globs, argv checkers, parsers, timeouts, and
environment policy are all schema-validated. Rich executable modules are
bundled in the published artifact or published as a separately installed
plugin/package whose dependencies are explicit; the plan must not promise
arbitrary dynamic imports from an options string.

### A32. Skill-catalog verification must be per-module, not global

The requirement is that the verifier runs the *same* generated skill catalog
pi-effect-harness ships (currently 53 `effect-*` files in the inspected source)
— and that other languages
get their own catalogs. Treating the harness skill catalog as a plugin-global
singleton would couple verify-core to Effect and break the bend-module story.

**Correction:** `VerificationModule` owns its `skills` and `patterns`
catalogs. The bundled TypeScript module carries the complete current upstream
inventory (53 skills/46
patterns as its knowledge base; deterministic pattern findings cite catalog
entries with full guidance + suggestedSkills, and semantic review checks the
ChangeSet against those skills. A bend module ships empty/own catalogs with
identical interfaces. The write gate keeps using the harness catalog; the
verifier consumes the module catalog. Both read the same migrated assets — no
duplication of content, only of reference.

### A33. The critic agent must not collapse into the semantic reviewer

Adding a critic risks duplicating the verifier's semantic review or, worse,
letting one worker grade its own kind of work.

**Correction:** keep them distinct by contract. Verifier semantic review =
"does this ChangeSet comply with skills/patterns" (code-level). Critic =
independent audit of the builder's *reasoning*: summary + plan + traces in,
findings out (`logical-flaw`, `hallucination`, `domain-error`,
`reference-mismatch`, `architecture-drift`, `missing-consideration`). The
critic must open every reference it cites before flagging it
(`checkReferences`), is read-only, never edits or builds, and cannot approve
its own fixes. Its reports are persisted artifacts the human can audit.

### A34. Benchmark-mode single-run scoring is noisy — accepted requirement

The requirement is exactly **one run per configured LLM**, then score. One run
cannot distinguish model quality from variance, and AVO-style correctness
gating still applies (failed verification ⇒ score 0).

**Correction:** implement `trialsPerModel = 1` as specified, but record enough
context per run (usage tokens, duration, trajectory ref, acceptance detail)
that a later multi-trial mode can be added without schema changes. Scorecards
must label single-run results as such ("n=1") so rankings are never presented
as statistically settled.

### A35. The prompt-evolution loop needs hard safety rails

Letting an agent rewrite its own prompts can spiral: cost blowups, prompt drift
toward benchmark overfitting, or destructive edits to accumulated knowledge.

**Correction:** adopt the AVO commit discipline verbatim — a variation step may
explore freely, but a version is appended to the blueprint markdown **only**
when verification passes AND train/holdout score strictly beats the running
best; everything else becomes a
journaled `VariationAttempt` with a `lessonLearned`. Additional rails: explicit
opt-in (`evolution.enabled`, default false), `maxVariationSteps` +
`stagnationLimit` with supervisor redirect, per-run budget caps, append-only
markdown with immutable identity frontmatter and append-only version blocks
with score metadata parsed via Effect `Schema`,
and rollback via BlueprintStore history. The evolution loop is never
auto-triggered by session events.

### A36. "Difficult tasks" must not be read as code-only

The compound requirement covers prompts and solution traces for **all**
difficult tasks, not only programming. A pipeline that only recognized code
edits would silently discard most of a session's transferable knowledge.

**Correction:** make domain scope explicit end-to-end: `Insight.domain` and
`Blueprint.domain` tags (`coding | research | writing | planning | automation |
…`, free-form allowed), mining prompts that hunt non-coding wins/failures
explicitly, tasks with a `domain` field, and verification through
`AgentJudgeCheck` rubrics wherever no executable check exists. Caveat recorded:
rubric-judged scores are subjective — deterministic `CommandCheck` remains
preferred wherever possible; judge rubrics are versioned artifacts so score
climbs stay comparable over time.

### A37. Mutable frontmatter conflicts with append-only Markdown

The recent blueprint example put `version` and `bestScore` in the file's
frontmatter while also requiring the file to be append-only. Updating those
fields would rewrite history.

**Correction:** blueprint Markdown has immutable identity frontmatter followed
by append-only `## Version vN` blocks containing each prompt, bounded solution
trace, evaluator version, score, and evolution reason. `BlueprintStore/current`
is the mutable pointer to the best committed block. The parser derives the
lineage from all blocks and rejects duplicate/non-monotonic versions.

### A38. A critic is not independent merely because it has a different prompt

The critic and builder may otherwise use the same model, same stale context, or
the builder's unverified summary as truth. That weakens the requested
independent challenge.

**Correction:** the critic receives the summary as an untrusted claim, opens
the referenced plan/repository/reference material itself, and reports the
references it actually checked. Record builder and critic model references in
the report. `requireIndependentModel: true` rejects equal model references;
automatic feature detection is never inferred from an execution event and
requires an explicit checkpoint or configured cadence.

### A39. The cited AVO paper is not an ARC-AGI result

The referenced arXiv paper is *AVO: Agentic Variation Operators for Autonomous
Evolutionary Search*. It reports autonomous optimization of attention kernels,
not solving all ARC-AGI-3 tasks. Its transferable ideas are agentic variation,
lineage, execution feedback, correctness-gated promotion, and stagnation
redirection. Claiming broader benchmark results would be an unsupported
hallucination.

**Correction:** use AVO as a design analogy only. This project must generate
its own scores and evidence for coding, research, writing, planning, or other
domains; the critic must flag any claim that the paper proves performance for a
different domain.

### A40. “Feature completion” cannot be inferred from a generic execution event

OpenCode execution events do not state whether the builder finished a feature,
plan, or architecture decision. An automatic critic trigger based on every
successful execution would create noisy reviews and would not satisfy the
builder-checkpoint requirement.

**Correction:** the builder explicitly calls `effect_harness_critic` with a
typed checkpoint (`feature | plan | architecture | drift | full`), or the user
enables a clearly named `autoEveryNBuildExecutions` cadence. No automatic
feature inference is permitted; plan-only requests may omit a ChangeSet.

### A41. Evolution must prove improvement without exposing the holdout

Repeated prompt variation against one visible benchmark can overfit, and a
single-run model comparison cannot prove that a prompt improved generally.

**Correction:** freeze an evaluator manifest and split tasks into visible train
and hidden holdout sets. The variation agent sees only train results; promotion
requires verification plus strict improvement on train and holdout, with the
evaluator version and bounded solution traces recorded in the appended Markdown
version block. Benchmark mode remains deliberately one run per configured model
and labels its scorecard `n=1`.

### A42. Host SDK types leaked into the core domain sketch

The recent `CriticRequest`/`LiveSessionSource` sketch used `Session.ID` and
`OpenCodeEvent` inside the compound core. That would violate the stated
host-neutral dependency boundary and make the core package import OpenCode
schemas.

**Correction:** core uses neutral `string` session IDs and a small validated
`SessionEvent` projection. Only `src/opencode`, `src/index.ts`, the TUI, and
full-client collector map OpenCode-branded IDs/events into those values.

### A43. The new critic must share the recursion guard

The earlier recursion discussion named verifier, compound, and benchmark child
sessions but not critic sessions. An automatic critic review would therefore
observe its own `session.execution.succeeded` event and could trigger another
critic indefinitely.

**Correction:** register every plugin-owned child with an origin enum that
includes `verifier | critic | compound | benchmark`, exclude all origins from
automatic trigger policies, and clear the origin only after the terminal trace
is persisted.

### A44. Historical traces are untrusted prompt input

Session transcripts and tool outputs may contain prompt injection, secrets, or
instructions aimed at the distiller/critic rather than evidence about the
task. Passing them into Stage 1, the critic, or an LLM judge without a trust
boundary can cause the review system to follow the trace instead of analyzing
it.

**Correction:** render every trace inside a clearly delimited, data-only input
section; system prompts explicitly say that transcript text, tool output,
Markdown modules, and candidate answers are untrusted evidence, never
instructions. Apply redaction and size limits before model calls. Judges
receive a fixed trusted rubric plus separately delimited candidate output, and
human approval remains required before a mined prompt becomes executable.

### A45. Critic model types must not depend on compound-core

The critic belongs to verification, while `ModelRef` was introduced in the
compound domain. Referencing that type from `CriticReport` would create a
cross-package dependency and make the supposedly host-neutral core graph
cyclic.

**Correction:** define one neutral `ModelReference` in `src/shared` and use it
from verifier, critic, compound, and executor contracts. OpenCode-branded model
refs are converted only in the adapter.

### A46. “One run per LLM” must still preserve task isolation

The recent benchmark wording could mean one model session for a whole suite,
which would allow one task's files/output to contaminate another task and make
the score ambiguous.

**Correction:** define one benchmark trial as one `(blueprint, model, task)`
execution in one isolated environment. A selected set produces one scorecard
per model/task pair, with no repeated trial. Evolution uses a fixed train and
holdout set and records the aggregate plus each task result. This satisfies the
single-run requirement without sacrificing isolation.

### A47. Evolution cannot claim improvement without a stored baseline

The commit rule refers to a baseline, but a newly mined BlueprintModule has no
score until it is evaluated. Comparing against an absent or changing baseline
would make the “climbing” claim meaningless.

**Correction:** before evolution, establish and persist a baseline for the
fixed evaluator manifest and selected train/holdout tasks. A candidate is not
promotable if the baseline is missing, stale, or evaluated with a different
manifest. Baseline and candidate runs retain the same task/model/environment
policy and their score components are recorded separately.

## Acceptance gates added by this audit

- Exact plugin package/API capability probe passes, including skill registration
  and TUI loading.
- No plugin-owned child session can recursively trigger verifier or compound.
- No benchmark trial shares a mutable workspace with another trial.
- A compound run cannot append or replace user content without an explicit
  approval record.
- `bun run typecheck`, the complete pattern catalog, and adapter contract tests
  pass before a release is called a full migration.
- Critic runs are read-only, persist their reports, and verify cited references
  before flagging them.
- Evolution commits obey the AVO discipline (verification gate + strict train/
  holdout improvement over best);
  failed attempts are journaled with lessons and never promoted; the loop never
  auto-triggers.
- Every evolved module has a stored baseline tied to the evaluator manifest;
  missing or stale baselines block promotion.
- Distillation and judging treat session traces as untrusted data, apply
  redaction/size bounds, and pass prompt-injection fixtures without following
  embedded instructions.

Reference adopted for the compound evolve loop: *AVO: Agentic Variation
Operators for Autonomous Evolutionary Search*
([arXiv:2603.24517](https://arxiv.org/html/2603.24517v1)) — agent-as-variation-operator,
scored lineage, correctness-gated commits, and stagnation-supervised redirection.

## Final Architecture Verdict

### Was the original goal followed?

Not fully. The first draft captured the three repositories' broad ideas, but it
would not have delivered the requested product without the corrections above:

- it claimed install-time agent and command creation that v2 does not expose;
- it excluded important pi UI and pi-compound review behavior;
- it did not actually review passing changes semantically;
- it made model benchmarks unsafe by sharing a mutable checkout;
- it called a flat prompt document a composable module;
- it could recurse indefinitely through its own child-session events;
- it treated an ID-only session cursor as sufficient; and
- it used an unsafe string command contract.

After correction, the goal is represented faithfully:

1. Build-agent invocation is an installable `effect_harness_verify` tool. It
   runs language checks, Effect pattern/skill-evidence checks against the
   module's skill catalog (the same 53-skill catalog pi-effect-harness ships,
   per-language), and the configured reviewer worker, then sends a structured
   report back to the originating session.
2. A separate critic agent (`effect_harness_critic`) audits the builder's
   reasoning — logical flaws, hallucinations, drift, domain/reference errors —
   from a summary + plan + traces, read-only, with reference verification.
3. Automatic verification is opt-in and project-scoped, with debounce,
   idempotency, child-session exclusion, and no auto-fix by default.
4. Compound runs in two explicit modes: `benchmark` (one run per configured
   OpenCode model/task case, then scorecard) and `mine-evolve` — mining all/new
   sessions for solved difficulties, recurring LLM failures, and workflows into
   approved knowledge, then an AVO-style prompt-evolution loop
   (`Vary(P) = Agent(P, K, f)`) that appends only correctness-passing,
   strict train/holdout-improving prompt versions to testable blueprint
   markdown modules, while retaining failed traces as lessons.
5. A Blueprint is an ordered composition of independently versioned
   BlueprintModules. The pure composition operation renders the same prompt
   for any executor, while acceptance and scoring remain separate validated
   domains.
6. Benchmarking compares models only in isolated environments and records
   deterministic results, subjective judge results, variance, and provenance.
7. The server plugin is installable independently; TUI parity is provided by
   `./tui`; named server agents/commands are supplied through supported config
   because the plugin API cannot add them.

### Is it genuinely Effect v4?

The corrected plan is Effect v4-compatible, but “Effect v4” means the exact RC
line required by the selected OpenCode beta, not a vague dependency range. The
implementation must:

- pin one exact compatible `effect` version and one exact compatible
  `@opencode-ai/plugin` version in the packed artifact;
- use `Schema.Class`/`Schema.TaggedErrorClass` at boundaries, `Context.Service`
  for dependencies, and `Layer` for construction/provisioning;
- use `Ref`/Atom for mutable state and `Effect.forkScoped` for long-lived
  consumers;
- keep `Effect.runPromise`, Promise APIs, JSX, and OpenCode imports at the TUI
  or plugin host boundary only;
- use typed failure channels, especially `Tool.Error` for `execute.before`,
  and never use JavaScript throws in Effect workflows; and
- run the migrated Effect pattern catalog against the plugin's own source.

The core design is composable only if these boundaries are enforced. A module
is not reusable merely because it exports a function: its data schema, service
requirements, layer, and executor must be explicit. `BlueprintModule`
composition, `VerificationModule` registration, `LlmExecutor`, and
`BenchmarkEnvironment` are the intended substitution points.

### Conditional decisions

Two decisions remain deliberately unresolved until the first implementation
spike:

- the exact native skill-registration operation supported by the pinned v2
  package; and
- the exact TUI-to-server control transport after testing the public client and
  synthetic-event envelope.

These are release gates, not details to guess around. If either capability is
unavailable, the release must state the limitation or change its install
strategy. It must not silently ship a partial migration while claiming all
features are present.
