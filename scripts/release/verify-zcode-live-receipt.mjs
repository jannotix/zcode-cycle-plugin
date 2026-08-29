import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { lstat, readFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const EXPECTED_DESKTOP = "3.10.1"
const EXPECTED_CLI = "0.16.5"
const EXPECTED_VERSION = "1.0.1"
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024
const REQUIRED_SCENARIOS = new Set([
  "component-discovery",
  "setup-doctor",
  "quick",
  "full",
  "forced-repair",
  "hard-kill-resume",
  "browser",
  "accessibility",
  "goal",
  "update-from-withdrawn-1.0.0",
  "uninstall",
  "isolated-rollback-to-withdrawn-1.0.0",
])

export async function verifyLiveCertification({
  expectedSignerFingerprint,
  receiptPath,
  sealedDirectory,
  signaturePath,
  verifySignature = true,
}) {
  const receiptFile = resolve(receiptPath)
  const receiptDirectory = dirname(receiptFile)
  const sealed = resolve(sealedDirectory)
  const receiptInfo = await lstat(receiptFile)
  assert.equal(receiptInfo.isFile() && !receiptInfo.isSymbolicLink(), true, "unsafe live receipt")
  const receiptText = await readFile(receiptFile, "utf8")
  assertSanitized(receiptText, "live receipt")
  const receipt = JSON.parse(receiptText)

  const releaseManifest = JSON.parse(await readFile(resolve(sealed, "release-manifest.json"), "utf8"))
  assert.equal(receipt.schema_version, 1)
  assert.equal(receipt.product_version, EXPECTED_VERSION)
  assert.equal(receipt.source_git_sha, releaseManifest.source_git_sha)
  assert.match(receipt.source_git_sha, /^[0-9a-f]{40}$/u)
  assert.equal(receipt.host?.desktop_version, EXPECTED_DESKTOP)
  assert.equal(receipt.host?.cli_version, EXPECTED_CLI)
  assert.equal(receipt.host?.platform, "windows-11-x64")
  assert.match(receipt.tested_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u)
  assert.equal(receipt.final_state, "1.0.1-installed-enabled")
  assert.equal(receipt.audit_data_preserved, true)
  assert.equal(receipt.isolated_withdrawn_version_tests, true)

  const archiveName = `zcode-cycle-${EXPECTED_VERSION}.zip`
  const archive = releaseManifest.artifacts.find((item) => item.path === archiveName)
  assert.ok(archive, `sealed manifest lacks ${archiveName}`)
  assert.equal(receipt.plugin_archive?.path, archiveName)
  assert.equal(receipt.plugin_archive?.sha256, archive.sha256)
  assert.equal(
    sha256(await readFile(resolve(sealed, archiveName))),
    archive.sha256,
    "sealed plugin archive digest changed",
  )

  assert.ok(Array.isArray(receipt.scenarios))
  const scenarios = new Map()
  const evidencePaths = new Set()
  for (const scenario of receipt.scenarios) {
    assert.equal(typeof scenario?.id, "string")
    assert.equal(scenarios.has(scenario.id), false, `duplicate scenario: ${scenario.id}`)
    scenarios.set(scenario.id, scenario)
    assert.equal(scenario.status, "PASS", `${scenario.id} is not PASS`)
    assert.ok(Array.isArray(scenario.evidence) && scenario.evidence.length > 0, `${scenario.id} lacks evidence`)
    for (const evidence of scenario.evidence) {
      assertSafeRelativePath(evidence.path)
      assert.match(evidence.sha256, /^[0-9a-f]{64}$/u)
      const path = resolve(receiptDirectory, ...evidence.path.split("/"))
      assert.equal(path.startsWith(`${receiptDirectory}${sep}`), true, "evidence escapes receipt directory")
      const info = await lstat(path)
      assert.equal(info.isFile() && !info.isSymbolicLink(), true, evidence.path)
      assert.ok(info.size > 0 && info.size <= MAX_EVIDENCE_BYTES, `unbounded evidence: ${evidence.path}`)
      const bytes = await readFile(path)
      assert.equal(sha256(bytes), evidence.sha256, evidence.path)
      if (/\.(?:json|log|md|txt)$/iu.test(evidence.path)) {
        assertSanitized(bytes.toString("utf8"), evidence.path)
      }
      evidencePaths.add(evidence.path)
    }
  }
  for (const required of REQUIRED_SCENARIOS) assert.ok(scenarios.has(required), `missing scenario: ${required}`)

  let signerFingerprint = null
  if (verifySignature) {
    if (!signaturePath || !expectedSignerFingerprint) {
      throw new Error("live certification requires a detached signature and expected signer fingerprint")
    }
    signerFingerprint = verifyDetachedSignature(
      resolve(signaturePath),
      receiptFile,
      expectedSignerFingerprint,
    )
  }

  return {
    archive_sha256: archive.sha256,
    evidence_files: evidencePaths.size,
    scenarios: scenarios.size,
    signer_fingerprint: signerFingerprint,
    source_git_sha: receipt.source_git_sha,
  }
}

function verifyDetachedSignature(signature, receipt, expectedFingerprint) {
  const result = spawnSync("gpg", ["--batch", "--status-fd=1", "--verify", signature, receipt], {
    encoding: "utf8",
    shell: false,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || "live receipt signature is invalid")
  const fingerprint = /^\[GNUPG:\] VALIDSIG ([0-9A-F]+)\b/mu.exec(result.stdout)?.[1]
  if (!fingerprint) throw new Error("gpg did not report a valid live receipt signer")
  if (fingerprint.toUpperCase() !== expectedFingerprint.replaceAll(" ", "").toUpperCase()) {
    throw new Error(`unexpected live receipt signer: ${fingerprint}`)
  }
  return fingerprint
}

function assertSafeRelativePath(value) {
  assert.equal(typeof value, "string")
  const segments = value.split("/")
  assert.equal(!value || isAbsolute(value) || value.includes("\\") || segments.includes(".."), false)
}

function assertSanitized(value, label) {
  for (const pattern of [
    /[A-Za-z]:\\Users\\/u,
    /\/(?:home|Users)\/[A-Za-z0-9._-]+\//u,
    /(?:ghp_|github_pat_|npm_[A-Za-z0-9]|-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----)/u,
  ]) {
    assert.equal(pattern.test(value), false, `${label} contains a path or credential pattern`)
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function argumentsMap(argv) {
  const result = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith("--") || value === undefined) throw new Error("invalid arguments")
    result.set(key.slice(2), value)
  }
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const values = argumentsMap(process.argv.slice(2))
  const result = await verifyLiveCertification({
    expectedSignerFingerprint: values.get("signer-fingerprint"),
    receiptPath: values.get("receipt"),
    sealedDirectory: values.get("sealed"),
    signaturePath: values.get("signature"),
  })
  process.stdout.write(`live ZCode certification valid: ${JSON.stringify(result)}\n`)
}
