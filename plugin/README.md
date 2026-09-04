# Cycle for Zcode

Cycle for Zcode is a local evidence-gated delivery plugin for ZCode. It
separates architecture, implementation, functional review, security review and
final arbitration, while a deterministic Rust control plane owns workflow
state, candidate bytes, verification evidence and delivery.

## Release status

- `1.0.2` is the unreleased production version. Do not distribute it until the
  exact Windows/Linux artifact has completed the release matrix.
- `1.0.2-rc.4` is a superseded internal candidate and was never published. It
  must not be installed or reused: it carries different bytes under a different
  identity.
- `1.0.2-rc.3` is superseded: the exact Desktop probe supplied the raw role as
  camelCase `agentType`, which that candidate did not normalize. Do not install
  or reuse it.
- `1.0.2-rc.2` is superseded: an exact Desktop raw-dispatch probe exposed an
  ungoverned host-native `SubAgent` route. Do not install or reuse it.
- `1.0.2-rc.1` is superseded because the Desktop did not discover its standard
  hook file; it must not be installed or reused.
- `1.0.1` is a superseded, never-published candidate. It must not be installed
  or reused: different candidate bytes were exercised under that identity.
- `1.0.0` is withdrawn and must not be installed. Its historical tag is kept
  for auditability and is not reused.

## Supported scope for 1.0.2

| Platform | Status |
|---|---|
| Windows 11 x64 | Certification target |
| Linux x64, Ubuntu 22.04 and 24.04 | Certification target |
| macOS x64 / arm64 | Compatible but untested only after native build gates pass |
| Windows/Linux ARM64 | Unsupported |

The certification target is the current ZCode Desktop release recorded in the
release receipt. A newer ZCode version invalidates host-integration receipts
until the live matrix is repeated.

## Installation

Production users should install the plugin only from the official ZCode public
marketplace after version `1.0.2` is accepted and published. Official
installation matters because public role enforcement depends on ZCode loading
the plugin hooks from a trusted source.

For development and certification, add a **local directory marketplace** in
Settings -> Plugins -> Create -> Add marketplace, select this repository, then
install `zcode-cycle`. In each governed project run `/cycle:setup install`,
start a new ZCode session, then run `/cycle:setup` to verify the five managed
role profiles. The main session is the orchestrator; roles are sub-agents.
Every Cycle role dispatch requires one unique Cycle registration; a raw agent
launch that bypasses registration is denied.

Requirements:

- ZCode Desktop with plugin support;
- Node.js 22 or later available to plugin processes;
- Git and the build/test tools required by the governed project;
- Windows x64 or a supported Linux x64 distribution;
- Chrome, Edge or Chromium when a change requires managed browser evidence.

The platform `workflowd` daemon ships inside the verified plugin archive. It is
never downloaded or executed from a remote URL at runtime.

## What the plugin installs

- five explicit project role profiles: architect, executor, two reviewers and
  arbiter; the main ZCode session orchestrates them;
- slash commands and five workflow skills;
- a `PreToolUse` role guard and a `PostToolUse` audit hook;
- one local stdio MCP server;
- a self-contained MCP/browser bridge built from the locked npm dependency graph;
- platform-bound `workflowd` binaries, user documentation and legal notices.

## Permissions and side effects

Cycle is intentionally capable of changing a project, but only after the user
arms a governed run.

### Files and Git

- Normal conversation, setup, architecture and review are read-only.
- `/cycle:setup install` writes five managed files under the current project's
  `.zcode/agents`; repair, model changes and removal require their explicit
  setup/model command forms and never overwrite an unowned conflicting file.
- The executor modifies an isolated Git worktree within declared write scopes.
- The executor may stage and commit those worktree changes. It cannot delegate,
  push, tag, switch branches, create another worktree, rewrite history or run
  destructive Git cleanup through the Cycle hook.
- The control plane freezes exact candidate bytes, verifies them and promotes
  only the approved paths onto the recorded base revision.
- Export, cancellation with data loss, external browser origins and publication
  remain explicit user decisions. Cycle does not weaken ZCode confirmations.

### Command execution

The control plane runs verification commands declared in the validated plan.
Commands use direct argument vectors rather than an interactive shell; unsafe
operators, blocked programs and destructive forms are rejected. Commands run
with the user's operating-system privileges. Use ZCode in an isolated
development environment and review high-risk actions as its Terms recommend.

### Network and browser

- Cycle has no telemetry, account service, update service or remote backend.
- The MCP bridge and daemon communicate only through a local authenticated pipe
  or Unix socket.
- Managed browser sessions use an isolated temporary profile. Loopback origins
  are allowed; every external origin requires explicit approval. Browser
  requests then reach that approved origin directly.
- ZCode and any model/provider selected by the user operate under their own
  terms and privacy policies. Cycle never reads or stores provider credentials.

### Local data

Workflow state, the tamper-evident ledger, signing keys, worktrees, browser
evidence and project memory are stored outside the application installation:

| Platform | Default |
|---|---|
| Windows | `%LOCALAPPDATA%\ZCode Cycle` |
| Linux | `$XDG_DATA_HOME/zcode-cycle` or `~/.local/share/zcode-cycle` |
| macOS | `~/Library/Application Support/ZCode Cycle` |

Uninstalling the plugin leaves this audit data intact. Delete it only as a
separate, explicit data-destruction decision after taking any required backup.

## How delivery works

1. `/cycle:run auto|quick|full` captures the user's next request verbatim.
2. The architect produces a requirement-linked, bounded task graph.
3. The executor implements and commits tasks in an isolated worktree.
4. The control plane freezes the candidate and runs mandatory gates.
5. Full mode dispatches both shell-free independent reviewers.
6. The arbiter judges the original request, exact candidate and raw evidence.
7. Only an approved candidate is promoted. Rejection drives a bounded repair
   loop; interruption is recovered by `/cycle:resume`.

See [the user manual](docs/USER_MANUAL.md), [command reference](docs/commands/reference.md),
[threat model](docs/security/threat-model.md) and
[release plan](docs/releases/production-release-plan.md).

## Update, rollback and removal

- Never reuse a published version. Refresh the marketplace, update to a higher
  semantic version, run `/cycle:setup repair`, and start a new session.
- Release certification includes upgrade from the previous public version and
  rollback with preserved data. A newer database schema may open only in the
  documented safe read-only mode.
- Before uninstalling, run `/cycle:setup remove` in every configured project;
  then remove the plugin in ZCode. Remove the data directory separately only
  if the ledger, memory, evidence and recovery state are no longer required.

## Development checks

```text
cargo fmt --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features --no-fail-fast
cd mcp && bun install --frozen-lockfile && bun run typecheck && bun run build && bun run test
node tests/qualification/battery.mjs 1
```

The public release also requires the official marketplace validator/build,
20/20 deterministic batteries on both certified platforms, clean-install/live
ZCode checks, SBOM/notices/provenance, and signed Windows binaries.

## Security and legal

Report plugin vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
Report ZCode host vulnerabilities through ZCode's own private reporting channel.

Copyright 2026 Gianluca Iannotta. Licensed under FSL-1.1-MIT; each released
version becomes available under the MIT License two years after its release
date. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Cycle for Zcode is an independent integration. It is not affiliated with,
sponsored by or endorsed by ZCode or its operator. ZCode names and trademarks
belong to their respective owners.

Development disclosure: changes prepared for `1.0.2` include AI-assisted code
and documentation and require human owner review before publication.
