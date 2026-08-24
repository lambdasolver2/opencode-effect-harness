/** Markdown files that are documentation, not pattern detectors. */
export const SKIPPED_FILES = ['CLAUDE', 'AGENTS', 'GEMINI', 'README'];

export const PATTERNS_DIR = 'patterns';
export const SKILLS_DIR = 'skills';
export const GUIDANCE_DIR = 'guidance';

/** Matches content containing Effect code (the word `Effect` or effect imports). */
export const EFFECT_CODE_RE = /\bEffect\b|from\s+['"]effect(?:\/[^'"]*)?['"]/;

/** Minimum distinct effect-* skills required before writing Effect code.
 * Upstream source pins 4 while its README says 5; the executable constant is
 * the compatibility baseline and is exposed as a plugin option. */
export const MIN_EFFECT_SKILLS = 4;

/** Effect-smol repository for the version-compatible reference clone. */
export const GITHUB_REPO = 'https://github.com/Effect-TS/effect-smol.git';
