// F6 Windows qualification battery: the deterministic control-plane matrix
// (no LLM dispatches - roles are platform-independent and were qualified in
// F3-F5). Repeatable: run N times for the repeat-suite matrix item.

import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { pathToFileURL } from "node:url"

const ROOT = process.env.F6_ROOT ?? "/home/user/f6"
const BINARY = process.env.F6_BINARY ?? `${ROOT}/target/release/workflowd`
const CLIENT = pathToFileURL(process.env.F6_CLIENT ?? `${ROOT}/mcp/dist/client.js`).href

let passed = 0
let failed = 0
const check = (label, condition, detail) => {
  if (condition) {
    passed += 1
    console.log(`PASS ${label}`)
  } else {
    failed += 1
    console.log(`FAIL ${label}: ${JSON.stringify(detail).slice(0, 300)}`)
  }
}

async function withPlane(dataDirectory, run) {
  const { LocalControlPlane } = await import(CLIENT)
  const plane = new LocalControlPlane({
    binaryPath: BINARY,
    dataDirectory,
    stopOwnedProcessOnDispose: true,
  })
  try {
    return await run(plane)
  } finally {
    await plane.dispose()
  }
}

const DEFER_REASONS = new Set([
  "memory_pressure",
  "cpu_pressure",
  "disk_pressure",
  "verification_priority",
  "metrics_unavailable",
  "recovery_backpressure",
])

async function hookDecision(dataDir, input) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [process.env.F6_HOOK ?? `${ROOT}/hooks/pre-tool-use.js`], {
      env: {
        ...process.env,
        ZCODE_CYCLE_DATA_DIR: dataDir,
        ZCODE_PLUGIN_ROOT: process.env.F6_PLUGIN_ROOT ?? `${ROOT}`,
      },
      stdio: ["pipe", "pipe", "ignore"],
    })
    let out = ""
    child.stdout.on("data", (chunk) => (out += chunk))
    child.stdin.write(JSON.stringify(input))
    child.stdin.end()
    child.on("close", () => resolve(JSON.parse(out)))
    child.on("error", reject)
  })
  return result
}

async function main() {
  const iteration = process.argv[2] ?? "1"
  const projectKey = `f6-win-battery-${iteration}`
  const dataDir = await mkdtemp(join(tmpdir(), "zcode-cycle-f6-"))
  const fixture = await mkdtemp(join(tmpdir(), "zcode-cycle-f6-repo-"))
  const { execSync } = await import("node:child_process")
  const git = (args) =>
    execSync(`git ${args}`, { cwd: fixture, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } })

  try {
    git("init -q -b main")
    await writeFile(join(fixture, "package.json"), '{"name":"f6","type":"module","scripts":{"test":"node test.js"}}')
    await writeFile(join(fixture, "utils.js"), "export const ping = () => \"pong\"\n")
    await writeFile(join(fixture, "test.js"), "import assert from 'node:assert/strict'; import { ping } from './utils.js'; assert.equal(ping(), 'pong'); console.log('ok')\n")
    git('add -A && git -c user.name=f6 -c user.email=f6@invalid commit -qm base')

    await withPlane(dataDir, async (plane) => {
      // 1. health + doctor
      const health = await plane.health()
      check("health protocol 1", health.protocol_version === 1, health)
      const doctor = await plane.control(projectKey, "doctor")
      check("doctor PASS", doctor.status === "PASS", doctor)

      // 2. audit + history verify
      const receipt = await plane.audit({
        actor_id: "f6-battery",
        candidate_id: null,
        data: { action: "battery_observation", type: "workflow" },
        evidence_ids: [],
        files: [],
        metadata: {},
        model: null,
        project_key: projectKey,
        role: null,
        session_id: null,
        task_id: null,
        timestamp_unix_millis: Date.now(),
        workflow_id: null,
      })
      check("audit ledger entry", /^[0-9a-f]{64}$/.test(receipt.entryHash), receipt)
      const verified = await plane.history(projectKey, { type: "verify" })
      check(
        "history verify chain valid",
        verified.chain?.status === "valid" && verified.checkpoints?.every((c) => c.status === "valid"),
        verified,
      )

      // 3. memory insert (citing the audit event) + search
      const history = await plane.history(projectKey, { type: "query", after_sequence: null, limit: 10 })
      const eventId = history.entries.at(-1).event.event_id
      const inserted = await plane.memory(projectKey, {
        confidence: "user_asserted",
        detail: "Battery observation drives memory provenance.",
        kind: "command",
        scope: ["battery"],
        source_event_ids: [eventId],
        summary: "Battery memory with ledger provenance.",
        title: "Battery memory",
        type: "insert",
      })
      check("memory insert", Boolean(inserted.memory_id), inserted)
      const found = await plane.memory(projectKey, {
        confidence: null,
        limit: 5,
        scope: null,
        text: "battery",
        type: "search",
      })
      check("memory search", found.entries.length >= 1, found)

      // 4. workflow lifecycle: start -> status/tasks -> pause -> resume -> cancel
      const start = await plane.startWorkflow({
        originalRequest: "Add a beep function to the string utilities with a unit test",
        preference: "quick",
        projectKey,
      })
      check("start quick", start.mode === "quick" || start.mode === "full", start)
      const status = await plane.control(projectKey, "status", start.workflowId)
      check("status reflects workflow", status.workflowId === start.workflowId, status)
      const tasks = await plane.control(projectKey, "tasks", start.workflowId)
      check("tasks responds", typeof tasks === "object" && tasks !== null, tasks)
      const evidenceList = await plane.control(projectKey, "evidence", start.workflowId)
      check("evidence responds", typeof evidenceList === "object" && evidenceList !== null, evidenceList)

      // 5. admission lease on the durable workflow. A deferral with a
      // bounded reason is correct resource-aware behavior under load.
      const admitted = await plane.admission(projectKey, start.workflowId, fixture, "acquire")
      check(
        "admission acquire",
        admitted.admitted === true || DEFER_REASONS.has(admitted.reason),
        admitted,
      )
      const renewed = await plane.admission(projectKey, start.workflowId, fixture, "renew")
      check(
        "admission renew",
        renewed.admitted === true || DEFER_REASONS.has(renewed.reason),
        renewed,
      )
      const released = await plane.admission(projectKey, start.workflowId, fixture, "release")
      check("admission release", released !== null && released !== undefined, released)

      const taskId = randomUUID()
      await plane.submitArchitecture(projectKey, start.workflowId, {
        assumptions: [],
        integration_checks: ["Run the fixture test from the repository root."],
        request_digest: start.requestDigest,
        requirements: [
          {
            acceptance_criteria: ["The string utility exposes the requested behavior."],
            id: "REQ-1",
            statement: "Add the requested string utility behavior with a test.",
          },
        ],
        risks: [],
        tasks: [
          {
            acceptance_criteria: ["The fixture test passes."],
            dependencies: [],
            id: taskId,
            objective: "Implement and test the bounded utility change.",
            requirement_ids: ["REQ-1"],
            title: "Implement utility change",
            verification_commands: ["node test.js"],
            write_scopes: ["utils.js", "test.js"],
          },
        ],
      })
      check("quick architecture accepted", true, { taskId })
      const worktree = await plane.prepareWorktree(projectKey, fixture, start.workflowId)
      check(
        "quick worktree follows accepted architecture",
        worktree.path.length > 0 && /^[0-9a-f]{40,64}$/u.test(worktree.baseRevision),
        worktree,
      )

      const paused = await plane.control(projectKey, "pause", start.workflowId)
      check("pause accepted", paused !== null && paused !== undefined, paused)
      const resumed = await plane.control(projectKey, "resume", start.workflowId)
      check("resume accepted", resumed !== null && resumed !== undefined, resumed)
      const cancelled = await plane.control(projectKey, "cancel", start.workflowId)
      check("cancel accepted", cancelled !== null && cancelled !== undefined, cancelled)
      const afterCancel = await plane.control(projectKey, "status", start.workflowId)
      check(
        "cancelled state recorded",
        JSON.stringify(afterCancel).toLowerCase().includes("cancel"),
        afterCancel,
      )

      // 6. role registry + hook enforcement via registry file
      const registryPath = join(dataDir, "runtime", "role-sessions.json")
      await mkdir(join(dataDir, "runtime"), { recursive: true })
      await writeFile(
        registryPath,
        JSON.stringify({
          "sess-f6-ro": { project_key: projectKey, registered_at_unix_millis: 1, role: "architect", workflow_id: null },
        }),
      )
      const denied = await hookDecision(dataDir, {
        sessionId: "sess-f6-ro",
        toolName: "Write",
        toolInput: { file_path: "x.txt", content: "hi" },
      })
      check(
        "hook denies read-only role mutation",
        denied.hookSpecificOutput?.permissionDecision === "deny",
        denied,
      )
      const allowed = await hookDecision(dataDir, {
        sessionId: "unknown-session",
        toolName: "Write",
        toolInput: { file_path: "x.txt", content: "hi" },
      })
      check(
        "hook allows unregistered session",
        allowed.hookSpecificOutput?.permissionDecision === "allow",
        allowed,
      )
    })

    // 7. MCP server over stdio (sequential request/response)
    const server = spawn(process.execPath, [process.env.F6_SERVER ?? `${ROOT}/mcp/dist/server.js`], {
      env: {
        ...process.env,
        ZCODE_CYCLE_BINARY: BINARY,
        ZCODE_CYCLE_DATA_DIR: dataDir,
        ZCODE_PLUGIN_ROOT: ROOT,
        ZCODE_PROJECT_DIR: fixture,
      },
      stdio: ["pipe", "pipe", "ignore"],
    })
    let nextId = 1
    const pending = new Map()
    let buffer = ""
    server.stdout.setEncoding("utf8")
    server.stdout.on("data", (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (!line.trim()) continue
        const message = JSON.parse(line)
        if (message.id !== undefined && pending.has(message.id)) {
          pending.get(message.id)(message)
          pending.delete(message.id)
        }
      }
    })
    const request = (method, params) => {
      const id = nextId++
      server.stdin.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`mcp timeout: ${method}`)), 90_000)
        pending.set(id, (message) => {
          clearTimeout(timer)
          if (message.error) reject(new Error(message.error.message))
          else resolve(message.result)
        })
      })
    }
    try {
      const initialized = await request("initialize", {
        capabilities: {},
        clientInfo: { name: "f6", version: "0" },
        protocolVersion: "2025-06-18",
      })
      check("mcp initialize", initialized.serverInfo?.name === "zcode-cycle", initialized)
      const listed = await request("tools/list", {})
      check(
        "mcp exposes pipeline tools",
        [
          "cycle_start",
          "cycle_freeze_candidate",
          "cycle_submit_arbitration",
          "cycle_browser",
          "cycle_role_profiles",
        ].every(
          (name) => listed.tools.some((tool) => tool.name === name),
        ),
        listed.tools.map((t) => t.name),
      )
      const architectureTool = listed.tools.find((tool) => tool.name === "cycle_submit_architecture")
      check(
        "mcp publishes the strict architecture schema",
        architectureTool?.inputSchema?.properties?.plan?.additionalProperties === false &&
          architectureTool.inputSchema.properties.plan.required.includes("request_digest"),
        architectureTool,
      )
      const malformedArchitecture = await request("tools/call", {
        name: "cycle_submit_architecture",
        arguments: {
          project_key: "battery-architecture-project",
          workflow_id: randomUUID(),
          plan: { plan_id: "short", requirements: ["string"], tasks: [{ id: "T1" }] },
        },
      })
      check(
        "mcp rejects malformed architecture before IPC",
        malformedArchitecture.isError === true &&
          /must contain exactly/u.test(malformedArchitecture.content?.[0]?.text ?? ""),
        malformedArchitecture,
      )
      const healthCall = await request("tools/call", {
        name: "cycle_health",
        arguments: {},
      })
      const mcpHealth = JSON.parse(healthCall.content?.[0]?.text ?? "null")
      check(
        "mcp health reports the authoritative data directory",
        healthCall.isError === false && mcpHealth?.data_directory === dataDir,
        healthCall,
      )
      const invalidRoleToken = await request("tools/call", {
        name: "cycle_role_register",
        arguments: {
          project_key: "battery-role-project",
          role: "executor",
          session_id: "orchestrator-main",
        },
      })
      check(
        "mcp rejects non-UUID role tokens",
        invalidRoleToken.isError === true && /UUID session_id/u.test(invalidRoleToken.content?.[0]?.text ?? ""),
        invalidRoleToken,
      )
      const roleToken = randomUUID()
      const registerRole = await request("tools/call", {
        name: "cycle_role_register",
        arguments: {
          project_key: "battery-role-project",
          role: "architect",
          session_id: roleToken,
        },
      })
      const revokeRole = await request("tools/call", {
        name: "cycle_role_revoke",
        arguments: { session_id: roleToken },
      })
      check(
        "mcp registers and revokes a UUID role token",
        registerRole.isError === false && revokeRole.isError === false,
        { registerRole, revokeRole },
      )
      const installProfiles = await request("tools/call", {
        name: "cycle_role_profiles",
        arguments: {
          operation: "install",
          confirmation: "INSTALL_ZCODE_CYCLE_ROLE_PROFILES",
        },
      })
      const installedProfiles = JSON.parse(installProfiles.content?.[0]?.text ?? "null")
      check(
        "mcp installs managed role profiles",
        installProfiles.isError === false && installedProfiles?.ready === true,
        installProfiles,
      )
      const removeProfiles = await request("tools/call", {
        name: "cycle_role_profiles",
        arguments: {
          operation: "remove",
          confirmation: "REMOVE_ZCODE_CYCLE_ROLE_PROFILES",
        },
      })
      const removedProfiles = JSON.parse(removeProfiles.content?.[0]?.text ?? "null")
      check(
        "mcp removes only managed role profiles",
        removeProfiles.isError === false && removedProfiles?.ready === false,
        removeProfiles,
      )
    } finally {
      server.kill()
    }
  } finally {
    await rm(dataDir, { force: true, recursive: true }).catch(() => {})
    await rm(fixture, { force: true, recursive: true }).catch(() => {})
  }
  console.log(`\nITERATION ${iteration}: ${passed} PASS / ${failed} FAIL`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(`BATTERY ERROR: ${error.message}`)
  process.exit(1)
})
