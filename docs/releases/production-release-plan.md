# Cycle for Zcode 1.0.2 Production Release Plan

Status: **BLOCKED - NOT AUTHORIZED TO PUBLISH**

This plan is fail closed. A green source test, a platform build, or an agent
summary cannot substitute for exact-artifact installation and runtime evidence.
Receipts are valid only for the full clean Git SHA and the immutable plugin
archive digest they name.

## Product and platform scope

- Product: Cycle for Zcode `1.0.2`. The internal candidates `1.0.2-rc.1`
  through `1.0.2-rc.4` were never published and carry different bytes.
- ZCode certification target: Desktop `3.11.2.6792`, bundled CLI `0.16.5`,
  refreshed if ZCode changes before release sealing.
- Certified platforms: Windows 11 x64 and Linux x64 on Ubuntu 22.04 and 24.04.
- Windows/Linux ARM64: unsupported in `1.0.2`; the marketplace documentation
  must not imply support.
- macOS x64/arm64: compatible but untested only after native packages are built
  successfully; macOS evidence never substitutes for a Windows/Linux gate.
- Node.js: 22 or later. Rust and Bun versions are pinned by the release
  workflow and recorded in provenance.

## Comparison with Cycle for Claude Code

Adopt these independently useful mechanisms:

1. Explicit artifact allowlist and denylist, verified against the built ZIP.
2. Reproducible archive construction plus SHA-256 sidecars.
3. CycloneDX SBOM, complete third-party notices and a private vulnerability
   reporting policy.
4. Read-only roles that do not receive mutating or shell tools. The profile is
   the boundary, not a convenience in front of one: ZCode does not run
   PreToolUse inside a dispatched agent, so a hook cannot be a second layer
   behind it.
5. A requirement-to-evidence certification matrix covering installation,
   workflow behavior, failure paths, recovery, platform behavior and packaging.
6. Version information derived from one product manifest instead of duplicated
   literals.

Do not adopt these defects from the current Claude Code repository:

- a CI working directory/cache path that does not match the public repository;
- certification receipts from an older version reused for a newer tag;
- placeholder provider documentation presented as a completed integration;
- host-specific manifest fields without a current ZCode contract test.

The Rust control plane remains authoritative for Zcode. No TypeScript rewrite
is part of this release.

## ZCode policy and terms constraints

The plugin must:

- use `.zcode-plugin/plugin.json`, the documented `${ZCODE_PLUGIN_ROOT}`
  variable, and newline-delimited JSON-RPC for MCP;
- keep durable data out of the install directory. Cycle does, and does **not**
  use `${ZCODE_PLUGIN_DATA}` to do it: the ledger, the signed checkpoints, the
  evidence and the project history are written under `%LOCALAPPDATA%\ZCode Cycle`
  and its POSIX equivalents instead. This is a deliberate, disclosed deviation
  from the recommendation, for one reason: the product promises that a history
  of delivered work outlives the plugin, and the uninstall scenario asserts that
  audit data survives removal. What ZCode does to `ZCODE_PLUGIN_DATA` when a
  plugin is uninstalled is not specified in the contract, and a tamper-evident
  record cannot rest on unspecified behaviour. The binding rule — never the
  install directory — is met; the path is reported by `cycle_health`, documented
  per platform in both READMEs, and removable by the user;
- preserve every ZCode confirmation, risk rule, permission boundary and
  platform safeguard; Cycle may add denials but never bypass host controls;
- keep credentials, private endpoints, customer data and machine-specific
  paths out of source, artifacts, logs, fixtures and receipts;
- disclose command execution, file writes, Git operations, browser control,
  MCP, hooks, local data retention, network access and all third-party code;
- require explicit user approval for external browser origins, destructive
  operations, export, uninstall data deletion and publication;
- use a non-affiliation statement and no ZCode logo or brand asset;
- include equivalent English and Simplified Chinese user documentation;
- ship only necessary prebuilt binaries, each tied to source SHA, toolchain,
  checksum, SBOM and provenance;
- publish through an official marketplace pull request before relying on hook
  enforcement for public installations.

The owner must separately confirm that the account/subscription and intended
commercial use satisfy the current ZCode Terms. This engineering plan is not a
legal opinion.

## Release gates

1. **Version and history** - `1.0.0` is marked withdrawn and `1.0.1` is
   marked superseded; all final installable manifests say `1.0.2`; historical
   tags are unchanged.
2. **Linux runtime** - the installed daemon is materialized atomically under
   plugin data, hash-verified, mode `0700`, and runs on the declared glibc
   baseline. A `0644` archive entry is a required regression case.
3. **Role boundaries** - the current runtime's diagnostic-only plugin-agent
   field is not used. Explicit setup installs five managed project profiles;
   read-only roles lack mutating, shell and subagent tools. That profile is the
   only boundary a dispatched role actually meets: ZCode runs PreToolUse for the
   main session and not inside a dispatched agent, measured 3 of 3 against 0 of
   9 in a live governed run. The hook therefore gates what the main session does
   - it denies mutation while a workflow is locked, denies a role dispatch
   without a unique registration, and denies malformed or ambiguous input - and
   its executor-scoped rules are unreachable until that changes.

   **Closed at the control plane.** The executor legitimately holds Edit and
   Bash, so it is the one role the profile cannot constrain, and two live runs
   saw work reach the project before the gates ran. Freezing a candidate now
   refuses to proceed unless the project still stands at the base revision the
   workflow started from with nothing uncommitted, and the refusal names the
   files that appeared. The project path it checks comes from the code index,
   not from the caller, so a role cannot aim the check somewhere harmless. The
   philosophy does not change - a role is bounded by something it cannot talk
   its way past - only the layer moves, from a host hook this harness never
   calls to a control plane it must call in order to deliver anything at all.

   What the receipt may claim is therefore reconciliation, not containment: the
   executor is not sandboxed and can still write outside its worktree; what it
   cannot do is have that write survive into a delivery. A role that wrote into
   the project and restored it exactly would pass this check, having delivered
   nothing. State it that way or not at all.
4. **Marketplace contract** - English/Chinese docs, i18n fields, supported
   category and disclosures are present, and `scripts/validate-marketplace.mjs`
   passes in CI.

   There is no official validator or distribution builder to run: ZCode ships
   neither as a command. The CLI (`0.16.5`) exposes only `plugins list`, and the
   official checks - `validateMarketplaceSource`, `validateMarketplacePlugin`
   and the archive SHA-256 verification - live inside the client and run when a
   marketplace is added and a plugin is installed. So the official half of this
   gate is not a build step at all: it is satisfied by observing the Desktop
   accept the marketplace and install the sealed archive with no diagnostic,
   which is scenario 1 of the live lane. Our own validator covers the static
   contract in CI; the client covers the rest, live, or the gate stays open.
   Do not record this gate as passed from the CI half alone.
5. **Quality** - format, clippy, Rust tests, MCP typecheck/build, dependency and
   license audits, package allowlists and secret scans all pass on Windows and
   Linux.
6. **Repeatability** - the deterministic battery passes 20 consecutive times
   per certified platform with zero retry masking.
7. **Exact artifact** - Windows and Linux consume the same plugin ZIP bytes;
   native binaries are built on their target OS and their digests are bound in
   the archive manifest, SBOM and provenance.
8. **Live ZCode** - clean install from the final ZIP, component discovery,
   setup/doctor, quick and full routes, forced repair, hard-kill resume, Goal
   Mode, schema compatibility and uninstall pass. Browser and accessibility
   evidence is required on Windows and not on Linux, matching the declared
   scope: the Linux lane has no browser installed, and an unobserved row is not
   recorded as passed. Upgrade and rollback from a published predecessor are not
   gates for `1.0.2` and cannot be: `v1.0.0` was withdrawn carrying no release
   asset, so no installable predecessor has ever existed. Building one now from
   the tag would manufacture the artifact the gate claims to exercise. What the
   gate protects - that delivered history survives a version change - is proved
   instead by the schema-compatibility scenarios, and the upgrade path itself is
   certified at `1.0.3`, from bytes that were genuinely published.
9. **Supply chain** - tag/commit verification, immutable checksums, SBOM,
   notices and provenance pass. Windows code signing is applied when the signing
   secrets are configured and is not a release gate: ZCode does not require it,
   and the plugin verifies its own native bytes by digest before running them.
   The signature state is recorded as a fact in the staged evidence and in the
   release documentation, so an unsigned release is a declared limitation rather
   than an unnoticed one. A signature that exists and does not verify still
   fails, on the binary and again inside the sealed archive.
10. **Independent review** - an independent reviewer approves the exact SHA and
    artifact receipts. Owner approval changes status to `AUTHORIZED TO
    PUBLISH`.
11. **Publication** - official marketplace PR, immutable GitHub Release and npm
    packages are created only from the approved bytes. A public clean-install
    recheck changes status to `PUBLIC RELEASE VERIFIED`; failure changes it to
    `WITHDRAWN - ROLLBACK REQUIRED`.

## Rollback

- Do not delete or rewrite published tags or versions.
- If publication verification fails, mark the release withdrawn, remove it
  from discovery where the platform permits, preserve evidence, and issue a
  higher patch version.
- Upgrade tests take a backup before schema or runtime changes. Rollback must
  restore the prior plugin and read the preserved data without mutation; a
  newer schema may open only in documented safe read-only mode.
