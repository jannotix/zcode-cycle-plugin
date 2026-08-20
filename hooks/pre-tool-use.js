// PreToolUse enforcement for registered role sessions. Reads the hook input,
// checks the role registry written by the MCP bridge, denies mutating tools
// from read-only roles, and records the decision to the project ledger.

const { createHash } = require("node:crypto")
const { readFile } = require("node:fs/promises")
const { join, posix, win32 } = require("node:path")
const { spawn } = require("node:child_process")

const READ_ONLY_ROLES = new Set([
  "architect",
  "functional_reviewer",
  "security_reviewer",
  "arbiter",
])
const DENIED_FOR_READ_ONLY = new Set(["Edit", "Write", "MultiEdit", "ApplyPatch", "Bash"])
const LEDGER_ROLE = {
  architect: "architect",
  executor: "executor",
  functional_reviewer: "functional_reviewer",
  security_reviewer: "security_architecture_reviewer",
  arbiter: "arbiter",
}

function dataDirectory() {
  if (process.env.ZCODE_CYCLE_DATA_DIR) return process.env.ZCODE_CYCLE_DATA_DIR
  const combine = process.platform === "win32" ? win32.join : posix.join
  if (process.platform === "win32") {
    return combine(process.env.LOCALAPPDATA, "ZCode Cycle")
  }
  if (process.platform === "darwin") {
    return combine(process.env.HOME, "Library", "Application Support", "ZCode Cycle")
  }
  return combine(process.env.XDG_DATA_HOME || combine(process.env.HOME, ".local", "share"), "zcode-cycle")
}

function readStdin() {
  return new Promise((resolve) => {
    let data = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk) => (data += chunk))
    process.stdin.on("end", () => resolve(data))
  })
}

async function readRegistry() {
  try {
    return JSON.parse(await readFile(join(dataDirectory(), "runtime", "role-sessions.json"), "utf8"))
  } catch {
    return {}
  }
}

function auditAsync(observation) {
  const pluginRoot = process.env.ZCODE_PLUGIN_ROOT
  if (!pluginRoot) return
  const child = spawn(process.execPath, ["mcp/dist/cli.js", "audit"], {
    cwd: pluginRoot,
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
  })
  child.stdin.write(JSON.stringify(observation))
  child.stdin.end()
  child.unref()
}

function decision(output) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: output,
      },
    }),
  )
}

async function main() {
  const raw = await readStdin()
  let input
  try {
    input = JSON.parse(raw)
  } catch {
    decision("allow")
    return
  }

  const sessionId = input.sessionId ?? input.session_id
  const toolName = input.toolName ?? input.tool_name
  const registry = await readRegistry()
  const registration = typeof sessionId === "string" ? registry[sessionId] : undefined

  if (registration === undefined) {
    decision("allow")
    return
  }

  const invocationDigest = createHash("sha256").update(raw).digest("hex")
  const auditBase = {
    actor_id: `role:${registration.role}`,
    candidate_id: null,
    data: { invocation_digest: invocationDigest, tool: String(toolName ?? "unknown"), type: "tool" },
    evidence_ids: [],
    files: [],
    metadata: {},
    model: null,
    project_key: registration.project_key,
    role: LEDGER_ROLE[registration.role] ?? null,
    session_id: typeof sessionId === "string" ? sessionId : null,
    task_id: null,
    timestamp_unix_millis: Date.now(),
    workflow_id: registration.workflow_id,
  }

  if (READ_ONLY_ROLES.has(registration.role) && DENIED_FOR_READ_ONLY.has(toolName)) {
    auditAsync({
      ...auditBase,
      metadata: { phase: "denied", reason: "read-only role boundary" },
    })
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `ZCode Cycle: the ${registration.role} role is read-only and cannot use ${toolName}.`,
        },
      }),
    )
    return
  }

  auditAsync({ ...auditBase, metadata: { phase: "started" } })
  decision("allow")
}

main().catch(() => process.exit(1))
