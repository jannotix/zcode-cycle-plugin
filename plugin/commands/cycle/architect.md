---
description: Consult the architect alone (read-only planning, no workflow)
argument-hint: "[topic]"
---

Consult the architect role about $ARGUMENTS without starting a workflow.
Register a temporary architect session (`cycle_role_register`, role
`architect`), dispatch the `zcode-cycle:architect` agent with the exact
question, revoke the registration when it returns, and present its task
graph or analysis. Nothing is implemented; no files change; this is
planning only.
