import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { checkNativeVersions } from "../../scripts/release/check-native-version.mjs"

// DEFECT-26. The gate that compares a tracked daemon against the plugin
// manifest has now let the same two binaries through twice.
//
// It first scanned the executable for the expected version as a substring, and
// in a 39 MB binary "1.0.6" turns up on its own, so the 1.0.5 linux daemon was
// reported as declaring 1.0.6. Rewritten to execute `workflowd --version`, it
// failed again for the opposite reason: `--version` was added in 1.0.6, so a
// daemon older than that cannot answer at all, and the catch arm recorded the
// refusal as `verified: false` - the same value used for a binary built for
// another platform, which is a legitimate skip. Both callers blocked only on
// `verified && declared !== expected`, so the daemon that could not speak was
// the one that walked past.
//
// `assemble-plugin.ts` then copies staging into the plugin and stamps
// `product_version` from the manifest rather than from the binary, so what
// ships carries an honest digest and a version nobody ever read.
//
// The distinction that closes it is `runnable`: this machine could execute the
// file and it still would not answer, which is a failure, as against this
// machine could never execute it, which is not.

async function stagingRoot(files) {
  const root = await mkdtemp(join(tmpdir(), "native-gate-"))
  await mkdir(join(root, ".zcode-plugin"), { recursive: true })
  await writeFile(
    join(root, ".zcode-plugin", "plugin.json"),
    JSON.stringify({ version: "9.9.9" }),
  )
  await mkdir(join(root, "bin"), { recursive: true })
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(root, "bin", name), contents)
  }
  return root
}

test("a daemon that runs here and will not answer is a failure, not a skip", async () => {
  // Not a real executable, so launching it fails the way a pre-1.0.6 daemon
  // fails: the file is there, this platform would run it, no version comes back.
  const root = await stagingRoot({ "workflowd.exe": "not a portable executable" })
  try {
    const { results } = await checkNativeVersions(root, ["bin/workflowd.exe"], "win32")
    assert.equal(results.length, 1)
    const [result] = results
    assert.equal(result.verified, false)
    assert.equal(
      result.runnable,
      true,
      "a binary this platform can launch must not be filed under the same flag as one it cannot",
    )
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("a daemon built for another platform stays a skip", async () => {
  const root = await stagingRoot({ workflowd: "an elf binary, on a windows host" })
  try {
    const { results } = await checkNativeVersions(root, ["bin/workflowd"], "win32")
    assert.equal(results.length, 1)
    const [result] = results
    assert.equal(result.verified, false)
    assert.equal(
      result.runnable,
      false,
      "the cross-platform case is the only one the CI job on the other platform is left to cover",
    )
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("the assembler refuses on a daemon that would not answer", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(
      new URL("../../scripts/packaging/assemble-plugin.ts", import.meta.url),
      "utf8",
    ),
  )
  assert.match(
    source,
    /!result\.verified && result\.runnable/u,
    "assembly must block on a staged daemon that runs here and proves no version",
  )
})
