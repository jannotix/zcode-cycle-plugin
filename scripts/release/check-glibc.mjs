import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

const binary = process.argv[2]
const maximum = process.argv[3] ?? "2.35"
if (!binary) throw new Error("Expected binary path and optional maximum GLIBC version")
if (!/^\d+\.\d+$/u.test(maximum)) throw new Error("Maximum GLIBC version must be major.minor")

const result = spawnSync("readelf", ["--version-info", resolve(binary)], {
  encoding: "utf8",
  shell: false,
})
if (result.error) throw result.error
if (result.status !== 0) throw new Error(result.stderr || "readelf failed")

const versions = [...result.stdout.matchAll(/GLIBC_(\d+)\.(\d+)/gu)].map((match) => [
  Number(match[1]),
  Number(match[2]),
])
if (versions.length === 0) throw new Error("No GLIBC requirement was found in the Linux binary")
versions.sort((left, right) => left[0] - right[0] || left[1] - right[1])
const required = versions.at(-1)
const allowed = maximum.split(".").map(Number)
if (required[0] > allowed[0] || (required[0] === allowed[0] && required[1] > allowed[1])) {
  throw new Error(`workflowd requires GLIBC_${required.join(".")}; maximum supported is GLIBC_${maximum}`)
}
process.stdout.write(`workflowd GLIBC baseline: ${required.join(".")} <= ${maximum}\n`)
