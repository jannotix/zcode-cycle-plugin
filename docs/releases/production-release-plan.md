# Cycle for Zcode 1.0.2 Production Release Plan

Status: **BLOCKED - NOT AUTHORIZED TO PUBLISH**

This plan is fail closed. A green source test, a platform build, or an agent
summary cannot substitute for exact-artifact installation and runtime evidence.
Receipts are valid only for the full clean Git SHA and the immutable plugin
archive digest they name.

## Product and platform scope

- Product: Cycle for Zcode `1.0.2`. The internal candidates `1.0.2-rc.1`
  through `1.0.2-rc.4` were never published and carry different bytes.
- ZCode certification target: Desktop `3.10.2.6414`, bundled CLI `0.16.5`,
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
4. Read-only roles that do not receive mutating or shell tools, with a hook as
   a second enforcement layer rather than the only boundary.
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

- use `.zcode-plugin/plugin.json`, the documented `${ZCODE_PLUGIN_ROOT}` and
  `${ZCODE_PLUGIN_DATA}` variables, and newline-delimited JSON-RPC for MCP;
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
   read-only roles lack mutating, shell and subagent tools; an executor cannot
   mutate without one unique active workflow registration; malformed hook
   input and ambiguous identity deny high-risk calls.
4. **Marketplace contract** - official validator and distribution builder
   pass; English/Chinese docs, i18n fields, supported category and disclosures
   are present.
5. **Quality** - format, clippy, Rust tests, MCP typecheck/build, dependency and
   license audits, package allowlists and secret scans all pass on Windows and
   Linux.
6. **Repeatability** - the deterministic battery passes 20 consecutive times
   per certified platform with zero retry masking.
7. **Exact artifact** - Windows and Linux consume the same plugin ZIP bytes;
   native binaries are built on their target OS and their digests are bound in
   the archive manifest, SBOM and provenance.
8. **Live ZCode** - clean install from the final ZIP, component discovery,
   setup/doctor, quick and full routes, forced repair, hard-kill resume, browser
   and accessibility evidence, Goal Mode, update, uninstall and rollback pass.
9. **Supply chain** - tag/commit verification, immutable checksums, SBOM,
   notices and provenance pass. Windows publication additionally requires a
   valid Authenticode signature and timestamp; no unsigned substitute passes.
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
