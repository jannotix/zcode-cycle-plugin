import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { productVersion } from "../dist/version.js"

test("the MCP server version comes from the installable ZCode manifest", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
  const product = JSON.parse(await readFile(join(root, ".zcode-plugin", "plugin.json"), "utf8"))
  assert.equal(productVersion(), product.version)
})
