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

## Refreshing the binaries tracked in `plugin/bin`

Those two files are what a local install and the qualification battery run
against. They do **not** feed a release: `release-candidate.yml` rebuilds both
from the admitted source on their own operating systems, so a certified archive
never contains a byte from here. What a stale tracked binary costs is local
work measured against code that is no longer the code.

Rebuild them after any change under `crates/`, and regenerate the manifest so
the bridge's digest check still passes:

```text
cargo build --release --locked -p workflowd
bun scripts/release/write-native-manifest.ts plugin
```

The Linux binary must be built on **Ubuntu 22.04**, not on whatever Linux is at
hand. The glibc floor is whatever the build host provides, so 24.04 produces a
binary requiring 2.39 that will not start on 22.04 — a platform this release
certifies. Without a 22.04 machine, a container is enough:

```text
docker run --rm -v "$PWD:/src:ro" -v "$PWD/out:/out" ubuntu:22.04 sh -c "..."
```

`scripts/release/check-glibc.mjs` verifies the floor; run it on the result
rather than trusting the build host.
