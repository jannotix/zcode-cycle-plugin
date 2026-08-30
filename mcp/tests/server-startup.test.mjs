import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { createInterface } from "node:readline"
import test from "node:test"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

test("the MCP handshake stays lightweight and browser code loads on demand", async () => {
  const serverPath = join(ROOT, "dist", "server.js")
  const browserPath = join(ROOT, "dist", "browser-runtime.js")
  assert.ok((await stat(serverPath)).size < 300_000, "server entrypoint eagerly bundles browser runtime")
  assert.ok((await stat(browserPath)).size > 500_000, "browser runtime entrypoint is unexpectedly empty")

  const child = spawn(process.execPath, [serverPath], {
    cwd: ROOT,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  const lines = createInterface({ input: child.stdout })
  const started = Date.now()
  child.stdin.write(`${JSON.stringify({ id: 1, jsonrpc: "2.0", method: "initialize", params: {} })}\n`)
  const response = await Promise.race([
    once(lines, "line").then(([line]) => JSON.parse(line)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("MCP initialize timed out")), 5_000)),
  ])
  assert.equal(response.result.serverInfo.name, "zcode-cycle")
  assert.ok(Date.now() - started < 5_000)
  child.stdin.end()
  await once(child, "exit")
})
