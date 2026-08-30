import assert from "node:assert/strict"
import test from "node:test"

import { validateArchitecturePlan } from "../dist/architecture-plan.js"

const TASK_1 = "11111111-1111-4111-8111-111111111111"
const TASK_2 = "22222222-2222-4222-8222-222222222222"

function validPlan() {
  return {
    assumptions: [],
    integration_checks: ["Run the complete test suite."],
    request_digest: "a".repeat(64),
    requirements: [
      {
        acceptance_criteria: ["Whitespace is trimmed."],
        id: "REQ-1",
        statement: "Trim surrounding whitespace.",
      },
    ],
    risks: [],
    tasks: [
      {
        acceptance_criteria: ["The regression test passes."],
        dependencies: [],
        id: TASK_1,
        objective: "Implement trimming and its regression test.",
        requirement_ids: ["REQ-1"],
        title: "Trim greeting input",
        verification_commands: ["npm test"],
        write_scopes: ["src/greeting.js", "test/greeting.test.js"],
      },
    ],
  }
}

test("a complete architecture plan passes the MCP boundary", () => {
  const plan = validPlan()
  assert.deepEqual(validateArchitecturePlan(plan), plan)
})

test("the malformed shape observed in live ZCode is rejected before IPC", () => {
  assert.throws(
    () =>
      validateArchitecturePlan({
        plan_id: "greeting-trim-name",
        requirements: ["Trim whitespace"],
        tasks: [
          {
            id: "T1",
            description: "Trim whitespace",
            verification_commands: ["npm test"],
            write_scopes: ["src/greeting.js"],
          },
        ],
      }),
    /must contain exactly/u,
  )
})

test("task identifiers, references, scopes and DAG edges fail closed", () => {
  const shortId = validPlan()
  shortId.tasks[0].id = "T1"
  assert.throws(() => validateArchitecturePlan(shortId), /unique UUID/u)

  const unknownRequirement = validPlan()
  unknownRequirement.tasks[0].requirement_ids = ["REQ-404"]
  assert.throws(() => validateArchitecturePlan(unknownRequirement), /unknown requirement/u)

  const unsafeScope = validPlan()
  unsafeScope.tasks[0].write_scopes = ["../outside"]
  assert.throws(() => validateArchitecturePlan(unsafeScope), /unsafe path/u)

  const cycle = validPlan()
  cycle.tasks = [
    { ...cycle.tasks[0], dependencies: [TASK_2] },
    {
      ...cycle.tasks[0],
      dependencies: [TASK_1],
      id: TASK_2,
      title: "Second task",
    },
  ]
  assert.throws(() => validateArchitecturePlan(cycle), /contain a cycle/u)
})
