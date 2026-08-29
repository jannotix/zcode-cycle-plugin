import assert from "node:assert/strict"
import test from "node:test"

import { productVersion } from "../dist/version.js"

test("the MCP server version comes from the installable ZCode manifest", () => {
  assert.equal(productVersion(), "1.0.1")
})
