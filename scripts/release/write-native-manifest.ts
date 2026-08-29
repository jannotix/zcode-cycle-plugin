import { resolve } from "node:path"

import { writeNativeManifest } from "../packaging/native-manifest.js"

const pluginDirectory = resolve(process.argv[2] ?? "plugin")
await writeNativeManifest(pluginDirectory)
process.stdout.write(`native manifest written: ${pluginDirectory}\n`)
