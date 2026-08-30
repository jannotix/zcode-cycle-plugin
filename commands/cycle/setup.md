---
description: Inspect or explicitly install, repair or remove Cycle role profiles
argument-hint: "[install|repair|remove]"
---

Run setup with arguments: $ARGUMENTS

- No arguments: call `cycle_role_profiles` with operation `status`; do not
  modify files.
- `install`: call it with operation `install` and confirmation
  `INSTALL_ZCODE_CYCLE_ROLE_PROFILES`.
- `repair`: call it with operation `repair` and confirmation
  `REPAIR_ZCODE_CYCLE_ROLE_PROFILES`.
- `remove`: call it with operation `remove` and confirmation
  `REMOVE_ZCODE_CYCLE_ROLE_PROFILES`.
- Any other arguments: print these four forms and stop.

After `install`, `repair` or `remove`, report the exact `.zcode/agents`
directory and stop for a real ZCode session restart. Do not load the setup
skill or perform more checks in that stale session; never claim that changed
profiles are already active.

With no arguments only, load and follow the `cycle-setup` skill.
