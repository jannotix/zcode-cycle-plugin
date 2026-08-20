import { cp, mkdir, rm, stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

// Assembles the installable plugin directory: only runtime files, never the
// repository working tree (build outputs like target/ must not reach an
// installation copy).

const root = fileURLToPath(new URL("../../", import.meta.url))
const output = join(root, "plugin-dist")

const copy = [
  [".zcode-plugin/plugin.json", ".zcode-plugin/plugin.json"],
  [".mcp.json", ".mcp.json"],
  ["LICENSE", "LICENSE"],
  ["NOTICE", "NOTICE"],
  ["README.md", "README.md"],
  ["agents", "agents"],
  ["commands", "commands"],
  ["skills", "skills"],
  ["hooks/hooks.json", "hooks/hooks.json"],
  ["hooks/pre-tool-use.js", "hooks/pre-tool-use.js"],
  ["hooks/post-tool-use.js", "hooks/post-tool-use.js"],
  ["mcp/dist", "mcp/dist"],
]

await rm(output, { force: true, recursive: true })
await mkdir(output, { recursive: true })
for (const [from, to] of copy) {
  await cp(join(root, from), join(output, to), { recursive: true })
}

// The sidecar daemon binary is optional for assembly (distribution decides
// between sidecar and native packages) but required for local installs.
try {
  await stat(join(root, "bin"))
  await cp(join(root, "bin"), join(output, "bin"), { recursive: true })
} catch {
  console.log("note: no sidecar bin/ assembled")
}

console.log(`assembled ${output}`)
