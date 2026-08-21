---
description: Consult the security reviewer alone (read-only review)
argument-hint: "[scope]"
---

Ask the security reviewer role to review $ARGUMENTS read-only. Register a
temporary `security_reviewer` session, dispatch the
`zcode-cycle:security-reviewer` agent over the named scope, revoke the
registration when it returns, and present its verdict. No approval is
recorded: an advisory review outside a governed workflow cannot approve
anything.
