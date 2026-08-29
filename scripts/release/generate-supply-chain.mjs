import { createHash } from "node:crypto"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const values = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  const value = process.argv[index + 1]
  if (key === undefined || value === undefined || !key.startsWith("--")) {
    throw new Error("Expected --plugin and --source-sha arguments")
  }
  values.set(key.slice(2), value)
}
const pluginDirectory = resolve(values.get("plugin") ?? join(ROOT, "plugin"))
const sourceSha = values.get("source-sha")
if (sourceSha === undefined || !/^[0-9a-f]{40}$/u.test(sourceSha)) {
  throw new Error("--source-sha must be a full lowercase Git SHA")
}

const product = json(await readFile(join(pluginDirectory, ".zcode-plugin", "plugin.json"), "utf8"))
const nativeManifest = json(await readFile(join(pluginDirectory, "bin", "native-manifest.json"), "utf8"))
if (nativeManifest.product_version !== product.version) {
  throw new Error("native manifest and plugin versions differ")
}

const cargoPackages = new Map()
for (const target of ["x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"]) {
  const metadata = json(
    await run(
      "cargo",
      ["metadata", "--locked", "--format-version", "1", "--filter-platform", target],
      ROOT,
    ),
  )
  for (const item of metadata.packages) cargoPackages.set(item.id, item)
}
const cargoLock = Bun.TOML.parse(await readFile(join(ROOT, "Cargo.lock"), "utf8"))
const cargoChecksums = new Map(
  (cargoLock.package ?? []).map((entry) => [`${entry.name}@${entry.version}`, entry.checksum]),
)
const bunLock = Bun.JSONC.parse(await readFile(join(ROOT, "mcp", "bun.lock"), "utf8"))
const npmIntegrity = new Map()
for (const entry of Object.values(bunLock.packages ?? {})) {
  const specifier = entry?.[0]
  const integrity = entry?.[3]
  if (typeof specifier !== "string" || typeof integrity !== "string") continue
  const separator = specifier.lastIndexOf("@")
  if (separator <= 0) continue
  npmIntegrity.set(specifier, integrity)
}

const components = []
for (const item of cargoPackages.values()) {
  if (item.source === null) continue
  const checksum = cargoChecksums.get(`${item.name}@${item.version}`)
  components.push({
    type: "library",
    group: "cargo",
    name: item.name,
    version: item.version,
    scope: "required",
    licenses: [{ expression: normalizeLicense(item.license ?? "UNKNOWN") }],
    purl: `pkg:cargo/${encodeURIComponent(item.name)}@${encodeURIComponent(item.version)}`,
    ...(typeof checksum === "string" ? { hashes: [{ alg: "SHA-256", content: checksum }] } : {}),
    ...(item.repository
      ? { externalReferences: [{ type: "vcs", url: item.repository }] }
      : {}),
  })
}

// The shipped MCP is a self-contained bundle: derive its auditable runtime
// closure from the frozen build lock, then resolve license metadata from the
// build environment. No node_modules tree is copied into the plugin.
const npmPackages = await runtimeNpmPackages(bunLock, join(ROOT, "mcp", "node_modules"))
for (const item of npmPackages) {
  const specifier = `${item.name}@${item.version}`
  const integrity = npmIntegrity.get(specifier)
  const integrityHash = decodeIntegrity(integrity)
  components.push({
    type: "library",
    group: "npm",
    name: item.name,
    version: item.version,
    scope: "required",
    licenses: [{ expression: normalizeLicense(item.license ?? "UNKNOWN") }],
    purl: `pkg:npm/${encodeURIComponent(item.name)}@${encodeURIComponent(item.version)}`,
    ...(integrityHash ? { hashes: [integrityHash] } : {}),
    ...(item.repository
      ? { externalReferences: [{ type: "vcs", url: item.repository }] }
      : {}),
  })
}

for (const [target, item] of Object.entries(nativeManifest.targets)) {
  components.push({
    type: "file",
    group: "native",
    name: `workflowd-${target}`,
    version: product.version,
    scope: "required",
    hashes: [{ alg: "SHA-256", content: item.sha256 }],
    properties: [
      { name: "cycle:path", value: item.path },
      { name: "cycle:size", value: String(item.size) },
    ],
  })
}
components.sort((left, right) => `${left.group}/${left.name}/${left.version}`.localeCompare(`${right.group}/${right.name}/${right.version}`))

const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: {
    component: {
      type: "application",
      name: product.name,
      version: product.version,
      licenses: [{ license: { name: product.license } }],
    },
    properties: [
      { name: "cycle:source_git_sha", value: sourceSha },
      { name: "cycle:artifact_scope", value: "official ZCode plugin directory" },
    ],
  },
  components,
}
await writeFile(join(pluginDirectory, "SBOM.cdx.json"), `${JSON.stringify(sbom, null, 2)}\n`, "utf8")

const npmLicenseGroups = new Map()
const npmLicenseTextByExpression = new Map(
  npmPackages
    .filter((item) => item.licenseText)
    .map((item) => [normalizeLicense(item.license), item.licenseText]),
)
for (const item of npmPackages) {
  const licenseText = item.licenseText ?? npmLicenseTextByExpression.get(normalizeLicense(item.license))
  if (!licenseText) throw new Error(`npm package has no resolvable license text: ${item.name}@${item.version}`)
  const digest = createHash("sha256").update(licenseText).digest("hex")
  const group = npmLicenseGroups.get(digest) ?? { packages: [], text: licenseText }
  group.packages.push(`${item.name} ${item.version}`)
  npmLicenseGroups.set(digest, group)
}
const npmLicenses = [
  "<!doctype html>",
  '<html lang="en"><head><meta charset="utf-8"><title>Cycle for Zcode - npm dependency licenses</title></head><body>',
  "<h1>Cycle for Zcode - npm dependency licenses</h1>",
  ...[...npmLicenseGroups.entries()].flatMap(([digest, group]) => [
    `<h2>${digest}</h2>`,
    `<p>Used by: ${escapeHtml(group.packages.sort().join(", "))}</p>`,
    `<pre>${escapeHtml(group.text)}</pre>`,
  ]),
  "</body></html>",
  "",
].join("\n")
await writeFile(join(pluginDirectory, "THIRD-PARTY-NPM-LICENSES.html"), npmLicenses, "utf8")

const cargoRows = components.filter((item) => item.group === "cargo")
const npmRows = components.filter((item) => item.group === "npm")
const notices = [
  "# Third-Party Notices",
  "",
  "This file identifies third-party runtime components in the exact plugin artifact.",
  "Full license texts are in `THIRD-PARTY-RUST-LICENSES.html` and `THIRD-PARTY-NPM-LICENSES.html`.",
  "The machine-readable inventory is `SBOM.cdx.json`.",
  "",
  `## Rust dependencies (${cargoRows.length})`,
  "",
  "| Package | Version | License |",
  "|---|---:|---|",
  ...cargoRows.map((item) => `| ${escapeTable(item.name)} | ${item.version} | ${escapeTable(item.licenses[0].expression)} |`),
  "",
  `## npm runtime dependencies (${npmRows.length})`,
  "",
  "| Package | Version | License |",
  "|---|---:|---|",
  ...npmRows.map((item) => `| ${escapeTable(item.name)} | ${item.version} | ${escapeTable(item.licenses[0].expression)} |`),
  "",
  "## Third-party services and executables",
  "",
  "- Chrome, Edge or Chromium is user-supplied and is controlled only for an explicitly opened browser evidence session.",
  "- Git, Node.js and project build/test tools are user-supplied executables and remain governed by their own licenses.",
  "- ZCode and configured model providers are separate services governed by their own terms and privacy policies.",
  "",
].join("\n")
await writeFile(join(pluginDirectory, "THIRD-PARTY-NOTICES.md"), notices, "utf8")

const provenance = {
  _type: "https://in-toto.io/Statement/v1",
  subject: Object.values(nativeManifest.targets).map((item) => ({
    name: item.path,
    digest: { sha256: item.sha256 },
  })),
  predicateType: "https://slsa.dev/provenance/v1",
  predicate: {
    buildDefinition: {
      buildType: "https://github.com/jannotix/zcode-cycle-plugin/assemble-plugin/v1",
      externalParameters: { product_version: product.version },
      internalParameters: { source_git_sha: sourceSha },
      resolvedDependencies: [
        {
          uri: "git+https://github.com/jannotix/zcode-cycle-plugin.git",
          digest: { gitCommit: sourceSha },
        },
      ],
    },
    runDetails: {
      builder: {
        id: process.env.GITHUB_REPOSITORY
          ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID ?? "unknown"}`
          : "local-release-candidate-builder",
      },
      metadata: {
        invocationId: process.env.GITHUB_RUN_ID ?? "local",
      },
    },
  },
}
await writeFile(join(pluginDirectory, "provenance.intoto.json"), `${JSON.stringify(provenance, null, 2)}\n`, "utf8")

process.stdout.write(
  `supply-chain metadata written: ${cargoRows.length} cargo, ${npmRows.length} npm, ${Object.keys(nativeManifest.targets).length} native\n`,
)

function json(text) {
  return JSON.parse(text)
}

function normalizeLicense(value) {
  return String(value)
    .replaceAll("MIT/Apache-2.0", "MIT OR Apache-2.0")
    .replaceAll("Unlicense/MIT", "Unlicense OR MIT")
}

function decodeIntegrity(value) {
  if (typeof value !== "string") return null
  const separator = value.indexOf("-")
  if (separator <= 0) return null
  const algorithm = value.slice(0, separator).toUpperCase()
  if (algorithm !== "SHA512" && algorithm !== "SHA256") return null
  return { alg: algorithm === "SHA512" ? "SHA-512" : "SHA-256", content: Buffer.from(value.slice(separator + 1), "base64").toString("hex") }
}

async function installedNpmPackages(nodeModules) {
  const found = new Map()
  await scan(nodeModules)
  return [...found.values()].sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`))

  async function scan(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === ".bin") continue
      const path = join(directory, entry.name)
      if (entry.name.startsWith("@")) {
        await scan(path)
        continue
      }
      try {
        const manifest = json(await readFile(join(path, "package.json"), "utf8"))
        if (typeof manifest.name === "string" && typeof manifest.version === "string") {
          const repository =
            typeof manifest.repository === "string"
              ? manifest.repository
              : typeof manifest.repository?.url === "string"
                ? manifest.repository.url
                : undefined
          const files = await readdir(path, { withFileTypes: true })
          const licenseFile = files.find(
            (entry) => entry.isFile() && /^(?:licen[sc]e|copying|notice)(?:\..*)?$/iu.test(entry.name),
          )
          found.set(`${manifest.name}@${manifest.version}`, {
            name: manifest.name,
            version: manifest.version,
            license: typeof manifest.license === "string" ? manifest.license : "UNKNOWN",
            licenseText: licenseFile
              ? await readFile(join(path, licenseFile.name), "utf8")
              : undefined,
            repository,
          })
        }
      } catch {
        // A non-package directory inside node_modules is not a runtime component.
      }
      try {
        await scan(join(path, "node_modules"))
      } catch {
        // Most packages have no nested dependency directory.
      }
    }
  }
}

async function runtimeNpmPackages(lock, nodeModules) {
  const packages = lock.packages ?? {}
  const rootDependencies = Object.keys(lock.workspaces?.[""]?.dependencies ?? {})
  const pending = [...rootDependencies]
  const visitedKeys = new Set()
  const requiredSpecifiers = new Set()

  while (pending.length > 0) {
    const key = pending.pop()
    if (visitedKeys.has(key)) continue
    const entry = packages[key]
    if (!Array.isArray(entry) || typeof entry[0] !== "string") {
      throw new Error(`runtime dependency is absent from bun.lock: ${key}`)
    }
    visitedKeys.add(key)
    requiredSpecifiers.add(entry[0])

    const dependencies = entry[2]?.dependencies ?? {}
    for (const dependency of Object.keys(dependencies)) {
      const nestedKey = `${key}/${dependency}`
      if (packages[nestedKey] !== undefined) pending.push(nestedKey)
      else if (packages[dependency] !== undefined) pending.push(dependency)
      else throw new Error(`locked runtime dependency cannot be resolved: ${key} -> ${dependency}`)
    }
  }

  const installed = await installedNpmPackages(nodeModules)
  const bySpecifier = new Map(installed.map((item) => [`${item.name}@${item.version}`, item]))
  const resolved = []
  for (const specifier of requiredSpecifiers) {
    const item = bySpecifier.get(specifier)
    if (!item) throw new Error(`locked runtime package is not installed for license collection: ${specifier}`)
    resolved.push(item)
  }
  return resolved.sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  )
}

function escapeTable(value) {
  return String(value).replaceAll("|", "\\|")
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

async function run(program, args, cwd) {
  const child = Bun.spawn([program, ...args], { cwd, stderr: "inherit", stdout: "pipe" })
  const output = await new Response(child.stdout).text()
  if ((await child.exited) !== 0) throw new Error(`${program} ${args.join(" ")} failed`)
  return output
}
