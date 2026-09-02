// PreToolUse enforcement for Cycle role sessions. Managed project profiles are
// the first boundary; this hook is the fail-closed runtime boundary; candidate
// reconciliation is the final boundary. It never relaxes a ZCode permission or
// confirmation decision.

const { createHash } = require("node:crypto")
const { readFile } = require("node:fs/promises")
const { join, posix, resolve, win32 } = require("node:path")
const { spawn } = require("node:child_process")

const MAX_HOOK_INPUT_BYTES = 1024 * 1024
const READ_ONLY_ROLES = new Set([
  "architect",
  "functional_reviewer",
  "security_reviewer",
  "arbiter",
])
const ALL_ROLES = new Set([...READ_ONLY_ROLES, "executor"])
const DENIED_FOR_READ_ONLY = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "ApplyPatch",
  "NotebookEdit",
  "Bash",
  "Shell",
])
const DELEGATION_TOOLS = new Set(["Task", "Agent", "SubAgent"])
const FORBIDDEN_GIT = new Set([
  "am",
  "branch",
  "checkout",
  "cherry-pick",
  "clean",
  "config",
  "fetch",
  "filter-branch",
  "gc",
  "maintenance",
  "merge",
  "notes",
  "prune",
  "pull",
  "push",
  "rebase",
  "remote",
  "replace",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "submodule",
  "switch",
  "symbolic-ref",
  "tag",
  "update-ref",
  "worktree",
])
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"])
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
  if (process.platform === "win32") return combine(requiredEnvironment("LOCALAPPDATA"), "ZCode Cycle")
  if (process.platform === "darwin") {
    return combine(requiredEnvironment("HOME"), "Library", "Application Support", "ZCode Cycle")
  }
  return combine(
    process.env.XDG_DATA_HOME || combine(requiredEnvironment("HOME"), ".local", "share"),
    "zcode-cycle",
  )
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (!value) throw new Error(`required environment variable ${name} is missing`)
  return value
}

function readStdin() {
  return new Promise((resolve) => {
    let data = ""
    let settled = false
    process.stdin.setEncoding("utf8")
    const settle = (value) => {
      if (settled) return
      settled = true
      process.stdin.off("data", onData)
      process.stdin.off("end", onEnd)
      process.stdin.destroy()
      resolve(value)
    }
    const onData = (chunk) => {
      data += chunk
      const newline = data.indexOf("\n")
      if (newline >= 0) {
        settle(data.slice(0, newline).replace(/\r$/u, ""))
      } else if (Buffer.byteLength(data) > MAX_HOOK_INPUT_BYTES) {
        settle(data)
      }
    }
    const onEnd = () => settle(data)
    process.stdin.on("data", onData)
    process.stdin.on("end", onEnd)
  })
}

async function readRegistry() {
  try {
    const parsed = JSON.parse(
      await readFile(join(dataDirectory(), "runtime", "role-sessions.json"), "utf8"),
    )
    return typeof parsed === "object" && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function roleFromAgent(input) {
  const candidates = [
    input.agent_type,
    input.agentType,
    input.subagent_type,
    input.agent?.type,
    input.context?.agent_type,
  ]
  for (const value of candidates) {
    if (typeof value !== "string") continue
    const prefix = value.startsWith("zcode-cycle:")
      ? "zcode-cycle:"
      : value.startsWith("cycle:")
        ? "cycle:"
        : null
    if (prefix === null) continue
    const role = value.slice(prefix.length).replaceAll("-", "_")
    if (ALL_ROLES.has(role)) return role
  }
  return null
}

function sameProject(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !left || !right) return false
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

function registrationForHostRole(registry, role) {
  const projectDirectory = process.env.ZCODE_PROJECT_DIR
  if (!projectDirectory) return { ambiguous: false, registration: undefined }
  const candidates = Object.values(registry).filter(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      item.role === role &&
      sameProject(item.project_directory, projectDirectory),
  )
  return candidates.length === 1
    ? { ambiguous: false, registration: candidates[0] }
    : { ambiguous: candidates.length > 1, registration: undefined }
}

function workflowLocksForProject(registry) {
  const projectDirectory = process.env.ZCODE_PROJECT_DIR
  if (!projectDirectory) return []
  return Object.values(registry).filter(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      item.kind === "workflow_lock" &&
      typeof item.workflow_id === "string" &&
      sameProject(item.project_directory, projectDirectory),
  )
}

function auditAsync(observation) {
  const pluginRoot = process.env.ZCODE_PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT
  if (!pluginRoot) return
  try {
    const child = spawn(process.execPath, ["mcp/dist/cli.js", "audit"], {
      cwd: pluginRoot,
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    })
    child.on("error", () => undefined)
    child.stdin.on("error", () => undefined)
    child.stdin.end(JSON.stringify(observation))
    child.unref()
  } catch {
    // The decision is authoritative even when best-effort audit delivery is unavailable.
  }
}

function decision(output, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: output,
        ...(reason ? { permissionDecisionReason: reason } : {}),
      },
    }),
  )
}

function commandSegments(command) {
  return command
    .split(/(?:&&|\|\||[;\n|])/u)
    .map((part) => part.trim())
    .filter(Boolean)
}

function commandTokens(segment) {
  const parts = []
  let current = ""
  let quote = null
  for (const character of segment) {
    if (quote !== null) {
      if (character === quote) quote = null
      else current += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (/\s/u.test(character)) {
      if (current) parts.push(current)
      current = ""
      continue
    }
    current += character
  }
  if (current) parts.push(current)
  return parts
}

function gitVerb(segment) {
  const parts = commandTokens(segment)
  let index = 0
  while (index < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(parts[index])) index += 1
  const program = parts[index]
  if (program === undefined) return null
  const base = program.split(/[\\/]/u).at(-1)?.replace(/\.exe$/iu, "")
  if (base !== "git") return null
  index += 1
  while (index < parts.length) {
    const option = parts[index]
    if (!option.startsWith("-")) return option.toLowerCase()
    if (option.includes("=")) {
      index += 1
      continue
    }
    index += GIT_OPTIONS_WITH_VALUE.has(option) ? 2 : 1
  }
  return null
}

function auditBase(raw, input, registration, role, toolName) {
  if (registration === undefined) return null
  const sessionId = input.sessionId ?? input.session_id
  return {
    actor_id: `role:${role}`,
    candidate_id: null,
    data: {
      invocation_digest: createHash("sha256").update(raw).digest("hex"),
      tool: String(toolName ?? "unknown"),
      type: "tool",
    },
    evidence_ids: [],
    files: [],
    metadata: {},
    model: null,
    project_key: registration.project_key,
    role: LEDGER_ROLE[role] ?? null,
    session_id: typeof sessionId === "string" ? sessionId : null,
    task_id: null,
    timestamp_unix_millis: Date.now(),
    workflow_id: registration.workflow_id ?? null,
  }
}

function deny(reason, audit) {
  if (audit !== null) auditAsync({ ...audit, metadata: { phase: "denied", reason } })
  decision("deny", `ZCode Cycle: ${reason}`)
}

async function main() {
  const raw = await readStdin()
  if (Buffer.byteLength(raw) > MAX_HOOK_INPUT_BYTES) {
    deny("hook input exceeded the safety limit", null)
    return
  }

  let input
  try {
    input = JSON.parse(raw)
  } catch {
    deny("malformed hook input was denied fail closed", null)
    return
  }
  if (typeof input !== "object" || input === null) {
    deny("malformed hook input was denied fail closed", null)
    return
  }

  const sessionId = input.sessionId ?? input.session_id
  const toolName = String(input.toolName ?? input.tool_name ?? "")
  const registry = await readRegistry()
  const candidateRegistration = typeof sessionId === "string" ? registry[sessionId] : undefined
  const directRegistration =
    typeof candidateRegistration === "object" &&
    candidateRegistration !== null &&
    ALL_ROLES.has(candidateRegistration.role)
      ? candidateRegistration
      : undefined
  const registeredRole =
    directRegistration !== undefined && ALL_ROLES.has(directRegistration.role)
      ? directRegistration.role
      : null
  const hostRole = roleFromAgent(input)

  if (registeredRole !== null && hostRole !== null && registeredRole !== hostRole) {
    deny("role identity mismatch between the host payload and Cycle registry", null)
    return
  }

  const fallback =
    directRegistration === undefined && hostRole !== null
      ? registrationForHostRole(registry, hostRole)
      : { ambiguous: false, registration: undefined }
  if (fallback.ambiguous) {
    deny("multiple active workflow registrations made the role identity ambiguous", null)
    return
  }
  const registration = directRegistration ?? fallback.registration

  const role = registeredRole ?? hostRole
  if (role === null) {
    const workflowLocks = workflowLocksForProject(registry)
    const requestedRole =
      DELEGATION_TOOLS.has(toolName)
        ? roleFromAgent({
            agent_type:
              input.toolInput?.subagent_type ??
              input.toolInput?.agent_type ??
              input.tool_input?.subagent_type ??
              input.tool_input?.agent_type,
          })
        : null
    if (DELEGATION_TOOLS.has(toolName) && requestedRole !== null) {
      const requestedRegistration = registrationForHostRole(registry, requestedRole)
      if (requestedRegistration.ambiguous) {
        deny("multiple active workflow registrations made the requested Cycle role ambiguous", null)
        return
      }
      if (requestedRegistration.registration === undefined) {
        deny("a Cycle role dispatch requires a unique active registration", null)
        return
      }
    }
    if (workflowLocks.length > 0 && DELEGATION_TOOLS.has(toolName)) {
      if (requestedRole === null) {
        deny(
          "an active Cycle workflow may dispatch only an exact zcode-cycle role profile",
          null,
        )
        return
      }
    }
    if (workflowLocks.length > 0 && DENIED_FOR_READ_ONLY.has(toolName)) {
      deny(
        "the main orchestrator is mutation-locked while a Cycle workflow is active; dispatch a registered executor",
        null,
      )
      return
    }
    decision("allow")
    return
  }
  const audit = auditBase(raw, input, registration, role, toolName)

  if (DELEGATION_TOOLS.has(toolName)) {
    deny(`${role} may not delegate or spawn a subagent`, audit)
    return
  }
  if (READ_ONLY_ROLES.has(role) && DENIED_FOR_READ_ONLY.has(toolName)) {
    deny(`${role} is read-only and cannot use ${toolName || "an unidentified high-risk tool"}`, audit)
    return
  }

  if (
    role === "executor" &&
    registration === undefined &&
    (DENIED_FOR_READ_ONLY.has(toolName) || toolName === "Bash" || toolName === "Shell")
  ) {
    deny("the executor has no unique active workflow registration", audit)
    return
  }

  if (role === "executor" && (toolName === "Bash" || toolName === "Shell")) {
    const command = String(input.toolInput?.command ?? input.tool_input?.command ?? "")
    for (const segment of commandSegments(command)) {
      const verb = gitVerb(segment)
      if (verb !== null && FORBIDDEN_GIT.has(verb)) {
        deny(`the executor may not run git ${verb}`, audit)
        return
      }
    }
  }

  if (audit !== null) auditAsync({ ...audit, metadata: { phase: "started" } })
  decision("allow")
}

main().catch(() => {
  deny("the role boundary failed internally and denied the call", null)
})
