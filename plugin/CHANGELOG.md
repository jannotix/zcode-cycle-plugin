# Changelog

All notable changes to Cycle for Zcode are recorded here. Installed plugin
content is immutable: a published version is never reused for different bytes.

## [1.0.4] - Unreleased

Status: **blocked until every Windows/Linux certification gate passes against
the same immutable plugin archive**.

`1.0.3` was sealed and carried through the full thirteen-scenario live campaign.
Ten scenarios passed, one was partial and two failed. Two of the failures were
fixes shipped in `1.0.3` that did not work, and the third was a gate that had
been reporting a judgement it never made. All three share one shape: the
mechanism is present, is wired, and does not run in the case it exists for.

### Fixed

- The ledger now records which model a role ran on. The `1.0.3` fix resolved the
  managed profile from the observation's `project_key`, which is a stable
  identifier and not a path, so it never found one — four live workflows recorded
  `null`, including one where the arbiter was pinned to a model the session was
  not using. The project directory now comes from the code index, the same source
  freezing uses and the only one a role cannot aim somewhere harmless.
- The orphaned-role-registration sweep now runs whatever the daemon answers. In
  `1.0.3` it sat after the awaited control call, so a daemon that refused
  recovery skipped it — and refusing recovery is exactly what happens after the
  hard kill the sweep was written for. A recovery asked about the project rather
  than one workflow no longer skips the sweep either.
- The accessibility gate judges the snapshot instead of counting the operation.
  The managed browser now carries the accessibility tree's findings into the
  receipt, and the gate fails when interactive elements carry no accessible name,
  naming the roles that were missing one. A receipt with no summary cannot
  discharge the gate. Previously a page with unnamed controls passed exactly like
  one without, and the receipt said `passed` either way.

### Changed

- The browser guide states what the accessibility gate does and does not check,
  and that a project-native `a11y`, `accessibility` or `axe` command takes
  precedence over the built-in assessment.
- The live certification plan's accessibility and per-role-model rows now say
  what evidence a pass requires, rather than describing a state the product has
  moved past.

## [1.0.3] - Superseded, never published

Status: **blocked until every Windows/Linux certification gate passes against
the same immutable plugin archive**.

`1.0.2` was sealed and carried through the full thirteen-scenario live
certification against ZCode Desktop. Eleven scenarios passed, two failed, and
the campaign found seven defects that eighty-nine Rust test binaries, the
qualification battery and the MCP suite had all missed. They share one shape: a
mechanism that works correctly, and an artefact that does not carry what a
reader needs. Fixing them changed the bytes, so `1.0.2` is superseded and was
never published.

### Fixed

- The ledger now records which model ran a role, read from the managed profile
  rather than accepted from the role itself. `Actor.model` existed in the schema
  and every construction site passed `None`, so a receipt could not answer which
  model approved a candidate.
- Promotion is recorded by the control plane. Delivery is the one step that
  changes the user's project and was the one step no component recorded; across
  the campaign the same sealed bytes produced a delivery event in some runs and
  none in others.
- Recovery sweeps the role registrations a hard-killed session leaves behind.
  Until it did, every subsequent dispatch was ambiguous and recovery could not
  use the sanctioned path to repair anything.
- `StoreError::AggregateConflict` carries the condition that failed. It was
  raised from sixty-six places and rendered as one sentence asserting one
  specific cause, which was true of three of them.
- The secret scanner no longer refuses ordinary cryptographic code. It now
  requires a quoted literal and a whole-word name, reports the line and the rule
  it matched, and never prints the value.

### Changed

- An installation no longer carries `docs/releases`: release engineering, the
  internal certification plan and the public signing key are repository and
  release-page content. A signing key shipped inside the artifact it attests to
  proves nothing about those bytes.
- Governed roles accept only the models ZCode ships for the Z.ai coding plan.
  The restriction was enforced and undocumented; it is now stated in the model
  guide, both READMEs and the release plan, with the reason.
- One list decides what an installation contains, shared by the assembler and
  the verifier that proves the assembly still matches source.

## [1.0.2] - Superseded, never published

Status: sealed, fully certified live, and superseded by the fixes its own
certification required. `1.0.2-rc.1` through `1.0.2-rc.4` were internal
candidates and none was ever published. Their entries are kept below because
they record why the candidate bytes changed.

### Planned

- Repair Linux installation and define the supported glibc baseline.
- Conform to the official ZCode marketplace contract and disclosures.
- Add reproducible release-candidate CI, SBOM, notices, checksums and
  provenance.
- Certify install, quick/full workflows, repair, resume, browser evidence,
  upgrade, uninstall and rollback on the exact release bytes.

### Changed during candidate hardening

- PreToolUse and PostToolUse hooks consume ZCode's newline-delimited protocol
  without waiting for stdin closure.
- A Cycle role dispatch now requires one unique active registration, so a raw
  direct role launch cannot bypass the role/hook contract.
- The hook configuration is declared explicitly from
  `hooks/cycle-hooks.json`; it no longer relies on the client discovering the
  standard hook file.
- The host-native `SubAgent` tool name is now matched and governed alongside
  the documented `Task` and `Agent` aliases.
- Dispatch payloads now normalize `agentType` and `subagentType` camelCase
  fields as well as their snake_case compatibility aliases.
- One version identity across the whole product. The workspace, the plugin
  manifest, both marketplace documents, the MCP bridge, the four native
  packages and the certification fixtures all read `1.0.2`; the daemon reports
  it from the same number, and the bridge refuses a daemon that disagrees.

### Fixed

- A run in which the two independent reviewers disagreed could not converge, and
  left no trace of why. The plane refused an arbiter's approval that contradicted
  a live rejection — correctly — but refused it by raising an error before the
  verdict was written: no arbitration row, no history event, nothing new for the
  orchestrator to read. It dispatched the same arbiter again with the same
  inputs, which produced the same verdict, and the record the product exists to
  keep stayed silent about all of it.

  The verdict is a fact whichever way it went, so it is now written either way,
  refused by name in the audit chain as `arbitration_refused` with the reason and
  the repair target in its metadata, and the workflow is routed to repair toward
  the target the rejecting reviewer asked for. A plan defect outranks an
  implementation finding: if either rejecting reviewer says the architecture is
  wrong, repairing the implementation against that same plan would produce the
  same candidate again. One dispatch now settles it even when the arbiter is
  wrong.

  The arbiter's own contract said the opposite of the rule the plane enforces —
  *"weigh review disagreements yourself; you are the final judge"* — which
  invited exactly the verdict that would be refused. It now states that a
  rejection binds: the arbiter is the final judge of whether the candidate
  answers the request, not of whether a reviewer's rejection counts, and
  disagreeing means rejecting with the reasoning on record.

  `mandatory_gates_passed` was passed to the state machine as a literal `true`.
  It was correct only because the check above it had already excluded failing
  gates, so any change to that check would have turned the literal into a silent
  bypass. It is derived from the check now.

  Found by reading Cycle for Claude Code 1.0.20, which hit this on its own
  certification when its two reviewers first split. Zcode had never run a
  governed cycle in which they disagreed, so it could not have found it alone.

- Two of the three symlink cases that had always been skipped on Windows now run
  there. A POSIX symlink needs elevation on Windows, which is why they were
  skipped, but a directory junction needs none, `lstat` reports one as a symbolic
  link, and it redirects a path the same way — so the role-profile directory and
  the private runtime directory are now proven against a real redirect on both
  certified platforms. The third needs a *file* symlink, which a junction cannot
  be; it states that as its skip reason instead of passing silently, and the
  guard it covers is one shared line checked before the Windows path returns
  early, proven on Linux on every push.

- Where the managed browser is looked for is now covered by tests on all three
  platforms. It is the only part of the browser gates that differs by platform,
  and Linux is where they have never been observed running, so proving the list
  costs nothing and removes the one thing that could differ. Both READMEs and the
  browser guide now say plainly that the browser and accessibility gates are
  certified on Windows only, what that does and does not mean, which browsers
  Cycle looks for on each platform, and that `ZCODE_CYCLE_BROWSER` names another.

- Recovery could not tell a promotion that never began from one that started and
  stopped, and the two need opposite responses. In a non-interactive session the
  workflow dies with the session, so an approved cycle ordinarily ends with the
  delivery never having started. The plane holds both facts already — a
  reservation is taken before any byte moves, a journal is bound once one has —
  and now reports them as `deliveryBegan`, `deliveryReserved` and
  `deliveryJournalDigest`, so `/cycle:resume` finishes a delivery that never
  began and leaves a half-written one to a person.

## [1.0.2-rc.4] - SUPERSEDED - NOT RELEASED

Do not install or reuse this candidate. It was the last internal candidate
before `1.0.2` and carries different bytes under a different identity.

## [1.0.2-rc.3] - SUPERSEDED - NOT RELEASED

Do not install or reuse this candidate. Its exact Desktop raw probe still
created an unregistered architect because the host supplied the role as the
camelCase `agentType` payload field. `1.0.2-rc.4` adds that normalization and
the corresponding regression cases.

## [1.0.2-rc.2] - SUPERSEDED - NOT RELEASED

Do not install or reuse this candidate. The exact GitHub-source Desktop test
at `813c285` showed that an unregistered `zcode-cycle:architect` dispatch
could still create a subagent. `1.0.2-rc.3` adds the observed host-native
`SubAgent` matcher and a regression assertion before recertification.

## [1.0.2-rc.1] - SUPERSEDED - NOT RELEASED

Do not install or reuse this candidate. The current ZCode Desktop did not
load its standard `hooks/hooks.json` from the GitHub-source installation.
`1.0.2-rc.2` introduced the explicit, nonstandard manifest hook path.

## [1.0.1] - SUPERSEDED - NOT RELEASED

Do not install or reuse this candidate. Multiple local certification bytes
were evaluated under its identity before the Desktop hook-cache behavior was
observed. `1.0.2-rc.4` uses a new semantic version for a clean host-integrated
certification; the eventual production release is `1.0.2`.

## [1.0.0] - 2026-08-21 - WITHDRAWN

Do not install this version.

- Installable content changed after the first publication without a version
  bump, including removal of a development-machine binary path.
- A clean Linux checkout stored the bundled daemon without its executable bit,
  so the MCP bridge could not start it.
- The public CI run was not green and its Windows smoke command failed under a
  non-blocking `continue-on-error` step.

The `v1.0.0` tag remains available only as audit history. It must not be moved,
rewritten or reused.
