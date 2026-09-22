import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const SCRIPT = join(ROOT, "scripts", "release", "verify-published-release.mjs")

// 1.0.7, 1.0.8 and 1.0.9 were each published missing two artifacts their own
// sealed manifest declared, and each was reported verified. The check was never
// wrong - it compares both directions - but it was only ever run against CI's
// sealed output, which contains what CI just wrote. Nothing compared the
// manifest to what a user could download.
//
// The failure that matters here is therefore the quiet one: a release whose
// published set is a strict subset of what it declares must fail, not pass on
// the files that happen to be present.

const sha256 = (value) => createHash("sha256").update(value).digest("hex")

/** A stub `gh` on PATH that publishes exactly `assets` for any tag. */
function stubbedRelease(assets) {
  const home = mkdtempSync(join(tmpdir(), "published-release-gate-"))
  const store = join(home, "assets")
  mkdirSync(store)
  for (const [name, content] of Object.entries(assets)) writeFileSync(join(store, name), content)

  const script =
    process.platform === "win32"
      ? `@echo off\r\nsetlocal enabledelayedexpansion\r\nset "DIR="\r\n:parse\r\nif "%~1"=="" goto copy\r\nif "%~1"=="--dir" (set "DIR=%~2" & shift)\r\nshift\r\ngoto parse\r\n:copy\r\ncopy /y "${store}\\*" "%DIR%" >nul\r\nexit /b 0\r\n`
      : `#!/bin/sh\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "--dir" ]; then DIR="$2"; fi\n  shift\ndone\ncp "${store}"/* "$DIR"\nexit 0\n`
  const binary = join(home, process.platform === "win32" ? "gh.cmd" : "gh")
  writeFileSync(binary, script, { mode: 0o755 })
  if (process.platform !== "win32") chmodSync(binary, 0o755)
  return home
}

function runAgainst(assets) {
  const home = stubbedRelease(assets)
  try {
    return spawnSync(process.execPath, [SCRIPT, "v9.9.9", "example/example"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${home}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}` },
    })
  } finally {
    rmSync(home, { force: true, recursive: true })
  }
}

/** A manifest and the files it declares, as the release workflow seals them. */
function release() {
  const contents = {
    "LICENSES.html": "<html>third party licenses</html>",
    "product.zip": "sealed plugin bytes",
  }
  const manifest = {
    schema_version: 1,
    product_version: "9.9.9",
    source_git_sha: "0".repeat(40),
    artifacts: Object.entries(contents)
      .map(([path, body]) => ({ path, sha256: sha256(body), size: Buffer.byteLength(body) }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  }
  return { ...contents, "release-manifest.json": `${JSON.stringify(manifest, null, 2)}\n` }
}

test("a complete published release verifies", () => {
  const result = runAgainst(release())
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /published release verified: v9\.9\.9/u)
})

test("a declared artifact that was never uploaded fails the gate", () => {
  const published = release()
  delete published["LICENSES.html"]
  const result = runAgainst(published)
  assert.notEqual(result.status, 0, "a release missing a declared artifact must not verify")
  assert.match(result.stderr, /LICENSES\.html|does not match the manifest it publishes/u)
})

test("an undeclared artifact that was uploaded fails the gate", () => {
  const result = runAgainst({ ...release(), "stray.txt": "not in the manifest" })
  assert.notEqual(result.status, 0, "a release carrying an undeclared artifact must not verify")
})
