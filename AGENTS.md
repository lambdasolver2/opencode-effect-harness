# Project instructions

## Mandatory validation gates

After EVERY change (even minor), run these in order from the repo root:

```sh
bunx tsgo --noEmit          # Effect-aware typecheck (Go compiler) — MUST pass
bunx tsc --noEmit           # fallback typecheck — MUST pass
bunx vitest run             # full test suite — MUST pass
```

If any gate fails, fix before continuing. Never skip or ignore failures.

## Pattern catalog self-check

The repo ships its own Effect-v4 anti-pattern detectors in
`packages/module-typescript/assets/patterns/*.md`. These use ast-grep
(structural code matching) and regex to detect code smells.

Key patterns to watch for when writing code:

- **No imperative loops** — use `Arr.map/filter/reduce`, `Effect.forEach`
- **No throw inside Effect.gen** — use `Effect.fail` with typed errors
- **No native fetch** — use Effect HTTP client
- **No direct JSON.parse/stringify** — use Schema codecs at boundaries
- **No process.env** — use Config service
- **No mutable state outside Ref** — use Ref/SynchronizedRef
- **No node: imports** — use platform services (FileSystem, Path, etc.)
- **No as any / as never** — validate at boundaries with Schema

Whole-repository self-scan against ALL shipped detectors (new violations fail;
the `src/pattern/Baseline.ts` debt list must shrink, never grow):

```sh
bunx vitest run src/pattern/Scan.test.ts
```

Catalog integrity check (loads every shipped detector/skill and fails loudly
on malformed or missing assets):

```sh
bunx vitest run packages/harness-kit/src/Catalog.test.ts
```

## Planning & documents

- Never write plans or specs to `~/.opencode/plan/`. Keep all planning documents
  inside the repository under `docs/spec/`. `PLAN.md` at the repo root links them.
- The canonical migration spec lives in `docs/spec/`. Treat
  `docs/spec/05-implementation-adversarial-audit-2026-08-23.md` as the
  normative implementation audit (append-only).

## How the pattern detection works

Each pattern is a Markdown file with YAML frontmatter defining:
- `detector: ast` — uses ast-grep structural query (matches code shape)
- `detector: regex` — uses a regex pattern (with optional comment-skipping)
- `glob` — which files to match (e.g. `'**/*.{ts,tsx}'`)
- `level` — severity (`critical`, `high`, `medium`, `warning`, `info`)
- `suggestSkills` — effect-* skill IDs to load for guidance

After each successful write/edit, the plugin runs every detector against the
post-write content. Matches are sent back as a single advisory message with
the pattern's full guidance body and suggested skills.
