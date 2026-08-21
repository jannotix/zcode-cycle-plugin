# Getting Started

## Install

1. Settings → Plugin Management → Discover → `+` → add
   `jannotix/zcode-cycle-plugin` as a marketplace (GitHub repository or a
   local clone).
2. Install `zcode-cycle`.
3. Restart the session. **Windows: quit from the tray** — closing the
   window only hides the app and new plugins do not register until a
   real restart.
4. Open your project, select the `zcode-cycle:cycle` agent, run
   `/cycle:setup`. A clean bill of health ends with the data directory
   location, outside any application installation.

## First delivery

1. Discuss the change with the Cycle agent — planning conversation is
   read-only and free.
2. `/cycle:run auto` — the next message you send is captured verbatim as
   the immutable original request.
3. Send the request. The router picks quick or full; the governed flow
   runs: architecture, isolated worktree, implementation, verification,
   reviews (full route), arbitration, promotion.
4. When the delivery lands, commit the delivered changes in your project
   before the next run — promotion is fast-forward only.

## Model configuration

Roles inherit your session model by default. Assign per-role models
with `/cycle:models <role> <provider/model>` — for example
`/cycle:models architect zai/GLM-5.3`. Assignments persist as user-scope
agent overrides and apply after a session restart. `/cycle:models` with
no arguments shows every effective assignment.

## Update

Update the plugin from Plugin Management, then restart the session
(tray-quit on Windows). Your data — ledger, memory, goals, worktrees,
browser evidence — is untouched; it lives in your user data directory,
not in the plugin.

## Remove

Remove `zcode-cycle` from Plugin Management and delete the marketplace
entry. All project data remains in
`%LOCALAPPDATA%\ZCode Cycle` (Windows) or `~/.local/share/zcode-cycle`
(Linux); delete that directory only if you want the data gone too.

## Troubleshooting

- **A command is unknown** — the plugin did not load this session:
  restart (tray-quit on Windows).
- **Control plane unreachable** — `/cycle:doctor`; a missing or stale
  native binary means the platform install did not match.
- **Stuck install** — an install from a working-tree directory copies
  everything; always install from the assembled plugin directory.
- **Promotion refused: "not an ancestor"** — your project HEAD moved
  since the workflow started; commit delivered changes between runs.
