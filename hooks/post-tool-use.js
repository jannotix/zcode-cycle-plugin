// PostToolUse audit: records completed tool calls from registered role
// sessions to the project ledger. Fire-and-forget; never blocks the session.

const { createHash } = require("node:crypto")
const { readFile } = require("node:fs/promises")
const { join, posix, win32 } = require("node:path")
const { spawn } = require("node:child_process")

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

async function main() {
  const raw = await readStdin()
  let input
  try {
    input = JSON.parse(raw)
  } catch {
    return
  }
  const sessionId = input.sessionId ?? input.session_id
  if (typeof sessionId !== "string") return

  let registry
  try {
    registry = JSON.parse(
      await readFile(join(dataDirectory(), "runtime", "role-sessions.json"), "utf8"),
    )
  } catch {
    return
  }
  const registration = registry[sessionId]
  if (registration === undefined) return
  if (!process.env.ZCODE_PLUGIN_ROOT) return

  const observation = {
    actor_id: `role:${registration.role}`,
    candidate_id: null,
    data: {
      invocation_digest: createHash("sha256").update(raw).digest("hex"),
      tool: String(input.toolName ?? input.tool_name ?? "unknown"),
      type: "tool",
    },
    evidence_ids: [],
    files: [],
    metadata: { phase: "completed" },
    model: null,
    project_key: registration.project_key,
    role: LEDGER_ROLE[registration.role] ?? null,
    session_id: sessionId,
    task_id: null,
    timestamp_unix_millis: Date.now(),
    workflow_id: registration.workflow_id,
  }
  const child = spawn(process.execPath, ["mcp/dist/cli.js", "audit"], {
    cwd: process.env.ZCODE_PLUGIN_ROOT,
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
  })
  child.stdin.write(JSON.stringify(observation))
  child.stdin.end()
  child.unref()
}

main().catch(() => process.exit(0))
