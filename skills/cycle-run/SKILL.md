---
name: cycle-run
description: Use when a workflow is armed or running - after /cycle:run, on explicit implementation intent, or to continue a governed delivery. Defines the exact orchestration procedure through the control plane tools: routing, architecture, isolated worktree, execution, candidate freeze, mandatory verification, independent reviews, arbitration, the five-cycle repair loop and promotion.
---

# Running a Governed Workflow

The daemon owns every transition and refuses out-of-order submissions. Your
job is to feed it exact inputs, dispatch roles, and relay outcomes. Never
fabricate a state the daemon did not return.

Throughout: `project_key` is this workspace's stable project key. Register
every role session with `cycle_role_register` before its dispatch and
`cycle_role_revoke` after it returns.

## 0. Capture and start

When armed (or on explicit implementation intent), take the user's request
message **verbatim** — the whole message, never your summary — and call
`cycle_start` with it. Record the returned `workflowId`, `mode` (quick or
full) and `requestDigest`. Report the route and the repair budget (five).

## 1. Architecture

1. `cycle_role_register` (role `architect`, workflow id).
2. `cycle_code_index` for the workflow; pass the paths and scopes summary
   to the architect as context.
3. Dispatch `zcode-cycle:architect` with the verbatim request and the code
   context. Collect its task-graph JSON. Protocol requirements the graph
   must satisfy: task `id` and `dependencies` are UUIDs; `write_scopes`
   are repository-relative; `verification_commands` are single commands
   (no `&&`, `||`, `;`, pipes or redirections; git, sh and powershell are
   blocked) runnable from the repository root.
4. `cycle_submit_architecture` with the graph. Rejected: send the daemon's
   reason back to the architect and repeat (at most five attempts; then
   `cycle_report_execution` `blocked` and stop).
5. `cycle_role_revoke` the architect.

## 2. Worktree

`cycle_prepare_worktree` — record the returned `path` and `baseRevision`.
All execution happens inside that path, never in the project directory.

## 3. Execution

1. `cycle_role_register` (role `executor`, workflow id).
2. Dispatch `zcode-cycle:executor` with the task graph, the worktree path
   and the base revision. The executor commits its work in the worktree
   (candidates freeze committed state). Collect per-task reports.
3. For each task, `cycle_audit` an `execution_task_<status>` observation
   with the changed paths.
4. Any task failed: send its report as repair feedback to the executor and
   repeat from step 2 (shared budget of five repair cycles, counted below).
   `PLAN_DEFECT`: `cycle_report_execution` `plan_defect`; if the daemon
   returns the workflow to architecture, go to phase 1 keeping the same
   workflow id.
5. `cycle_role_revoke` the executor.

## 4. Verification

1. `cycle_plan_verification` — record `planId` and `evidenceIds`.
2. Managed browser evidence (UI-affecting changes): the daemon discovers
   mandatory `browser:affected-user-flow` and
   `accessibility:affected-user-flow` gates, satisfied only by an
   attested session whose receipt contains the required operation
   subsequence. Run one executor session with `cycle_browser` in this
   order — `open` the page (loopback allowed by default), `check` the
   expected text, `screenshot`, `logs`, `snapshot` (accessibility),
   `close` — then pass `browser_session_ids` plus the frozen
   `candidate_digest` to verify. External origins require explicit user
   approval (`approve_origin`) after the tool reports
   `origin-approval-required`.
3. `cycle_freeze_candidate` with the base revision, plan id and evidence
   ids. Record `candidateId`, `candidateDigest` and the manifest.
4. `cycle_verify_candidate`. Record every gate's status.
5. Mandatory gates failed or skipped for lack of valid attestations: the
   evidence becomes repair feedback; the daemon drives the state back to
   execution — continue from phase 3 and count one repair cycle. Five
   failed repairs: the daemon blocks; report the blocked state and stop
   (recovery is `/cycle:resume`).

## 5. Reviews (full mode only)

1. Register both reviewers (`functional_reviewer`, `security_reviewer`).
2. Dispatch `zcode-cycle:functional-reviewer` and
   `zcode-cycle:security-reviewer` — both in the same turn, so they run in
   parallel — each with the verbatim original request, the plan, the
   candidate manifest and the verification evidence.
3. Collect both verdict JSONs and `cycle_submit_review` each. Revoke both
   registrations.

## 6. Arbitration

1. Register the arbiter.
2. Dispatch `zcode-cycle:arbiter` with the verbatim original request, the
   candidate manifest, the raw evidence records and both review verdicts.
3. `cycle_submit_arbitration` with its verdict JSON.
   - Approved: `cycle_promote_candidate` with the project directory, then
     report the delivered paths and the final state. Audit an
     `approved_candidate_delivered` observation. Done.
   - Rejected with `repair_target` `execution`: the verdict is repair
     feedback; continue from phase 3, one repair cycle.
   - Rejected with `repair_target` `architecture`: continue from phase 1,
     one repair cycle.
4. `cycle_role_revoke` the arbiter.

## Repair budget

Five repair cycles across the whole workflow (execution restarts and
architecture restarts share it). When the daemon reports blocked, say so
plainly: the work is preserved, `/cycle:resume` reconciles and continues.

## Reporting

Always: next action first line, current state (from the daemon, never
assumed), numbered steps, no filler. Never claim completion the daemon did
not report.
