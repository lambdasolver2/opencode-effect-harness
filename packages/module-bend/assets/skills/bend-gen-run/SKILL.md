---
name: bend-gen-run
description: Compile-check Bend programs with bend check before declaring success
---

# bend-gen-run

Run `bend check` inside the project root before finishing. Bend is strictly
functional: iteration is structural recursion or `match` over inductive data;
pattern matches must be exhaustive.
