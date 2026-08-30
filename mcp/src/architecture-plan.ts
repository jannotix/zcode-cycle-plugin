import type { ArchitecturePlanInput } from "./client.js"

const MAX_ITEMS = 256
const MAX_TEXT_BYTES = 4096
const KEY = /^[A-Za-z0-9._-]{1,64}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

const text = { type: "string", minLength: 1, maxLength: MAX_TEXT_BYTES }
const textList = { type: "array", items: text, maxItems: MAX_ITEMS }

export const architecturePlanSchema = {
  type: "object",
  properties: {
    assumptions: textList,
    integration_checks: { ...textList, minItems: 1 },
    request_digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    requirements: {
      type: "array",
      minItems: 1,
      maxItems: MAX_ITEMS,
      items: {
        type: "object",
        properties: {
          acceptance_criteria: { ...textList, minItems: 1 },
          id: { type: "string", pattern: "^[A-Za-z0-9._-]{1,64}$" },
          statement: text,
        },
        required: ["acceptance_criteria", "id", "statement"],
        additionalProperties: false,
      },
    },
    risks: textList,
    tasks: {
      type: "array",
      minItems: 1,
      maxItems: MAX_ITEMS,
      items: {
        type: "object",
        properties: {
          acceptance_criteria: { ...textList, minItems: 1 },
          dependencies: {
            type: "array",
            items: { type: "string", pattern: UUID.source },
            maxItems: MAX_ITEMS,
          },
          id: { type: "string", pattern: UUID.source },
          objective: text,
          requirement_ids: {
            type: "array",
            minItems: 1,
            maxItems: MAX_ITEMS,
            items: { type: "string", pattern: KEY.source },
          },
          title: text,
          verification_commands: { ...textList, minItems: 1 },
          write_scopes: { ...textList, minItems: 1 },
        },
        required: [
          "acceptance_criteria",
          "dependencies",
          "id",
          "objective",
          "requirement_ids",
          "title",
          "verification_commands",
          "write_scopes",
        ],
        additionalProperties: false,
      },
    },
  },
  required: [
    "assumptions",
    "integration_checks",
    "request_digest",
    "requirements",
    "risks",
    "tasks",
  ],
  additionalProperties: false,
} as const

export function validateArchitecturePlan(value: unknown): ArchitecturePlanInput {
  const plan = record(value, "architecture plan")
  exactKeys(
    plan,
    ["assumptions", "integration_checks", "request_digest", "requirements", "risks", "tasks"],
    "architecture plan",
  )
  if (typeof plan.request_digest !== "string" || !SHA256.test(plan.request_digest)) {
    throw new Error("architecture plan request_digest must be the exact 64-character digest from cycle_start")
  }
  const assumptions = strings(plan.assumptions, "assumptions", false)
  const integrationChecks = strings(plan.integration_checks, "integration_checks", true)
  const risks = strings(plan.risks, "risks", false)

  const requirementValues = boundedArray(plan.requirements, "requirements", true)
  const requirementIds = new Set<string>()
  const requirements = requirementValues.map((value, index) => {
    const item = record(value, `requirements[${index}]`)
    exactKeys(item, ["acceptance_criteria", "id", "statement"], `requirements[${index}]`)
    if (typeof item.id !== "string" || !KEY.test(item.id) || requirementIds.has(item.id)) {
      throw new Error(`requirements[${index}].id must be unique and contain only A-Z, a-z, 0-9, dot, underscore or hyphen`)
    }
    requirementIds.add(item.id)
    return {
      acceptance_criteria: strings(item.acceptance_criteria, `requirements[${index}].acceptance_criteria`, true),
      id: item.id,
      statement: requiredText(item.statement, `requirements[${index}].statement`),
    }
  })

  const taskValues = boundedArray(plan.tasks, "tasks", true)
  const taskIds = new Set<string>()
  const tasks = taskValues.map((value, index) => {
    const item = record(value, `tasks[${index}]`)
    exactKeys(
      item,
      [
        "acceptance_criteria",
        "dependencies",
        "id",
        "objective",
        "requirement_ids",
        "title",
        "verification_commands",
        "write_scopes",
      ],
      `tasks[${index}]`,
    )
    if (typeof item.id !== "string" || !UUID.test(item.id) || taskIds.has(item.id)) {
      throw new Error(`tasks[${index}].id must be a unique UUID`)
    }
    taskIds.add(item.id)
    const requirementIdsForTask = strings(item.requirement_ids, `tasks[${index}].requirement_ids`, true)
    if (new Set(requirementIdsForTask).size !== requirementIdsForTask.length) {
      throw new Error(`tasks[${index}].requirement_ids contains a duplicate`)
    }
    for (const id of requirementIdsForTask) {
      if (!requirementIds.has(id)) throw new Error(`tasks[${index}] references unknown requirement ${id}`)
    }
    const writeScopes = strings(item.write_scopes, `tasks[${index}].write_scopes`, true)
    for (const scope of writeScopes) {
      if (!safeRelative(scope)) throw new Error(`tasks[${index}].write_scopes contains an unsafe path: ${scope}`)
    }
    return {
      acceptance_criteria: strings(item.acceptance_criteria, `tasks[${index}].acceptance_criteria`, true),
      dependencies: strings(item.dependencies, `tasks[${index}].dependencies`, false),
      id: item.id,
      objective: requiredText(item.objective, `tasks[${index}].objective`),
      requirement_ids: requirementIdsForTask,
      title: requiredText(item.title, `tasks[${index}].title`),
      verification_commands: strings(item.verification_commands, `tasks[${index}].verification_commands`, true),
      write_scopes: writeScopes,
    }
  })

  for (const [index, task] of tasks.entries()) {
    if (new Set(task.dependencies).size !== task.dependencies.length) {
      throw new Error(`tasks[${index}].dependencies contains a duplicate`)
    }
    for (const dependency of task.dependencies) {
      if (!UUID.test(dependency) || !taskIds.has(dependency) || dependency === task.id) {
        throw new Error(`tasks[${index}] has an invalid dependency ${dependency}`)
      }
    }
  }
  assertAcyclic(tasks)
  const covered = new Set(tasks.flatMap((task) => [...task.requirement_ids]))
  for (const id of requirementIds) {
    if (!covered.has(id)) throw new Error(`architecture requirement ${id} is not covered by a task`)
  }

  return {
    assumptions,
    integration_checks: integrationChecks,
    request_digest: plan.request_digest,
    requirements,
    risks,
    tasks,
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} must contain exactly: ${wanted.join(", ")}`)
  }
}

function boundedArray(value: unknown, label: string, required: boolean): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS || (required && value.length === 0)) {
    throw new Error(`${label} must be ${required ? "a non-empty" : "an"} array with at most ${MAX_ITEMS} items`)
  }
  return value
}

function strings(value: unknown, label: string, required: boolean): string[] {
  return boundedArray(value, label, required).map((item, index) => requiredText(item, `${label}[${index}]`))
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > MAX_TEXT_BYTES || value.includes("\0")) {
    throw new Error(`${label} must be non-empty text of at most ${MAX_TEXT_BYTES} bytes`)
  }
  return value
}

function safeRelative(value: string): boolean {
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/u.test(value)) return false
  const segments = value.split("/")
  return segments.every((segment) => segment && segment !== "." && segment !== "..")
}

function assertAcyclic(tasks: readonly { readonly dependencies: readonly string[]; readonly id: string }[]): void {
  const dependencies = new Map(tasks.map((task) => [task.id, task.dependencies]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error("architecture task dependencies contain a cycle")
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of dependencies.get(id) ?? []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const task of tasks) visit(task.id)
}
