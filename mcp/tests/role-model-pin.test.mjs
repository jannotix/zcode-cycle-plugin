import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { manageRoleProfiles } from "../dist/role-profiles.js"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const PINNED = "custom:builtin:zai-coding-plan:GLM-5.3-Flash"

test("a per-role model pin outlives a silent rewrite of the profile, and is reported when it does not", async () => {
  // DEFECT-25, as the live 1.0.5 certification found it: the arbiter was pinned
  // through the supported path and read back from disk, something rewrote the
  // profile from its template four minutes before the arbiter was dispatched,
  // and the ledger went on recording `inherit` with nothing anywhere saying a
  // pin had ever been asked for.
  const projectRoot = await mkdtemp(join(tmpdir(), "zcode-cycle-role-pin-"))
  const pinStorePath = join(projectRoot, "state", "role-model-pins.json")
  const call = (operation, extra = {}) =>
    manageRoleProfiles({ operation, pinStorePath, pluginRoot: ROOT, projectRoot, ...extra })
  try {
    await call("install", { confirmation: "INSTALL_ZCODE_CYCLE_ROLE_PROFILES" })
    const pinned = await call("configure", {
      confirmation: "CONFIGURE_ZCODE_CYCLE_ROLE_PROFILE",
      model: PINNED,
      role: "arbiter",
      thoughtLevel: "high",
    })
    assert.equal(pinned.ready, true)
    assert.equal(pinned.pin_drift, undefined)

    // The rewrite itself: the managed template put back over the pinned profile.
    // It is a legitimate-looking file, which is why nothing caught it before.
    const target = join(projectRoot, ".zcode", "agents", "zcode-cycle-arbiter.md")
    await writeFile(target, await readFile(join(ROOT, "agents", "arbiter.md"), "utf8"), "utf8")

    const drifted = await call("status")
    assert.equal(drifted.ready, false, "a lost pin must not read as ready")
    assert.deepEqual(drifted.pin_drift, [
      { on_disk: "inherit", pinned: PINNED, role: "arbiter" },
    ])
    assert.match(drifted.warning, /arbiter on inherit instead of/u)

    const arbiter = drifted.profiles.find((profile) => profile.role === "arbiter")
    assert.equal(arbiter.model, "inherit", "what will actually be dispatched")
    assert.equal(arbiter.model_requested, PINNED, "what the operator asked for")

    const repaired = await call("repair", {
      confirmation: "REPAIR_ZCODE_CYCLE_ROLE_PROFILES",
    })
    assert.equal(repaired.ready, true)
    assert.equal(repaired.pin_drift, undefined)
    assert.match(await readFile(target, "utf8"), /^model: custom:builtin:zai-coding-plan:GLM-5\.3-Flash$/mu)
  } finally {
    await rm(projectRoot, { force: true, recursive: true })
  }
})

test("inherit clears a pin rather than recording one", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "zcode-cycle-role-pin-"))
  const pinStorePath = join(projectRoot, "state", "role-model-pins.json")
  const call = (operation, extra = {}) =>
    manageRoleProfiles({ operation, pinStorePath, pluginRoot: ROOT, projectRoot, ...extra })
  try {
    await call("install", { confirmation: "INSTALL_ZCODE_CYCLE_ROLE_PROFILES" })
    await call("configure", {
      confirmation: "CONFIGURE_ZCODE_CYCLE_ROLE_PROFILE",
      model: PINNED,
      role: "arbiter",
      thoughtLevel: "high",
    })
    await call("configure", {
      confirmation: "CONFIGURE_ZCODE_CYCLE_ROLE_PROFILE",
      model: "inherit",
      role: "arbiter",
    })

    // Returning a role to the session model is withdrawing the pin, not pinning
    // it to whatever the session happens to run. Nothing should drift afterwards.
    const status = await call("status")
    assert.equal(status.ready, true)
    assert.equal(status.pin_drift, undefined)
    assert.equal(
      status.profiles.find((profile) => profile.role === "arbiter").model_requested,
      undefined,
    )
  } finally {
    await rm(projectRoot, { force: true, recursive: true })
  }
})
