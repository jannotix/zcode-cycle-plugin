import assert from "node:assert/strict"
import test from "node:test"

import { accessibilitySummary } from "../dist/browser-runtime.js"

// The accessibility gate used to pass on the snapshot operation having happened.
// What it judges now is this summary, so this is where the judgement is decided:
// a control a person operates and cannot have announced is the thing to catch.

const tree = (...children) => ({ role: "WebArea", name: "page", children })

test("a fully named interface reports nothing missing", () => {
  const summary = accessibilitySummary(
    tree(
      { role: "textbox", name: "Tags" },
      { role: "button", name: "Parse" },
      { role: "link", name: "Help" },
    ),
  )

  assert.equal(summary.interactive, 3)
  assert.equal(summary.unnamed, 0)
  assert.deepEqual(summary.unnamedRoles, [])
})

test("interactive elements without an accessible name are counted and named by role", () => {
  const summary = accessibilitySummary(
    tree(
      { role: "textbox", name: "" },
      { role: "button", name: "   " },
      { role: "button", name: "Parse" },
    ),
  )

  assert.equal(summary.interactive, 3)
  assert.equal(summary.unnamed, 2)
  assert.deepEqual(summary.unnamedRoles, ["button", "textbox"])
})

test("nesting is walked, because controls are rarely at the top level", () => {
  const summary = accessibilitySummary(
    tree({
      role: "form",
      name: "Filters",
      children: [{ role: "group", children: [{ role: "checkbox", name: "" }] }],
    }),
  )

  assert.equal(summary.interactive, 1)
  assert.equal(summary.unnamed, 1)
})

test("non-interactive nodes are not counted, named or not", () => {
  const summary = accessibilitySummary(
    tree({ role: "heading", name: "" }, { role: "paragraph", name: "" }),
  )

  assert.equal(summary.interactive, 0)
  assert.equal(summary.unnamed, 0)
})

test("an empty or malformed tree yields zero rather than throwing", () => {
  for (const value of [null, undefined, {}, "not a tree", 42]) {
    const summary = accessibilitySummary(value)
    assert.equal(summary.interactive, 0)
    assert.equal(summary.unnamed, 0)
  }
})
