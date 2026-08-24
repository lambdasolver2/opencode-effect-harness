import { Effect } from 'effect';

// ── Command execution ────────────────────────────────────────────────

export interface CommandSpec {
	readonly executable: string;
	readonly args: ReadonlyArray<string>;
	readonly cwd?: string;
	readonly timeoutMs: number;
	readonly maxOutputBytes: number;
}

export interface CommandResult {
	readonly exitCode: number | undefined;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}

export const succeeded = (r: CommandResult): boolean => r.exitCode === 0 && !r.timedOut;

// ── Diagnostics ──────────────────────────────────────────────────────

export interface Diagnostic {
	readonly checkerId: string;
	readonly severity: 'error' | 'warning' | 'info';
	readonly file?: string;
	readonly line?: number;
	readonly column?: number;
	readonly message: string;
}

// ── Checker results ──────────────────────────────────────────────────

export type Verdict = 'passed' | 'failed' | 'error' | 'skipped';

export interface CheckerSpec {
	readonly id: string;
	readonly kind: 'typecheck' | 'test' | 'lint' | 'build' | 'custom';
	readonly label: string;
	readonly command: CommandSpec;
}

export interface CheckerResult {
	readonly specId: string;
	readonly verdict: Verdict;
	readonly diagnostics: ReadonlyArray<Diagnostic>;
	readonly durationMs: number;
}

// ── Skill catalog (per-language knowledge base) ─────────────────────

export interface SkillCatalogManifest {
	readonly source: string;
	readonly contentHash: string;
	readonly skillCount: number;
}

export interface SkillCatalog {
	readonly root: string;
	readonly skillCount: number;
	readonly minRequired: number;
	readonly manifest: SkillCatalogManifest;
	load(name: string): Effect.Effect<string>;
}

export interface PatternCatalog {
	readonly root: string;
	readonly patternCount: number;
}

// ── Verification module ──────────────────────────────────────────────

export interface ProjectContext {
	readonly projectRoot: string;
	readonly touchedFiles: ReadonlyArray<string>;
}

export interface VerificationModule {
	readonly id: string;
	readonly languages: ReadonlyArray<string>;
	readonly appliesTo: (filePath: string) => boolean;
	checkers(context: ProjectContext): Effect.Effect<ReadonlyArray<CheckerSpec>>;
	parseDiagnostics?(spec: CheckerSpec, result: CommandResult): ReadonlyArray<Diagnostic>;
	readonly skills?: SkillCatalog;
	readonly patterns?: PatternCatalog;
}

// ── Registry ─────────────────────────────────────────────────────────

export interface RegistryService {
	register(module: VerificationModule): Effect.Effect<void>;
	all(): Effect.Effect<ReadonlyArray<VerificationModule>>;
	resolve(touchedFiles: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<VerificationModule>>;
}

// ── Evidence ─────────────────────────────────────────────────────────

export type EvidenceStatus = 'sufficient' | 'insufficient' | 'skipped';

export const assessEvidence = (
	codeDetected: boolean,
	loadedSkills: ReadonlyArray<string>,
	minRequired: number
): EvidenceStatus => {
	if (!codeDetected || minRequired <= 0) return 'skipped';
	return new Set(loadedSkills).size >= minRequired ? 'sufficient' : 'insufficient';
};

// ── Semantic review ──────────────────────────────────────────────────

export interface ReviewFinding {
	readonly severity: 'critical' | 'major' | 'minor' | 'note';
	readonly kind: string;
	readonly message: string;
}

export interface SemanticReview {
	readonly status: 'passed' | 'failed' | 'error' | 'skipped';
	readonly findings: ReadonlyArray<ReviewFinding>;
}

export const skippedSemantic = (): SemanticReview => ({ status: 'skipped', findings: [] });
