import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { manageRoleProfiles } from "../dist/role-profiles.js"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")

function options(projectRoot, operation, extra = {}) {
  return { operation, pluginRoot: ROOT, projectRoot, ...extra }
}

test("managed project role profiles install, configure, repair and remove fail closed", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "zcode-cycle-role-profiles-"))
  try {
    const initial = await manageRoleProfiles(options(projectRoot, "status"))
    assert.equal(initial.ready, false)
    assert.equal(initial.profiles.every((profile) => profile.state === "missing"), true)

    await assert.rejects(
      manageRoleProfiles(options(projectRoot, "install")),
      /INSTALL_ZCODE_CYCLE_ROLE_PROFILES/u,
    )
    const installed = await manageRoleProfiles(
      options(projectRoot, "install", {
        confirmation: "INSTALL_ZCODE_CYCLE_ROLE_PROFILES",
      }),
    )
    assert.equal(installed.ready, true)
    assert.equal(installed.profiles.length, 5)
    assert.match(
      await readFile(join(projectRoot, ".zcode", "agents", "zcode-cycle-architect.md"), "utf8"),
      /^name: zcode-cycle:architect$/mu,
    )

    const configured = await manageRoleProfiles(
      options(projectRoot, "configure", {
        confirmation: "CONFIGURE_ZCODE_CYCLE_ROLE_PROFILE",
        model: "custom:builtin:zai-coding-plan:GLM-5.3",
        role: "architect",
        thoughtLevel: "max",
      }),
    )
    const architect = configured.profiles.find((profile) => profile.role === "architect")
    assert.equal(architect.model, "custom:builtin:zai-coding-plan:GLM-5.3")
    assert.equal(architect.thought_level, "max")

    for (const model of ["custom:builtin:", "custom::GLM-5.3", "custom:builtin:zai plan"]) {
      await assert.rejects(
        manageRoleProfiles(
          options(projectRoot, "configure", {
            confirmation: "CONFIGURE_ZCODE_CYCLE_ROLE_PROFILE",
            model,
            role: "executor",
          }),
        ),
        /custom:provider:model/u,
      )
    }

    await assert.rejects(
      manageRoleProfiles(
        options(projectRoot, "configure", {
          confirmation: "CONFIGURE_ZCODE_CYCLE_ROLE_PROFILE",
          model: "anthropic/claude-sonnet",
          role: "executor",
        }),
      ),
      /not supported by this Cycle release/u,
    )

    const turbo = await manageRoleProfiles(
      options(projectRoot, "configure", {
        confirmation: "CONFIGURE_ZCODE_CYCLE_ROLE_PROFILE",
        model: "custom:builtin:zai-coding-plan:GLM-5-Turbo",
        role: "executor",
        thoughtLevel: "off",
      }),
    )
    const executor = turbo.profiles.find((profile) => profile.role === "executor")
    assert.equal(executor.model, "custom:builtin:zai-coding-plan:GLM-5-Turbo")
    assert.equal(executor.thought_level, "off")

    for (const thoughtLevel of ["nothink", "low", "medium", "high", "max"]) {
      await assert.rejects(
        manageRoleProfiles(
          options(projectRoot, "configure", {
            confirmation: "CONFIGURE_ZCODE_CYCLE_ROLE_PROFILE",
            model: "custom:builtin:zai-coding-plan:GLM-5-Turbo",
            role: "executor",
            thoughtLevel,
          }),
        ),
        /not supported by custom:builtin:zai-coding-plan:GLM-5-Turbo/u,
      )
    }
    await assert.rejects(
      manageRoleProfiles(
        options(projectRoot, "configure", {
          confirmation: "CONFIGURE_ZCODE_CYCLE_ROLE_PROFILE",
          model: "custom:builtin:zai-coding-plan:GLM-5.3",
          role: "architect",
          thoughtLevel: "medium",
        }),
      ),
      /not supported by custom:builtin:zai-coding-plan:GLM-5.3/u,
    )

    const architectPath = join(projectRoot, ".zcode", "agents", "zcode-cycle-architect.md")
    await writeFile(architectPath, `${await readFile(architectPath, "utf8")}\nunauthorized drift\n`)
    const drifted = await manageRoleProfiles(options(projectRoot, "status"))
    assert.equal(drifted.profiles.find((profile) => profile.role === "architect").state, "managed-drift")
    await assert.rejects(
      manageRoleProfiles(
        options(projectRoot, "install", {
          confirmation: "INSTALL_ZCODE_CYCLE_ROLE_PROFILES",
        }),
      ),
      /managed-drift/u,
    )

    const repaired = await manageRoleProfiles(
      options(projectRoot, "repair", {
        confirmation: "REPAIR_ZCODE_CYCLE_ROLE_PROFILES",
      }),
    )
    assert.equal(repaired.ready, true)
    assert.equal(
      repaired.profiles.find((profile) => profile.role === "architect").model,
      "custom:builtin:zai-coding-plan:GLM-5.3",
    )
    assert.equal(
      repaired.profiles.find((profile) => profile.role === "architect").thought_level,
      "max",
    )

    await assert.rejects(
      manageRoleProfiles(options(projectRoot, "remove")),
      /REMOVE_ZCODE_CYCLE_ROLE_PROFILES/u,
    )
    const removed = await manageRoleProfiles(
      options(projectRoot, "remove", {
        confirmation: "REMOVE_ZCODE_CYCLE_ROLE_PROFILES",
      }),
    )
    assert.equal(removed.ready, false)
    assert.equal(removed.profiles.every((profile) => profile.state === "missing"), true)
  } finally {
    await rm(projectRoot, { force: true, recursive: true })
  }
})

test("repair never overwrites an unowned role-profile conflict", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "zcode-cycle-role-conflict-"))
  try {
    const directory = join(projectRoot, ".zcode", "agents")
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "zcode-cycle-executor.md"), "user-owned profile\n")
    const status = await manageRoleProfiles(options(projectRoot, "status"))
    assert.equal(status.profiles.find((profile) => profile.role === "executor").state, "conflict")
    await assert.rejects(
      manageRoleProfiles(
        options(projectRoot, "repair", {
          confirmation: "REPAIR_ZCODE_CYCLE_ROLE_PROFILES",
        }),
      ),
      /conflict/u,
    )
    assert.equal(await readFile(join(directory, "zcode-cycle-executor.md"), "utf8"), "user-owned profile\n")
  } finally {
    await rm(projectRoot, { force: true, recursive: true })
  }
})

test(
  "a linked role-profile directory is rejected",
  { skip: process.platform === "win32" },
  async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "zcode-cycle-role-link-"))
    const outside = await mkdtemp(join(tmpdir(), "zcode-cycle-role-outside-"))
    try {
      await mkdir(join(projectRoot, ".zcode"))
      await symlink(outside, join(projectRoot, ".zcode", "agents"), "dir")
      await assert.rejects(manageRoleProfiles(options(projectRoot, "status")), /unsafe/u)
    } finally {
      await rm(projectRoot, { force: true, recursive: true })
      await rm(outside, { force: true, recursive: true })
    }
  },
)
