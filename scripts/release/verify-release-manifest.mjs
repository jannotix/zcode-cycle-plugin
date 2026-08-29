import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstat, readdir, readFile } from "node:fs/promises"
import { relative, resolve, sep } from "node:path"

const directory = resolve(process.argv[2] ?? "")
if (!process.argv[2]) throw new Error("Expected sealed artifact directory")
const manifestPath = resolve(directory, "release-manifest.json")
const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
assert.equal(manifest.schema_version, 1)
assert.match(manifest.product_version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u)
assert.match(manifest.source_git_sha, /^[0-9a-f]{40}$/u)
assert.ok(Array.isArray(manifest.artifacts))

const expected = new Set(["release-manifest.json"])
for (const item of manifest.artifacts) {
  assert.equal(typeof item.path, "string")
  assert.equal(item.path.startsWith("/") || item.path.split("/").includes(".."), false)
  assert.match(item.sha256, /^[0-9a-f]{64}$/u)
  assert.ok(Number.isSafeInteger(item.size) && item.size >= 0)
  assert.equal(expected.has(item.path), false, `duplicate artifact: ${item.path}`)
  expected.add(item.path)

  const path = resolve(directory, ...item.path.split("/"))
  assert.ok(path.startsWith(`${directory}${sep}`), `artifact escapes directory: ${item.path}`)
  const info = await lstat(path)
  assert.equal(info.isFile() && !info.isSymbolicLink(), true, item.path)
  const digest = createHash("sha256").update(await readFile(path)).digest("hex")
  assert.equal(digest, item.sha256, item.path)
  assert.equal(info.size, item.size, item.path)
}

const actual = new Set((await files(directory)).map((path) => relative(directory, path).split(sep).join("/")))
assert.deepEqual([...actual].sort(), [...expected].sort())
process.stdout.write(`release manifest valid: ${manifest.artifacts.length} artifacts, ${manifest.source_git_sha}\n`)

async function files(root) {
  const result = []
  await walk(root)
  return result
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`sealed tree contains symlink: ${child}`)
      if (entry.isDirectory()) await walk(child)
      else if (entry.isFile()) result.push(child)
    }
  }
}
