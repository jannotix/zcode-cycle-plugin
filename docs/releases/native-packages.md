# Native Package Publication

The primary distribution channel is the plugin marketplace (the plugin
directory ships both platform binaries). The npm packages are the
secondary channel and the CI artifact path.

One-time (authenticated npm account with 2FA):

```text
cd packages/native-win32-x64 && bun run build-not-needed
```

Per release, for each certified target:

```text
cargo build --release -p workflowd
bun scripts/release/package-native.ts --target win32-x64 --binary target/release/workflowd.exe --output target/native-packages
cd target/native-packages && npm publish zcode-cycle-native-win32-x64-1.0.2.tgz
```

Repeat with `--target linux-x64` and the Linux binary. The packaging
script enforces the archive allowlist (LICENSE, NOTICE, bin, manifest),
verifies the packed binary digest and emits the sha256 sidecar.
