# opencode-effect-harness

An [OpenCode v2](https://opencode.ai/v2/) plugin harness for Effect v4 development.

Migrated from [pi-effect-harness](https://github.com/mpsuesser/pi-effect-harness) with three new subsystems:

1. **Verifier** — runs `tsc` + tests + the complete Effect skill catalog (53 skills / 46 patterns) against every write
2. **Critic** — independent read-only reviewer that audits builder reasoning for logical flaws, hallucinations, and architecture drift
3. **Compound** — mines past sessions into testable prompt modules (Blueprint markdown), benchmarks LLMs, and improves prompts through AVO-style evolution

## Install

```sh
opencode2 plugin add opencode-effect-harness
```

## What it does

When enabled:

- **Policy header** — system prompt augmented every turn with Effect-first guidance and a loaded-skills preview
- **Skill gate** — writes introducing Effect code are blocked until at least 4 `effect-*` skills are loaded
- **Pattern feedback** — after every successful write, 46 detectors match the post-write content; findings include full guidance + suggested skill hints
- **Reference clone** — a shallow clone of `Effect-TS/effect-smol` maintained at `~/.cache/effect-v4/`
- **Verifier** — `effect_harness_verify` tool runs `tsc --noEmit`, tests, and semantic review
- **Critic** — `harness_critic` tool spawns an independent reviewer to audit reasoning quality
- **Compound** — `effect_harness_compound` tool mines sessions and evolves blueprints

## Options

```jsonc
{
  "plugins": [{
    "package": "opencode-effect-harness",
    "options": {
      "harness": {
        "enabled": true,
        "minEffectSkills": 4,
        "strictAgents": ["build"],
        "referenceClone": true,
        "referenceMode": "compatible"
      },
      "verify": {
        "trigger": "auto",
        "semanticReview": true,
        "workerAgent": "explore"
      },
      "critic": {
        "workerAgent": "explore",
        "checkReferences": true
      },
      "compound": {
        "mode": "mine-evolve",
        "sessionScope": "project",
        "benchmark": { "enabled": false, "models": [] },
        "evolution": { "enabled": false }
      }
    }
  }]
}
```

## Packages

| Package | Description |
|---|---|
| `packages/harness-kit` | Host-neutral kernel port of pi-harness-kit |
| `packages/verify-kit` | Verification engine + critic core |
| `packages/compound-kit` | Traces, blueprints, evolution, scoring |
| `packages/effect-harness` | The OpenCode v2 plugin (publishable) |

## Development

```sh
bun install
bun run probe          # capability probe
bun run check          # typecheck + tests
bun run build:publishable  # verify publishable artifact
```

## License

MIT
