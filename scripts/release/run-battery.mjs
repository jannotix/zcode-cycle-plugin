import { spawn } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const values = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  const value = process.argv[index + 1]
  if (key === undefined || value === undefined || !key.startsWith("--")) {
    throw new Error("Expected --iterations and optional --binary arguments")
  }
  values.set(key.slice(2), value)
}

const iterations = Number(values.get("iterations") ?? "1")
if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 100) {
  throw new Error("--iterations must be an integer from 1 through 100")
}
const binary =
  values.get("binary") ??
  join(ROOT, "target", "release", process.platform === "win32" ? "workflowd.exe" : "workflowd")
const environment = {
  ...process.env,
  F6_BINARY: binary,
  F6_CLIENT: join(ROOT, "mcp", "dist", "client.js"),
  F6_HOOK: join(ROOT, "hooks", "pre-tool-use.js"),
  F6_PLUGIN_ROOT: ROOT,
  F6_ROOT: ROOT,
  F6_SERVER: join(ROOT, "mcp", "dist", "server.js"),
}

for (let iteration = 1; iteration <= iterations; iteration += 1) {
  const exitCode = await run([
    process.execPath,
    join(ROOT, "tests", "qualification", "battery.mjs"),
    `repeat-${iteration}`,
  ])
  if (exitCode !== 0) process.exit(exitCode)
}

process.stdout.write(`qualification battery: ${iterations}/${iterations} iterations passed\n`)

function run(command) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: ROOT,
      env: environment,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (signal !== null) reject(new Error(`battery terminated by ${signal}`))
      else resolveExit(code ?? 1)
    })
  })
}
