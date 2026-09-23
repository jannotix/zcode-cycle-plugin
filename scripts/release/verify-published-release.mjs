import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { mkdtemp, readdir, rm } from "node:fs/promises"
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

const here = dirname(fileURLToPath(import.meta.url))
const verifier = resolve(here, "verify-release-manifest.mjs")
const receiptVerifier = resolve(here, "verify-zcode-live-receipt.mjs")
const signingKey = resolve(here, "..", "..", "docs", "releases", "release-signing-key.asc")
const SIGNER = "29CB2E3FA61B8A2FFE97BF87CC4D1A39CE15684F"
const directory = await mkdtemp(join(tmpdir(), "published-release-"))
const certification = await mkdtemp(join(tmpdir(), "published-certification-"))
try {
  const download = run(["release", "download", tag, "--repo", repository, "--dir", directory, "--clobber"])
  if (download.error) throw download.error
  if (download.status !== 0) {
    throw new Error(`could not download ${tag} from ${repository}: ${(download.stderr ?? "").trim()}`)
  }

  // The live-certification receipt travels as one asset beside the sealed
  // ones, and is the only thing that may: a release marked stable must carry a
  // receipt that verifies against this release's own sealed archive, signed by
  // the release key. A pre-release may carry none - that is what makes it one.
  const view = run(["release", "view", tag, "--repo", repository, "--json", "isPrerelease"])
  if (view.error) throw view.error
  if (view.status !== 0) throw new Error(`could not read ${tag}: ${(view.stderr ?? "").trim()}`)
  const prerelease = JSON.parse(view.stdout).isPrerelease === true
  const bundle = (await readdir(directory)).find((name) => /^zcode-live-certification-[0-9A-Za-z.-]+\.tgz$/u.test(name))
  if (bundle) {
    verifyCertification(join(directory, bundle))
    await rm(join(directory, bundle))
    process.stdout.write(`live certification verified: ${bundle}\n`)
  } else if (!prerelease) {
    throw new Error(`${tag} is marked stable but carries no live certification receipt`)
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
  await rm(certification, { force: true, recursive: true })
}

// Unpacks the bundle and runs the existing receipt verifier against this
// release's downloaded sealed artifacts, with the public release key imported
// into a throwaway keyring so the caller's own is never touched.
function verifyCertification(bundlePath) {
  const unpacked = spawnSync("tar", ["-xzf", bundlePath, "-C", certification], { encoding: "utf8" })
  if (unpacked.error) throw unpacked.error
  if (unpacked.status !== 0) throw new Error(`live certification bundle is unreadable: ${unpacked.stderr.trim()}`)
  const keyring = join(certification, ".gnupg")
  mkdirSync(keyring, { mode: 0o700 })
  // Git for Windows ships an MSYS gpg that cannot read a Windows path from the
  // environment, so the keyring is named relative to the working directory -
  // which every gpg understands - and the key is handed over on stdin.
  const env = { ...process.env, GNUPGHOME: ".gnupg" }
  const imported = spawnSync("gpg", ["--batch", "--import"], {
    cwd: certification,
    encoding: "utf8",
    env,
    input: readFileSync(signingKey),
  })
  if (imported.error) throw imported.error
  if (imported.status !== 0) throw new Error(`could not import the release signing key: ${imported.stderr.trim()}`)
  const checked = spawnSync(
    process.execPath,
    [
      receiptVerifier,
      "--receipt", join(certification, "zcode-live-certification.json"),
      "--signature", join(certification, "zcode-live-certification.json.asc"),
      "--signer-fingerprint", SIGNER,
      "--sealed", directory,
    ],
    { cwd: certification, encoding: "utf8", env },
  )
  process.stderr.write(checked.stderr)
  process.stdout.write(checked.stdout)
  if (checked.status !== 0) {
    throw new Error("the live certification receipt attached to this release does not verify")
  }
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
