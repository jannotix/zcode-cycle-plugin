import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstat, readdir, readFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const PLUGIN = join(ROOT, "plugin")
const COPY_MAPPINGS = [
  [".zcode-plugin/plugin.json", ".zcode-plugin/plugin.json"],
  [".mcp.json", ".mcp.json"],
  ["LICENSE", "LICENSE"],
  ["NOTICE", "NOTICE"],
  ["README.md", "README.md"],
  ["README_CN.md", "README_CN.md"],
  ["CHANGELOG.md", "CHANGELOG.md"],
  ["SECURITY.md", "SECURITY.md"],
  ["THIRD-PARTY-RUST-LICENSES.html", "THIRD-PARTY-RUST-LICENSES.html"],
  ["docs", "docs"],
  ["agents", "agents"],
  ["commands", "commands"],
  ["skills", "skills"],
  ["hooks/cycle-hooks.json", "hooks/cycle-hooks.json"],
  ["hooks/pre-tool-use.js", "hooks/pre-tool-use.js"],
  ["hooks/post-tool-use.js", "hooks/post-tool-use.js"],
  ["mcp/dist", "mcp/dist"],
]

for (const [sourcePath, pluginPath] of COPY_MAPPINGS) {
  const source = resolve(ROOT, sourcePath)
  const installed = resolve(PLUGIN, pluginPath)
  assert.deepEqual(await tree(source), await tree(installed), `stale assembled content: ${pluginPath}`)
}

process.stdout.write(`assembled plugin source sync valid: ${COPY_MAPPINGS.length} mappings\n`)

async function tree(root) {
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
