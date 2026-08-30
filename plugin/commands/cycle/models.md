---
description: Inspect or safely configure a managed project role profile
argument-hint: "[role] [model-ref|inherit] [low|medium|high|max]"
---

Handle model assignment with arguments: $ARGUMENTS

No arguments: call `cycle_role_profiles` with operation `status` and report
each role's effective model and thought level. Refuse configuration until all
five profiles are `current`.

With `role model-ref [thought-level]`: call `cycle_role_profiles` with
operation `configure`, the exact role/model, thought level (default `high`)
and confirmation `CONFIGURE_ZCODE_CYCLE_ROLE_PROFILE`. `inherit`, a standard
`provider/model`, or ZCode's exact `custom:provider:model` value are valid.
Never invent or shorten a model ref. The tool preserves the security-critical prompt and tool list.
Report the project profile changed and that a new session is required.

With invalid input: explain the accepted model-ref forms and stop.
