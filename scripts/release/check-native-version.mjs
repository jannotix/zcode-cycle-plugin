import { execFile } from "node:child_process"
import { access, constants } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

// The daemon embeds CARGO_PKG_VERSION and the bridge refuses a daemon whose
// product version disagrees with the plugin manifest. A tracked binary built
// from an earlier version therefore ships an installation that cannot start,
// and nothing else in the repository compares the two. This does.
//
// It used to do it by scanning the executable for the expected version as a
// substring, and that is how a 1.0.5 linux daemon came to be reported as
// declaring 1.0.6: in a 39 MB binary the sequence "1.0.6" turns up on its own,
// in a dependency's metadata or a license or plain padding. The gate whose one
// job is to stop an unstartable installation passed the wrong daemon, and read
// as a pass while doing it.
//
// So the binary is asked. `workflowd --version` needs no data directory and no
// IPC handshake, and its answer cannot be produced by an accident of layout.
// A daemon for another platform cannot be run here, so it is reported as
// unverified rather than scanned and waved through - the two CI jobs between
// them execute both, and `--require` names the ones a given job must have
// actually run.

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const run = promisify(execFile)

// `bin/` is local assembly staging and is not tracked; `plugin/bin/` is what an
// installation actually receives. Both are checked, and a staging target that
// does not exist on this machine is skipped, because a fresh clone has none.
export const STAGING_TARGETS = ["bin/workflowd", "bin/workflowd.exe"]
export const SHIPPED_TARGETS = [
  "plugin/bin/linux-x64/workflowd",
  "plugin/bin/win32-x64/workflowd.exe",
]

/** Whether this machine can execute that binary, which is what makes the answer worth having. */
export function runnableHere(target, platform = process.platform) {
  const windows = target.endsWith(".exe")
  return platform === "win32" ? windows : !windows
}

export async function checkNativeVersions(
  root = ROOT,
  targets = [...STAGING_TARGETS, ...SHIPPED_TARGETS],
  platform = process.platform,
) {
  const manifest = JSON.parse(
    await (await import("node:fs/promises")).readFile(
      join(root, ".zcode-plugin", "plugin.json"),
      "utf8",
    ),
  )
  const expected = manifest.version
  if (typeof expected !== "string" || !expected) {
    throw new Error("plugin manifest version is missing")
  }

  const results = []
  for (const target of targets) {
    const path = join(root, target)
    try {
      await access(path, constants.F_OK)
    } catch (error) {
      if (error.code !== "ENOENT") throw error
      // Staging is absent in a fresh clone and that is not a defect. A shipped
      // binary is tracked, so its absence is one, and a check that quietly
      // examined nothing would be worse than no check at all.
      if (SHIPPED_TARGETS.includes(target)) {
        throw new Error(`a shipped daemon is missing from the plugin: ${target}`)
      }
      continue
    }
    if (!runnableHere(target, platform)) {
      results.push({ reason: "built for another platform", target, verified: false })
      continue
    }
    try {
      const { stdout } = await run(path, ["--version"], { timeout: 30_000 })
      results.push({ declared: stdout.trim(), target, verified: true })
    } catch (error) {
      results.push({ reason: `could not be asked: ${error.message}`, target, verified: false })
    }
  }
  return { expected, results }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // Every path this job is expected to have executed itself. Without it a job
  // whose daemon silently became unrunnable would report nothing but skips and
  // exit zero.
  const required = process.argv
    .slice(2)
    .filter((argument) => argument.startsWith("--require="))
    .flatMap((argument) => argument.slice("--require=".length).split(","))
    .filter(Boolean)

  const { expected, results } = await checkNativeVersions()
  let failed = false
  for (const { declared, reason, target, verified } of results) {
    if (!verified) {
      process.stdout.write(`${target}: not verified here (${reason})\n`)
      continue
    }
    if (declared === expected) {
      process.stdout.write(`${target}: ${declared}\n`)
    } else {
      failed = true
      process.stdout.write(`${target}: declares ${declared}, expected ${expected}\n`)
    }
  }
  for (const target of required) {
    if (!results.some((result) => result.target === target && result.verified)) {
      failed = true
      process.stdout.write(`${target}: required on this platform and was not verified\n`)
    }
  }
  if (failed) {
    process.stderr.write("a tracked daemon disagrees with the plugin manifest version\n")
    process.exit(1)
  }
  const verified = results.filter((result) => result.verified).length
  process.stdout.write(`${verified} tracked daemon(s) asked, every one declares ${expected}\n`)
}
