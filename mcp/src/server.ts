import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"

import {
  LocalControlPlane,
  resolveDataDirectory,
  type ControlOperation,
  type HistoryOperation,
  type MemoryOperation,
} from "./client.js"

// Role session registry: the bridge writes it, the PreToolUse hook reads it.
// The agents' tool whitelists are the primary role boundary; this is the
// audited second layer.
interface RoleRegistration {
  readonly project_key: string
  readonly registered_at_unix_millis: number
  readonly role: string
  readonly workflow_id: string | null
}

const READ_ONLY_ROLES = new Set([
  "architect",
  "functional_reviewer",
  "security_reviewer",
  "arbiter",
])
const MUTATING_TOOLS = new Set(["Edit", "Write", "ApplyPatch", "MultiEdit"])

const SERVER_INFO = { name: "zcode-cycle", version: "1.0.0" }
const PROTOCOL_VERSION = "2025-06-18"

const plane = new LocalControlPlane({
  ...(process.env.ZCODE_CYCLE_BINARY
    ? { binaryPath: process.env.ZCODE_CYCLE_BINARY }
    : {}),
  ...(process.env.ZCODE_CYCLE_DATA_DIR
    ? { dataDirectory: process.env.ZCODE_CYCLE_DATA_DIR }
    : {}),
  stopOwnedProcessOnDispose: false,
})

const registryPath = join(
  process.env.ZCODE_CYCLE_DATA_DIR ?? resolveDataDirectory(process.platform, process.env),
  "runtime",
  "role-sessions.json",
)

async function readRegistry(): Promise<Record<string, RoleRegistration>> {
  try {
    return JSON.parse(await readFile(registryPath, "utf8")) as Record<string, RoleRegistration>
  } catch {
    return {}
  }
}

async function writeRegistry(registry: Record<string, RoleRegistration>): Promise<void> {
  await mkdir(dirname(registryPath), { recursive: true })
  const temporary = `${registryPath}.tmp`
  await writeFile(temporary, JSON.stringify(registry, null, 1), "utf8")
  await rm(registryPath, { force: true })
  await rename(temporary, registryPath)
}

function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null)
}

interface ToolDefinition {
  readonly description: string
  readonly inputSchema: object
}

async function callTool(name: string, rawArgs: unknown): Promise<unknown> {
  const args = (typeof rawArgs === "object" && rawArgs !== null ? rawArgs : {}) as Record<
    string,
    unknown
  >
  const projectKey = typeof args.project_key === "string" ? args.project_key : ""
  switch (name) {
    case "cycle_health":
      return plane.health()
    case "cycle_start": {
      const preference =
        args.preference === "quick" || args.preference === "full" || args.preference === "auto"
          ? args.preference
          : undefined
      return plane.startWorkflow({
        originalRequest: text(args.original_request),
        ...(preference !== undefined ? { preference } : {}),
        projectKey,
        ...(Array.isArray(args.affected_paths)
          ? { affectedPaths: args.affected_paths.map(String) }
          : {}),
        ...(Array.isArray(args.attachment_hashes)
          ? { attachmentHashes: args.attachment_hashes.map(String) }
          : {}),
      })
    }
    case "cycle_control":
      return plane.control(
        projectKey,
        (args.operation as ControlOperation) ?? "status",
        typeof args.workflow_id === "string" ? args.workflow_id : undefined,
      )
    case "cycle_audit": {
      const observation = args.observation
      if (typeof observation !== "object" || observation === null) {
        throw new Error("cycle_audit requires an observation object")
      }
      return plane.audit(observation as Parameters<typeof plane.audit>[0])
    }
    case "cycle_history":
      return plane.history(
        projectKey,
        (args.operation as HistoryOperation) ?? { type: "query", after_sequence: null, limit: 50 },
      )
    case "cycle_memory":
      return plane.memory(projectKey, args.operation as MemoryOperation)
    case "cycle_goal":
      return plane.goal(projectKey, args.operation as Parameters<typeof plane.goal>[1])
    case "cycle_admission":
      return plane.admission(
        projectKey,
        text(args.workflow_id),
        text(args.workspace),
        args.operation === "renew" || args.operation === "release" ? args.operation : "acquire",
      )
    case "cycle_role_register": {
      const sessionId = text(args.session_id)
      const role = text(args.role)
      if (!sessionId || ![...READ_ONLY_ROLES, "executor"].includes(role)) {
        throw new Error("cycle_role_register requires session_id and a known role")
      }
      const registry = await readRegistry()
      registry[sessionId] = {
        project_key: projectKey,
        registered_at_unix_millis: Date.now(),
        role,
        workflow_id: typeof args.workflow_id === "string" ? args.workflow_id : null,
      }
      await writeRegistry(registry)
      return { registered: sessionId, role }
    }
    case "cycle_role_revoke": {
      const sessionId = text(args.session_id)
      const registry = await readRegistry()
      const revoked = registry[sessionId] ?? null
      delete registry[sessionId]
      await writeRegistry(registry)
      return { revoked }
    }
    case "cycle_role_list":
      return readRegistry()
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}

const TOOLS: Record<string, ToolDefinition> = {
  cycle_health: {
    description:
      "Check the ZCode Cycle control plane: spawns or attaches the local workflowd daemon and returns product and protocol versions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  cycle_start: {
    description:
      "Start a governed workflow for the exact original user request. Returns the workflow id, the deterministic route (quick or full) and the immutable request digest.",
    inputSchema: {
      type: "object",
      properties: {
        original_request: { type: "string" },
        project_key: { type: "string" },
        preference: { enum: ["auto", "quick", "full"] },
        affected_paths: { type: "array", items: { type: "string" } },
        attachment_hashes: { type: "array", items: { type: "string" } },
      },
      required: ["original_request", "project_key"],
      additionalProperties: false,
    },
  },
  cycle_control: {
    description:
      "Control or inspect workflows: status, tasks, evidence, doctor, pause, resume, cancel, retry, recovery.",
    inputSchema: {
      type: "object",
      properties: {
        project_key: { type: "string" },
        operation: {
          enum: [
            "cancel",
            "doctor",
            "evidence",
            "pause",
            "recovery",
            "resume",
            "retry",
            "status",
            "tasks",
          ],
        },
        workflow_id: { type: "string" },
      },
      required: ["project_key", "operation"],
      additionalProperties: false,
    },
  },
  cycle_audit: {
    description:
      "Append a tamper-evident audit observation to the project ledger (actor, role, session, digests, metadata).",
    inputSchema: {
      type: "object",
      properties: {
        observation: { type: "object" },
      },
      required: ["observation"],
      additionalProperties: false,
    },
  },
  cycle_history: {
    description: "Query, export or verify the project audit ledger.",
    inputSchema: {
      type: "object",
      properties: {
        project_key: { type: "string" },
        operation: { type: "object" },
      },
      required: ["project_key"],
      additionalProperties: false,
    },
  },
  cycle_memory: {
    description: "Search, explain or remove reusable project knowledge.",
    inputSchema: {
      type: "object",
      properties: { project_key: { type: "string" }, operation: { type: "object" } },
      required: ["project_key", "operation"],
      additionalProperties: false,
    },
  },
  cycle_goal: {
    description:
      "Manage persistent goals: create, amend, focus, link workflows, save versioned plans, control lifecycle.",
    inputSchema: {
      type: "object",
      properties: { project_key: { type: "string" }, operation: { type: "object" } },
      required: ["project_key", "operation"],
      additionalProperties: false,
    },
  },
  cycle_admission: {
    description:
      "Acquire, renew or release a workflow resource permit (bounded concurrent workflows per project).",
    inputSchema: {
      type: "object",
      properties: {
        project_key: { type: "string" },
        workflow_id: { type: "string" },
        workspace: { type: "string" },
        operation: { enum: ["acquire", "renew", "release"] },
      },
      required: ["project_key", "workflow_id", "workspace", "operation"],
      additionalProperties: false,
    },
  },
  cycle_role_register: {
    description:
      "Register a dispatched role session (architect, executor, functional_reviewer, security_reviewer, arbiter) so the PreToolUse hook enforces its boundaries and audits its tool use.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        role: {
          enum: [
            "architect",
            "executor",
            "functional_reviewer",
            "security_reviewer",
            "arbiter",
          ],
        },
        project_key: { type: "string" },
        workflow_id: { type: "string" },
      },
      required: ["session_id", "role", "project_key"],
      additionalProperties: false,
    },
  },
  cycle_role_revoke: {
    description: "Revoke a registered role session when its dispatch completes.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  cycle_role_list: {
    description: "List registered role sessions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
}

interface JsonRpcRequest {
  readonly id?: unknown
  readonly method: string
  readonly params?: unknown
}

function writeMessage(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function reply(id: unknown, result: unknown): void {
  writeMessage({ id, jsonrpc: "2.0", result })
}

function replyError(id: unknown, code: number, message: string): void {
  writeMessage({ error: { code, message }, id, jsonrpc: "2.0" })
}

async function handle(request: JsonRpcRequest): Promise<void> {
  const { id, method } = request
  switch (method) {
    case "initialize":
      reply(id, {
        capabilities: { tools: { listChanged: false } },
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
      })
      return
    case "notifications/initialized":
      return
    case "ping":
      reply(id, {})
      return
    case "tools/list":
      reply(id, {
        tools: Object.entries(TOOLS).map(([name, tool]) => ({
          description: tool.description,
          inputSchema: tool.inputSchema,
          name,
        })),
      })
      return
    case "tools/call": {
      const params = (request.params ?? {}) as { arguments?: unknown; name?: string }
      const name = typeof params.name === "string" ? params.name : ""
      if (!(name in TOOLS)) {
        replyError(id, -32602, `unknown tool: ${name}`)
        return
      }
      try {
        const result = await callTool(name, params.arguments)
        reply(id, {
          content: [{ text: JSON.stringify(result, null, 1), type: "text" }],
          isError: false,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        reply(id, {
          content: [{ text: message, type: "text" }],
          isError: true,
        })
      }
      return
    }
    default:
      if (id !== undefined) replyError(id, -32601, `method not found: ${method}`)
  }
}

async function main(): Promise<void> {
  const stdin = createInterface({ input: process.stdin })
  stdin.on("line", (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let request: JsonRpcRequest
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest
    } catch {
      return
    }
    void handle(request).catch(() => {
      if (request.id !== undefined) {
        replyError(request.id, -32603, "internal error")
      }
    })
  })
  process.stdin.on("close", () => {
    void plane.dispose().finally(() => process.exit(0))
  })
}

void main()
