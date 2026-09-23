import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { LocalControlPlane, daemonsServing, stopDaemonsServing } from "../dist/client.js"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const BINARY =
  process.env.CYCLE_TEST_BINARY ??
  join(ROOT, "plugin", "bin", process.platform === "win32" ? "win32-x64" : "linux-x64",
    process.platform === "win32" ? "workflowd.exe" : "workflowd")

// The 1.0.10 live campaign: after upgrading from 1.0.9, the 1.0.9 daemon a
// previous ZCode session had started was still running. The new bridge asked
// it for health, got "workflowd 1.0.9 is incompatible with plugin 1.0.10", and
// tried to reclaim it through runtime/workflowd.pid - a file nothing has ever
// written. The old daemon lived on holding the data directory, every new one
// failed to start, and after fifteen seconds the user got "did not become
// healthy". Every upgrade would have ended there.

/** A detached daemon for `dataDirectory`, started by a bridge exactly as ZCode's would be. */
async function runningDaemon(dataDirectory) {
  const plane = new LocalControlPlane({ binaryPath: BINARY, dataDirectory })
  const health = await plane.health()
  const pids = daemonsServing(dataDirectory)
  assert.equal(pids.length, 1, `expected one daemon, found ${pids.join(", ")}`)
  return { pid: pids[0], version: health.product_version }
}

/** Stops the daemons a test started and removes each directory once they have let go of it. */
async function cleanUp(...directories) {
  for (const directory of directories) {
    stopDaemonsServing(directory)
    for (let attempt = 0; attempt < 100 && daemonsServing(directory).length > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await rm(directory, { force: true, maxRetries: 20, recursive: true, retryDelay: 100 })
  }
}

const gone = async (pid) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

test("a bridge newer than the running daemon stops it instead of timing out", { skip: !existsSync(BINARY) }, async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "zcode-cycle-stale-daemon-"))
  try {
    const { pid } = await runningDaemon(dataDirectory)

    // Stand in for the upgraded plugin: it expects a version above the daemon's.
    const upgraded = new LocalControlPlane({
      binaryPath: BINARY,
      dataDirectory,
      expectedProductVersion: "999.0.0",
      stopOwnedProcessOnDispose: true,
    })
    await assert.rejects(upgraded.health(), /incompatible with plugin 999\.0\.0/u)
    assert.equal(await gone(pid), true, "the older daemon must have been stopped")
    await upgraded.dispose()
  } finally {
    await cleanUp(dataDirectory)
  }
})

test("a bridge older than the running daemon leaves it alone and says why", { skip: !existsSync(BINARY) }, async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "zcode-cycle-newer-daemon-"))
  try {
    const { pid } = await runningDaemon(dataDirectory)
    const older = new LocalControlPlane({ binaryPath: BINARY, dataDirectory, expectedProductVersion: "0.0.1" })
    await assert.rejects(older.health(), /newer than this plugin/u)
    assert.deepEqual(daemonsServing(dataDirectory), [pid], "a newer daemon must not be stopped")
  } finally {
    await cleanUp(dataDirectory)
  }
})

test("only a daemon serving exactly this data directory is matched", { skip: !existsSync(BINARY) }, async () => {
  const one = await mkdtemp(join(tmpdir(), "zcode-cycle-serving-a-"))
  const two = await mkdtemp(join(tmpdir(), "zcode-cycle-serving-b-"))
  try {
    const { pid } = await runningDaemon(one)
    assert.deepEqual(daemonsServing(two), [])
    assert.deepEqual(daemonsServing(`${one}-suffix`), [])
    assert.deepEqual(daemonsServing(one), [pid])
  } finally {
    await cleanUp(one, two)
  }
})
