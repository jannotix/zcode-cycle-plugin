# Cycle for Zcode

ZCode Cycle is a native ZCode plugin for evidence-gated software delivery. It
coordinates an architect, an executor, two independent reviewers and an
independent final arbiter over a deterministic control plane: requests are
decomposed into bounded tasks, implemented in isolated worktrees, verified
against real evidence, and approved only by an arbiter that sees the original
user request, the exact candidate and the raw verification output — never the
executor's own summary of its work.

The problem it solves: single-agent sessions self-confirm. The same context
interprets a request, implements it, reviews its own assumptions and declares
itself done. ZCode Cycle separates those responsibilities and requires real
verification before anything is called complete.

## Install

Add this repository as a plugin marketplace in ZCode (Settings → Plugin
Management → Discover → `+`), install `zcode-cycle`, restart the session —
on Windows, quit from the tray — then open a project, select the
`zcode-cycle:cycle` agent and run `/cycle:setup`. The control-plane daemon
ships with the plugin for Windows x64 and Linux x64.

[Complete user manual](docs/USER_MANUAL.md) · [Getting started](docs/guides/getting-started.md) · [Command reference](docs/commands/reference.md) · [Threat model](docs/security/threat-model.md)

## Repository layout

- `plugin/` — the assembled, self-contained distribution plugin (what the
  marketplace installs): agents, commands, skills, hooks, the MCP bridge with
  its dependencies, the user documentation and the per-platform `workflowd`
  binaries.
- `crates/` — the Rust control plane: state machine, framed IPC, SQLite
  store, tamper-evident ledger, project memory, incremental code
  intelligence, and the `workflowd` daemon.
- `mcp/` — the MCP bridge between the ZCode session and the daemon.
- `packages/` — platform-bound npm packages carrying the prebuilt `workflowd`
  binary (Windows x64 and Linux x64 are the certified targets; macOS builds
  are compiled but not certified).
- `scripts/` — packaging and release tooling.
- `tests/qualification/` — the cross-platform deterministic battery.
- `.github/workflows/` — continuous integration: formatting, clippy with
  denied warnings, the full test suite on Windows and Linux, native package
  assembly and the qualification battery.

## Development

Requires a stable Rust toolchain (see `rust-toolchain.toml`), Node.js and Bun.

```text
cargo fmt --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
cd mcp && bun install && bun run build
bun scripts/packaging/assemble-plugin.ts
node tests/qualification/battery.mjs 1
```

## License

Copyright 2026 Gianluca Iannotta. Licensed under FSL-1.1-MIT; each version
becomes available under the MIT License on the second anniversary of its
release date. See `LICENSE` and `NOTICE`.
