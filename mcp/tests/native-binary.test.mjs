import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { ControlPlaneError, prepareNativeBinary } from "../dist/client.js"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const PRODUCT_VERSION = JSON.parse(
  await readFile(join(ROOT, ".zcode-plugin", "plugin.json"), "utf8"),
).version

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zcode-cycle-native-test-"))
  const pluginRoot = join(root, "plugin")
  const dataDirectory = join(root, "data")
  const source = join(pluginRoot, "bin", "linux-x64", "workflowd")
  await mkdir(join(pluginRoot, "bin", "linux-x64"), { recursive: true })
  await writeFile(source, "certified-binary-bytes", { mode: 0o600 })
  await chmod(source, 0o600)
  await writeFile(
    join(pluginRoot, "bin", "native-manifest.json"),
    JSON.stringify({
      schema_version: 1,
      product_version: PRODUCT_VERSION,
      targets: {
        "linux-x64": {
          path: "bin/linux-x64/workflowd",
          sha256: createHash("sha256").update("certified-binary-bytes").digest("hex"),
          size: Buffer.byteLength("certified-binary-bytes"),
        },
      },
    }),
  )
  return { dataDirectory, pluginRoot, root, source }
}

test("a non-executable packaged Linux daemon is materialized as verified user-only executable", async () => {
  const item = await fixture()
  try {
    const options = {
      architecture: "x64",
      dataDirectory: item.dataDirectory,
      environment: { ZCODE_PLUGIN_ROOT: item.pluginRoot },
      platform: "linux",
    }
    const first = await prepareNativeBinary(options)
    const second = await prepareNativeBinary(options)

    assert.notEqual(first, item.source)
    assert.equal(second, first)
    assert.equal(await readFile(first, "utf8"), "certified-binary-bytes")
    if (process.platform !== "win32") assert.equal((await stat(first)).mode & 0o777, 0o700)
  } finally {
    await rm(item.root, { force: true, recursive: true })
  }
})

test("a tampered materialized daemon fails closed instead of being silently replaced", async () => {
  const item = await fixture()
  try {
    const options = {
      architecture: "x64",
      dataDirectory: item.dataDirectory,
      environment: { ZCODE_PLUGIN_ROOT: item.pluginRoot },
      platform: "linux",
    }
    const target = await prepareNativeBinary(options)
    await writeFile(target, "tampered")

    await assert.rejects(
      prepareNativeBinary(options),
      (error) => error instanceof ControlPlaneError && error.message.includes("digest mismatch"),
    )
  } finally {
    await rm(item.root, { force: true, recursive: true })
  }
})

test("a packaged daemon that disagrees with its native manifest is rejected", async () => {
  const item = await fixture()
  try {
    const manifestPath = join(item.pluginRoot, "bin", "native-manifest.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    manifest.targets["linux-x64"].sha256 = "0".repeat(64)
    await writeFile(manifestPath, JSON.stringify(manifest))

    await assert.rejects(
      prepareNativeBinary({
        architecture: "x64",
        dataDirectory: item.dataDirectory,
        environment: { ZCODE_PLUGIN_ROOT: item.pluginRoot },
        platform: "linux",
      }),
      /does not match its native manifest/u,
    )
  } finally {
    await rm(item.root, { force: true, recursive: true })
  }
})

test("a symlink cannot be used as the packaged daemon", { skip: process.platform === "win32" }, async () => {
  const item = await fixture()
  try {
    const other = join(item.root, "other")
    await writeFile(other, "other")
    await rm(item.source)
    await symlink(other, item.source)

    await assert.rejects(
      prepareNativeBinary({
        architecture: "x64",
        dataDirectory: item.dataDirectory,
        environment: { ZCODE_PLUGIN_ROOT: item.pluginRoot },
        platform: "linux",
      }),
      /not a regular file/u,
    )
  } finally {
    await rm(item.root, { force: true, recursive: true })
  }
})

test("a symlink cannot replace the private runtime directory", { skip: process.platform === "win32" }, async () => {
  const item = await fixture()
  try {
    const options = {
      architecture: "x64",
      dataDirectory: item.dataDirectory,
      environment: { ZCODE_PLUGIN_ROOT: item.pluginRoot },
      platform: "linux",
    }
    const target = await prepareNativeBinary(options)
    const runtimeDirectory = dirname(target)
    const redirect = join(item.root, "redirect")
    await rm(runtimeDirectory, { force: true, recursive: true })
    await mkdir(redirect)
    await symlink(redirect, runtimeDirectory, "dir")

    await assert.rejects(prepareNativeBinary(options), /runtime directory is unsafe/u)
  } finally {
    await rm(item.root, { force: true, recursive: true })
  }
})
