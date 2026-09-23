---
description: Run read-only installation and project diagnostics
---

Run diagnostics via the `cycle_control` tool (operation `doctor`) plus
`cycle_health` for this project. Report: control plane health, protocol
compatibility, data directory state, registered role sessions
(`cycle_role_list`), and the ledger verification outcome. Read-only: no state
changes.

Report workflows from the doctor result's `workflows` list and nothing else,
one line each: `workflowId`, `state`, `mode`, `currentCandidate`, and
`nextOperations`.

- Whether a workflow can be resumed, retried, paused, recovered or cancelled is
  exactly its `nextOperations`. An empty list means nothing can be done with it.
  Never infer an operation from the state name, a ledger entry or an earlier
  conversation.
- A non-null `currentCandidate` is the workflow's frozen candidate; name it.
  Null means it has none. Do not describe a candidate the field does not show.
- `terminal: true` means the workflow is finished (completed or cancelled) and
  stays that way.
