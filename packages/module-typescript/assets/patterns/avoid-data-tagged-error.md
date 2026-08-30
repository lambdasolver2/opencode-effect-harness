---
action: context
tool: (edit|write)
event: after
name: avoid-data-tagged-error
description: Use Schema.TaggedError instead of Data.TaggedError for serialization and RPC compatibility
glob: '**/*.{ts,tsx}'
detector: ast
pattern: Data.TaggedError($$$)
level: warning
suggestSkills:
    - effect-error-handling
---

# Use `Schema.TaggedError` Instead of `Data.TaggedError`

```haskell
-- Transformation
Data.TaggedError        :: String -> { fields } -> Error   -- not serializable
Schema.TaggedError :: String -> { schemas } -> Error   -- serializable, RPC-ready
```

```haskell
-- Pattern
bad :: Error
bad = class MyError extends Data.TaggedError("MyError")<{ message: string }>

good :: Error
good = class MyError extends Schema.TaggedError<MyError>()("MyError", {
  message: Schema.String
})
```

`Schema.TaggedError` provides serialization, RPC compatibility, and runtime validation. `Data.TaggedError` lacks these — always prefer `Schema.TaggedError` with a `message` field.
