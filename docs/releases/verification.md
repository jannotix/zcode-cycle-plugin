# Release Verification

Every release follows this checklist. A release that fails any step
does not ship.

1. **Build from a clean checkout.** `cargo build --release -p workflowd`
   on Windows and Linux; verify the exit code before copying anything
   (a link step silently blocked by a running daemon once shipped a
   stale binary).
2. **Full workspace suite on both platforms.**
   `cargo test --workspace --all-features` — expect 242 passed, 0
   failed, identical on both.
3. **Qualification battery on both platforms.**
   `node tests/qualification/battery.mjs <n>` with the platform
   overrides — zero FAIL iterations.
4. **Assemble the distribution.**
   `bun scripts/packaging/assemble-plugin.ts`; verify the assembled
   plugin contains both platform binaries, the built MCP bundle, all
   agents, commands, skills, hooks and manifests — and nothing else
   (no working tree, no node_modules, no build intermediates).
5. **Clean-install smoke.** Install from the assembled plugin in a
   pristine profile: `/cycle:setup` clean bill, `/cycle:doctor` PASS,
   one quick governed cycle on a fixture, `/cycle:history verify` valid.
6. **Uninstall check.** Remove the plugin: zero residues in the
   application, user data directory untouched.
7. **License and identity.** `LICENSE`, `NOTICE`, package manifests and
   commit authorship consistent; no attribution noise; version numbers
   aligned across workspace, plugin manifest and marketplace entry.
8. **Tag.** `git tag vX.Y.Z` on the verified commit; the tag is the
   release.
