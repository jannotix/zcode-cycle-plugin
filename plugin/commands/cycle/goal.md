---
description: Manage persistent goals (create, list, status, amend, focus, plan, link, unlink, control)
argument-hint: "<subcommand> [arguments]"
---

Handle goal management with arguments: $ARGUMENTS

Route by subcommand to the `cycle_goal` tool for this project. Each call's
`operation` object is selected by its `type`; the tool schema lists the fields
of each. Generate every id yourself as a UUID: `goal_id` when creating, and a
fresh `operation_id` for every `amend` and `control` call. Use one stable
`session_id` for this conversation.

| Subcommand | `operation` |
| --- | --- |
| `list` | `{type: "list"}` |
| `status [id]` | `{type: "status", goal_id: <id or null>, session_id}`; null means the goal this session focused |
| `create` | collect objective, constraints, non-goals and success criteria, then `{type: "create", goal_id, objective, success_criteria, constraints, non_goals, max_continuations: 5, session_id}` |
| `amend <id> <text>` | `{type: "amend", goal_id, operation_id, text}` |
| `focus <id>` | `{type: "focus", goal_id, session_id}` |
| `plan <id>` | `{type: "save_plan", goal_id, content, source_session_id}`; also moves a draft goal to planning |
| `link <goal> <milestone> <workflow>` | `{type: "link_workflow", goal_id, milestone, workflow_id}` |
| `unlink <goal> <workflow>` | `{type: "unlink_workflow", goal_id, workflow_id}` |
| `control <action> <id>` | `{type: "control", goal_id, operation_id, action, completion_evidence: null, reason: null}` |

Control actions follow the lifecycle:
Draft → `start_planning` (or `save_plan`) → Planning → `mark_ready` (needs a
saved plan) → Ready → `activate` → Active → `request_completion` (needs at least
one linked workflow, and every linked milestone backed by a completed workflow)
→ Completing → `approve_completion` or `reject_completion`. `pause`/`resume`,
`block`/`resume_blocked`, `continue` (bounded by `max_continuations`) and
`abort` (give a `reason`) are the side paths.

For `approve_completion`, set `completion_evidence` to one of the
`arbitrationReceiptDigests` that `status` lists under the goal's linked
workflows; nothing else is accepted.

Report the daemon's answer as returned. When it refuses, quote the refusal and
stop: it names what is missing. Unknown subcommand: list the valid ones and
stop.
