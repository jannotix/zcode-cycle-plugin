# Security Policy

## Supported versions

`1.0.2-rc.4` is an unreleased release candidate. `1.0.2-rc.3`,
`1.0.2-rc.2`, `1.0.2-rc.1` and `1.0.1` are superseded and never released;
`1.0.0` is withdrawn. None is supported for production use.

## Reporting a Cycle vulnerability

Use the repository's private GitHub Security Advisory form. Do not place
secrets, exploit payloads, customer code or private machine paths in a public
issue. Include the affected version, platform, ZCode version, reproduction,
impact and the smallest evidence needed to validate the report.

If the defect is in ZCode rather than this plugin, report it through ZCode's
official private feedback/security channel and follow its disclosure terms.

## Security boundaries

- Cycle is local-first and has no telemetry or remote service.
- It executes project verification and Git operations with the current user's
  privileges; it is not an operating-system sandbox.
- Read-only roles declare mutating, shell and delegation tools away. The
  PreToolUse hook is a second boundary, and candidate reconciliation is the
  final write-scope boundary.
- The executor may create code and commits only in the isolated worktree. It
  cannot use the Cycle hook to push, tag, switch, rewrite history, delete
  candidate state or delegate.
- External browser origins require explicit approval and use an isolated
  temporary profile. Approved websites remain third parties with their own
  security and privacy terms.
- IPC is local and authenticated. A user or process able to read the Cycle data
  directory is inside the trust boundary.
- Release binaries are necessary prebuilt components. Production publication
  requires exact-source provenance, checksums, SBOM/notices and platform signing
  where applicable.

See [the full threat model](docs/security/threat-model.md) for assumptions and
out-of-scope risks.
