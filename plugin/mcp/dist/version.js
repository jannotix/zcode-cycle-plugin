import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
export function productVersion(moduleUrl = import.meta.url) {
    const manifestPath = fileURLToPath(new URL("../../.zcode-plugin/plugin.json", moduleUrl));
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof manifest.version !== "string" || !SEMVER.test(manifest.version)) {
        throw new Error(`Cycle for Zcode manifest has an invalid version: ${manifestPath}`);
    }
    return manifest.version;
}
