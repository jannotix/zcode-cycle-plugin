# Live ZCode Certification

This lane certifies the exact signed plugin ZIP after the release-candidate
workflow has sealed it. Source-tree tests, an unsigned local build and an
older ZIP do not satisfy this gate.

## Admission

1. Verify `release-manifest.json`, the Git SHA and every sealed artifact with
   `verify-release-manifest.mjs`.
2. Record the ZIP SHA-256 before extraction. It must be the same digest used
   in every scenario and in the final receipt.
3. Use Windows 11 x64 with ZCode Desktop `3.10.2.6414` and bundled CLI `0.16.5`.
   Any host update invalidates this receipt and requires a complete rerun.
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

Sign the receipt with the authorized release key:

```text
gpg --batch --armor --detach-sign zcode-live-certification.json
node scripts/release/verify-zcode-live-receipt.mjs --receipt zcode-live-certification.json --signature zcode-live-certification.json.asc --signer-fingerprint <FULL_FINGERPRINT> --sealed <SEALED_DIRECTORY>
```

The marketplace submission, signed tag, GitHub Release and npm publication
must reject a missing, unsigned, incomplete, stale or wrong-byte receipt.
