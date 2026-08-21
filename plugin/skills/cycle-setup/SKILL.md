---
name: cycle-setup
description: Use when initializing ZCode Cycle in a workspace or after changes to the installation. Guides the first-run checks - control plane health, doctor diagnostics, role agent resolution, data directory placement - and what the user must fix before workflows can run.
---

# ZCode Cycle Setup

Run these checks in order and report facts, not guesses.

1. Call `cycle_health`. Expect product and protocol versions and
   `schema_mode: read_write`. A protocol mismatch means the plugin and the
   native package differ; tell the user to reinstall matching versions.
2. Call `cycle_control` with operation `doctor` for the current project.
   Report every diagnostic the control plane returns.
3. Verify role agent resolution: the session must be able to dispatch
   `zcode-cycle:architect`, `zcode-cycle:executor`,
   `zcode-cycle:functional-reviewer`, `zcode-cycle:security-reviewer` and
   `zcode-cycle:arbiter`. If any is missing, the plugin was not loaded at
   session start — tell the user to restart the session (on Windows, quit
   from the tray, not just the window).
4. Report the data directory (from the doctor output) and confirm it is
   outside any application installation directory.
5. Close with a numbered list of required user actions, or state that
   setup is complete and `/cycle:run` arms the next request.

Never modify project files during setup.
