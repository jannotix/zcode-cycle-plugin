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

// The arbiter's verdict is the one payload that, when wrong, used to close the
// IPC connection without a word. Three of its values were wrong in the live
// run: "approve" for "approved", prose strings where Finding objects belong,
// and human references like worktree:src/utils.js:9-12 where an evidence UUID
// belongs. The daemon holds every one of those ids and the dispatch already
// carries them, so the contract has to say so.
test("every verdict-submitting role states the shape the control plane enforces", async () => {
  const roles = {
    arbiter: "arbiter.md",
    "functional-reviewer": "functional-reviewer.md",
    "security-reviewer": "security-reviewer.md",
  }
  for (const [role, file] of Object.entries(roles)) {
    const source = await readFile(join(ROOT, "agents", file), "utf8")
    const shipped = await readFile(join(ROOT, "plugin", "agents", file), "utf8")
    assert.equal(shipped, source, `${role} profile drifted from the shipped copy`)

    assert.match(source, /critical\/high\/medium\/low\/info/u, `${role} omits the severity enum`)
    assert.match(source, /execution\/architecture\/null/u, `${role} omits the repair targets`)
    assert.match(source, /satisfied\/unsatisfied/u, `${role} omits the requirement statuses`)
    assert.match(source, /evidence[ _]id/iu, `${role} never mentions evidence ids`)
  }

  const arbiter = await readFile(join(ROOT, "agents", "arbiter.md"), "utf8")
  assert.match(
    arbiter,
    /`approved`\/`rejected` — those exact words/u,
    "the arbiter must be told the decision values verbatim",
  )
  assert.match(
    arbiter,
    /is the `id` field of an evidence record in your dispatch/u,
    "the arbiter must be told where evidence ids come from",
  )
  assert.match(arbiter, /never a bare string/u, "the arbiter must be told findings are objects")
})
