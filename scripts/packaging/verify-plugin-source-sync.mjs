import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstat, readdir, readFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import { COPY_MAPPINGS, EXCLUDED_FROM_PLUGIN, excludedFromPlugin } from "./plugin-contents.mjs"

const ROOT = resolve(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const PLUGIN = join(ROOT, "plugin")

for (const [sourcePath, pluginPath] of COPY_MAPPINGS) {
  const source = resolve(ROOT, sourcePath)
  const installed = resolve(PLUGIN, pluginPath)
  assert.deepEqual(
    await tree(source, sourcePath),
    await tree(installed),
    `stale assembled content: ${pluginPath}`,
  )
}

// An exclusion that silently matches nothing stops excluding the day the path
// is renamed, and nothing fails. Prove each one still names something.
for (const prefix of EXCLUDED_FROM_PLUGIN) {
  const source = resolve(ROOT, prefix)
  assert.ok((await tree(source)).length > 0, `exclusion matches nothing in source: ${prefix}`)
  await assert.rejects(
    async () => await lstat(resolve(PLUGIN, prefix)),
    `excluded content was installed: ${prefix}`,
  )
}

process.stdout.write(
  `assembled plugin source sync valid: ${COPY_MAPPINGS.length} mappings, ${EXCLUDED_FROM_PLUGIN.length} exclusions\n`,
)

/// Hashes a file or directory. `base`, when given, is the repository-relative
/// path of `root`, and makes the walk skip what an installation must not carry
/// - so the source side of a comparison is the installable subset, not the
/// whole directory.
async function tree(root, base) {
  const info = await lstat(root)
  if (info.isSymbolicLink()) throw new Error(`unsafe linked runtime input: ${root}`)
  if (info.isFile()) return [{ path: "", sha256: sha256(await readFile(root)), size: info.size }]
  if (!info.isDirectory()) throw new Error(`unsupported runtime input: ${root}`)
  const files = []
  await walk(root)
  return files.sort((left, right) => left.path.localeCompare(right.path))

  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`unsafe linked runtime input: ${path}`)
      if (base !== undefined && excludedFromPlugin(join(base, relative(root, path)))) continue
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        const bytes = await readFile(path)
        files.push({
          path: relative(root, path).split(sep).join("/"),
          sha256: sha256(bytes),
          size: bytes.length,
        })
      }
    }
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}
