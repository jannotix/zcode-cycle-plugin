import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// Verify a *published* release, not the sealed directory it came from.
//
// `verify-release-manifest.mjs` already compares both directions - every
// declared artifact must exist, and every existing file must be declared. It
// was never wrong. It was only ever aimed at CI's own output, which by
// construction contains what CI just wrote. Publication is a separate, manual
// step, and nothing stood between the two: 1.0.7, 1.0.8 and 1.0.9 each shipped
// with two declared artifacts that were never uploaded, and each was reported
// as verified because what was checked was the set that happened to be present.
//
// So this script adds no new check. It points the existing one at the bytes a
// user can actually download.
//
//   node scripts/release/verify-published-release.mjs v1.0.9 [owner/repo]

const tag = process.argv[2]
if (!tag) throw new Error("Expected a release tag, e.g. v1.0.9")
const repository = process.argv[3] ?? "jannotix/zcode-cycle-plugin"

// Both reach a child process, and on Windows `gh` is not always a real
// executable, so the command may be re-parsed by cmd. Constrain them here
// rather than trusting the quoting of whatever ends up running them.
const NAME = "[A-Za-z0-9][A-Za-z0-9._-]*"
if (!new RegExp(`^${NAME}$`, "u").test(tag)) throw new Error(`refusing tag: ${tag}`)
if (!new RegExp(`^${NAME}/${NAME}$`, "u").test(repository)) {
  throw new Error(`refusing repository: ${repository}`)
}

const verifier = resolve(dirname(fileURLToPath(import.meta.url)), "verify-release-manifest.mjs")
const directory = await mkdtemp(join(tmpdir(), "published-release-"))
try {
  const download = run(["release", "download", tag, "--repo", repository, "--dir", directory, "--clobber"])
  if (download.error) throw download.error
  if (download.status !== 0) {
    throw new Error(`could not download ${tag} from ${repository}: ${(download.stderr ?? "").trim()}`)
  }

  const verified = spawnSync(process.execPath, [verifier, directory], { encoding: "utf8" })
  process.stderr.write(verified.stderr)
  process.stdout.write(verified.stdout)
  if (verified.status !== 0) {
    throw new Error(
      `${tag} does not match the manifest it publishes - a declared artifact is missing, ` +
        `an undeclared one was uploaded, or a digest does not match`,
    )
  }
  process.stdout.write(`published release verified: ${tag}\n`)
} finally {
  await rm(directory, { force: true, recursive: true })
}

// Run `gh` without a shell. Windows needs the extension spelled out, because
// spawn will not try `.exe` or `.cmd` on its own, and it refuses to execute a
// `.cmd` directly - so a script wrapper goes through cmd explicitly. The
// arguments are constrained above, which is what makes that safe.
function run(args) {
  const options = { encoding: "utf8" }
  if (process.platform !== "win32") return spawnSync("gh", args, options)
  const resolved = locate()
  return resolved.toLowerCase().endsWith(".exe")
    ? spawnSync(resolved, args, options)
    : spawnSync("cmd.exe", ["/d", "/s", "/c", resolved, ...args], options)
}

function locate() {
  for (const directory of (process.env.PATH ?? "").split(";").filter(Boolean)) {
    for (const name of ["gh.exe", "gh.cmd", "gh.bat"]) {
      const candidate = join(directory, name)
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error("gh was not found on PATH")
}
