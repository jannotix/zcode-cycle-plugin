import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { LocalControlPlane } from "../../mcp/dist/client.js"
import { productVersion } from "../../mcp/dist/version.js"

const ROOT = resolve(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const binary =
  process.argv[2] ?? join(ROOT, "target", "release", process.platform === "win32" ? "workflowd.exe" : "workflowd")
const dataDirectory = await mkdtemp(join(tmpdir(), "zcode-cycle-runtime-smoke-"))
const plane = new LocalControlPlane({
  binaryPath: binary,
  dataDirectory,
  stopOwnedProcessOnDispose: true,
})

try {
  const health = await plane.health()
  assert.equal(health.product_version, productVersion())
  assert.equal(health.protocol_version, 1)
  assert.equal(health.schema_mode, "read_write")
  const doctor = await plane.control(`release-smoke-${randomUUID()}`, "doctor")
  assert.equal(doctor.status, "PASS")
  process.stdout.write(`${JSON.stringify({ binary, doctor: doctor.status, health })}\n`)
} finally {
  await plane.dispose()
  await rm(dataDirectory, { force: true, recursive: true })
}
