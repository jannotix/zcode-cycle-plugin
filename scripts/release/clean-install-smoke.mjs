import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const values = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  const value = process.argv[index + 1]
  if (key === undefined || value === undefined || !key.startsWith("--")) {
    throw new Error("Expected --archive and optional --expected-sha arguments")
  }
  values.set(key.slice(2), value)
}
const archiveInput = values.get("archive")
if (!archiveInput) throw new Error("--archive is required")
const archive = resolve(archiveInput)
const expectedSha = values.get("expected-sha")
if (expectedSha !== undefined && !/^[0-9a-f]{64}$/u.test(expectedSha)) {
  throw new Error("--expected-sha must be a lowercase SHA-256 digest")
}

const archiveSha = createHash("sha256").update(await readFile(archive)).digest("hex")
if (expectedSha !== undefined) assert.equal(archiveSha, expectedSha)

const root = await mkdtemp(join(tmpdir(), "zcode-cycle-clean-install-"))
const extract = join(root, "extract")
const dataDirectory = join(root, "data")
const projectDirectory = join(root, "project")
await Promise.all([mkdir(extract), mkdir(projectDirectory)])

try {
  const unpack = spawnSync("tar", ["-xf", archive, "-C", extract], {
    encoding: "utf8",
    shell: false,
  })
  if (unpack.error) throw unpack.error
  if (unpack.status !== 0) throw new Error(unpack.stderr || "archive extraction failed")

  const pluginRoot = join(extract, "zcode-cycle")
  const required = [
    ".zcode-plugin/plugin.json",
    ".mcp.json",
    "README.md",
    "README_CN.md",
    "SECURITY.md",
    "LICENSE",
    "NOTICE",
    "SBOM.cdx.json",
    "THIRD-PARTY-NOTICES.md",
    "THIRD-PARTY-NPM-LICENSES.html",
    "THIRD-PARTY-RUST-LICENSES.html",
    "provenance.intoto.json",
    "bin/native-manifest.json",
    "mcp/dist/server.js",
  ]
  for (const path of required) assert.equal((await stat(join(pluginRoot, path))).isFile(), true, path)

  const product = JSON.parse(await readFile(join(pluginRoot, ".zcode-plugin", "plugin.json"), "utf8"))
  const nativeManifest = JSON.parse(await readFile(join(pluginRoot, "bin", "native-manifest.json"), "utf8"))
  assert.equal(product.version, "1.0.1")
  assert.equal(nativeManifest.product_version, product.version)

  const environment = {
    ...process.env,
    ZCODE_CYCLE_DATA_DIR: dataDirectory,
    ZCODE_PLUGIN_ROOT: pluginRoot,
    ZCODE_PROJECT_DIR: projectDirectory,
  }
  const { LocalControlPlane } = await import(
    `${pathToFileURL(join(pluginRoot, "mcp", "dist", "client.js")).href}?clean=${Date.now()}`
  )
  const plane = new LocalControlPlane({
    dataDirectory,
    environment,
    stopOwnedProcessOnDispose: true,
  })
  let health
  try {
    health = await plane.health()
    assert.equal(health.product_version, product.version)
    assert.equal(health.protocol_version, 1)
    assert.equal((await plane.control("clean-install-smoke", "doctor")).status, "PASS")
  } finally {
    await plane.dispose()
  }

  let materializedMode = null
  if (process.platform !== "win32") {
    const target = `${process.platform}-${process.arch}`
    const native = nativeManifest.targets[target]
    assert.ok(native, `native manifest has no ${target}`)
    const materialized = join(
      dataDirectory,
      "runtime",
      "native",
      target,
      native.sha256,
      "workflowd",
    )
    materializedMode = (await stat(materialized)).mode & 0o777
    assert.equal(materializedMode, 0o700)
    assert.equal(createHash("sha256").update(await readFile(materialized)).digest("hex"), native.sha256)
  }

  const guard = spawnSync(process.execPath, [join(pluginRoot, "hooks", "pre-tool-use.js")], {
    encoding: "utf8",
    env: environment,
    input: "{malformed",
    shell: false,
  })
  assert.equal(guard.status, 0)
  assert.equal(JSON.parse(guard.stdout).hookSpecificOutput.permissionDecision, "deny")

  const receipt = {
    archiveSha,
    health,
    materializedMode,
    platform: process.platform,
    version: product.version,
  }
  const receiptText = `${JSON.stringify(receipt)}\n`
  const receiptPath = values.get("receipt")
  if (receiptPath) await writeFile(resolve(receiptPath), receiptText, "utf8")
  process.stdout.write(receiptText)
} finally {
  // Windows can briefly retain executable handles after process exit.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  await chmod(root, 0o700).catch(() => undefined)
  await rm(root, { force: true, recursive: true })
}
