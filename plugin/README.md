# ZCode Cycle

ZCode Cycle is a native ZCode plugin for evidence-gated software delivery. It
coordinates an architect, an executor, two independent reviewers and an
independent final arbiter over a deterministic control plane: requests are
decomposed into bounded tasks, implemented in isolated worktrees, verified
against real evidence, and approved only by an arbiter that sees the original
user request, the exact candidate and the raw verification output — never the
executor's own summary of its work.

This repository is under active development toward the first public release.
Installation and usage documentation ships with the release; until then the
code here is qualification material.

## Repository layout

- `crates/` — the Rust control plane: state machine, framed IPC, SQLite store,
  tamper-evident ledger, project memory, incremental code intelligence, and
  the `workflowd` daemon.
- `packages/` — platform-bound npm packages carrying the prebuilt `workflowd`
  binary (Windows x64 and Linux x64 are the certified targets; macOS builds
  are compiled but not certified).
- `scripts/` — packaging tooling for native packages.
- `.github/workflows/` — continuous integration: formatting, clippy with
  denied warnings, the full test suite on Windows and Linux, and native
  package assembly.

## Development

Requires a stable Rust toolchain (see `rust-toolchain.toml`) and Bun for
packaging.

```text
cargo fmt --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
cargo build --release -p workflowd
```

## License

Copyright 2026 Gianluca Iannotta. Licensed under FSL-1.1-MIT; each version
becomes available under the MIT License on the second anniversary of its
release date. See `LICENSE` and `NOTICE`.
