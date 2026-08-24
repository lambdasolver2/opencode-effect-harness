/** Session entry name used to persist loaded Effect skills. */
export const SKILL_LOADED_ENTRY = 'opencode-effect-harness:skill-loaded';

/** Session entry name used to record each successful Effect skill read. */
export const SKILL_READ_ENTRY = 'opencode-effect-harness:skill-read';

/** Matches content containing Effect code (the word `Effect` or effect imports). */
export const EFFECT_CODE_RE = /\bEffect\b|from\s+['"]effect(?:\/[^'"]*)?['"]/;

/** Minimum number of distinct effect-* skills required before writing Effect code.
 * Upstream source pins 4 while its README says 5; we follow the executable
 * constant for behavioral parity and expose it as an option. */
export const MIN_EFFECT_SKILLS = 4;

/** Effect-smol repository URL for reference cloning. */
export const GITHUB_REPO = 'https://github.com/Effect-TS/effect-smol.git';
