import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const LIFECYCLE = readFileSync(join(ROOT, "crates", "workflowd", "src", "lifecycle.rs"), "utf8")

// DEFECT-11. Promotion is the one step that changes the user's project, and it
// was the one step the control plane did not record. The delivery event was
// written by the orchestrating session as a voluntary observation, so whether a
// delivery appeared in the audit chain depended on a narrator remembering.
//
// Across the live certification the same sealed bytes produced a delivery event
// in some runs and none in others. A hash-chained ledger is worth what it
// contains always, not what it contains usually.

test("the control plane records the delivery itself", () => {
  const promote = /ClientMessage::PromoteCandidate[\s\S]*?ClientMessage::(?!PromoteCandidate)/u.exec(LIFECYCLE)?.[0] ?? ""
  assert.ok(promote.length > 0, "promotion handler not found")
  assert.match(
    promote,
    /crate::audit::record\(/u,
    "promotion must append to the ledger, not rely on the session to narrate it",
  )
  assert.match(
    promote,
    /action: "approved_candidate_delivered"\.to_owned\(\)/u,
    "the recorded action must be the delivery",
  )
  assert.match(
    promote,
    /actor_id: "workflowd"\.to_owned\(\)/u,
    "the component that delivered must be the actor; a self-declared session id proves nothing",
  )
})

test("the delivery record carries what an auditor needs to check it", () => {
  const promote = /ClientMessage::PromoteCandidate[\s\S]*?ClientMessage::(?!PromoteCandidate)/u.exec(LIFECYCLE)?.[0] ?? ""
  for (const field of ["candidate_digest", "delivery_journal_digest", "workflow_state"]) {
    assert.match(promote, new RegExp(`"${field}"\\.to_owned\\(\\)`, "u"), `delivery metadata must carry ${field}`)
  }
  assert.match(promote, /files: changed_paths\.iter\(\)\.cloned\(\)\.collect\(\)/u, "the promoted paths must be recorded")
})
