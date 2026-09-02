# ZCode Cycle — User Manual

ZCode Cycle adds governed, evidence-gated software delivery to ZCode. A
`Cycle` orchestrator coordinates five independent roles — an architect,
an executor, a functional reviewer, a security reviewer and a final
arbiter — over a deterministic control plane. Work happens in isolated
git worktrees; candidates are frozen with digests; verification runs
real commands; the arbiter sees the original request, the exact
candidate and the raw evidence, never the executor's summary. Nothing is
declared done that the control plane did not verify.

## Installation

1. In ZCode: Settings → Plugin Management → Discover → `+` → add the
   repository `jannotix/zcode-cycle-plugin` as a marketplace (or a local
   directory clone of it).
2. Install `zcode-cycle`, open the project and run `/cycle:setup install`.
   This writes five managed profiles under `.zcode/agents` and refuses any
   unowned conflicting file.
3. Start a new session, then run `/cycle:setup`. On Windows, quit from the
   tray if a normal restart does not reload plugin or project profiles.

Requirements: ZCode Desktop with plugin support, a git repository for
the project you govern, and Node.js for the bundled bridge. The
`workflowd` control-plane binary ships with the plugin per platform.

## The roles

| Role | Boundaries |
|---|---|
| Architect | Read-only. Decomposes the exact request into a validated task graph. |
| Executor | Implements bounded tasks in the isolated worktree, commits its work. |
| Functional reviewer | Read-only. Completeness, behavior, tests, every user-visible path. |
| Security reviewer | Read-only. Security, trust boundaries, architecture. Blocking findings need a reproducible path. |
| Arbiter | Read-only. Final approval from the original request plus evidence plus reviews. The only role that can approve. |

Read-only roles physically lack edit and shell tools in the managed project
profiles. The PreToolUse hook enforces those identities again; an executor
cannot mutate without one unique active workflow registration. Every Cycle
role dispatch likewise requires a unique Cycle registration; raw direct role
launches are denied.

## Modes and routing

`/cycle:run auto` lets the deterministic router choose: small
well-understood changes take the quick route (verification and
arbitration); risk signals — authentication, cryptography, migrations,
dependencies, public interfaces, deployment, large refactors — take the
full route with both independent reviews. `quick` and `full` force a
route; a critical downgrade is refused without explicit approval. A normal
conversation in the main orchestrator session stays read-only until you arm a
run or express implementation intent.

## The governed flow

Intake and routing → architecture (the graph is validated by the daemon;
the orchestrator interrogates risks and ambiguities before submitting) →
isolated worktree from your current HEAD → execution with per-task
verification commands → candidate freeze (per-file digests) → mandatory
verification gates (your commands, secret scanning, candidate integrity,
and — for UI changes — managed-browser evidence) → full route only:
both reviews in parallel → arbitration → approved candidates are
promoted to your project directory. Failures drive a repair loop capped
at five cycles, then a recoverable blocked state.

Two operational rules keep promotion clean: the executor commits inside
the worktree (candidates are committed state), and you commit delivered
changes in your project between workflows (promotion is fast-forward
only — it applies onto the base revision it started from).

## Goal Mode

Persistent objectives above single workflows: immutable objective,
constraints, non-goals, success criteria, a versioned plan, milestones
linked to real workflows, bounded continuations. Completion is gated:
every milestone needs a COMPLETED workflow (cancelled does not count)
and the approval must cite the arbiter's receipt digest as evidence.
Manage goals with `/cycle:goal`.

## Managed browser QA

For UI-affecting changes the daemon adds mandatory browser gates,
satisfied only by an attested managed-browser session: isolated
temporary profile, loopback pages allowed by default, external origins
blocked until you explicitly approve them, actions and logs recorded as
a receipt bound to the candidate digest. Interactive actions are
executor-only. See the browser guide.

## Project memory and history

Every action lands in a tamper-evident ledger (hash chain plus signed
checkpoints): who, when, which tools, which files, which outcome.
`/cycle:history verify` proves integrity. `/cycle:memory` manages
durable project knowledge — every entry cites ledger events as
provenance; manual entries cannot claim verified confidence.

## Code intelligence

An incremental index (git-fingerprinted) feeds the architect
request-scoped context without rescanning unchanged files. Unchanged
repositories report `reused: true` with zero parsed files.

## Recovery

`/cycle:resume` reconciles paused, interrupted or blocked work — the
daemon's state is durable, so even a hard kill loses nothing.
`/cycle:doctor` diagnoses; `/cycle:pause` and `/cycle:cancel --confirm`
control live runs.

## Where data lives

Everything durable — control-plane database, ledger keys, worktrees,
browser evidence, role registry — lives under your user data directory
(`%LOCALAPPDATA%\ZCode Cycle` on Windows, `~/.local/share/zcode-cycle`
on Linux), never inside the ZCode installation or your repository. The five
non-secret role configuration files live in `.zcode/agents`; remove them with
`/cycle:setup remove` before uninstalling. Uninstalling preserves audit data.

## License

Copyright 2026 Gianluca Iannotta. FSL-1.1-MIT: every version becomes
MIT two years after its release. See `LICENSE` and `NOTICE`.
