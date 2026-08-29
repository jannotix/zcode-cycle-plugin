import { createHash } from "node:crypto"
import { readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"

const TARGETS = {
  "linux-x64": "bin/linux-x64/workflowd",
  "win32-x64": "bin/win32-x64/workflowd.exe",
} as const

export async function writeNativeManifest(pluginDirectory: string): Promise<void> {
  const product = JSON.parse(
    await readFile(join(pluginDirectory, ".zcode-plugin", "plugin.json"), "utf8"),
  ) as Record<string, unknown>
  if (typeof product.version !== "string") throw new Error("plugin manifest version is missing")

  const targets: Record<string, { path: string; sha256: string; size: number }> = {}
  for (const [target, path] of Object.entries(TARGETS)) {
    const bytes = await readFile(join(pluginDirectory, path))
    const info = await stat(join(pluginDirectory, path))
    if (!info.isFile() || info.size <= 0) throw new Error(`native binary is invalid: ${path}`)
    targets[target] = {
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: info.size,
    }
  }

  await writeFile(
    join(pluginDirectory, "bin", "native-manifest.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        product_version: product.version,
        targets,
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
}
