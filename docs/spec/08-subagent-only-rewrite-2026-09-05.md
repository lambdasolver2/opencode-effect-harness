# 08 — Subagent-only rewrite (opencode2 auto-invocation)

Status: plan. Normative audit `05-implementation-adversarial-audit-2026-08-23.md` stays append-only; this doc proposes the rewrite, it does not amend past findings.

## 0. Goal

Rewrite `opencode-effect-harness` so opencode2 itself decides when to call us, via **child-session subagents only**:

- No `ctx.tool.add` surface (`effect_harness_verify`, `effect_harness_critic`, `effect_harness_compound`, `harness_skill_stats`, `harness_toggle` deleted as tools).
- No reliance on the model calling a same-session tool.
- Primary agents (`build`, `plan`) delegate through the built-in `subagent` tool to 4 shipped subagents.
- Registration is file-driven so discovery is automatic (no manual `session.create` wiring in plugin code).

## 1. Hard V2 constraint (shapes the whole plan)

`ctx.agent.transform` exposes `list/get/update/remove/default` only — **no `add`** (`src/index.ts:184`, docs `/v2/docs/build/plugins`, `/v2/docs/agents`).

Consequences:

- A plugin alone **cannot** register a new agent. "Automatically registered" = ship agent definitions where opencode2 discovers them:
  - `A`: `.opencode/agents/effect-*.md` in this repo (project scope, auto-discovered upward to project root), shipped in npm `files`.
  - `B`: `opencode.jsonc:agents` inline entries as fallback for packed installs where `.opencode/` is not copied.
  - Plugin `setup` may only `update` description/model/steps of those IDs, never `add`.
- The only plugin-only auto-background path is `ctx.command.transform` with `subagent:true` (`/v2/docs/commands`). That registers a **command**, not an agent. Rejected as the canonical path; optionally kept as one thin bridge command during migration, then removed.

## 2. Proposed subagents (4, no more)

All `mode: subagent` (never primary), `hidden: false`, explicit `description` (that text is the model-facing trigger — it must say *when* to call).

### 2.1 `effect-verify` — replaces `effect_harness_verify` + auto-verify + feedback rule

- When: "after any write/edit/patch touching Effect/TS code, or before claiming done; runs typecheck+tests+pattern scan, persists report".
- System: deterministic runbook — `bunx tsgo --noEmit`, `bunx tsc --noEmit`, `bunx vitest run`, ast-grep scan over `packages/module-typescript/assets/patterns/*.md`, skill-evidence check (`minEffectSkills:4`), write `.effect-harness/reports/<ts>-verify.json`. Reuses `packages/verify-kit/Orchestrator`, `packages/module-typescript` as prompt-bundled scripts, not plugin runtime.
- Model: inherit parent when unset; `steps: 12`.
- Permissions: `read/glob/grep allow`; `shell allow bunx tsgo *, bunx tsc *, bunx vitest *`; `edit deny`; `subagent deny` (no nesting); `external_directory ask`.
- Input contract (parent passes explicitly — fresh session has no parent context): `touchedFiles[]`, `projectRoot`, `loadedSkills[]`.
- Output: `verify passed|failed|error + report: <path>`.

### 2.2 `effect-critic` — replaces `effect_harness_critic` worker

- When: "after a feature/plan/architecture decision; audits reasoning for logical-flaw|hallucination|domain-error|reference-mismatch|architecture-drift|missing-consideration".
- System: read-only reviewer, strict JSON contract `{"verdict","findings","checkedReferences"}`; findings citing unopened refs are dropped; undecodable = UNVERIFIED. Reuses `packages/verify-kit/Critic` decode/filter as a bundled script.
- `steps: 8`. Permissions: `read/glob/grep/webfetch/websearch allow`; `edit/shell/subagent deny`.
- Input: `summary (>=10 chars)`, `focus: feature|plan|architecture|drift|full`, explicit file refs.
- Output: `verdict + findings[] + report: .effect-harness/critic-reports/*-critic.json`.

### 2.3 `effect-benchmark` — replaces `effect_harness_compound` benchmark ops

- When: "only on explicit user request to compare models/tasks; never auto".
- System: DB-first flow per `06-benchmark-store-spec.md` — `task.create/get/list`, `benchmark.start/status/leading/history/trial` via `packages/bench-store` + isolated `git worktree` workspaces under `.effect-harness/workspaces/`. `mine-evolve` stays an explicit error (REM-4).
- `steps: 16`. Permissions: `shell allow git worktree *, bunx *`; `read/glob allow`; `edit allow .effect-harness/** only`; `subagent deny`.
- Output: `status + jobId/trialId + artifact paths`.

### 2.4 `effect-guide` — replaces header injection + gate message + `harness_skill_stats`

- When: "before writing Effect code; looks up the minimal effect-* skills/patterns for the task".
- System: read `packages/module-typescript/assets/skills/*/SKILL.md` + `guidance/*.md` index, return 2–5 skill IDs with why. Never writes code itself.
- `steps: 4`. Permissions: read-only; `edit/shell/subagent deny`.
- Output: skill ID list the parent must `read` before editing (replaces the blocking gate message with a delegation instruction).

Dropped without replacement: `harness_toggle` (becomes config `harness.enabled` only), destructive-shell regex and containment escapes stay as narrow hooks (see §4).

## 3. Auto-registration + auto-invocation wiring

Files to add (shipped in `package.json:files`):

```text
.opencode/agents/effect-verify.md
.opencode/agents/effect-critic.md
.opencode/agents/effect-benchmark.md
.opencode/agents/effect-guide.md
```

`opencode.jsonc` (this repo + README snippet for consumers):

```jsonc
{
  "agents": {
    "effect-verify": { "description": "...", "mode": "subagent", "steps": 12 },
    "effect-critic": { "description": "...", "mode": "subagent", "steps": 8 }
  },
  "permissions": [
    { "action": "subagent", "resource": "effect-verify", "effect": "allow" },
    { "action": "subagent", "resource": "effect-critic", "effect": "allow" },
    { "action": "subagent", "resource": "effect-guide", "effect": "allow" },
    { "action": "subagent", "resource": "effect-benchmark", "effect": "ask" }
  ],
  "plugins": [{ "package": "./src/index.ts", "options": {} }]
}
```

Parent prompt (replaces header injection): one short instruction file (e.g. `assets/agents/parent-instructions.md`) telling `build`: "before editing Effect code call `effect-guide`; after edits call `effect-verify`; after features call `effect-critic`". Injected only if a minimal `session.hook("context")` is kept (§4), otherwise shipped as project `instructions`.

Invocation at runtime is then: primary model sees catalog (ID+description) → calls `subagent` tool with `agentID + prompt(touchedFiles/summary)` → child runs → parent receives result. Foreground for verify/critic/guide, background for benchmark.

## 4. What stays in `src/index.ts` (minimal, explicit)

Pure subagent-only **cannot synchronously block** a write. The current fail-closed gate (`evaluateGate`, `pendingSnapshots`, `denyInternalMutation`, auto-verify consumer `src/index.ts:1052-1636`) has no subagent equivalent. Decision:

- DELETE: all `ctx.tool.transform` adds, `ctx.skill.transform` bulk registration (subagents read skill files directly), `headerRule` injection, `FeedbackRule` result mutation, `Ledger/ChangeLedger` tracking, event-consumer auto-verify, `persistReport/persistCriticReport` from plugin (move into subagent scripts).
- KEEP (narrow security boundary, documented as the only hooks): origin read-only guard for internal sessions + containment fail-closed on escapes + destructive-shell block. Everything else becomes advisory text telling the model which subagent to call.
- `Options.ts`: shrink to `harness.enabled`, `assetsRoot`, benchmark DB path, critic on/off. Delete `minEffectSkills/strictAgents/failClosedForGate/verify.trigger` enforcement knobs (they become subagent prompt constants).

## 5. Migration phases

1. Freeze: record current tool/hook inventory + tests that assert them (they will be inverted).
2. Agents: add the 4 `.opencode/agents/effect-*.md` + `opencode.jsonc` agents/permissions; add discovery test (IDs visible, `mode:subagent`, descriptions non-empty) and permission test (parent may launch verify/critic/guide; benchmark is `ask`).
3. Slim plugin: delete tool registrations and enforcement hooks in `src/index.ts`; keep guards from §4; move `Orchestrator.verify`, `decodeWorkerOutput/filterUnverifiedFindings`, `BenchmarkTool.handle` call sites into `scripts/effect-verify.ts`, `scripts/effect-critic.ts`, `scripts/effect-benchmark.ts` runnable by subagents.
4. Skills/patterns: stop registering 54 skills natively; subagent prompts reference `packages/module-typescript/assets/{skills,patterns,guidance}` by path. Keep `Catalog.test.ts` + `Scan.test.ts` as subagent-side integrity checks.
5. Cutover tests: assert `ctx.tool.transform` never calls `add`; assert no `session.hook("context")` header injection; e2e: parent prompt "edit X" results in `subagent(effect-guide)` then `subagent(effect-verify)` calls (mock `subagent` tool); benchmark requires explicit user ask.
6. Docs: link this spec from `PLAN.md`; update `README` consumer snippet (agents + permissions + plugin); append audit note that blocking enforcement was intentionally dropped.

## 6. Risks / tradeoffs (accepted)

- Loss of fail-closed blocking: a model that skips the subagent skips verification. Mitigation: keep §4 guards; make descriptions imperative ("ALWAYS call after edits").
- Cost/latency: each delegation is a child session with its own steps. Mitigation: `effect-guide steps:4`, verify only on touched Effect files.
- Distribution gap: npm installs do not auto-install `.opencode/agents/` into consumers. Mitigation: dual-ship (`assets/agents/` in `files` + `opencode.jsonc:agents` inline + README copy step); discovery test covers both.
- No nesting: `general/explore` cannot launch subagents; our subagents set `subagent: deny` so they never delegate further — all context (touchedFiles, summary) must be passed in the delegation prompt.
- Fresh-context loss: child sees nothing unless the parent passes it. Every agent doc lists its required input contract.

## 7. Acceptance

- `grep -rn "tools.add\|ctx.tool.transform" src/` shows only §4 guards (no `add`).
- New agent discovery + permission tests green.
- Mandatory gates green: `bunx tsgo --noEmit`, `bunx tsc --noEmit`, `bunx vitest run`, `effect_harness_verify overall:passed`.
- Manual e2e: edit an Effect file → model calls `effect-guide` then `effect-verify` without being told in-chat; feature lands → model calls `effect-critic`.
