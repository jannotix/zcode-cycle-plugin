import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { manageRoleProfiles } from "../dist/role-profiles.js"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const CONFIRM = "INSTALL_ZCODE_CYCLE_ROLE_PROFILES"

function install(projectRoot) {
  return manageRoleProfiles({
    confirmation: CONFIRM,
    operation: "install",
    pluginRoot: ROOT,
    projectRoot,
  })
}

async function gitProject() {
  const projectRoot = await mkdtemp(join(tmpdir(), "zcode-cycle-git-exclude-"))
  await mkdir(join(projectRoot, ".git", "info"), { recursive: true })
  return projectRoot
}

const exclude = (projectRoot) => join(projectRoot, ".git", "info", "exclude")

/**
 * The 1.0.6 certification deadlocked here: install wrote five profiles into the
 * project, the freeze guard refused the dirty tree, and committing them moved
 * HEAD off the workflow's start revision - which the same guard also refuses.
 */
test("install keeps its own managed profiles out of the project's change set", async () => {
  const projectRoot = await gitProject()
  try {
    const report = await install(projectRoot)
    assert.equal(report.ready, true)
    assert.equal(report.git_exclude_warning, undefined)

    const contents = await readFile(exclude(projectRoot), "utf8")
    assert.match(contents, /^\.zcode\/$/mu)
  } finally {
    await rm(projectRoot, { force: true, recursive: true })
  }
})

test("an existing exclude file is appended to, never replaced", async () => {
  const projectRoot = await gitProject()
  try {
    await writeFile(exclude(projectRoot), "# operator's own rules\nbuild/\n", "utf8")
    await install(projectRoot)

    const contents = await readFile(exclude(projectRoot), "utf8")
    assert.match(contents, /^# operator's own rules$/mu)
    assert.match(contents, /^build\/$/mu)
    assert.match(contents, /^\.zcode\/$/mu)
  } finally {
    await rm(projectRoot, { force: true, recursive: true })
  }
})

test("repeating the install does not repeat the exclude entry", async () => {
  const projectRoot = await gitProject()
  try {
    await install(projectRoot)
    await manageRoleProfiles({
      confirmation: "REPAIR_ZCODE_CYCLE_ROLE_PROFILES",
      operation: "repair",
      pluginRoot: ROOT,
      projectRoot,
    })

    const lines = (await readFile(exclude(projectRoot), "utf8"))
      .split(/\r?\n/u)
      .filter((line) => line.trim() === ".zcode/")
    assert.equal(lines.length, 1)
  } finally {
    await rm(projectRoot, { force: true, recursive: true })
  }
})

/**
 * The 1.0.9 live certification found the next file of the same kind. ZCode
 * writes `.zcodeignore` into the project the first time its search palette is
 * opened; untracked, it refused the next freeze, and the run "repaired" that by
 * deleting a file whose lower half is reserved for the operator's own rules.
 */
test("install also keeps the host's own search-index file out of the change set", async () => {
  const projectRoot = await gitProject()
  try {
    await install(projectRoot)
    await install(projectRoot)

    const lines = (await readFile(exclude(projectRoot), "utf8")).split(/\r?\n/u)
    assert.equal(lines.filter((line) => line.trim() === "/.zcodeignore").length, 1)
    assert.equal(lines.filter((line) => line.trim() === ".zcode/").length, 1)
  } finally {
    await rm(projectRoot, { force: true, recursive: true })
  }
})

/** A project that is not a git repository must still install, and be told why. */
test("a project outside git installs and is told the profiles are visible to it", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "zcode-cycle-no-git-"))
  try {
    const report = await install(projectRoot)
    assert.equal(report.ready, true)
    assert.match(report.git_exclude_warning, /not a git repository/u)
    assert.match(report.git_exclude_warning, /cannot freeze a candidate/u)
  } finally {
    await rm(projectRoot, { force: true, recursive: true })
  }
})
