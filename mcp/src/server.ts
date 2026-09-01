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
import { architecturePlanSchema, validateArchitecturePlan } from "./architecture-plan.js"
import { manageRoleProfiles } from "./role-profiles.js"
import { productVersion } from "./version.js"

// Role session registry: the bridge writes it, the PreToolUse hook reads it.
// Managed project profile tool whitelists are the primary role boundary; this is the
// audited second layer.
interface RoleRegistration {
  readonly kind?: "role"
  readonly project_directory: string
  readonly project_key: string
  readonly registered_at_unix_millis: number
  readonly role: string
  readonly workflow_id: string | null
}

interface WorkflowLock {
  readonly kind: "workflow_lock"
  readonly project_directory: string
  readonly project_key: string
  readonly registered_at_unix_millis: number
  readonly workflow_id: string
}

type RegistryRecord = RoleRegistration | WorkflowLock

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

interface BrowserRuntime {
  attest(args: Record<string, unknown>): Promise<readonly unknown[]>
  dispose(): Promise<void>
  run(input: {
    readonly command: Record<string, unknown>
    readonly registration: { role: string } | undefined
    readonly sessionId: string
  }): Promise<unknown>
}

let browserRuntimePromise: Promise<BrowserRuntime> | undefined

function browserRuntime(): Promise<BrowserRuntime> {
  browserRuntimePromise ??= import(new URL("./browser-runtime.js", import.meta.url).href).then(
    (module: { createBrowserRuntime(options: object): BrowserRuntime }) =>
      module.createBrowserRuntime({ allowedOrigins, dataDirectory }),
  )
  return browserRuntimePromise
}

async function readRegistry(): Promise<Record<string, RegistryRecord>> {
  try {
    return JSON.parse(await readFile(registryPath, "utf8")) as Record<string, RegistryRecord>
  } catch {
    return {}
  }
}

async function writeRegistry(registry: Record<string, RegistryRecord>): Promise<void> {
  await mkdir(dirname(registryPath), { recursive: true })
  const temporary = `${registryPath}.tmp`
  await writeFile(temporary, JSON.stringify(registry, null, 1), "utf8")
  await rm(registryPath, { force: true })
  await rename(temporary, registryPath)
}

function isRoleRegistration(value: RegistryRecord | undefined): value is RoleRegistration {
  return value !== undefined && value.kind !== "workflow_lock" && typeof value.role === "string"
}

function isWorkflowLock(value: RegistryRecord | undefined): value is WorkflowLock {
  return value?.kind === "workflow_lock"
}

function workflowLockKey(workflowId: string): string {
  return `workflow:${workflowId}`
}

async function lockWorkflow(projectKey: string, workflowId: string): Promise<void> {
  const registry = await readRegistry()
  registry[workflowLockKey(workflowId)] = {
    kind: "workflow_lock",
    project_directory: process.env.ZCODE_PROJECT_DIR ?? process.cwd(),
    project_key: projectKey,
    registered_at_unix_millis: Date.now(),
    workflow_id: workflowId,
  }
  await writeRegistry(registry)
}

async function unlockWorkflow(workflowId: string): Promise<void> {
  const registry = await readRegistry()
  delete registry[workflowLockKey(workflowId)]
  for (const [key, value] of Object.entries(registry)) {
    if (isRoleRegistration(value) && value.workflow_id === workflowId) delete registry[key]
  }
  await writeRegistry(registry)
}

function terminalWorkflowState(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  const state = record.state ?? record.workflowState
  return state === "completed" || state === "cancelled"
}

async function requireRoleSession(
  args: Record<string, unknown>,
  expectedRoles: ReadonlySet<string>,
  projectKey: string,
  workflowId: string,
): Promise<RoleRegistration> {
  const sessionId = text(args.role_session_id)
  const registration = (await readRegistry())[sessionId]
  if (
    !UUID.test(sessionId) ||
    !isRoleRegistration(registration) ||
    !expectedRoles.has(registration.role) ||
    registration.project_key !== projectKey ||
    registration.workflow_id !== workflowId
  ) {
    throw new Error(
      `role-bound submission requires an active ${[...expectedRoles].join(" or ")} role_session_id`,
    )
  }
  return registration
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
      return { ...(await plane.health()), data_directory: dataDirectory }
    case "cycle_start": {
      const preference =
        args.preference === "quick" || args.preference === "full" || args.preference === "auto"
          ? args.preference
          : undefined
      const started = await plane.startWorkflow({
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
      try {
        await lockWorkflow(projectKey, started.workflowId)
      } catch (error) {
        await plane.control(projectKey, "cancel", started.workflowId).catch(() => undefined)
        throw error
      }
      return {
        ...started,
        next_phase: "architecture",
        orchestrator_locked: true,
      }
    }
    case "cycle_control": {
      const workflowId = typeof args.workflow_id === "string" ? args.workflow_id : undefined
      const result = await plane.control(
        projectKey,
        (args.operation as ControlOperation) ?? "status",
        workflowId,
      )
      if (workflowId !== undefined && terminalWorkflowState(result)) await unlockWorkflow(workflowId)
      return result
    }
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
    case "cycle_role_profiles": {
      const operation =
        args.operation === "install" ||
        args.operation === "repair" ||
        args.operation === "configure" ||
        args.operation === "remove"
          ? args.operation
          : "status"
      const pluginRoot = process.env.ZCODE_PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT
      if (!pluginRoot) throw new Error("cycle_role_profiles requires ZCODE_PLUGIN_ROOT")
      return manageRoleProfiles({
        operation,
        pluginRoot,
        projectRoot: process.env.ZCODE_PROJECT_DIR ?? process.cwd(),
        ...(typeof args.confirmation === "string" ? { confirmation: args.confirmation } : {}),
        ...(typeof args.model === "string" ? { model: args.model } : {}),
        ...(typeof args.role === "string" ? { role: args.role } : {}),
        ...(typeof args.thought_level === "string" ? { thoughtLevel: args.thought_level } : {}),
      })
    }
    case "cycle_role_register": {
      const sessionId = text(args.session_id)
      const role = text(args.role)
      if (!UUID.test(sessionId) || ![...READ_ONLY_ROLES, "executor"].includes(role)) {
        throw new Error("cycle_role_register requires a UUID session_id and a known role")
      }
      const registry = await readRegistry()
      const workflowId = typeof args.workflow_id === "string" ? args.workflow_id : null
      if (workflowId !== null) {
        const lock = registry[workflowLockKey(workflowId)]
        if (!isWorkflowLock(lock) || lock.project_key !== projectKey) {
          throw new Error("cycle_role_register requires an active workflow lock")
        }
      }
      registry[sessionId] = {
        kind: "role",
        project_directory: process.env.ZCODE_PROJECT_DIR ?? process.cwd(),
        project_key: projectKey,
        registered_at_unix_millis: Date.now(),
        role,
        workflow_id: workflowId,
      }
      await writeRegistry(registry)
      return { registered: sessionId, role }
    }
    case "cycle_role_revoke": {
      const sessionId = text(args.session_id)
      const registry = await readRegistry()
      const revoked = isRoleRegistration(registry[sessionId]) ? registry[sessionId] : null
      if (revoked !== null) delete registry[sessionId]
      await writeRegistry(registry)
      return { revoked }
    }
    case "cycle_role_list": {
      const registry = await readRegistry()
      return Object.fromEntries(
        Object.entries(registry).filter(([, value]) => isRoleRegistration(value)),
      )
    }
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
      if (!workflowId) {
        throw new Error("cycle_submit_architecture requires workflow_id and a plan object")
      }
      const plan = validateArchitecturePlan(args.plan)
      await requireRoleSession(args, new Set(["architect"]), projectKey, workflowId)
      await plane.submitArchitecture(projectKey, workflowId, plan)
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
      if (Array.isArray(args.browser_session_ids) && args.browser_session_ids.length > 0) {
        attestations = [...attestations, ...(await (await browserRuntime()).attest(args))]
      }
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
      const registration = (await readRegistry())[sessionId]
      return (await browserRuntime()).run({
        command: args,
        registration: isRoleRegistration(registration) ? registration : undefined,
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
      await requireRoleSession(
        args,
        new Set(["functional_reviewer", "security_reviewer"]),
        projectKey,
        workflowId,
      )
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
      await requireRoleSession(args, new Set(["arbiter"]), projectKey, workflowId)
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
      const result = await plane.promoteCandidate(projectKey, workflowId, candidateId, projectDirectory)
      if (terminalWorkflowState(result)) await unlockWorkflow(workflowId)
      return result
    }
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}

const TOOLS: Record<string, ToolDefinition> = {
  cycle_health: {
    description:
      "Check the Cycle control plane: spawns or attaches the local workflowd daemon and returns product/protocol/schema versions plus the authoritative data directory.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  cycle_start: {
    description:
      "Start a governed workflow for the exact original user request. Returns the workflow id, deterministic route and immutable request digest, and locks main-session mutation until terminal cleanup; dispatch registered roles for all implementation.",
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
      "Register a dispatched role session (architect, executor, functional_reviewer, security_reviewer, arbiter) against an active workflow lock so the PreToolUse hook enforces its boundaries and audits its tool use.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", pattern: UUID.source },
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
  cycle_role_profiles: {
    description:
      "Inspect or explicitly install, repair, configure or remove the five managed Cycle role profiles under the current project's .zcode/agents directory. Mutations require the operation-specific confirmation token and a session restart.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { enum: ["status", "install", "repair", "configure", "remove"] },
        confirmation: { type: "string" },
        role: {
          enum: [
            "architect",
            "executor",
            "functional-reviewer",
            "security-reviewer",
            "arbiter",
          ],
        },
        model: { type: "string" },
        thought_level: { enum: ["low", "high", "max", "enabled", "off"] },
      },
      required: ["operation"],
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
      "Submit the architect's task graph with its active architect role_session_id. The bridge and daemon reject unbound roles, invalid graphs and out-of-order submissions.",
    inputSchema: {
      type: "object",
      properties: {
        project_key: { type: "string" },
        workflow_id: { type: "string" },
        role_session_id: { type: "string" },
        plan: architecturePlanSchema,
      },
      required: ["project_key", "workflow_id", "role_session_id", "plan"],
      additionalProperties: false,
    },
  },
  cycle_prepare_worktree: {
    description:
      "After an accepted architecture, prepare the isolated git worktree and record its base revision. The main session is mutation-locked: dispatch a registered executor into the returned path and never edit project_directory.",
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
      "Submit an independent review verdict with the active functional or security reviewer role_session_id.",
    inputSchema: {
      type: "object",
      properties: {
        project_key: { type: "string" },
        workflow_id: { type: "string" },
        candidate_id: { type: "string" },
        role_session_id: { type: "string" },
        verdict: { type: "object" },
      },
      required: ["project_key", "workflow_id", "candidate_id", "role_session_id", "verdict"],
      additionalProperties: false,
    },
  },
  cycle_submit_arbitration: {
    description:
      "Submit the arbiter's final verdict with its active arbiter role_session_id. Only valid after verification (and reviews in full mode).",
    inputSchema: {
      type: "object",
      properties: {
        project_key: { type: "string" },
        workflow_id: { type: "string" },
        candidate_id: { type: "string" },
        role_session_id: { type: "string" },
        verdict: { type: "object" },
      },
      required: ["project_key", "workflow_id", "candidate_id", "role_session_id", "verdict"],
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
    const disposeBrowser = browserRuntimePromise?.then((runtime) => runtime.dispose())
    void Promise.allSettled([
      plane.dispose(),
      ...(disposeBrowser === undefined ? [] : [disposeBrowser]),
    ]).finally(() => process.exit(0))
  })
}

void main()
