---
description: Inspect or safely configure a managed project role profile
argument-hint: "[role] [provider/model|inherit] [low|medium|high|max]"
---

Handle model assignment with arguments: $ARGUMENTS

No arguments: call `cycle_role_profiles` with operation `status` and report
each role's effective model and thought level. Refuse configuration until all
five profiles are `current`.

With `role provider/model [thought-level]`: call `cycle_role_profiles` with
operation `configure`, the exact role/model, thought level (default `high`)
and confirmation `CONFIGURE_ZCODE_CYCLE_ROLE_PROFILE`. `inherit` is a valid
model value. The tool preserves the security-critical prompt and tool list.
Report the project profile changed and that a new session is required.

With invalid input: explain the two forms and stop.
