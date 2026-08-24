---
action: context
tool: (edit|write)
event: after
name: bend-imperative-loop
description: Bend has no imperative loops — use recursion or match
glob: '**/*.bend'
detector: regex
pattern: '\b(for|while)\s*\('
level: warning
---

# No Imperative Loops in Bend

```haskell
good :: Nat -> Nat
good Zero     = Zero
good (Succ k) = Succ (good k)   -- structural recursion
```
