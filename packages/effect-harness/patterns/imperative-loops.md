---
action: context
tool: (edit|write)
event: after
name: imperative-loops
description: Use functional transformations instead of imperative loops (for / while / do-while)
glob: '**/*.{ts,tsx}'
detector: ast
rule:
    any:
        - kind: for_statement
        - kind: for_in_statement
        - kind: while_statement
        - kind: do_statement
level: warning
---

# Use Functional Transformations

```haskell
-- Array operations
map     :: [a] → (a → b) → [b]
filter  :: [a] → (a → Bool) → [a]
reduce  :: [a] → b → (b → a → b) → b
filterMap :: [a] → (a → Option b) → [b]   -- single pass

-- Record operations
Record.map        :: {k: a} → (a → b) → {k: b}
Record.filter     :: {k: a} → (a → Bool) → {k: a}
Record.filterMap  :: {k: a} → (a → Option b) → {k: b}

-- Effectful iteration
Effect.forEach :: [a] → (a → Effect b) → Effect [b]
```

```haskell
-- Bad: Imperative with mutations (any flavor of loop)
bad₁ :: [Number] → [Number]
bad₁ numbers = do
  result ← []
  for n in numbers do                       -- ✗ ForOf
    if n % 2 == 0 then result.push(n * n)
  return result

bad₂ :: Effect ()
bad₂ = do
  while (not done) do                       -- ✗ While
    yield* step

bad₃ :: Effect ()
bad₃ = do
  repeat                                    -- ✗ DoWhile
    yield* step
  until done

-- Good: Functional composition
good :: [Number] → [Number]
good numbers =
  filterMap numbers λn →
    if n % 2 == 0
    then Option.some(n * n)
    else Option.none()

goodEffect :: [Item] → Effect ()
goodEffect items = Effect.forEach items processItem { concurrency: 4 }
```

```ts
// Pure transformation: use Array combinators and return a new value.
const squaresOfEven = (values: ReadonlyArray<number>): ReadonlyArray<number> =>
    values.filter((value) => value % 2 === 0).map((value) => value * value)

// Sequential effectful fold: use Effect.forEach when every item performs an Effect.
const validateAll = (items: ReadonlyArray<Item>): Effect.Effect<ReadonlyArray<Result>, Error> =>
    Effect.forEach(items, validate, { concurrency: 1 })

// Independent work: make the concurrency decision explicit.
const loadAll = (ids: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<Record>, Error> =>
    Effect.forEach(ids, load, { concurrency: 8 })

// Stateful accumulation: keep the accumulator immutable and use reduce.
const indexById = (items: ReadonlyArray<Item>): ReadonlyMap<string, Item> =>
    items.reduce(
        (index, item) => new Map(index).set(item.id, item),
        new Map<string, Item>()
    )
```

Choose the combinator from the intent, not by mechanically hiding a loop:

- `map` transforms every value and preserves cardinality.
- `filter` keeps values that satisfy a pure predicate.
- `flatMap` handles zero-or-more output and replaces `continue` with `[]`.
- `reduce` folds a pure collection into one immutable result.
- `Effect.forEach` traverses effects and requires an explicit concurrency policy.
- `Effect.validate`/`Effect.all` are appropriate when independent effects need
  validation or aggregation rather than an ordered fold.

Do not replace a loop with a native `.forEach` that still mutates external
state. If an algorithm is a parser/state machine, model its state explicitly
and use a pure reducer; preserve source offsets when the result is used for
diagnostic locations.

Imperative loops — `for`, `for ... in`, `for ... of`, `while`, `do ... while` — encourage mutation and break composition. Use `Arr.map` / `Arr.filter` / `Arr.filterMap` / `Arr.reduce` for pure transformations, and `Effect.forEach` for effectful iteration (with explicit `concurrency`).

Note: in tree-sitter TypeScript, `for ... of` and `for ... in` share the same AST kind (`for_in_statement`), so listing `for_in_statement` covers both.
