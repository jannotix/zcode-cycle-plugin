# Release Verification

Every release follows this checklist. A release that fails any step
does not ship.

1. **Build from a clean checkout.** `cargo build --release -p workflowd`
   on Windows and Linux; verify the exit code before copying anything
   (a link step silently blocked by a running daemon once shipped a
   stale binary).
2. **Full workspace suite on both platforms.**
   `cargo test --workspace --all-features --no-fail-fast` — expect zero
   failed tests on both; record counts rather than hard-coding them here.
3. **Qualification battery on both platforms.**
   `node scripts/release/run-battery.mjs --iterations <n>`, which points the
   battery at this checkout and, with `--binary`, at a per-platform daemon —
   zero FAIL iterations.
4. **Assemble the distribution.**
   `bun scripts/packaging/assemble-plugin.ts`; verify the assembled
   plugin contains both platform binaries, the built MCP bundle, the five
   role-profile templates, commands, skills, hooks and manifests — and nothing else
   (no working tree, no node_modules, no build intermediates).
5. **Clean-install smoke.** Install from the assembled plugin in a
   pristine profile: `/cycle:setup install`, new session, `/cycle:setup`
   clean bill, `/cycle:doctor` PASS,
   one quick governed cycle on a fixture, `/cycle:history verify` valid.
6. **Uninstall check.** Run `/cycle:setup remove`, remove the plugin: the
   active installation and the project role profiles are gone, user data
   untouched. Anything the host keeps outside the installation — ZCode retains
   its marketplace's cached copy — must be inert: absent from
   `installed_plugins.json`, with no daemon process running from it, and
   disclosed in the README.
7. **License and identity.** `LICENSE`, `NOTICE`, package manifests and
   commit authorship consistent; no attribution noise; version numbers
   aligned across workspace, plugin manifest and marketplace entry.
   The Windows daemon is unsigned by design: confirm `authenticode.json`
   records `NotSigned` rather than an invalid signature, and that the README's
   SmartScreen guidance still matches the published checksums and the
   `gh attestation verify` invocation.
8. **Tag.** Create and verify a signed `vX.Y.Z` tag on the admitted commit;
   an unsigned or moved tag is not a release.
