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

Then follow the `cycle-setup` skill. A mutating operation must report the
exact `.zcode/agents` directory and stop for a real ZCode session restart;
never claim that the new profiles are loaded in the current session.
