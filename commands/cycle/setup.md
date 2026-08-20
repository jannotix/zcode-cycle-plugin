---
description: Guided configuration and compatibility checks (first-run initialization)
---

Run first-run setup: call `cycle_health` and report the control plane
versions; call `cycle_control` with operation `doctor` for this project and
report installation and project diagnostics; verify that role agents
resolve (dispatch a trivial read-only check if needed); report the data
directory location and confirm it is outside any application installation.
Finish with a numbered summary of anything the user must fix, or a clean
bill of health.
