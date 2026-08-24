# opencode-harness-kit

Pure kernel for coding-agent harness extensions. **Zero host dependencies** — imports nothing from `@opencode-ai/*` or any other agent SDK.

## What this is

All the domain logic for enforcing Effect v4 best practices during code writes: schemas, rules, ast-grep pattern matching, write projection, and a controller that dispatches host events through hooks then rules to produce decisions.

## Domain types

### `Decision`

The **central output** of every rule and hook evaluation. A tagged union with four variants, each mapping to a concrete action the host adapter must perform:

- **`BlockToolCall{reason}`** — Prevents the current write/edit from executing. The `reason` string is surfaced to the model as a tool error, explaining why the write was blocked and what to do instead (e.g. "read 2 more effect-* skills"). Produced by the skill gate when a prospective write introduces Effect code but fewer than `minEffectSkills` distinct skills have been loaded on this branch.
- **`InjectUserMessage{message, deliverAs}`** — Queues an advisory message into the conversation after the current tool completes. Used for pattern feedback: when post-write content matches known anti-patterns, this delivers the pattern's full guidance text plus suggested skills back to the model. Never blocks; purely advisory.
- **`InjectSystemPrompt{content}`** — Appends content to the system prompt before the next agent turn. Used to inject the merged Effect-first policy header every turn while the harness mode is enabled. The model sees this alongside its normal system prompt.
- **`AppendCustomEntry{customType, data}`** — Adds invisible session metadata (not shown in chat). Used to record successful skill reads as branch-level state entries that persist across turns but are invisible to the user.

Without `Decision`, rules would have no structured way to communicate their verdicts. The host adapter maps each variant to framework-specific calls (e.g. `Tool.Error` failure in OpenCode v2).

### `Intent`

A normalized representation of **what the model wants to write**, extracted from raw tool input before any policy check runs. Two variants:

- **`WriteFile`** — full-file content write (new file or complete overwrite). Fields: `filePath?`, `content`.
- **`EditFile`** — targeted edit with an array of `{oldText, newText}` replacement pairs applied to the existing file.

Both carry a `phase` field (`'before'` = captured at execute.before hook, `'after'` = captured at execute.after). This distinction matters because:

- The gate uses `'before'` intents with **prospective projection**: it reconstructs the would-be file content in memory and checks whether it still contains Effect code. Deletion-only changes whose result has no Effect code pass through unblocked.
- Pattern feedback uses `'after'` intents with **actual projection**: reads the file from disk and locates changed spans so detectors only flag newly introduced issues.

Extraction is host-specific: the adapter maps tool names like `write`/`edit`/`multiedit` and their input shapes into these normalized variants. Unknown tools produce `undefined` — never guessed writes.

### `Edit`

A single find-and-replace operation within an edit intent. Fields: `{oldText, newText}`. The kernel also tracks the **resolution** of each replacement against the current file content:

- **`UniqueMatch{span}`** — `oldText` found exactly once; safe to apply; span records position
- **`MissingMatch`** — oldText not present; the edit cannot apply
- **`AmbiguousMatch{count}`** — oldText appears multiple times; ambiguous which occurrence to replace
- **`OverlappingMatch`** — two replacements target overlapping regions

Resolutions drive the prospective projection: unique matches are applied in order to build the output; missing or overlapping ones cause fallback to concatenated newTexts. Changed spans (regions actually modified) are tracked so pattern matching only reports issues in newly written code.

### `Pattern`

Parsed from a markdown file with YAML frontmatter + body, representing **one detectable anti-pattern** in Effect v4 code. Each pattern knows:

- **How to detect**: via `ast-grep` structural query (e.g. `$A as any`) or regex (with optional comment-stripping), filtered by glob (`**/*.{ts,tsx}`) and tool name
- **How severe**: `critical` / `high` / `medium` / `warning` / `info`
- **What to tell the model**: the markdown body contains a Haskell-style transformation diagram showing bad → good form plus rationale
- **What to read next**: `suggestSkills` lists effect-* skill IDs that explain the correct approach in depth

When a pattern matches post-write content, the full guidance body + suggested skills are included verbatim in the feedback message. 46 patterns ship with the TypeScript module.

### `Rule`

Declarative metadata describing a harness policy: `{id, description, action, severity, patternName?, sourcePath?}`. The `action` field declares what the rule does (`blockToolCall`, `injectUserMessage`, `injectSystemPrompt`, `appendCustomEntry`). Rules are enumerated by the RuleCatalog for introspection but the actual evaluate logic lives in typed implementations, not in this data structure.

### `Branch`

A neutral snapshot of the current conversation branch — an array of typed entries representing everything that happened in this session lineage. Entry types include user messages, assistant messages, custom metadata entries, compaction boundaries, and configuration changes.

Its primary consumer is the **skill gate's loaded-skill counter**: it scans entries for skill-loaded markers after the last compaction boundary to determine how many distinct effect-* skills the model has read on this branch. When a compaction entry is encountered, the count resets — forcing the model to re-read skills after context loss.

In OpenCode v2, this snapshot is synthesized from durable events rather than read from session files.

### `Message`

A user message that can be injected into the conversation: `{content, deliverAs?}`. The `deliverAs` field controls delivery timing relative to the running execution:

- `'steer'` — inject immediately into the running turn (model sees it mid-execution)
- `'followUp'` — queue for the next turn boundary
- `'nextTurn'` — queue for after the current execution completes

Produced by the Feedback rule when patterns match. Consumed by the host adapter which calls `ctx.session.synthetic({text, delivery})`.

### `Skill`

Index entry describing one discovered skill directory: `{name, skillFilePath, skillDir}`. Produced by Catalog during self-discovery of bundled skills (scanning for `effect-*/SKILL.md` files). Consumed by:

- Path-based read tracking: when the model reads a file under a known `skillDir`, the corresponding skill name is credited
- Skill registration: entries are passed to the host's skill catalog so they appear in the model's available-skills list

## Pipeline

```
Host event (execute.before / execute.after / context)
  → Controller routes to phase-matching hooks, then rules
      │
      ├→ HOOKS (always run, even when mode is disabled)
      │    ├→ track pending reads: if tool=read & path under skill dir → Pending.remember
      │    └→ credit reads: if tool=read succeeded → Pending.take → Ledger.mark
      │
      └→ RULES (only run when mode is enabled)
           ├→ Header.rule (beforeAgentStart): inject merged guidance into system prompt
           ├→ Gate.rule (toolCall, before-phase intent):
           │     project prospective content → check EFFECT_CODE_RE
           │     → if match && loaded+pending < minSkills → BlockToolCall(reason)
           │     → else pass through
           └→ Feedback.rule (toolResult, after-phase intent):
                project actual content from disk → run all 46 detectors
                → deduplicate, sort by severity → InjectUserMessage(guidance)
                      ↓
    Decision[] returned to adapter layer
```
