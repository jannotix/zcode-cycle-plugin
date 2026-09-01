---
description: Inspect or safely configure a managed project role profile
argument-hint: "[role] [inherit|exact-supported-model] [low|high|max|enabled|off]"
---

Handle model assignment with arguments: $ARGUMENTS

No arguments: call `cycle_role_profiles` with operation `status` and report
each role's effective model and thought level. Refuse configuration until all
five profiles are `current`.

With `role model-ref [thought-level]`: call `cycle_role_profiles` with
operation `configure`, the exact role/model, the model-specific thought level
and confirmation `CONFIGURE_ZCODE_CYCLE_ROLE_PROFILE`. Explicit assignments
are fail-closed: accept only `inherit` or one of the exact supported Z.ai
Coding Plan IDs and levels documented below. Never invent or shorten a model
ref. The tool preserves the security-critical prompt and tool list.

For `inherit`, omit the thought level (ZCode applies a thought level only with
a specific model). For an explicit model, use exactly one supported pair:

| Model | Supported thought levels | Default when omitted |
| --- | --- | --- |
| `custom:builtin:zai-coding-plan:GLM-5.3` | `low`, `high`, `max` | `high` |
| `custom:builtin:zai-coding-plan:GLM-5.3-Flash` | `low`, `high`, `max` | `high` |
| `custom:builtin:zai-coding-plan:GLM-5-Turbo` | `enabled`, `off` | `off` |

Do not offer `nothink` or `medium`: this plugin rejects unsupported pairs
before ZCode can silently ignore or reject them.
Report the project profile changed and that a new session is required.

With invalid input: explain the supported table and stop.
