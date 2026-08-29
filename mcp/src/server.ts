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
import { BrowserEvidenceRegistry } from "./browser/browser-evidence.js"
import { BrowserManager } from "./browser/browser-manager.js"
import { ManagedBrowserSessionFactory } from "./browser/managed-browser-session.js"
import { attestForVerification, browserRun } from "./browser/browser-ops.js"
import { productVersion } from "./version.js"

// Role session registry: the bridge writes it, the PreToolUse hook reads it.
// The agents' tool whitelists are the primary role boundary; this is the
// audited second layer.
interface RoleRegistration {
  readonly project_key: string
  readonly registered_at_unix_millis: number
  readonly role: string
  readonly workflow_id: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const READ_ONLY_ROLES = new Set([
  "architect",
  "functional_reviewer",
  "security_reviewer",
  "arbiter",
])
const MUTATING_TOOLS = new Set(["Edit", "Write", "ApplyPatch", "MultiEdit"])

const SERVER_INFO = { name: "zcode-cycle", version: productVersion() }
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

const dataDirectory =
  process.env.ZCODE_CYCLE_DATA_DIR ?? resolveDataDirectory(process.platform, process.env)

const registryPath = join(dataDirectory, "runtime", "role-sessions.json")

const allowedOrigins = process.env.ZCODE_CYCLE_BROWSER_ALLOWED_ORIGINS?.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean)

const browserManager = new BrowserManager({
  ...(allowedOrigins !== undefined && allowedOrigins.length > 0 ? { allowedOrigins } : {}),
  artifactDirectory: join(dataDirectory, "browser"),
  create: (input) =>
    new ManagedBrowserSessionFactory({
      ...(process.env.ZCODE_CYCLE_BROWSER ? { browserExecutable: process.env.ZCODE_CYCLE_BROWSER } : {}),
      headless: process.env.ZCODE_CYCLE_BROWSER_HEADLESS !== "false",
      projectDirectory: process.env.ZCODE_PROJECT_DIR ?? process.cwd(),
    }).create(input),
  maxSessions: 2,
})

const browserEvidence = new BrowserEvidenceRegistry(join(dataDirectory, "browser"))

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
    case "cycle_code_index": {
      const projectDirectory = text(args.project_directory)
      const workflowId = text(args.workflow_id)
      if (!projectDirectory || !workflowId) {
        throw new Error("cycle_code_index requires project_directory and workflow_id")
      }
      return plane.codeIndex(projectKey, workflowId, projectDirectory)
    }
    case "cycle_submit_architecture": {
      const workflowId = text(args.workflow_id)
      const plan = args.plan
      if (!workflowId || typeof plan !== "object" || plan === null) {
        throw new Error("cycle_submit_architecture requires workflow_id and a plan object")
      }
      await plane.submitArchitecture(
        projectKey,
        workflowId,
        plan as Parameters<typeof plane.submitArchitecture>[2],
      )
      return { accepted: true, workflow_id: workflowId }
    }
    case "cycle_prepare_worktree": {
      const workflowId = text(args.workflow_id)
      const projectDirectory = text(args.project_directory)
      if (!workflowId || !projectDirectory) {
        throw new Error("cycle_prepare_worktree requires workflow_id and project_directory")
      }
      return plane.prepareWorktree(projectKey, projectDirectory, workflowId)
    }
    case "cycle_plan_verification": {
      const workflowId = text(args.workflow_id)
      const planId = UUID.test(String(args.plan_id ?? ""))
        ? (String(args.plan_id) as Parameters<typeof plane.planVerification>[2])
        : undefined
      if (!workflowId) throw new Error("cycle_plan_verification requires workflow_id")
      return plane.planVerification(projectKey, workflowId, planId)
    }
    case "cycle_freeze_candidate": {
      const workflowId = text(args.workflow_id)
      const baseRevision = text(args.base_revision)
      const planId = text(args.plan_id)
      if (!workflowId || !baseRevision || !planId) {
        throw new Error(
          "cycle_freeze_candidate requires workflow_id, base_revision and plan_id",
        )
      }
      const evidenceIds = Array.isArray(args.evidence_ids)
        ? args.evidence_ids.map(String)
        : []
      return plane.freezeCandidate(projectKey, workflowId, baseRevision, planId, evidenceIds)
    }
    case "cycle_verify_candidate": {
      const workflowId = text(args.workflow_id)
      const candidateId = text(args.candidate_id)
      const planId = text(args.plan_id)
      if (!workflowId || !candidateId || !planId) {
        throw new Error(
          "cycle_verify_candidate requires workflow_id, candidate_id and plan_id",
        )
      }
      let attestations = Array.isArray(args.attestations) ? args.attestations : []
      attestations = [
        ...attestations,
        ...(await attestForVerification(args, browserEvidence)),
      ]
      return plane.verifyCandidate(
        projectKey,
        workflowId,
        candidateId,
        planId,
        attestations as Parameters<typeof plane.verifyCandidate>[4],
      )
    }
    case "cycle_browser": {
      const sessionId = text(args.session_id)
      if (!sessionId || !text(args.operation)) {
        throw new Error("cycle_browser requires session_id and operation")
      }
      return browserRun({
        command: args,
        manager: browserManager,
        registration: (await readRegistry())[sessionId],
        registry: browserEvidence,
        sessionId,
      })
    }
    case "cycle_submit_review": {
      const workflowId = text(args.workflow_id)
      const candidateId = text(args.candidate_id)
      const verdict = args.verdict
      if (!workflowId || !candidateId || typeof verdict !== "object" || verdict === null) {
        throw new Error("cycle_submit_review requires workflow_id, candidate_id and verdict")
      }
      return plane.submitReview(
        projectKey,
        workflowId,
        candidateId,
        verdict as Parameters<typeof plane.submitReview>[3],
      )
    }
    case "cycle_submit_arbitration": {
      const workflowId = text(args.workflow_id)
      const candidateId = text(args.candidate_id)
      const verdict = args.verdict
      if (!workflowId || !candidateId || typeof verdict !== "object" || verdict === null) {
        throw new Error(
          "cycle_submit_arbitration requires workflow_id, candidate_id and verdict",
        )
      }
      return plane.submitArbitration(
        projectKey,
        workflowId,
        candidateId,
        verdict as Parameters<typeof plane.submitArbitration>[3],
      )
    }
    case "cycle_report_execution": {
      const workflowId = text(args.workflow_id)
      const outcome = args.outcome === "plan_defect" ? "plan_defect" : "blocked"
      if (!workflowId) throw new Error("cycle_report_execution requires workflow_id")
      const workflowState = await plane.reportExecution(projectKey, workflowId, outcome)
      return { outcome, workflow_id: workflowId, workflow_state: workflowState }
    }
    case "cycle_promote_candidate": {
      const workflowId = text(args.workflow_id)
      const candidateId = text(args.candidate_id)
      const projectDirectory = text(args.project_directory)
      if (!workflowId || !candidateId || !projectDirectory) {
        throw new Error(
          "cycle_promote_candidate requires workflow_id, candidate_id and project_directory",
        )
      }
      return plane.promoteCandidate(projectKey, workflowId, candidateId, projectDirectory)
    }
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
  cycle_browser: {
    description:
      "Control an isolated managed browser for QA evidence: open (loopback allowed by default; external origins require approve_origin after explicit user approval), snapshot, click, fill, press, upload, check, screenshot, logs, close. Interactive actions (click, fill, press, upload) require an executor-registered session. Close captures the evidence receipt bound to the session; pass browser_session_ids plus candidate_digest to cycle_verify_candidate for browser evidence gates.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        operation: {
          enum: [
            "open",
            "snapshot",
            "click",
            "fill",
            "press",
            "upload",
            "check",
            "screenshot",
            "logs",
            "close",
          ],
        },
        approve_origin: { type: "boolean" },
        url: { type: "string" },
        selector: { type: "string" },
        testId: { type: "string" },
        role: { type: "string" },
        name: { type: "string" },
        text: { type: "string" },
        value: { type: "string" },
        environmentVariable: { type: "string" },
        key: { type: "string" },
        path: { type: "string" },
        expectedText: { type: "string" },
        expectedUrl: { type: "string" },
        exact: { type: "boolean" },
        fullPage: { type: "boolean" },
      },
      required: ["session_id", "operation"],
      additionalProperties: false,
    },
  },
  cycle_code_index: {
    description:
      "Request the incremental code intelligence index for a workflow: scoped symbol graph context for the architect, without rescanning unchanged files.",
    inputSchema: {
      type: "object",
      properties: {
        project_key: { type: "string" },
        workflow_id: { type: "string" },
        project_directory: { type: "string" },
      },
      required: ["project_key", "workflow_id", "project_directory"],
      additionalProperties: false,
    },
  },
  cycle_submit_architecture: {
    description:
      "Submit the architect's task graph for validation and state transition. The daemon rejects invalid graphs and out-of-order submissions.",
    inputSchema: {
      type: "object",
      properties: {
        project_key: { type: "string" },
        workflow_id: { type: "string" },
        plan: { type: "object" },
      },
      required: ["project_key", "workflow_id", "plan"],
      additionalProperties: false,
    },
  },
  cycle_prepare_worktree: {
    description:
      "Prepare the isolated git worktree for execution and record its base revision.",
    inputSchema: {
      type: "object",
      properties: {
        project_key: { type: "string" },
        workflow_id: { type: "string" },
        project_directory: { type: "string" },
      },
      required: ["project_key", "workflow_id", "project_directory"],
      additionalProperties: false,
    },
  },
  cycle_plan_verification: {
    description:
      "Plan the verification gates for the pending candidate; returns the plan id and evidence ids.",
    inputSchema: {
      type: "object",
      properties: {
        project_key: { type: "string" },
        workflow_id: { type: "string" },
        plan_id: { type: "string" },
      },
      required: ["project_key", "workflow_id"],
      additionalProperties: false,
    },
  },
  cycle_freeze_candidate: {
    description:
      "Freeze the exact candidate from the worktree: manifest with per-file digests, diff and environment digests. Verification always runs against the frozen candidate.",
    inputSchema: {
      type: "object",
      properties: {
        project_key: { type: "string" },
        workflow_id: { type: "string" },
        base_revision: { type: "string" },
        plan_id: { type: "string" },
        evidence_ids: { type: "array", items: { type: "string" } },
      },
      required: ["project_key", "workflow_id", "base_revision", "plan_id"],
      additionalProperties: false,
    },
  },
  cycle_verify_candidate: {
    description:
      "Run the mandatory verification gates against the frozen candidate. Returns per-gate evidence records and the mandatory pass verdict; failures drive the repair loop. Pass browser_session_ids and the frozen candidate_digest to include managed-browser attestations as browser evidence gates.",
    inputSchema: {
      type: "object",
      properties: {
        project_key: { type: "string" },
        workflow_id: { type: "string" },
        candidate_id: { type: "string" },
        plan_id: { type: "string" },
        attestations: { type: "array", items: { type: "object" } },
        browser_session_ids: { type: "array", items: { type: "string" } },
        candidate_digest: { type: "string" },
      },
      required: ["project_key", "workflow_id", "candidate_id", "plan_id"],
      additionalProperties: false,
    },
  },
  cycle_submit_review: {
    description:
      "Submit an independent review verdict (functional or security reviewer) for the frozen candidate.",
    inputSchema: {
      type: "object",
      properties: {
        project_key: { type: "string" },
        workflow_id: { type: "string" },
        candidate_id: { type: "string" },
        verdict: { type: "object" },
      },
      required: ["project_key", "workflow_id", "candidate_id", "verdict"],
      additionalProperties: false,
    },
  },
  cycle_submit_arbitration: {
    description:
      "Submit the arbiter's final verdict. Only valid after verification (and reviews in full mode); the daemon refuses out-of-order arbitration.",
    inputSchema: {
      type: "object",
      properties: {
        project_key: { type: "string" },
        workflow_id: { type: "string" },
        candidate_id: { type: "string" },
        verdict: { type: "object" },
      },
      required: ["project_key", "workflow_id", "candidate_id", "verdict"],
      additionalProperties: false,
    },
  },
  cycle_report_execution: {
    description:
      "Report an execution outcome the orchestrator cannot resolve: blocked, or plan_defect to restart planning.",
    inputSchema: {
      type: "object",
      properties: {
        project_key: { type: "string" },
        workflow_id: { type: "string" },
        outcome: { enum: ["blocked", "plan_defect"] },
      },
      required: ["project_key", "workflow_id", "outcome"],
      additionalProperties: false,
    },
  },
  cycle_promote_candidate: {
    description:
      "Promote the approved candidate from the worktree to the project directory and deliver it.",
    inputSchema: {
      type: "object",
      properties: {
        project_key: { type: "string" },
        workflow_id: { type: "string" },
        candidate_id: { type: "string" },
        project_directory: { type: "string" },
      },
      required: ["project_key", "workflow_id", "candidate_id", "project_directory"],
      additionalProperties: false,
    },
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
    void Promise.allSettled([plane.dispose(), browserManager.dispose()]).finally(() =>
      process.exit(0),
    )
  })
}

void main()
