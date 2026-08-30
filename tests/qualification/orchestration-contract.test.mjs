import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")

test("the shipped orchestration contract forbids substitute role fallbacks", async () => {
  const source = await readFile(join(ROOT, "skills", "cycle-run", "SKILL.md"), "utf8")
  const shipped = await readFile(join(ROOT, "plugin", "skills", "cycle-run", "SKILL.md"), "utf8")

  assert.equal(shipped, source)
  assert.match(source, /Every role dispatch is fail closed/u)
  assert.match(source, /Never retry\s+with `general-purpose`, another profile, another model/u)
  assert.match(source, /A substitute agent is not evidence for the configured role/u)
})
