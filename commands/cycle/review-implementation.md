---
description: Consult the functional reviewer alone (read-only review)
argument-hint: "[scope]"
---

Ask the functional reviewer role to review $ARGUMENTS read-only. Register a
temporary `functional_reviewer` session, dispatch the
`zcode-cycle:functional-reviewer` agent over the named scope (working tree
or a named worktree), revoke the registration when it returns, and present
its verdict. No approval is recorded: an advisory review outside a
governed workflow cannot approve anything.
