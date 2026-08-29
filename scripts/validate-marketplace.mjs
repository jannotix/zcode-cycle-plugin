import assert from "node:assert/strict"
import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CATEGORIES = new Set([
  "developer-tools",
  "productivity",
  "utilities",
  "finance",
  "guides",
  "template",
  "other",
])

const json = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"))
const manifest = json(".zcode-plugin/plugin.json")
const installedManifest = json("plugin/.zcode-plugin/plugin.json")
const marketplace = json("marketplace.json")
const legacyMarketplace = json(".claude-plugin/marketplace.json")
const mcp = json(".mcp.json")
const entry = marketplace.plugins?.[0]
const legacyEntry = legacyMarketplace.plugins?.[0]

assert.equal(manifest.name, "zcode-cycle")
assert.equal(
  Object.hasOwn(manifest, "agents"),
  false,
  "certified ZCode CLI 0.16.5 treats plugin agent components as diagnostic-only",
)
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u)
assert.deepEqual(installedManifest, manifest, "source and installable plugin manifests differ")
assert.equal(entry?.name, manifest.name)
assert.equal(entry?.version, manifest.version)
assert.equal(entry?.description, manifest.description)
assert.deepEqual(entry?.description_i18n, manifest.description_i18n)
assert.ok(CATEGORIES.has(entry?.category), `unsupported marketplace category: ${entry?.category}`)
assert.equal(legacyEntry?.name, entry.name)
assert.equal(legacyEntry?.version, entry.version)
assert.equal(legacyEntry?.category, entry.category)
assert.deepEqual(legacyEntry?.description_i18n, entry.description_i18n)

for (const locale of ["en", "zh-CN"]) {
  assert.equal(typeof manifest.description_i18n?.[locale], "string")
  assert.ok(manifest.description_i18n[locale].trim())
}
for (const path of ["README.md", "README_CN.md", "plugin/README.md", "plugin/README_CN.md"]) {
  assert.ok(statSync(join(ROOT, path)).size > 500, `${path} is missing or not substantive`)
}

const server = mcp.mcpServers?.["zcode-cycle"]
assert.equal(server?.type, "stdio")
assert.equal(server?.command, "node")
assert.ok(server?.args?.includes("${ZCODE_PLUGIN_ROOT}/mcp/dist/server.js"))
assert.equal(server?.cwd, "${ZCODE_PROJECT_DIR}")
assert.equal(server?.enabled, true)
assert.equal(server?.timeoutMs, 60000)
assert.equal(JSON.stringify(mcp).includes("CLAUDE_PLUGIN_ROOT"), false)
assert.equal(existsSync(join(ROOT, "plugin", "mcp", "node_modules")), false)

for (const role of [
  "architect",
  "executor",
  "functional-reviewer",
  "security-reviewer",
  "arbiter",
]) {
  const profile = readFileSync(join(ROOT, "agents", `${role}.md`), "utf8")
  assert.match(profile, new RegExp(`^name: zcode-cycle:${role}$`, "mu"))
  assert.match(profile, /^thoughtLevel: high$/mu)
  assert.ok(profile.includes(`<!-- zcode-cycle-managed-role-profile: ${role} -->`))
}

console.log(`marketplace contract valid for ${manifest.name} ${manifest.version}`)
