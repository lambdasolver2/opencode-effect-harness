# opencode-compound-kit

Host-neutral compound domain: session mining, two-stage distillation, blueprint markdown modules, AVO-style prompt evolution, and benchmark scoring. **Zero host dependencies.**

## What this is

Implements the compound agent's reasoning brain. It mines past coding sessions for solution traces, distills them into reusable **Blueprint** prompt modules (markdown), benchmarks LLMs against those blueprints in isolated workspaces, and improves prompts through scored evolutionary variation (AVO-style commit discipline).

## Domain types

### `Trace.Digest`

A **bounded solution trace** — the distilled knowledge extracted from one session run. Not a raw transcript; a structured summary capturing what matters for future runs:

- `taskPrompt` — what was the model asked to do
- `attemptedStrategy` — how it approached the problem
- `observableSteps` — bounded list of actions taken
- `failure` / `detection` / `correction` — where it went wrong, how it noticed, and what fixed it
- `transferableLesson` — the one-sentence takeaway that makes this trace valuable
- `score` / `fullTraceRef` — outcome metric + pointer to full sanitized ATIF trajectory

Without digests, evolution would have to re-read entire sessions every iteration.

### `Trace.FailureLesson`

A structured lesson from a failed attempt: `{sourceTrace, attempt, failure, detection, resolution, invariant}`. Fed back into the knowledge base K so future variation steps avoid repeating known mistakes. These are the "scar tissue" of the system — each failed attempt teaches something permanent.

### `Insight`

A Stage-1 candidate mined from session traces. Fields: `{id, kind, domain, anchor, content, evidence, confidence, sourceSession}`. Kinds: `failure-pattern` (recurring mistake), `recovery-strategy` (how a failure was fixed), `task-blueprint` (reusable workflow), `preference` (user preference). Every insight carries verbatim evidence from the transcript and a `TraceDigest` showing the actual solution attempt.

### `GateDecision`

Stage-2 output: `{insightId, decision: 'approve'|'reject', reason?, rewrittenContent?, confidence?}`. The gate applies **null bias** (rejecting is the default) and rewrites content freely when approving. Rejected insights are retained with their rejection reason so they aren't re-proposed.

### `Blueprint`

The testable prompt module itself: `{systemPrompt, procedure[], pitfalls[], acceptance criteria, execution spec}`. Lives as human-readable markdown on disk with append-only version blocks containing score metadata. Structured schemas are the machine-readable projection parsed via Effect Schema.

### `Patch`

Declarative change to a blueprint: `set-system-prompt`, `add-procedure-step`, `remove-procedure-step`, `add-pitfall`, `set-execution`. Applied via a pure fold (`applyPatches`) that never mutates its input and skips patches targeting other blueprints.

### `Evolution.Lineage`

The scored history P in `Vary(P,K,f)`:
- `committed[]` — versions that passed verification AND strictly beat baseline (train + holdout)
- `attempts[]` — failed/rejected attempts with `lessonLearned`; kept for learning, never promoted
- `baselineScore` — frozen at first evaluation; promotion blocked without it

### `Benchmark.Run`

One execution result: `{blueprintId, modelProvider, modelName, taskId, score, passed, durationMs, tokensIn?, tokensOut?, tracePath}`. Scorecards label results `n=1` since benchmark mode uses exactly one trial per model per task.

## Pipelines

### Benchmark mode

```
for model in options.compound.benchmark.models:
    for task in selected_task_ids:
        create isolated workspace (Env.create)
        execute blueprint via LlmExecutor (one trial)
        verify via acceptance criteria
        → Run{score, passed}
aggregate → scorecard rows (n=1 labeled per spec A34)
```

### Mine & evolve mode

```
MINING LOOP:
  SessionSource.export(sessionID) → messages
  TraceBuilder.fromExport(messages) → SessionTrace + Digests
  Distill.extract(traces, docs) → Insights [cheap model, high recall]
  Distill.gate(candidates) → GateDecisions [premium model, null bias]
  human review → approve/edit/skip/reject/abort

EVOLUTION LOOP (Vary(P, K, f)):
  establish baseline on train+holdout tasks
  repeat up to maxVariationSteps:
    variation step = autonomous agent consults lineage P + knowledge K
      → edits candidate prompt
      → self-tests via f (benchmark tasks in isolated workspace)
    if verification passes AND train+holdout strictly beat baseline:
      append version block to Blueprint markdown
      update running-best
    else:
      journal VariationAttempt{outcome, lessonLearned}
  stagnation supervisor redirects after limit consecutive failures
```
