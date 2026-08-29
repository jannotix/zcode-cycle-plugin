import { mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(dirname(fileURLToPath(import.meta.url))))
const output = join(ROOT, "dist")
const temporary = join(ROOT, `.dist-${process.pid}`)

async function outputBytes(directory) {
  let bytes = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    bytes += entry.isDirectory() ? await outputBytes(path) : (await stat(path)).size
  }
  return bytes
}

await rm(temporary, { force: true, recursive: true })
await mkdir(temporary)
try {
  const result = await Bun.build({
    entrypoints: [
      join(ROOT, "src", "server.ts"),
      join(ROOT, "src", "cli.ts"),
      join(ROOT, "src", "client.ts"),
      join(ROOT, "src", "version.ts"),
    ],
    format: "esm",
    // Marketplace reviewers must be able to inspect the shipped runtime.
    // Bundling removes the installation-time dependency tree; it must not
    // make the resulting source opaque.
    minify: false,
    naming: {
      asset: "assets/[name]-[hash].[ext]",
      chunk: "chunks/[name]-[hash].[ext]",
      entry: "[name].[ext]",
    },
    outdir: temporary,
    packages: "bundle",
    sourcemap: "none",
    // Version discovery intentionally resolves from each public entrypoint's
    // import.meta.url. Shared chunks would move that URL one directory deeper
    // and make the manifest lookup depend on the bundler's chunk layout.
    splitting: false,
    target: "node",
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error("MCP bundle failed")
  }
  await rm(output, { force: true, recursive: true })
  await rename(temporary, output)
  const bytes = await outputBytes(output)
  process.stdout.write(`MCP bundle: ${result.outputs.length} files, ${bytes} bytes\n`)
} finally {
  await rm(temporary, { force: true, recursive: true })
}
