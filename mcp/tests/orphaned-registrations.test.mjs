import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

// From the registry module rather than the server: importing server.js attaches
// to stdin and starts serving, so a test that imported it would hang instead of
// finishing. That is how this import was first written, and the whole suite
// stopped at the test before it.
import { orphanedRegistrationKeys } from "../dist/role-registry.js"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const SERVER = readFileSync(join(ROOT, "src", "server.ts"), "utf8")

// DEFECT-12, found by killing ZCode and workflowd during execution: a role
// registration is revoked by the session that made it, so a dead session leaves
// registrations with no owner. Every later dispatch is ambiguous, and recovery
// cannot use the sanctioned path - dispatch a role - to repair anything.
//
// The 1.0.3 fix shipped with tests that asserted the sweep existed and that
// recovery called it. Both were true, and the sweep still never ran: it sat
// after an await that rejects precisely when a session has been killed
// mid-run. These tests are written the other way round - what the selection
// does, and whether a rejecting daemon can skip it.

const lock = (workflowId) => ({
  kind: "workflow_lock",
  project_directory: "/p",
  project_key: "p",
  registered_at_unix_millis: 1,
  workflow_id: workflowId,
})

const role = (workflowId, name = "executor") => ({
  kind: "role",
  project_directory: "/p",
  project_key: "p",
  registered_at_unix_millis: 2,
  role: name,
  workflow_id: workflowId,
})

test("a named workflow's registrations are swept and its lock is not", () => {
  const registry = {
    "workflow:w1": lock("w1"),
    "token-a": role("w1", "executor"),
    "token-b": role("w1", "arbiter"),
    "token-c": role("w2", "executor"),
  }

  const keys = orphanedRegistrationKeys(registry, "w1")

  assert.deepEqual(keys.sort(), ["token-a", "token-b"])
  assert.ok(!keys.includes("workflow:w1"), "the lock holds the main session read-only; it is not orphaned")
  assert.ok(!keys.includes("token-c"), "another workflow's registration is not this sweep's business")
})

test("without a workflow id, registrations whose lock is gone are swept", () => {
  const registry = {
    "workflow:live": lock("live"),
    "token-live": role("live"),
    "token-dead": role("vanished"),
  }

  const keys = orphanedRegistrationKeys(registry)

  assert.deepEqual(keys, ["token-dead"])
  assert.ok(
    !keys.includes("token-live"),
    "a registration whose workflow still holds a lock has an owner and is not orphaned",
  )
})

/// A project-level recovery used to be skipped entirely, which left the caller
/// with nothing to do but revoke by hand — which is what the live run did.
test("a project-level sweep is not a no-op", () => {
  const registry = { "token-dead": role("vanished") }
  assert.deepEqual(orphanedRegistrationKeys(registry), ["token-dead"])
})

test("a registration naming no workflow is left alone", () => {
  const registry = { "token-null": role(null) }
  assert.deepEqual(
    orphanedRegistrationKeys(registry),
    [],
    "there is no lock whose absence would make it orphaned, so there is no evidence to act on",
  )
})

// The one property that cannot be reached through the pure function: that a
// rejecting daemon call cannot skip the sweep. This is a shape assertion and is
// labelled as one, but it is the shape that actually broke.
test("the sweep cannot be skipped by a daemon that refuses recovery", () => {
  const body = /case "cycle_control":[\s\S]*?case "cycle_audit":/u.exec(SERVER)?.[0] ?? ""
  assert.ok(body.length > 0, "cycle_control case not found")
  assert.match(
    body,
    /\}\s*finally\s*\{[\s\S]*?revokeOrphanedRoleRegistrations/u,
    "the sweep must run in a finally: recovery refuses exactly when a session was killed mid-run, so anywhere a rejection can skip is the wrong place",
  )
})

test("a terminal workflow still releases both, as it did before", () => {
  const body = /async function unlockWorkflow[\s\S]*?\n\}/u.exec(SERVER)?.[0] ?? ""
  assert.match(body, /delete registry\[workflowLockKey\(workflowId\)\]/u)
  assert.match(body, /isRoleRegistration\(value\) && value\.workflow_id === workflowId/u)
})
