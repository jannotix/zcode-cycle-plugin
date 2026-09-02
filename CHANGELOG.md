# Changelog

All notable changes to Cycle for Zcode are recorded here. Installed plugin
content is immutable: a published version is never reused for different bytes.

## [1.0.2-rc.3] - Unreleased

Status: **release candidate blocked until every Windows/Linux certification
gate passes against the same immutable plugin archive**.

### Planned

- Repair Linux installation and define the supported glibc baseline.
- Conform to the official ZCode marketplace contract and disclosures.
- Add reproducible release-candidate CI, SBOM, notices, checksums and
  provenance.
- Certify install, quick/full workflows, repair, resume, browser evidence,
  upgrade, uninstall and rollback on the exact release bytes.

### Changed during candidate hardening

- PreToolUse and PostToolUse hooks consume ZCode's newline-delimited protocol
  without waiting for stdin closure.
- A Cycle role dispatch now requires one unique active registration, so a raw
  direct role launch cannot bypass the role/hook contract.
- The hook configuration is declared explicitly from
  `hooks/cycle-hooks.json`; it no longer relies on the client discovering the
  standard hook file.
- The host-native `SubAgent` tool name is now matched and governed alongside
  the documented `Task` and `Agent` aliases.

## [1.0.2-rc.2] - SUPERSEDED - NOT RELEASED

Do not install or reuse this candidate. The exact GitHub-source Desktop test
at `813c285` showed that an unregistered `zcode-cycle:architect` dispatch
could still create a subagent. `1.0.2-rc.3` adds the observed host-native
`SubAgent` matcher and a regression assertion before recertification.

## [1.0.2-rc.1] - SUPERSEDED - NOT RELEASED

Do not install or reuse this candidate. The current ZCode Desktop did not
load its standard `hooks/hooks.json` from the GitHub-source installation.
`1.0.2-rc.2` introduced the explicit, nonstandard manifest hook path.

## [1.0.1] - SUPERSEDED - NOT RELEASED

Do not install or reuse this candidate. Multiple local certification bytes
were evaluated under its identity before the Desktop hook-cache behavior was
observed. `1.0.2-rc.3` uses a new semantic version for a clean host-integrated
certification; the eventual production release is `1.0.2`.

## [1.0.0] - 2026-08-21 - WITHDRAWN

Do not install this version.

- Installable content changed after the first publication without a version
  bump, including removal of a development-machine binary path.
- A clean Linux checkout stored the bundled daemon without its executable bit,
  so the MCP bridge could not start it.
- The public CI run was not green and its Windows smoke command failed under a
  non-blocking `continue-on-error` step.

The `v1.0.0` tag remains available only as audit history. It must not be moved,
rewritten or reused.
