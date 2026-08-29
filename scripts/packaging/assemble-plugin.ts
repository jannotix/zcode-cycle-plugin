import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

// Assembles the installable plugin directory: only runtime files, never the
// repository working tree (build outputs like target/ must not reach an
// installation copy).

const root = fileURLToPath(new URL("../../", import.meta.url))
const output = join(root, "plugin")

const copy = [
  [".zcode-plugin/plugin.json", ".zcode-plugin/plugin.json"],
  [".mcp.json", ".mcp.json"],
  ["LICENSE", "LICENSE"],
  ["NOTICE", "NOTICE"],
  ["README.md", "README.md"],
  ["README_CN.md", "README_CN.md"],
  ["CHANGELOG.md", "CHANGELOG.md"],
  ["SECURITY.md", "SECURITY.md"],
  ["docs", "docs"],
  ["agents", "agents"],
  ["commands", "commands"],
  ["skills", "skills"],
  ["hooks/hooks.json", "hooks/hooks.json"],
  ["hooks/pre-tool-use.js", "hooks/pre-tool-use.js"],
  ["hooks/post-tool-use.js", "hooks/post-tool-use.js"],
  ["mcp/dist", "mcp/dist"],
]

await rm(output, { force: true, recursive: true })
await mkdir(join(output, "bin"), { recursive: true })
for (const [from, to] of copy) {
  await cp(join(root, from), join(output, to), { recursive: true })
}

// Per-platform daemon binaries; assembly fails if any certified platform
// binary is missing.
await cp(join(root, "bin", "workflowd.exe"), join(output, "bin", "win32-x64", "workflowd.exe"))
await cp(join(root, "bin", "workflowd"), join(output, "bin", "linux-x64", "workflowd"))

// Runtime dependencies (puppeteer-core and transitive) resolve from the
// plugin's own node_modules; install production dependencies into the
// assembled copy so the distribution is self-contained.
const mcpPackage = JSON.parse(await readFile(join(root, "mcp", "package.json"), "utf8")) as Record<
  string,
  unknown
>
const dependencyFree: Record<string, unknown> = { ...mcpPackage }
delete dependencyFree.devDependencies
await writeFile(
  join(output, "mcp", "package.json"),
  `${JSON.stringify(dependencyFree, null, 2)}\n`,
  "utf8",
)
const install = Bun.spawn(["bun", "install", "--production"], {
  cwd: join(output, "mcp"),
  stderr: "inherit",
  stdout: "inherit",
})
if ((await install.exited) !== 0) throw new Error("dependency installation for the plugin failed")

console.log(`assembled ${output}`)
