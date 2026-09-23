// The host stops a tool call at the `timeoutMs` declared in .mcp.json. Every
// timeout the IPC client sets lives under that ceiling, so a client timeout
// larger than the host's is not a longer wait — it is dead code, and the host's
// generic failure arrives instead of the client's specific one.
//
// That is not hypothetical. Verification asked for twenty-four hours while
// .mcp.json allowed sixty seconds. A full-route run reported the verification
// as failed twice while the gates it had started ran to completion and passed;
// the orchestrator only recovered because it thought to read cycle_control
// status instead of believing the error. Any project whose test suite runs
// longer than a minute would have hit it.

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { IPC_TIMEOUTS } from "../dist/client.js"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")

test("no IPC timeout outlives the host's tool-call ceiling", async () => {
  const mcp = JSON.parse(await readFile(join(ROOT, ".mcp.json"), "utf8"))
  const ceiling = mcp.mcpServers?.["zcode-cycle"]?.timeoutMs
  assert.equal(typeof ceiling, "number", ".mcp.json must declare timeoutMs")

  for (const [name, value] of Object.entries(IPC_TIMEOUTS)) {
    assert.ok(
      value <= ceiling,
      `IPC timeout ${name} is ${value}ms but the host stops the call at ${ceiling}ms, ` +
        "so the wait it promises can never happen",
    )
  }
})

test("the shipped .mcp.json declares the same ceiling as the source", async () => {
  const source = await readFile(join(ROOT, ".mcp.json"), "utf8")
  const shipped = await readFile(join(ROOT, "plugin", ".mcp.json"), "utf8")
  assert.equal(shipped, source)
})

test("the ceiling is long enough for a real project's test suite", async () => {
  const mcp = JSON.parse(await readFile(join(ROOT, ".mcp.json"), "utf8"))
  const ceiling = mcp.mcpServers?.["zcode-cycle"]?.timeoutMs
  // Sixty seconds was the value that broke; a minute does not cover a test run.
  assert.ok(
    ceiling >= 10 * 60_000,
    `a ${ceiling}ms ceiling cannot cover verification, which runs the project's own tests`,
  )
})
