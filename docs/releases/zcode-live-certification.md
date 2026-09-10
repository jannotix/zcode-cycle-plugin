# Live ZCode Certification

This lane certifies the exact signed plugin ZIP after the release-candidate
workflow has sealed it. Source-tree tests, an unsigned local build and an
older ZIP do not satisfy this gate.

## Admission

1. Verify `release-manifest.json`, the Git SHA and every sealed artifact with
   `verify-release-manifest.mjs`.
2. Record the ZIP SHA-256 before extraction. It must be the same digest used
   in every scenario and in the final receipt.
3. Use Windows 11 x64 with ZCode Desktop `3.11.2.6792` and bundled CLI `0.16.5`.
   Any host update invalidates this receipt and requires a complete rerun.

## The host pin, and what to do when it moves

ZCode Desktop updates itself. The pin above is therefore not a fact about the
product but a fact about one machine at one moment, and it goes stale on its own:
the lane was written against `3.10.2.6414` and `3.11.2.6792` was installed before
it ever ran. The bundled CLI did not move with it, which is why only one of the
two numbers changed.

**Before a campaign.** Read the installed build and confirm it matches the pin:

```text
(Get-Item 'C:\Program Files\ZCode\ZCode.exe').VersionInfo.ProductVersion
```

If it differs, update the pin *before* starting, in all four places that carry
it — `scripts/release/verify-zcode-live-receipt.mjs`, its fixture in
`tests/qualification/live-certification-receipt.test.mjs`, the production release
plan and this document — and record in the commit why it moved. Do not start a
campaign on a host you have not pinned.

**During a campaign.** Do not let the host update. Finish the twelve scenarios on
one build, because a receipt mixes evidence from every scenario and a mid-run
update makes half of it describe a host the other half did not use. If an update
lands anyway, discard the partial evidence and start over on the new build: a
receipt is cheaper to re-earn than to argue about.

**After it moves.** A published receipt stays true of the build it names — it is
not invalidated retroactively. What expires is its usefulness as evidence for the
*current* host, which is why the plan calls for a rerun rather than a patch.
4. Use a disposable fixture repository and a disposable ZCode plugin test
   profile. Keep the withdrawn `1.0.0` isolated from production projects.
5. Capture sanitized JSON/text evidence and screenshots where UI state is the
   assertion. Evidence must contain no credentials, user paths, private data
   or model conversation content unrelated to the scenario.

## Required scenarios

Run each scenario from the same admitted ZIP bytes and record at least one
digest-bound evidence file:

1. `component-discovery`: install and enable 1.0.2; commands, five skills,
   both Hooks and the MCP server load with no Cycle diagnostic.
2. `setup-doctor`: `/cycle:setup install`, a real new session,
   `/cycle:setup`, health 1.0.2/protocol 1/read-write schema and doctor PASS.
3. `quick`: complete a bounded fixture change through promotion; verify the
   candidate digest and audit-chain receipt.
4. `full`: complete architecture, execution, both independent reviews,
   arbitration and promotion on a risk-routed fixture.
5. `forced-repair`: force a deterministic mandatory-gate failure, confirm no
   promotion, repair, refreeze and pass without reusing old evidence.
6. `hard-kill-resume`: stop ZCode during active work, restart and use
   `/cycle:resume`; reconcile the durable state without duplicating promotion.
7. `browser`: on loopback only, capture open/check/screenshot/logs/snapshot/
   close and bind the receipt to the candidate. External origins are excluded
   unless separately approved at action time.
8. `accessibility`: prove the required accessibility gate from the managed
   browser snapshot, not from a narrative assertion.
9. `goal`: link completed workflows to every milestone and prove completion
   refuses missing workflow/arbiter evidence.
10. `update-from-withdrawn-1.0.0`: in the disposable profile only, update the
    historical 1.0.0 installation to the admitted 1.0.2 and verify data/schema
    reconciliation.
11. `uninstall`: run `/cycle:setup remove`, uninstall the plugin, verify plugin
    and project-profile residue is absent while audit data remains intact.
12. `isolated-rollback-to-withdrawn-1.0.0`: test rollback mechanics only in the
    disposable profile, record the expected withdrawn warning/read-only
    behavior, then restore and re-verify 1.0.2. The final state must be
    `1.0.2-installed-enabled`.

## Receipt and signature

Create `zcode-live-certification.json` using the schema enforced by
`scripts/release/verify-zcode-live-receipt.mjs`. Every scenario must be `PASS`
and cite relative evidence paths plus SHA-256 digests. Set
`isolated_withdrawn_version_tests` and `audit_data_preserved` to `true` only
after observing those facts.

Sign the receipt with the authorized release key. Its public half is
[`release-signing-key.asc`](release-signing-key.asc) and its fingerprint is:

```text
29CB 2E3F A61B 8A2F FE97  BF87 CC4D 1A39 CE15 684F
```

```text
gpg --batch --armor --detach-sign zcode-live-certification.json
node scripts/release/verify-zcode-live-receipt.mjs --receipt zcode-live-certification.json --signature zcode-live-certification.json.asc --signer-fingerprint 29CB2E3FA61B8A2FFE97BF87CC4D1A39CE15684F --sealed <SEALED_DIRECTORY>
```

The key is Ed25519, sign-only, and expires two years from creation. It carries
**no passphrase**, which is what lets a receipt be signed without an interactive
prompt. That is a deliberate trade: an attacker who can already read this
machine's home directory can forge a receipt — but the same attacker can run the
scenarios and earn a real one, and the threat model already places a compromised
host inside the boundary. Protect it with
`gpg --change-passphrase 29CB2E3FA61B8A2FFE97BF87CC4D1A39CE15684F` if receipts
will ever be signed somewhere less trusted than where they are produced.

A revocation certificate was written at generation time under
`~/.gnupg/openpgp-revocs.d/`. Move it somewhere you would still have if this
machine were lost; without it a compromised key cannot be retired.

The marketplace submission, signed tag, GitHub Release and npm publication
must reject a missing, unsigned, incomplete, stale or wrong-byte receipt.
