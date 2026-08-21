# Threat Model

ZCode Cycle moves trust from agent narration to a deterministic control
plane. This document states what it defends, what it assumes, and what
remains out of scope.

## Assets

- The integrity of the delivery record: ledger, checkpoints, evidence,
  candidate manifests.
- The user's repository and data directory contents.
- The isolation boundaries between roles and between the plugin and the
  host application.

## Trust boundaries

1. **Plugin ↔ host application.** The plugin registers agents, commands,
   hooks and one MCP server through the host's extension surface. It
   never patches the application installation and stores nothing inside
   it; application updates cannot destroy project data.
2. **Bridge ↔ control plane.** The MCP bridge and hooks speak framed IPC
   to `workflowd` over a named pipe (Windows) or unix socket (Linux),
   authenticated with a local HMAC challenge-response bound to a
   per-installation secret in the data directory. Only local processes
   that can read the runtime secret connect.
3. **Roles.** Read-only roles lack edit and shell tools at the agent
   definition level; a PreToolUse hook re-checks and audits every
   governed session's tool use into the ledger. Interactive browser
   actions are executor-only. No dispatched role can launch a workflow;
   arbitration is only accepted by the daemon in the arbitration state
   for the exact frozen candidate digest.
4. **Browser.** Isolated profile per session; loopback only by default;
   external origins blocked (including background requests) until
   explicit user approval; uploads confined to the project directory;
   filled values redacted from all evidence.

## Integrity guarantees

- Ledger entries form a hash chain with signed checkpoints
  (`/cycle:history verify`); tampering is detectable.
- Candidates are frozen with per-file, diff, configuration, dependency
  and environment digests; verification always runs against the frozen
  manifest; verdicts must bind to the candidate digest and cite real
  evidence ids the daemon knows.
- Verification commands are single invocations, shell-metacharacter
  free, with blocked programs (git, sh, powershell, cmd and friends) and
  destructive verbs; secret scanning runs over changed content; manual
  memories cannot claim verified confidence and must cite ledger events.
- Promotion is fast-forward only onto the recorded base revision.

## Assumptions

- The user's machine and the ZCode application are trusted; a
  compromised host can read the IPC secret and the data directory, and
  no local-only design defends against that.
- The host application enforces the tool allowlists agents declare.
- The git repository is the source of base-revision truth.

## Out of scope

- Multi-user or remote attestation; everything here is single-machine.
- Protecting the user from code the executor legitimately wrote and the
  gates legitimately passed — the gates prove what was verified, not
  that the software is free of every defect.
