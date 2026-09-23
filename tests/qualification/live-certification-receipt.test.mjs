import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { verifyLiveCertification } from "../../scripts/release/verify-zcode-live-receipt.mjs"

const SCENARIOS = [
  "component-discovery",
  "setup-doctor",
  "quick",
  "full",
  "forced-repair",
  "hard-kill-resume",
  "browser",
  "accessibility",
  "goal",
  "schema-forward-compatibility",
  "uninstall",
  "history-survives-version-change",
  "per-role-model",
]
// Read rather than repeated: a literal here goes stale at every bump, and this
// fixture exists to prove a receipt is bound to the version it names.
const PRODUCT_VERSION = JSON.parse(
  await readFile(
    join(
      dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
      ".zcode-plugin",
      "plugin.json",
    ),
    "utf8",
  ),
).version
const HOST_DESKTOP = "3.14.3.7762"

test("a live ZCode receipt is bound to sealed bytes and complete evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-cycle-live-receipt-"))
  try {
    const sealed = join(root, "sealed")
    const certification = join(root, "certification")
    await Promise.all([mkdir(sealed), mkdir(join(certification, "evidence"), { recursive: true })])
    const archiveName = `zcode-cycle-${PRODUCT_VERSION}.zip`
    const archive = Buffer.from("sealed plugin bytes")
    const archiveDigest = sha256(archive)
    await writeFile(join(sealed, archiveName), archive)
    await writeFile(
      join(sealed, "release-manifest.json"),
      JSON.stringify({
        schema_version: 1,
        product_version: PRODUCT_VERSION,
        source_git_sha: "a".repeat(40),
        artifacts: [{ path: archiveName, sha256: archiveDigest, size: archive.length }],
      }),
    )
    const evidence = Buffer.from('{"result":"PASS"}\n')
    const evidencePath = "evidence/result.json"
    await writeFile(join(certification, ...evidencePath.split("/")), evidence)
    const receipt = {
      schema_version: 1,
      product_version: PRODUCT_VERSION,
      source_git_sha: "a".repeat(40),
      plugin_archive: { path: archiveName, sha256: archiveDigest },
      host: {
        desktop_version: HOST_DESKTOP,
        cli_version: "0.16.9",
        platform: "windows-11-x64",
      },
      tested_at: "2026-08-29T12:00:00Z",
      final_state: `${PRODUCT_VERSION}-installed-enabled`,
      audit_data_preserved: true,
      scenarios: SCENARIOS.map((id) => ({
        id,
        status: "PASS",
        host_desktop_version: HOST_DESKTOP,
        evidence: [{ path: evidencePath, sha256: sha256(evidence) }],
      })),
    }
    const receiptPath = join(certification, "zcode-live-certification.json")
    await writeFile(receiptPath, JSON.stringify(receipt))

    const verified = await verifyLiveCertification({
      receiptPath,
      sealedDirectory: sealed,
      verifySignature: false,
    })
    assert.equal(verified.archive_sha256, archiveDigest)
    assert.equal(verified.scenarios, SCENARIOS.length)

    // A host that updates mid-campaign is the failure this guards: the receipt
    // would otherwise describe two builds and claim to describe one.
    receipt.scenarios.at(-1).host_desktop_version = "3.12.0.7000"
    await writeFile(receiptPath, JSON.stringify(receipt))
    await assert.rejects(
      verifyLiveCertification({ receiptPath, sealedDirectory: sealed, verifySignature: false }),
      /ran on ZCode Desktop 3\.12\.0\.7000/u,
    )
    receipt.scenarios.at(-1).host_desktop_version = HOST_DESKTOP

    receipt.scenarios.pop()
    await writeFile(receiptPath, JSON.stringify(receipt))
    await assert.rejects(
      verifyLiveCertification({ receiptPath, sealedDirectory: sealed, verifySignature: false }),
      /missing scenario/u,
    )
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}
