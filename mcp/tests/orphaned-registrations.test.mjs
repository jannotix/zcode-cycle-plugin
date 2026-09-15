import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const SERVER = readFileSync(join(ROOT, "src", "server.ts"), "utf8")

// DEFECT-12, found by killing ZCode and workflowd during execution: a role
// registration is revoked by the session that made it, so a dead session leaves
// registrations with no owner. Every later dispatch is ambiguous, and recovery
// cannot use the sanctioned path - dispatch a role - to repair anything. The
// operator sees "worktree recovery state is inconsistent", several steps
// downstream of the cause.
//
// These assert the shape of the fix rather than its behaviour, because the
// behaviour needs a live daemon. A live run is what found the defect; this is
// what stops it coming back silently.

test("recovery sweeps role registrations orphaned by a dead session", () => {
  assert.match(
    SERVER,
    /async function revokeOrphanedRoleRegistrations\(workflowId: string\)/u,
    "the sweep must exist as its own operation",
  )
  assert.match(
    SERVER,
    /args\.operation === "recovery"[\s\S]{0,120}revokeOrphanedRoleRegistrations\(workflowId\)/u,
    "recovery must call the sweep: it is the operation that declares the previous session dead",
  )
})

test("the sweep keeps the workflow lock, which is a different thing", () => {
  const body = /async function revokeOrphanedRoleRegistrations[\s\S]*?\n\}/u.exec(SERVER)?.[0] ?? ""
  assert.ok(body.length > 0, "sweep body not found")
  assert.doesNotMatch(
    body,
    /workflowLockKey/u,
    "the lock keeps the main session read-only while the workflow is non-terminal; only the registrations are orphaned",
  )
  assert.match(body, /isRoleRegistration\(value\) && value\.workflow_id === workflowId/u)
})

test("a terminal workflow still releases both, as it did before", () => {
  const body = /async function unlockWorkflow[\s\S]*?\n\}/u.exec(SERVER)?.[0] ?? ""
  assert.match(body, /delete registry\[workflowLockKey\(workflowId\)\]/u)
  assert.match(body, /isRoleRegistration\(value\) && value\.workflow_id === workflowId/u)
})
