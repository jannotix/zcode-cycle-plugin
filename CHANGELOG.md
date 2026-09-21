# Changelog

All notable changes to Cycle for Zcode are recorded here. Installed plugin
content is immutable: a published version is never reused for different bytes.

## [1.0.9] - Unreleased

### The threat model said the host ignores plugin agent components. It does not.

`1.0.8` shipped a trust boundary conditioned on ZCode CLI `0.16.9` not executing
plugin-provided agent components, and promised to re-establish that premise by
observation before any receipt asserted it. The observation was made, on Desktop
`3.14.1.7714` / CLI `0.16.9`, and it **refuted** the premise.

The host reads the `agents/` directory this archive ships — by convention, with
the manifest declaring no `agents` key — and lists all five roles under
Settings → Subagents as dispatchable, with their `tools:` lists parsed and a
model and reasoning level of the host's own, persisted per agent. Assume the
roles are reachable from any session, not only from a governed run.

This is a documentation defect, not a hole. The definitions the host reads *are*
the managed role profiles, carrying the same bounded tool lists, and the host's
built-in `general-purpose` subagent already holds every tool — so exposing
Cycle's roles adds nothing a session could not already do. What was wrong was the
stated reason for writing project profiles. The real reason is narrower and was
already recorded in the plugin's own hooks configuration: a dispatched role is
bounded by the tool list in its profile, because the host does not run
`PreToolUse` inside a dispatched agent. Hooks guard the main session; the profile
guards the role.

The marketplace contract asserted the same falsehood as the rationale for keeping
`agents` out of the manifest. Keeping it out is still right — declaring it would
add a second, divergent source for the same definitions — but the assertion now
says so instead.

### Noted, not yet acted on

The host assigns a model and reasoning level per plugin agent natively, writing
`providerId: account:zai-individual-coding-plan` into `agents-state.json`. That
is the exact namespace `/cycle:models` rejected, which is why every pin accepted
in `1.0.6` died at dispatch with `provider-not-found`. Whether the plugin's own
per-role machinery can be replaced by the host's depends on which definition wins
when both exist — the plugin agent or the project profile — and that is measured
by a governed run, not by reading either.

## [1.0.8] - Published, superseded by 1.0.9

No product change. `1.0.8` exists because the certification host moved while the
`1.0.7` campaign was being set up, and one of the numbers it moved is one the
plugin ships.

ZCode Desktop went from `3.12.3.7463` to `3.14.0.7681` — the update had already
been downloaded and was waiting for a restart, and three of the thirteen live
scenarios require one, so the campaign could never have finished on the build it
started on. With that update the bundled ZCode CLI moved from `0.16.5` to
`0.16.9`, the first time it has moved across four Desktop builds.

That second number is not bookkeeping. The shipped threat model states a trust
boundary conditioned on it — that the host does not execute plugin-provided agent
components, which is why `/cycle:setup install` writes five managed profiles
explicitly rather than relying on the host to discover them. `1.0.7` was already
published naming `0.16.5`, so its archive described a host configuration that no
longer exists, and its receipt would have been rejected by the release lane's own
verifier, which asserts the CLI version a campaign ran on.

So `1.0.8` carries the same seven fixes as `1.0.7` and names the host that will
actually certify them. The trust-boundary premise was to be re-established by
observation on `0.16.9` before any receipt asserted it. It was — and the
observation refuted it; see `1.0.9`.

Everything below this line is the `1.0.7` change set, unchanged.

## [1.0.7] - Published, superseded by 1.0.8 before certification

Seven defects closed. Six of them were found by taking `1.0.6`'s **published**
archive — downloaded with `gh release download`, checksum-verified and checked
against its build provenance attestation — and running the thirteen-scenario
live campaign against those exact bytes on Windows and in WSL. Eleven scenarios
passed. The two that failed are the first two below. The seventh was found while
assembling this release, and is the last one.

### Per-role model assignment was configurable but not usable

`/cycle:models` accepted exactly three model references, all under the
`custom:builtin:zai-coding-plan:` prefix, and reported them as applied with no
warning. All three failed at dispatch with `provider-not-found` — on the provider
**prefix**, not the model name — because the host resolves providers under
`account:zai-individual-coding-plan`, a namespace the plugin refused to accept.
The only setting that worked was `inherit`, which is the absence of the feature
the product is named for. The failure surfaced only at the review phase, after an
architecture, an execution and five verification gates had been paid for.

A plugin cannot enumerate a host's providers and has no business deciding which
ones exist. Cycle now validates the **shape** of a model reference and leaves the
rest to ZCode. What it owes the operator instead is an early answer: a pinned
role is reported as `dispatch_unverified`, and the run protocol probes every
pinned role before a workflow starts, so an unresolvable provider costs seconds.

Every receipt written by `1.0.6` and earlier therefore records a run in which
architect, executor, both reviewers and the arbiter shared one model — independent
prompts and tool lists, one judgement. Those receipts do not imply the wider claim.

### An abrupt stop could leave a workflow unrecoverable, and the project locked

Recovery required a worktree to exist on disk **if and only if** a base revision
was recorded. A session killed between those two writes broke the invariant, and
recovery refused outright with `workflow worktree recovery state is inconsistent`.

Refusing was wrong twice over. Recovery only reads — the guards that matter live
on `prepare_worktree` and `freeze`, and they still hold. And the refusal returned
before the immutable request text was assembled, so the one thing an interrupted
operator cannot reconstruct was withheld exactly when it was needed. Meanwhile the
mutation lock kept the project read-only, including for an unrelated delivery that
was already sitting uncommitted.

Recovery now names the inconsistency — `worktreeState` is `orphaned_worktree` or
`missing_worktree` — returns a `recoveryAction`, and hands back the original
request with everything else it knows.

### One project directory could carry two identities

`project_key` was whatever the calling agent chose to pass, and the run protocol
only described it as "this workspace's stable project key". It was neither. Across
a client restart the same folder was addressed two different ways, producing two
project ids: history, goals and evidence recorded under one are invisible to the
other, a goal linked under one can never be satisfied by a workflow recorded under
the other, and nothing warned.

The bridge already knows which directory it serves, so it now derives the key
itself and ignores the caller's. A caller cannot drift from a value it does not
choose. Projects certified before `1.0.7` keep whatever history was written under
their previous key; the ledger retains it.

### `/cycle:setup install` deadlocked the first governed run

Install writes five role profiles into the project. In a git project that leaves
the tree dirty, and the freeze guard refuses a candidate whose project changed
underneath it. Committing them trades that refusal for another: the freeze also
requires the project to sit at the workflow's start revision, which the commit
just moved. Both exits the first error offered were closed by the second.

Install and repair now add `.zcode/` to `.git/info/exclude` — git's per-clone
ignore list, never committed and never shared. A project that is not a git
repository still installs, and is told why a cycle would refuse to freeze.

### Risk routing was blind to the code a change touches

Only the request text could raise a critical category, and only by literal
marker. "Harden parseToken in auth.js", with `auth.js` declared as an affected
path, routed to `quick` — no independent reviews. The same change described as
"harden the **authentication** token parser" routed to `full`.

Paths now raise Authentication, Authorization, Cryptography, Secrets and
TrustBoundary on their own, matched as whole path tokens so `auth.js` counts and
`authors.ts` does not. Documentation takes precedence: prose cannot introduce an
authentication flaw, so a `.md` file is never routed through two independent
reviews on the strength of its name.

### The uninstall documentation named the wrong directory

The README said ZCode keeps its marketplace's *cached* copy after an uninstall.
The cached copy is removed completely — that directory is emptied. What remains
is ZCode's **mirror** of the marketplace source under
`plugins/marketplaces/<marketplace>/`, and it is larger than the installation was
because it carries every platform's daemon rather than only yours. Someone
following the old wording would check the plugin cache, find it empty, and
conclude the removal was complete.

### The daemon version gate passed the daemons it exists to reject

Assembling this release copied the **1.0.5** daemons into the plugin and wrote a
manifest declaring them `1.0.7`. They had been sitting in the untracked `bin/`
staging directory since the 1.0.5 release — nothing clears it — and the gate that
compares a staged daemon against the plugin manifest reported no problem.

That gate had already failed once on these same two files. It used to scan the
executable for the expected version as a substring, and in a 39 MB binary the
sequence turns up by accident, so the 1.0.5 Linux daemon was read as declaring
`1.0.6`. It was rewritten to execute `workflowd --version` instead. But
`--version` was *added* in `1.0.6`, so the one daemon that cannot answer is one
older than the release that introduced the flag — precisely the case the gate is
for — and the failure to answer was recorded as `verified: false`, the same value
used for a daemon built for another platform, which is a legitimate skip. Both
callers blocked only on a daemon that answered *and* answered wrong. The daemon
that would not speak walked past both.

What ships is not affected: the release workflow builds both daemons from source
on their own platforms before assembling, so the published `1.0.6` archive
carries genuine `1.0.6` binaries. The defect was in what a local assembly stages
and in what the merge gate would have allowed into the repository — and since
`native-manifest.json` takes `product_version` from the plugin manifest rather
than from the binary, the result carries an honest digest beside a version
nobody read.

A result now records whether this machine could execute the file at all.
Runnable-and-silent is a failure; not-runnable-here is a skip, left to the CI job
that can run it. Assembly additionally refuses when a staged daemon is missing
outright, because that copy used to throw *after* the previous plugin directory
had been removed.

## [1.0.6] - Published, superseded by 1.0.7

Eleven of the thirteen live scenarios passed on Windows, and the Linux lane
passed. The two failures and four further defects are closed in `1.0.7`.

`1.0.5` was sealed and carried through the full thirteen-scenario live campaign
a second time. Ten scenarios passed, one was partial and two failed. Two of the
four defects it closed stayed closed; four new ones were found, and three of
those are the same habit again — a record that is kept faithfully while the
thing it records has already been decided elsewhere.

### Fixed

- A per-role model pin is no longer lost in silence. The pin lived only in the
  profile's `model:` line, which is both the request and the resolution of that
  request, so anything that rewrote the profile from its template erased the
  request without trace: the arbiter was pinned through the supported path, read
  back from disk, and was running on `inherit` four minutes later with the ledger
  faithfully recording it. The request is now kept apart from its resolution,
  outside the project tree, and the two are compared on every call. A profile
  rewritten from its own template is structurally perfect, which is why a repair
  keyed on damage could never put the pin back; a pin missing from the file it
  was set on is now itself the thing to repair, and a role about to be dispatched
  on a model other than the one asked for is named before it runs.
- A gate the control plane ran and a gate a session merely asserted are no
  longer identical in the record. Both serialised to
  `{"type":"verification","gate":"…","status":"passed"}` byte for byte, and the
  only signals separating them — a free-text actor id, and whether an evidence
  row happened to exist — sat outside the gate entry. A claimed outcome now
  carries `declared`, which only the caller-facing path can set and always does.
  Entries written before this field keep their exact bytes and read as what they
  were.
- A repaired candidate can be verified again. Evidence ids come from the
  verification plan and a repair reuses that plan, while evidence was keyed on
  the evidence id alone — so the refrozen candidate arrived carrying the failed
  candidate's ids and every gate was refused as "already recorded with a
  different identity". A gate result belongs to the candidate it was run
  against, so that is what it is keyed on now, and both candidates keep their
  rows: the failed run stays in the record rather than being overwritten by the
  run that fixed it.
- `CI=1` is no longer accepted as a program name. The `1.0.5` fix enumerated
  what a program may not contain, and an environment assignment is one word,
  carries no metacharacter and is on no denylist — yet it is something a shell
  would have consumed, and the daemon has no shell. A program is now stated
  positively: a command name, or a path whose final component is one.

### Fixed in the release lane

- The gate that compares a tracked daemon against the plugin manifest now asks
  the daemon instead of searching it. It scanned the executable for the expected
  version as a substring, and in a 39 MB binary that sequence occurs on its own:
  a 1.0.5 Linux daemon was reported as declaring 1.0.6 and passed the gate whose
  one job is to stop an installation that cannot start. `workflowd --version`
  answers without a data directory or an IPC handshake. A daemon built for
  another platform cannot be asked on this one, so it is reported as unverified
  rather than waved through, and each CI job names with `--require` the daemon it
  must have actually executed.
- The tracked Linux daemon carries its executable bit again. It had regressed to
  `100644`, in 1.0.5 as well. **This was not user-visible**: the control plane
  never runs the daemon from the plugin tree — it copies it into the data
  directory at `runtime/native/<target>/<digest>/` with mode `0700` and runs it
  from there, so neither a checkout nor the sealed archive depends on the bit.
  What it actually broke was the new gate above, which runs the binary in place
  to ask its version. The same missing bit *was* user-visible before that
  staging existed, and is recorded under `1.0.1` for that reason.

### Recorded as a ZCode limitation

- Uninstalling still leaves the marketplace's cached copy of the plugin —
  roughly 76 MB including a native daemon per platform — in your ZCode profile.
  This is host behaviour: the cache and its registry belong to ZCode, and a
  plugin reaching into them to erase entries would be a worse fault than the
  disk space it recovers. ZCode's confirmation dialog compounds it by promising
  to remove "the plugin's cached files" and then not removing those. The
  retained copy is inert, and the README now carries a **Known ZCode
  limitations** section saying so plainly, with the way to reclaim the space.
  Recorded as a limitation of the host rather than closed as a defect of Cycle.

## [1.0.5] - Superseded by 1.0.6

Status: **blocked until every Windows/Linux certification gate passes against
the same immutable plugin archive**.

`1.0.4` was sealed and carried through the full thirteen-scenario live campaign.
Nine scenarios passed, two were partial and two failed, and the campaign found
eight defects. Seven of them are one habit: a mechanism that is present, is
wired, and in the case it exists for does not decide.

### Fixed

- One workspace now has one audit identity. The project key is a caller-supplied
  argument and nothing tied it to the directory, so two sessions on the same
  workspace chose different keys and the ledger split across two project ids. A
  status call reported "project has no workflow" while a workflow was running
  under the other one. Indexing now refuses a directory already bound to a
  different identity.
- An arbiter's approval can no longer stand against an explicit constraint of the
  immutable original request. The stored request said "do not modify any test
  file"; the approved candidate's file list named one. Where a prohibition is
  plain enough to decide by comparing paths, the approval is refused and the work
  goes back to the executor. Anything less explicit stays a matter of judgement,
  and silence from the check is never an approval.
- A mandatory gate that cannot start now fails instead of stalling. An entire
  shell expression sat in a gate's `program` field with no arguments, so the
  metacharacter check — which reads the arguments — never looked at it; the
  daemon spawns the program directly, and the workflow sat in verification for
  two and a half hours producing no pass, no fail and no block. A program name is
  one word, and a spawn failure is now the gate's answer rather than the run's.
- The browser and accessibility gates follow the files, not the wording. They
  attached from the architect's phrasing of the write scope, so declaring
  `public` rather than `public/index.html` removed both and an interface with two
  unnamed interactive controls was promoted. A directory scope is now expanded to
  the files under it before the question is asked.
- Goal completion resolves the evidence it is given. Sixty-four zeros satisfied
  "independent arbiter evidence" and completed a goal; the check only tested that
  the field was present and well-formed. The cited digest is now matched against
  the arbitration receipts recorded for that goal's own linked workflows.
- A goal-to-workflow link made in error can be corrected. Linking was one-way
  with no unlink, so a milestone kept asserting a tie to abandoned work for ever.
  A terminal goal's links still stand: at that point the record is the claim.

### Documentation

- The README claimed the ledger records "which model ran". It records the model
  each role's profile pins, read from that profile when the event is written.
  Cycle cannot observe ZCode's dispatch, so the record attests the assignment,
  not the inference. The models guide says so too.
- Uninstalling leaves the marketplace's cached copy of the plugin — roughly
  76 MB, including the native daemon for each supported platform — and ZCode's
  confirmation dialog does not mention it. The README now says what is kept,
  where, that it is inert, and how to reclaim the space.

## [1.0.4] - Unreleased, superseded by 1.0.5

Status: **superseded**. Sealed and fully certified live: 9 passed, 2 partial,
2 failed. Never published.

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
