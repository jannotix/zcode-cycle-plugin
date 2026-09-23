import { existsSync } from "node:fs"
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join, relative } from "node:path"

import { checkNativeVersions, STAGING_TARGETS } from "../release/check-native-version.mjs"
import { writeNativeManifest } from "./native-manifest.js"
import { COPY_MAPPINGS, excludedFromPlugin } from "./plugin-contents.mjs"

// Assembles the installable plugin directory: only runtime files, never the
// repository working tree (build outputs like target/ must not reach an
// installation copy).

const root = fileURLToPath(new URL("../../", import.meta.url))
const output = join(root, "plugin")

const copy = COPY_MAPPINGS

// Refuse before destroying the previous output: a tracked daemon built from a
// different product version would assemble an installation that cannot start,
// because the bridge rejects a daemon whose version disagrees with the
// manifest. Checking here also means a refusal leaves the existing plugin
// directory untouched instead of half-rebuilt.
// A daemon built for another platform cannot be asked here and is left to the
// CI job that can run it. A daemon that runs here and refuses to answer is a
// different thing and blocks assembly too: the manifest takes product_version
// from the plugin manifest rather than from the binary, so assembling over a
// silent daemon stamps it with a version it never declared. That is how a
// pre-1.0.6 daemon - too old to know `--version` at all - came to be staged as
// 1.0.7 with honest digests and a fabricated version.
// Staging missing entirely is not a defect to the checker, because a fresh
// clone has none. It is a defect here: the copy below would throw after the
// previous plugin directory had already been removed, which is the half-rebuilt
// state the check above exists to prevent.
for (const target of STAGING_TARGETS) {
  if (!existsSync(join(root, target))) {
    throw new Error(
      `refusing to assemble: ${target} is missing - stage the daemons built for this release first`,
    )
  }
}

const { expected, results } = await checkNativeVersions(root, STAGING_TARGETS)
const stale = results.filter((result) => result.verified && result.declared !== expected)
const silent = results.filter((result) => !result.verified && result.runnable)
if (stale.length > 0 || silent.length > 0) {
  for (const { declared, target } of stale) {
    console.error(`  ${target} — declares ${declared}, expected ${expected}`)
  }
  for (const { reason, target } of silent) {
    console.error(`  ${target} — runs here and would not answer --version (${reason})`)
  }
  throw new Error(
    `refusing to assemble: ${stale.length + silent.length} staged daemon(s) did not prove version ${expected}`,
  )
}

await rm(output, { force: true, recursive: true })
await mkdir(join(output, "bin"), { recursive: true })
for (const [from, to] of copy) {
  await cp(join(root, from), join(output, to), {
    filter: (source) => !excludedFromPlugin(relative(root, source)),
    recursive: true,
  })
}

// Per-platform daemon binaries; assembly fails if any certified platform
// binary is missing. Their product version was checked before anything was
// removed.
await cp(join(root, "bin", "workflowd.exe"), join(output, "bin", "win32-x64", "workflowd.exe"))
await cp(join(root, "bin", "workflowd"), join(output, "bin", "linux-x64", "workflowd"))
await writeNativeManifest(output)

// The MCP build bundles every runtime dependency into dist/. The runtime
// package only marks ESM semantics; no package manager runs during install.
const mcpPackage = JSON.parse(await readFile(join(root, "mcp", "package.json"), "utf8")) as Record<
  string,
  unknown
>
const dependencyFree: Record<string, unknown> = { ...mcpPackage }
delete dependencyFree.devDependencies
delete dependencyFree.scripts
delete dependencyFree.dependencies
await writeFile(
  join(output, "mcp", "package.json"),
  `${JSON.stringify(dependencyFree, null, 2)}\n`,
  "utf8",
)

console.log(`assembled ${output}`)
