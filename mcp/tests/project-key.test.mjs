import assert from "node:assert/strict"
import { isAbsolute, resolve } from "node:path"
import test from "node:test"

import { canonicalProjectKey } from "../dist/project-key.js"

/**
 * The 1.0.6 certification found one directory carrying two project identities:
 * the calling agent passed a different `project_key` after a client restart, and
 * the store recorded the work under two ids with no warning. The key must come
 * from the directory, so a caller cannot drift from it.
 */
test("one directory yields one key, whatever spelling it is given", () => {
  const direct = canonicalProjectKey(resolve("."))
  const viaDot = canonicalProjectKey(resolve(".", "."))
  const viaParent = canonicalProjectKey(resolve(".", "sub", ".."))
  assert.equal(direct, viaDot)
  assert.equal(direct, viaParent)
})

test("the key is always absolute", () => {
  assert.equal(isAbsolute(canonicalProjectKey("relative/path")), true)
})

test("a trailing separator does not make a second identity", () => {
  const base = resolve("fixture")
  assert.equal(canonicalProjectKey(base), canonicalProjectKey(`${base}${process.platform === "win32" ? "\\" : "/"}`))
})

test("it falls back to the served directory when none is given", () => {
  const previous = process.env.ZCODE_PROJECT_DIR
  try {
    process.env.ZCODE_PROJECT_DIR = resolve("some", "project")
    assert.equal(canonicalProjectKey(), canonicalProjectKey(resolve("some", "project")))
  } finally {
    if (previous === undefined) delete process.env.ZCODE_PROJECT_DIR
    else process.env.ZCODE_PROJECT_DIR = previous
  }
})

test("on Windows a drive letter's case does not make a second identity", { skip: process.platform !== "win32" }, () => {
  assert.equal(canonicalProjectKey("c:\\Users\\example\\project"), "C:\\Users\\example\\project")
  assert.equal(
    canonicalProjectKey("c:\\Users\\example\\project"),
    canonicalProjectKey("C:\\Users\\example\\project"),
  )
})
