// The control plane deserialises the arbiter's verdict, a reviewer's verdict
// and an audit observation into Rust types that deny unknown fields and accept
// no defaults. For a long time these three were published to the model as bare
// `{type: "object"}`, so a role had nothing to conform to; the shapes it
// invented were rejected at the protocol boundary and the connection closed
// without a word. Live certification found it: no governed workflow could
// reach promotion.
//
// These tests bind the published schema to the Rust struct it has to satisfy,
// so the two cannot drift apart again.

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { createInterface } from "node:readline"
import test from "node:test"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const CRATES = resolve(ROOT, "..", "crates")

async function publishedTools() {
  const child = spawn(process.execPath, [join(ROOT, "dist", "server.js")], {
    cwd: ROOT,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  const lines = createInterface({ input: child.stdout })
  child.stdin.write(`${JSON.stringify({ id: 1, jsonrpc: "2.0", method: "initialize", params: {} })}\n`)
  await once(lines, "line")
  child.stdin.write(`${JSON.stringify({ id: 2, jsonrpc: "2.0", method: "tools/list", params: {} })}\n`)
  const listed = await once(lines, "line").then(([line]) => JSON.parse(line))
  child.stdin.end()
  await once(child, "exit")
  return new Map(listed.result.tools.map((tool) => [tool.name, tool]))
}

/** Field names of a `pub struct` in a Rust source file, in declaration order. */
async function rustStructFields(file, name) {
  const source = await readFile(file, "utf8")
  const start = source.indexOf(`pub struct ${name} {`)
  assert.notEqual(start, -1, `${name} is no longer declared in ${file}`)
  const body = source.slice(start, source.indexOf("\n}", start))
  return [...body.matchAll(/^\s{4}pub (\w+):/gmu)].map((match) => match[1])
}

test("the published verdict schemas match the Rust types that must accept them", async () => {
  const tools = await publishedTools()

  const arbiter = tools.get("cycle_submit_arbitration").inputSchema.properties.verdict
  const arbiterFields = await rustStructFields(
    join(CRATES, "workflow-core", "src", "verdict.rs"),
    "ArbiterVerdict",
  )
  assert.deepEqual(
    [...arbiter.required].sort(),
    [...arbiterFields].sort(),
    "cycle_submit_arbitration publishes a different field set than ArbiterVerdict requires",
  )
  assert.equal(arbiter.additionalProperties, false, "ArbiterVerdict denies unknown fields")
  assert.deepEqual(arbiter.properties.decision.enum, ["approved", "rejected"])

  const review = tools.get("cycle_submit_review").inputSchema.properties.verdict
  const reviewFields = await rustStructFields(
    join(CRATES, "workflow-core", "src", "review.rs"),
    "ReviewVerdict",
  )
  assert.deepEqual(
    [...review.required].sort(),
    [...reviewFields].sort(),
    "cycle_submit_review publishes a different field set than ReviewVerdict requires",
  )
  assert.equal(review.additionalProperties, false)
  assert.deepEqual(review.properties.decision.enum, ["approved", "rejected"])
})

test("the published audit observation schema matches AuditObservation", async () => {
  const tools = await publishedTools()
  const observation = tools.get("cycle_audit").inputSchema.properties.observation
  const fields = await rustStructFields(
    join(CRATES, "workflow-ipc", "src", "audit.rs"),
    "AuditObservation",
  )
  assert.deepEqual(
    [...observation.required].sort(),
    [...fields].sort(),
    "cycle_audit publishes a different field set than AuditObservation requires",
  )
  assert.equal(observation.additionalProperties, false)
})

/** Variants of a `pub enum` and their field names, snake_cased as serde does. */
async function rustEnumVariants(file, name) {
  const source = await readFile(file, "utf8")
  const start = source.indexOf(`pub enum ${name} {`)
  assert.notEqual(start, -1, `${name} is no longer declared in ${file}`)
  const body = source.slice(start + `pub enum ${name} {`.length, source.indexOf("\n}", start))
  const snake = (value) => value.replace(/(?<!^)([A-Z])/gu, "_$1").toLowerCase()
  const variants = new Map()
  for (const match of body.replaceAll(/\/\/\/.*$/gmu, "").matchAll(/^\s{4}(\w+)\s*(?:\{([^}]*)\})?,/gmu)) {
    variants.set(snake(match[1]), [...(match[2] ?? "").matchAll(/(\w+):/gu)].map((field) => field[1]))
  }
  return variants
}

// The 1.0.9 and 1.0.11 campaigns learned mark_ready and activate by refusal:
// cycle_goal published `operation` as a bare object.
test("the published goal operation schema matches GoalOperation", async () => {
  const tools = await publishedTools()
  const operation = tools.get("cycle_goal").inputSchema.properties.operation
  const protocol = join(CRATES, "workflow-ipc", "src", "protocol.rs")
  const variants = await rustEnumVariants(protocol, "GoalOperation")
  assert.deepEqual(
    [...operation.properties.type.enum].sort(),
    [...variants.keys()].sort(),
    "cycle_goal publishes a different set of operations than GoalOperation accepts",
  )
  assert.equal(operation.additionalProperties, false, "GoalOperation denies unknown fields")
  assert.deepEqual(
    Object.keys(operation.properties).filter((field) => field !== "type").sort(),
    [...new Set([...variants.values()].flat())].sort(),
    "cycle_goal publishes a different field set than GoalOperation's variants use",
  )
  // The per-operation field list the model reads must name exactly each
  // variant's fields.
  const described = new Map(
    [...operation.description.matchAll(/(\w+)\(([^)]*)\)/gu)].map((match) => [
      match[1],
      match[2] ? match[2].split(", ").map((field) => field.replace("?", "")) : [],
    ]),
  )
  for (const [type, fields] of variants) {
    assert.deepEqual([...(described.get(type) ?? [])].sort(), [...fields].sort(), `description of ${type}`)
  }
  assert.deepEqual(
    [...operation.properties.action.enum].sort(),
    [...(await rustEnumVariants(protocol, "GoalControlAction")).keys()].sort(),
    "cycle_goal control publishes different actions than GoalControlAction",
  )
})

test("no payload the control plane parses strictly is published as a bare object", async () => {
  const tools = await publishedTools()
  const bare = []
  for (const [name, tool] of tools) {
    for (const [field, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
      const onlyType = schema && typeof schema === "object" && Object.keys(schema).length === 1
      if (onlyType && schema.type === "object") bare.push(`${name}.${field}`)
    }
  }
  // cycle_history and cycle_memory still take an untyped `operation`. They are
  // legible now — the daemon answers a malformed payload by name instead of
  // closing the connection — but they are not yet described.
  assert.deepEqual(
    bare.sort(),
    ["cycle_history.operation", "cycle_memory.operation"],
    "a strictly-parsed payload is published as a bare object; publish its schema",
  )
})
