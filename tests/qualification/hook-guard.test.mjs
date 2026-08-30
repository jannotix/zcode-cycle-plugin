import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const HOOK = join(ROOT, "hooks", "pre-tool-use.js")

function run(input, registry) {
  const dataDirectory = mkdtempSync(join(tmpdir(), "zcode-cycle-hook-test-"))
  try {
    if (registry !== undefined) {
      mkdirSync(join(dataDirectory, "runtime"), { recursive: true })
      writeFileSync(join(dataDirectory, "runtime", "role-sessions.json"), JSON.stringify(registry))
    }
    const result = spawnSync(process.execPath, [HOOK], {
      encoding: "utf8",
      env: {
        ...process.env,
        ZCODE_CYCLE_DATA_DIR: dataDirectory,
        ZCODE_PROJECT_DIR: ROOT,
      },
      input: typeof input === "string" ? input : JSON.stringify(input),
      shell: false,
    })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout).hookSpecificOutput
  } finally {
    rmSync(dataDirectory, { force: true, recursive: true })
  }
}

const denied = (result) => {
  assert.equal(result.permissionDecision, "deny")
  assert.equal(typeof result.permissionDecisionReason, "string")
  return result.permissionDecisionReason
}

const allowed = (result) => assert.equal(result.permissionDecision, "allow")

test("malformed input fails closed for a matched high-risk hook", () => {
  assert.match(denied(run("{not-json")), /malformed/u)
})

test("the host agent identity protects a read-only role even without the registry", () => {
  for (const toolName of ["Write", "Edit", "MultiEdit", "ApplyPatch", "NotebookEdit", "Bash", "Shell"])
    assert.match(
      denied(run({ agent_type: "zcode-cycle:functional-reviewer", toolName, toolInput: {} })),
      /read-only/u,
    )
})

test("a registered read-only role cannot mutate, run a shell or delegate", () => {
  const registry = {
    reviewer: {
      project_key: "project",
      registered_at_unix_millis: 1,
      role: "security_reviewer",
      workflow_id: null,
    },
  }
  for (const toolName of ["NotebookEdit", "Bash", "Task", "Agent"])
    assert.match(denied(run({ sessionId: "reviewer", toolName, toolInput: {} }, registry)), /read-only|delegate/u)
})

test("a conflicting host and registry identity is denied", () => {
  const registry = {
    role: {
      project_key: "project",
      registered_at_unix_millis: 1,
      role: "functional_reviewer",
      workflow_id: null,
    },
  }
  assert.match(
    denied(
      run(
        { agent_type: "zcode-cycle:executor", sessionId: "role", toolName: "Write", toolInput: {} },
        registry,
      ),
    ),
    /identity/u,
  )
})

test("the executor may commit but cannot delegate, rewrite history or publish", () => {
  const registry = {
    executor: {
      project_key: "project",
      registered_at_unix_millis: 1,
      role: "executor",
      workflow_id: null,
    },
  }
  allowed(run({ sessionId: "executor", toolName: "Bash", toolInput: { command: "git add src && git commit -m done" } }, registry))
  for (const command of ["git reset --hard HEAD", "git clean -fdx", "git rebase main", "git push origin main", "git tag v2"])
    assert.match(
      denied(run({ sessionId: "executor", toolName: "Bash", toolInput: { command } }, registry)),
      /may not run/u,
    )
  for (const toolName of ["Task", "Agent"])
    assert.match(denied(run({ sessionId: "executor", toolName, toolInput: {} }, registry)), /delegate/u)
})

test("an executor profile cannot mutate outside a uniquely registered workflow", () => {
  const input = {
    agent_type: "zcode-cycle:executor",
    sessionId: "child-session",
    toolName: "Write",
    toolInput: {},
  }
  assert.match(denied(run(input)), /no unique active workflow/u)

  const registered = {
    "role-token": {
      project_directory: ROOT,
      project_key: "project",
      registered_at_unix_millis: Date.now(),
      role: "executor",
      workflow_id: "workflow",
    },
  }
  allowed(run(input, registered))

  registered["second-token"] = { ...registered["role-token"] }
  assert.match(denied(run(input, registered)), /ambiguous/u)
})

test("an active workflow locks main-session mutation but still permits role dispatch", () => {
  const registry = {
    "workflow:active": {
      kind: "workflow_lock",
      project_directory: ROOT,
      project_key: "project",
      registered_at_unix_millis: 1,
      workflow_id: "active",
    },
  }
  for (const toolName of ["Write", "Edit", "MultiEdit", "ApplyPatch", "NotebookEdit", "Bash", "Shell"])
    assert.match(
      denied(run({ sessionId: "main", toolName, toolInput: {} }, registry)),
      /mutation-locked/u,
    )
  for (const toolName of ["Read", "Task", "Agent"])
    allowed(run({ sessionId: "main", toolName, toolInput: {} }, registry))

  registry.executor = {
    kind: "role",
    project_directory: ROOT,
    project_key: "project",
    registered_at_unix_millis: 2,
    role: "executor",
    workflow_id: "active",
  }
  allowed(run({ sessionId: "executor", toolName: "Write", toolInput: {} }, registry))
})

test("forbidden Git remains denied through options, paths, assignments and command chains", () => {
  const registry = {
    executor: {
      project_key: "project",
      registered_at_unix_millis: 1,
      role: "executor",
      workflow_id: null,
    },
  }
  for (const command of [
    "npm test && git reset --hard HEAD",
    "git -C . push origin main",
    "git --git-dir=.git --work-tree=. clean -fdx",
    "GIT_AUTHOR_NAME=cycle git rebase main",
    '"C:\\Program Files\\Git\\bin\\git.exe" tag v2',
  ])
    assert.match(
      denied(run({ sessionId: "executor", toolName: "Bash", toolInput: { command } }, registry)),
      /may not run/u,
      command,
    )
})

test("an unrelated valid session is not governed by Cycle", () => {
  allowed(run({ agent_type: "another-plugin:agent", toolName: "Write", toolInput: {} }))
})

test("shipped read-only agents do not declare mutating, shell or delegation tools", () => {
  for (const name of ["architect", "functional-reviewer", "security-reviewer", "arbiter"]) {
    const text = readFileSync(join(ROOT, "agents", `${name}.md`), "utf8")
    assert.match(text, new RegExp(`^name: zcode-cycle:${name}$`, "mu"))
    assert.match(text, /^thoughtLevel: high$/mu)
    const tools = text.match(/^tools:\s*(.+)$/mu)?.[1] ?? ""
    for (const deniedTool of ["Write", "Edit", "MultiEdit", "ApplyPatch", "NotebookEdit", "Bash", "Shell", "Task", "Agent"])
      assert.equal(tools.split(/\s*,\s*/u).includes(deniedTool), false, `${name} declares ${deniedTool}`)
  }
})
