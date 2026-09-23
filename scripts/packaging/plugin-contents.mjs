// What an installed plugin is made of.
//
// One list, imported by the assembler that writes plugin/ and by the verifier
// that proves plugin/ still matches source. They were two copies of the same
// array, which is a drift waiting to happen: an exclusion added to one and not
// the other either ships a file the verifier refuses or refuses a file that
// shipped.

export const COPY_MAPPINGS = [
  [".zcode-plugin/plugin.json", ".zcode-plugin/plugin.json"],
  [".mcp.json", ".mcp.json"],
  ["LICENSE", "LICENSE"],
  ["NOTICE", "NOTICE"],
  ["README.md", "README.md"],
  ["README_CN.md", "README_CN.md"],
  ["CHANGELOG.md", "CHANGELOG.md"],
  ["SECURITY.md", "SECURITY.md"],
  ["THIRD-PARTY-RUST-LICENSES.html", "THIRD-PARTY-RUST-LICENSES.html"],
  ["docs", "docs"],
  ["agents", "agents"],
  ["commands", "commands"],
  ["skills", "skills"],
  ["hooks/cycle-hooks.json", "hooks/cycle-hooks.json"],
  ["hooks/pre-tool-use.js", "hooks/pre-tool-use.js"],
  ["hooks/post-tool-use.js", "hooks/post-tool-use.js"],
  ["mcp/dist", "mcp/dist"],
]

/// Source paths that exist in the repository and must not reach an
/// installation, as repository-relative prefixes with forward slashes.
///
/// `docs/releases` is release engineering: the gate checklist, the npm
/// publication steps, the internal live-certification plan and the public
/// signing key. None of it is addressed to someone running the plugin, and the
/// signing key in particular is worse than useless inside the artifact it
/// verifies - a key shipped with the bytes it attests to proves nothing about
/// them. It stays in the repository and on the release page, where a user can
/// obtain it independently of the download.
export const EXCLUDED_FROM_PLUGIN = ["docs/releases"]

/// True when a repository-relative path must not be installed.
export function excludedFromPlugin(relativePath) {
  const path = relativePath.split(/[\\/]/u).join("/")
  return EXCLUDED_FROM_PLUGIN.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  )
}
