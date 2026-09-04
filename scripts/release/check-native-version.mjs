import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// The daemon embeds CARGO_PKG_VERSION and the bridge refuses a daemon whose
// product version disagrees with the plugin manifest. A tracked binary built
// from an earlier version therefore ships an installation that cannot start,
// and nothing else in the repository compares the two. This does.
//
// ponytail: the binary is scanned for the embedded version rather than
// executed, because a health call needs a data directory and the IPC
// handshake. Release builds intern the string without separators and LTO also
// materializes it as immediate operands, so the reliable signal is the
// presence of a prerelease suffix on the product's own base version — a fresh
// 1.0.2 build contains "1.0.2" and never "1.0.2-", while a 1.0.2-rc.4 build
// contains both. Replace this with a health call if a future daemon stops
// embedding its version as plain text.

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

// `bin/` is local assembly staging and is not tracked; `plugin/bin/` is what
// an installation actually receives. Both are checked, and a target that does
// not exist on this machine is skipped rather than failed, because a fresh
// clone has no staging directory.
export const STAGING_TARGETS = ["bin/workflowd", "bin/workflowd.exe"]
export const SHIPPED_TARGETS = [
  "plugin/bin/linux-x64/workflowd",
  "plugin/bin/win32-x64/workflowd.exe",
]

export async function checkNativeVersions(
  root = ROOT,
  targets = [...STAGING_TARGETS, ...SHIPPED_TARGETS],
) {
  const manifest = JSON.parse(await readFile(join(root, ".zcode-plugin", "plugin.json"), "utf8"))
  const expected = manifest.version
  if (typeof expected !== "string" || !expected) {
    throw new Error("plugin manifest version is missing")
  }
  const base = expected.split("-")[0]

  const results = []
  for (const target of targets) {
    let bytes
    try {
      bytes = await readFile(join(root, target))
    } catch (error) {
      if (error.code === "ENOENT") continue
      throw error
    }
    const content = bytes.toString("latin1")
    const declares = content.includes(expected)
    // Every build of this base version that is not the expected one carries a
    // prerelease suffix the expected build cannot contain.
    const foreign = [
      ...new Set(
        [...content.matchAll(new RegExp(`${base.replaceAll(".", "\\.")}-[0-9A-Za-z.]+`, "gu"))]
          .map((match) => match[0])
          .filter((token) => token !== expected),
      ),
    ]
    results.push({ declares, foreign, target })
  }
  return { expected, results }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { expected, results } = await checkNativeVersions()
  let failed = false
  for (const { declares, foreign, target } of results) {
    if (foreign.length > 0) {
      failed = true
      process.stdout.write(`${target}: carries ${foreign.join(", ")}, expected ${expected}\n`)
    } else if (!declares) {
      failed = true
      process.stdout.write(`${target}: does not declare ${expected}\n`)
    } else {
      process.stdout.write(`${target}: ${expected}\n`)
    }
  }
  if (failed) {
    process.stderr.write("a tracked daemon disagrees with the plugin manifest version\n")
    process.exit(1)
  }
  process.stdout.write(`every tracked daemon declares ${expected}\n`)
}
