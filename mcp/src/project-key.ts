import { resolve } from "node:path"

/**
 * The project identity, derived from the directory the bridge is serving.
 *
 * `project_key` used to be whatever the calling agent chose to pass, and the run
 * protocol only described it as "this workspace's stable project key". It was
 * neither stable nor a key: in the 1.0.6 live certification the same folder was
 * addressed as `zcode-cycle-1.0.6-fixture-ec4b885a21197ed7` before a client
 * restart and as `zcode-cycle-1.0.6-fixture` after it. That produced two project
 * identities for one directory. History, goals and evidence recorded under one
 * are invisible to the other, a goal linked under one can never be satisfied by
 * a workflow recorded under the other, and nothing warned.
 *
 * The bridge already knows which directory it serves - `.mcp.json` starts it with
 * `cwd: ${ZCODE_PROJECT_DIR}` - so it derives the key itself. A caller cannot
 * drift from a value it does not choose.
 *
 * Projects certified before 1.0.7 keep whatever history was written under their
 * previous key: the ledger retains it, and a 1.0.6 build still reaches it.
 */
export function canonicalProjectKey(directory?: string): string {
  const absolute = resolve(directory ?? process.env.ZCODE_PROJECT_DIR ?? process.cwd())
  // A Windows drive letter's case is insignificant to the filesystem but not
  // stable across callers, and two spellings would be two identities again.
  return process.platform === "win32"
    ? absolute.replace(/^([a-z]):/u, (_match, letter: string) => `${letter.toUpperCase()}:`)
    : absolute
}
