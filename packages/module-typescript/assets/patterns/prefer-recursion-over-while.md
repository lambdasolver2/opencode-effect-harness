---
action: context
tool: (edit|write)
event: after
name: prefer-recursion-over-while
description: Use recursive helpers or Effect.iterate instead of while loops for pagination and state machines
glob: '**/*.{ts,tsx}'
detector: ast
rule:
  kind: while_statement
level: warning
---

# Prefer Recursion Over While Loops

```haskell
-- While loops carry hidden mutable state
while :: State → (State → Bool) → (State → State) → State

-- Pagination as pure recursion
paginate :: Cursor → [Summary] → Effect [Summary]
paginate cursor acc = do
  page ← fetch cursor
  let all = acc ++ toSummaries page
  case nextCursor page of
    Just c  → paginate c all
    Nothing → pure all
```

```ts
// Bad: while loop with mutable cursor and accumulator
const results: Item[] = []
let cursor: string | undefined
let hasMore = true
while (hasMore) {
    const page = await fetch(cursor)
    results.push(...page.items)
    cursor = page.next
    hasMore = cursor !== undefined
}

// Good: recursive pagination helper (pure, composable, stack-safe via trampoline)
const paginate = (
    cursor: string | undefined,
    acc: ReadonlyArray<Item>
): Effect.Effect<ReadonlyArray<Item>, FetchError> =>
    fetchPage(cursor).pipe(
        Effect.flatMap((page) => {
            const all = [...acc, ...page.items]
            return page.next !== undefined
                ? paginate(page.next, all)
                : Effect.succeed(all)
        })
    )
```

While loops encode iteration through mutable state (`hasMore`, `cursor`,
`acc`). Replace them with:
- **Recursion** for state-machine patterns (pagination, parsers, scanners) —
  each call passes updated state as parameters.
- **`Effect.iterate`** or **`Effect.repeat`** when the condition is simple.
- **`Effect.forEach`** when iterating over a known collection.

For character-level scanners (lexers, comment strippers), use a reducer over
the char array with an explicit state type — one char per step, one output per
input, preserving offsets.
