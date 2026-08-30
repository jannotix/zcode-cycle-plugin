import { spawn } from "node:child_process"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const output = resolve(process.argv[2] ?? join(ROOT, "THIRD-PARTY-RUST-LICENSES.html"))
await mkdir(dirname(output), { recursive: true })
const child = spawn(
  "cargo",
  [
    "about",
    "generate",
    join(ROOT, "scripts", "release", "rust-licenses.hbs"),
    "--output-file",
    output,
  ],
  { cwd: ROOT, shell: false, stdio: "inherit", windowsHide: true },
)
const exitCode = await new Promise((resolveExit, reject) => {
  child.once("error", reject)
  child.once("exit", (code, signal) => {
    if (signal !== null) reject(new Error(`cargo-about terminated by ${signal}`))
    else resolveExit(code ?? 1)
  })
})
if (exitCode !== 0) process.exit(exitCode)
if ((await stat(output)).size < 1024) {
  throw new Error("cargo-about returned an unexpectedly small notice file")
}
const normalized = (await readFile(output, "utf8"))
  .replaceAll("\r\n", "\n")
  .replace(/[\t ]+$/gmu, "")
await writeFile(output, normalized, "utf8")
process.stdout.write(`Rust dependency licenses written: ${output}\n`)
