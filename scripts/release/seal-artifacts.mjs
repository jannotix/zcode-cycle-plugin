import { createHash } from "node:crypto"
import { lstat, readdir, readFile, writeFile } from "node:fs/promises"
import { relative, resolve, sep } from "node:path"

const values = argumentsMap()
const directory = resolve(values.get("directory") ?? "")
const sourceSha = values.get("source-sha")
const version = values.get("version")
if (!values.get("directory")) throw new Error("--directory is required")
if (!sourceSha || !/^[0-9a-f]{40}$/u.test(sourceSha)) throw new Error("--source-sha must be a full Git SHA")
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) throw new Error("--version is invalid")

const manifestPath = resolve(directory, "release-manifest.json")
const artifacts = []
for (const path of await files(directory)) {
  if (path === manifestPath) continue
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`unsafe artifact: ${path}`)
  const bytes = await readFile(path)
  artifacts.push({
    path: relative(directory, path).split(sep).join("/"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: info.size,
  })
}
artifacts.sort((left, right) => left.path.localeCompare(right.path))

for (const required of [
  `zcode-cycle-${version}.zip`,
  `zcode-cycle-native-linux-x64-${version}.tgz`,
  `zcode-cycle-native-win32-x64-${version}.tgz`,
  "SBOM.cdx.json",
  "provenance.intoto.json",
]) {
  if (!artifacts.some((item) => item.path === required)) throw new Error(`required sealed artifact is missing: ${required}`)
}

await writeFile(
  manifestPath,
  `${JSON.stringify({ schema_version: 1, product_version: version, source_git_sha: sourceSha, artifacts }, null, 2)}\n`,
  "utf8",
)
process.stdout.write(`sealed ${artifacts.length} artifacts for ${sourceSha}\n`)

function argumentsMap() {
  const result = new Map()
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index]
    const value = process.argv[index + 1]
    if (!key?.startsWith("--") || value === undefined) throw new Error("invalid arguments")
    result.set(key.slice(2), value)
  }
  return result
}

async function files(root) {
  const result = []
  await walk(root)
  return result.sort()
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`artifact tree contains a symlink: ${child}`)
      if (entry.isDirectory()) await walk(child)
      else if (entry.isFile()) result.push(child)
    }
  }
}
