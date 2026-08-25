/**
 * Self-pattern scan BASELINE — pre-existing detector hits accepted as
 * documented technical debt (AUDIT-044).
 *
 * Policy:
 *  - NEW (file, pattern) pairs FAIL the scan and must be fixed or explicitly
 *    justified here before merging.
 *  - Entries whose hits disappear become STALE and also FAIL, forcing this
 *    list to shrink over time instead of rotting.
 *
 * Justified entries:
 *  - src/RealPath.ts — SECURITY adapter (AUDIT-035): symlink-hardened
 *    containment requires the host realpath API; Node access is confined to
 *    this single file by design.
 *  - require-effect-concurrency on module-typescript/Ledger/Origins/index —
 *    matcher capture window cannot see concurrency options past multi-line
 *    generator callbacks, or the operation is a single-writer Ref/all by
 *    design.
 */
export const baseline: Readonly<Record<string, ReadonlyArray<string>>> = {
	'packages/compound-kit/src/Blueprint.ts': ['avoid-direct-tag-checks', 'prefer-match-over-switch', 'prefer-option-over-null'],
	'packages/compound-kit/src/Distill.ts': ['avoid-any', 'avoid-direct-json', 'avoid-untagged-errors', 'casting-awareness', 'prefer-option-over-null'],
	'packages/compound-kit/src/Env.ts': ['avoid-direct-json', 'prefer-effect-fn', 'prefer-option-over-null', 'stream-large-files', 'use-console-service'],
	'packages/compound-kit/src/Evolution.ts': ['avoid-untagged-errors'],
	'packages/compound-kit/src/Log.ts': ['casting-awareness', 'prefer-option-over-null'],
	'packages/compound-kit/src/Openai.ts': ['avoid-direct-json', 'avoid-native-fetch', 'avoid-schema-suffix', 'casting-awareness', 'prefer-option-over-null', 'prefer-schema-class', 'use-clock-service'],
	'packages/compound-kit/src/Queue.ts': ['avoid-try-catch', 'casting-awareness', 'prefer-option-over-null'],
	'packages/compound-kit/src/Source.ts': ['prefer-option-over-null'],
	'packages/compound-kit/src/Store.ts': ['avoid-direct-json', 'avoid-untagged-errors', 'prefer-option-over-null', 'use-clock-service', 'use-random-service'],
	'packages/compound-kit/src/Suite.ts': ['avoid-direct-tag-checks', 'prefer-option-over-null'],
	'packages/compound-kit/src/Trace.ts': ['prefer-option-over-null'],
	'packages/harness-kit/src/Catalog.ts': ['avoid-try-catch', 'casting-awareness'],
	'packages/harness-kit/src/Controller.ts': ['prefer-option-over-null'],
	'packages/harness-kit/src/Edit.ts': ['prefer-option-over-null'],
	'packages/harness-kit/src/Matcher.ts': ['prefer-match-over-switch'],
	'packages/harness-kit/src/Pattern.ts': ['avoid-schema-suffix'],
	'packages/harness-kit/src/Projection.ts': ['prefer-option-over-null'],
	'packages/harness-kit/src/Skill.ts': ['prefer-schema-class'],
	'packages/harness-kit/src/hook/Hook.ts': ['prefer-option-over-null'],
	'packages/harness-kit/src/rule/Feedback.ts': ['prefer-arr-sort'],
	'packages/harness-kit/src/rule/Rule.ts': ['prefer-option-over-null'],
	'packages/module-bend/src/index.ts': ['prefer-option-over-null'],
	'packages/module-typescript/src/index.ts': ['casting-awareness', 'prefer-option-over-null', 'stream-large-files', 'require-effect-concurrency'],
	'packages/shared/src/Journal.ts': ['avoid-any', 'avoid-direct-json', 'avoid-try-catch', 'casting-awareness', 'prefer-arr-sort', 'prefer-option-over-null', 'use-clock-service', 'use-random-service'],
	'packages/shared/src/PathGuard.ts': ['prefer-option-over-null'],
	'packages/verify-kit/src/ChangeSet.ts': ['prefer-effect-fn'],
	'packages/verify-kit/src/Checker.ts': ['prefer-option-over-null', 'use-clock-service'],
	'packages/verify-kit/src/Critic.ts': ['avoid-direct-json', 'avoid-untagged-errors', 'casting-awareness', 'prefer-option-over-null'],
	'packages/verify-kit/src/Module.ts': ['casting-awareness', 'prefer-option-over-null'],
	'packages/verify-kit/src/Orchestrator.ts': ['casting-awareness', 'prefer-option-over-null'],
	'packages/verify-kit/src/Report.ts': ['prefer-schema-class'],
	'packages/verify-kit/src/Reviewer.ts': ['avoid-direct-json', 'avoid-untagged-errors', 'casting-awareness', 'prefer-option-over-null'],
	'src/Capability.ts': ['avoid-try-catch', 'prefer-option-over-null'],
	'src/ChangeLedger.ts': ['effect-run-in-body', 'prefer-arr-sort'],
	'src/Events.ts': ['casting-awareness', 'prefer-option-over-null', 'use-console-service'],
	'src/ExecNode.ts': ['avoid-any', 'avoid-non-null-assertion', 'avoid-process-env', 'casting-awareness', 'prefer-option-over-null', 'use-command-executor-service'],
	'src/Ledger.ts': ['casting-awareness', 'effect-run-in-body', 'prefer-option-over-null', 'require-effect-concurrency'],
	'src/LiveSessions.ts': ['prefer-option-over-null', 'use-clock-service'],
	'src/ModeState.ts': ['casting-awareness', 'effect-run-in-body', 'prefer-option-over-null', 'use-clock-service'],
	'src/Options.ts': ['prefer-option-over-null', 'prefer-schema-class'],
	'src/Origins.ts': ['effect-run-in-body', 'prefer-option-over-null', 'require-effect-concurrency'],
	'src/Sessions.ts': ['casting-awareness', 'effect-run-in-body', 'prefer-option-over-null'],
	'src/Snapshots.ts': ['prefer-option-over-null'],
	'src/companion/Collector.ts': ['avoid-any', 'casting-awareness', 'prefer-option-over-null', 'use-clock-service'],
	'src/companion/cli.ts': ['avoid-direct-json', 'avoid-process-env', 'effect-run-in-body'],
	'src/index.ts': ['avoid-any', 'avoid-direct-json', 'avoid-direct-tag-checks', 'casting-awareness', 'effect-promise-vs-trypromise', 'prefer-option-over-null', 'use-console-service'],
	'src/RealPath.ts': ['prefer-option-over-null', 'use-filesystem-service'],
};
