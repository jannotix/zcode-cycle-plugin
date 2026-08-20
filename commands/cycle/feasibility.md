---
description: Consult the executor for feasibility analysis only (never implementation outside a workflow)
argument-hint: "[question]"
---

Ask the executor role for feasibility analysis of $ARGUMENTS. Register a
temporary executor session, dispatch the `zcode-cycle:executor` agent with
explicit instructions that this is a feasibility consultation: analysis,
risks, estimated effort and blockers only — no file changes of any kind.
Revoke the registration when it returns and present the analysis.
