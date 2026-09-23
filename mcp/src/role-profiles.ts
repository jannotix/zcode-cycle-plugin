import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

const MAX_PROFILE_BYTES = 256 * 1024
const MODEL_REF = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:/-]+$/u
const CUSTOM_MODEL_REF = /^custom:(?:[A-Za-z0-9._+\/-]|%[0-9A-Fa-f]{2})+:(?:[A-Za-z0-9._:+\/-]|%[0-9A-Fa-f]{2})+$/u
const INHERIT_MODEL = "inherit"
const INHERIT_THOUGHT_LEVEL = "high"
const BUILTIN_ZAI_MODEL_CAPABILITIES = new Map<string, ReadonlySet<string>>([
  ["custom:builtin:zai-coding-plan:GLM-5.3", new Set(["low", "high", "max"])],
  ["custom:builtin:zai-coding-plan:GLM-5.3-Flash", new Set(["low", "high", "max"])],
  ["custom:builtin:zai-coding-plan:GLM-5-Turbo", new Set(["enabled", "off"])],
])

const ROLE_PROFILES = [
  { file: "architect.md", role: "architect" },
  { file: "executor.md", role: "executor" },
  { file: "functional-reviewer.md", role: "functional-reviewer" },
  { file: "security-reviewer.md", role: "security-reviewer" },
  { file: "arbiter.md", role: "arbiter" },
] as const

type Role = (typeof ROLE_PROFILES)[number]["role"]
type Operation = "status" | "install" | "repair" | "configure" | "remove"
type ProfileState = "current" | "missing" | "managed-drift" | "conflict"

interface RoleProfileOptions {
  readonly confirmation?: string
  readonly model?: string
  readonly operation: Operation
  /** Where the record of deliberate per-role model pins lives. See `readPins`. */
  readonly pinStorePath?: string
  readonly pluginRoot: string
  readonly projectRoot: string
  readonly role?: string
  readonly thoughtLevel?: string
}

interface Pin {
  readonly model: string
  readonly recorded_at: string
  readonly thought_level: string
}

type PinStore = Record<string, Record<string, Pin>>

/**
 * A per-role model pin is the operator's one control over *which model renders a
 * verdict*. It is how the arbiter's independence from the executor stops being
 * nominal, so losing one silently is not a cosmetic failure.
 *
 * DEFECT-25: the pin lived only in the profile's `model:` line, which is both the
 * request and the resolution of that request. Anything that rewrote the profile
 * from its template therefore erased the request with no trace, and the ledger
 * went on faithfully recording `inherit` for a role the operator believed was
 * pinned. In the live 1.0.5 certification the arbiter's pin was set through the
 * supported path, verified on disk, and was gone four minutes before the arbiter
 * was dispatched.
 *
 * So the request is recorded separately from its resolution, outside the project
 * tree, and the two are compared on every call. A rewrite can still happen - this
 * does not prevent it - but it can no longer happen quietly.
 */
async function readPins(path: string | undefined): Promise<PinStore> {
  if (!path) return {}
  try {
    const parsed: unknown = JSON.parse(await readBoundedRegularFile(path, "role-model pin record"))
    return parsed !== null && typeof parsed === "object" ? (parsed as PinStore) : {}
  } catch (error) {
    if (isMissing(error)) return {}
    throw error
  }
}

async function writePins(path: string | undefined, pins: PinStore): Promise<void> {
  if (!path) return
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(pins, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  await rename(temporary, path)
}

interface ProfileRecord {
  readonly content?: string
  readonly digest?: string
  readonly file: string
  readonly model?: string
  readonly role: Role
  readonly state: ProfileState
  readonly target: string
  readonly thought_level?: string
}

export async function manageRoleProfiles(options: RoleProfileOptions): Promise<object> {
  const projectRoot = resolve(options.projectRoot)
  const pluginRoot = resolve(options.pluginRoot)
  await requireSafeDirectory(projectRoot, "project root")
  await requireSafeDirectory(pluginRoot, "plugin root")
  await requireSafeDirectory(join(pluginRoot, "agents"), "plugin role-profile directory")

  const templates = new Map<Role, string>()
  for (const profile of ROLE_PROFILES) {
    const source = join(pluginRoot, "agents", profile.file)
    const content = await readBoundedRegularFile(source, "role-profile template")
    assertCanonicalTemplate(content, profile.role)
    templates.set(profile.role, content)
  }

  const mutating = options.operation !== "status"
  let changed = false
  const targetDirectory = await roleProfileDirectory(projectRoot, mutating)
  const records = await Promise.all(
    ROLE_PROFILES.map((profile) =>
      inspectProfile(targetDirectory, profile.role, profile.file, templates.get(profile.role)!),
    ),
  )

  switch (options.operation) {
    case "status":
      return report(
        projectRoot,
        records,
        false,
        (await readPins(options.pinStorePath))[projectRoot] ?? {},
      )
    case "install":
      requireConfirmation(options.confirmation, "INSTALL_ZCODE_CYCLE_ROLE_PROFILES")
      rejectStates(records, new Set(["managed-drift", "conflict"]), "install")
      for (const record of records) {
        if (record.state === "missing") {
          await writeAtomic(record.target, templates.get(record.role)!, false)
          changed = true
        }
      }
      break
    case "repair": {
      requireConfirmation(options.confirmation, "REPAIR_ZCODE_CYCLE_ROLE_PROFILES")
      rejectStates(records, new Set(["conflict"]), "repair")
      const pins = (await readPins(options.pinStorePath))[projectRoot] ?? {}
      for (const record of records) {
        // DEFECT-25: a profile rewritten from its own template is structurally
        // perfect - that is exactly how the pin was lost, and why a repair keyed
        // only on damage could never put it back. A pin that is no longer in the
        // file it was set on is the thing needing repair, whatever the file's
        // state says.
        const pinned = pins[record.role]
        const lostPin = pinned !== undefined && (record.model ?? INHERIT_MODEL) !== pinned.model
        if (record.state !== "current" || lostPin) {
          const template = templates.get(record.role)!
          const settings =
            pinned ??
            (record.state === "managed-drift" && record.content
              ? extractManagedSettings(record.content, record.role)
              : null)
          const repaired = settings
            ? template
                .replace(/^model:.*$/mu, `model: ${settings.model}`)
                .replace(/^thoughtLevel:.*$/mu, `thoughtLevel: ${settings.thought_level}`)
            : template
          await writeAtomic(record.target, repaired, record.state !== "missing")
          changed = true
        }
      }
      break
    }
    case "configure": {
      requireConfirmation(options.confirmation, "CONFIGURE_ZCODE_CYCLE_ROLE_PROFILE")
      rejectStates(records, new Set(["missing", "managed-drift", "conflict"]), "configure")
      const role = canonicalRole(options.role)
      const model = options.model ?? "inherit"
      if (!validModel(model)) {
        throw new Error(
          "role-profile model must be inherit, provider/model or a ZCode custom:provider:model value",
        )
      }
      if (!supportedModel(model)) {
        throw new Error(
          "role-profile model is not supported by this Cycle release; use inherit or an exact supported ZCode built-in model",
        )
      }
      const thoughtLevel = options.thoughtLevel ?? defaultThoughtLevel(model)
      if (!supportsThoughtLevel(model, thoughtLevel)) {
        throw new Error(
          `role-profile thought level ${thoughtLevel} is not supported by ${model}; allowed: ${supportedThoughtLevels(model).join(", ")}`,
        )
      }
      const record = records.find((item) => item.role === role)!
      const configured = record.content!
        .replace(/^model:.*$/mu, `model: ${model}`)
        .replace(/^thoughtLevel:.*$/mu, `thoughtLevel: ${thoughtLevel}`)
      if (configured !== record.content) {
        await writeAtomic(record.target, configured, true)
        changed = true
      }
      // DEFECT-25: the request is recorded where a rewrite of the project tree
      // cannot reach it. `inherit` is the absence of a pin, not a pin on the
      // session model, so it clears the record instead of adding to it.
      {
        const pins = await readPins(options.pinStorePath)
        const forProject = { ...(pins[projectRoot] ?? {}) }
        if (model === INHERIT_MODEL) {
          delete forProject[role]
        } else {
          forProject[role] = {
            model,
            recorded_at: new Date().toISOString(),
            thought_level: thoughtLevel,
          }
        }
        await writePins(options.pinStorePath, { ...pins, [projectRoot]: forProject })
      }
      break
    }
    case "remove":
      requireConfirmation(options.confirmation, "REMOVE_ZCODE_CYCLE_ROLE_PROFILES")
      rejectStates(records, new Set(["conflict"]), "remove")
      for (const record of records) {
        if (record.state !== "missing") {
          await rm(record.target)
          changed = true
        }
      }
      break
    default:
      throw new Error(`unsupported role-profile operation: ${String(options.operation)}`)
  }

  const afterDirectory = await roleProfileDirectory(projectRoot, false)
  const after = await Promise.all(
    ROLE_PROFILES.map((profile) =>
      inspectProfile(afterDirectory, profile.role, profile.file, templates.get(profile.role)!),
    ),
  )
  const pins = (await readPins(options.pinStorePath))[projectRoot] ?? {}
  // The profiles this plugin writes are its own, not the operator's work. Keep
  // them out of the project's change set so a governed cycle can still freeze a
  // candidate immediately after setup.
  const gitExcludeWarning =
    options.operation === "install" || options.operation === "repair"
      ? await excludeManagedProfilesFromGit(projectRoot)
      : null
  return report(projectRoot, after, changed, pins, gitExcludeWarning)
}

function canonicalRole(value: string | undefined): Role {
  const role = ROLE_PROFILES.find((item) => item.role === value)?.role
  if (!role) throw new Error("unknown Cycle role profile")
  return role
}

function marker(role: Role): string {
  return `<!-- zcode-cycle-managed-role-profile: ${role} -->`
}

function assertCanonicalTemplate(content: string, role: Role): void {
  if (!content.includes(marker(role))) throw new Error(`role-profile template lacks marker: ${role}`)
  if (!content.includes(`name: zcode-cycle:${role}`)) {
    throw new Error(`role-profile template has the wrong identity: ${role}`)
  }
  if (!/^model: inherit$/mu.test(content) || !/^thoughtLevel: high$/mu.test(content)) {
    throw new Error(`role-profile template has a non-canonical model configuration: ${role}`)
  }
}

async function roleProfileDirectory(projectRoot: string, create: boolean): Promise<string | null> {
  let current = projectRoot
  for (const segment of [".zcode", "agents"]) {
    current = join(current, segment)
    try {
      await requireSafeDirectory(current, "project role-profile directory")
    } catch (error) {
      if (!isMissing(error)) throw error
      if (!create) return null
      await mkdir(current)
      await requireSafeDirectory(current, "project role-profile directory")
    }
  }
  return current
}

async function inspectProfile(
  directory: string | null,
  role: Role,
  file: string,
  template: string,
): Promise<ProfileRecord> {
  const target = join(directory ?? "", `zcode-cycle-${file}`)
  if (directory === null) return { file, role, state: "missing", target }
  let content: string
  try {
    content = await readBoundedRegularFile(target, "installed role profile")
  } catch (error) {
    if (isMissing(error)) return { file, role, state: "missing", target }
    throw error
  }
  const configured = configuredProfile(content, template, role)
  return {
    content,
    digest: sha256(content),
    file,
    ...(configured === null ? {} : configured),
    role,
    state: configured === null ? (content.includes(marker(role)) ? "managed-drift" : "conflict") : "current",
    target,
  }
}

function configuredProfile(
  content: string,
  template: string,
  role: Role,
): { model: string; thought_level: string } | null {
  const settings = extractManagedSettings(content, role)
  if (!settings) return null
  const normalized = content
    .replace(/^model:.*$/mu, "model: inherit")
    .replace(/^thoughtLevel:.*$/mu, "thoughtLevel: high")
  return normalized === template ? settings : null
}

function extractManagedSettings(
  content: string,
  role: Role,
): { model: string; thought_level: string } | null {
  if (!content.includes(marker(role))) return null
  const models = [...content.matchAll(/^model:\s*(\S+)\s*$/gmu)].map((match) => match[1])
  const thoughtLevels = [...content.matchAll(/^thoughtLevel:\s*(\S+)\s*$/gmu)].map(
    (match) => match[1],
  )
  if (models.length !== 1 || thoughtLevels.length !== 1) return null
  const model = models[0]!
  const thoughtLevel = thoughtLevels[0]!
  if (!validModel(model) || !supportedModel(model) || !supportsThoughtLevel(model, thoughtLevel)) {
    return null
  }
  return { model, thought_level: thoughtLevel }
}

/**
 * Keep the profiles this plugin writes out of the project's own change set.
 *
 * `install` writes five files into `<project>/.zcode/agents/`. In a git project
 * that leaves the tree dirty, and the freeze guard then refuses a candidate
 * because "the project changed while this workflow was holding it". Committing
 * them trades that refusal for another: the freeze also requires the project to
 * sit at the workflow's start revision, which the commit just moved. Both exits
 * the first error offers are closed by the second, and the 1.0.6 certification
 * deadlocked there on its first live full-route run.
 *
 * `.git/info/exclude` is git's per-clone ignore list. It is never committed and
 * never shared, so this changes nothing a collaborator would see - it only stops
 * the plugin's own managed files from looking like the operator's unreviewed work.
 *
 * Failure here is reported, never fatal: a project that is not a git repository,
 * or a git directory this process cannot write, must not block an install.
 */
async function excludeManagedProfilesFromGit(projectRoot: string): Promise<string | null> {
  const marker = ".zcode/"
  let gitDirectory: string
  try {
    const dotGit = join(projectRoot, ".git")
    const stats = await lstat(dotGit)
    if (stats.isDirectory()) {
      gitDirectory = dotGit
    } else {
      // A linked worktree stores `gitdir: <path>`; its exclude file lives in the
      // common directory when one is recorded.
      const pointer = (await readFile(dotGit, "utf8")).trim()
      const target = pointer.startsWith("gitdir:") ? pointer.slice("gitdir:".length).trim() : ""
      if (target === "") return "the project's .git is neither a directory nor a gitdir pointer"
      const resolved = resolve(projectRoot, target)
      const common = await readFile(join(resolved, "commondir"), "utf8").catch(() => null)
      gitDirectory = common === null ? resolved : resolve(resolved, common.trim())
    }
  } catch {
    return "the project is not a git repository"
  }

  // `.zcodeignore` is ZCode's, not Cycle's: the host writes it the first time its
  // search palette opens, and untracked it refuses the next freeze exactly as
  // the profiles did. Excluding only affects untracked files, so an operator who
  // chooses to commit it is unaffected.
  const entries = [
    { line: marker, aliases: [marker, ".zcode"], why: "role profiles are not project content." },
    {
      line: "/.zcodeignore",
      aliases: ["/.zcodeignore", ".zcodeignore"],
      why: "ZCode's own search-index file is not project content.",
    },
  ]
  try {
    const excludePath = join(gitDirectory, "info", "exclude")
    const existing = await readFile(excludePath, "utf8").catch(() => "")
    const listed = new Set(existing.split(/\r?\n/u).map((line) => line.trim()))
    const missing = entries.filter((entry) => !entry.aliases.some((alias) => listed.has(alias)))
    if (missing.length === 0) return null
    await mkdir(dirname(excludePath), { recursive: true })
    const separator = existing === "" || existing.endsWith("\n") ? "" : "\n"
    const added = missing.map((entry) => `# Managed by ZCode Cycle: ${entry.why}\n${entry.line}\n`).join("")
    await writeFile(excludePath, `${existing}${separator}${added}`, "utf8")
    return null
  } catch (error) {
    return `could not update .git/info/exclude: ${(error as Error).message}`
  }
}

function validModel(value: string): boolean {
  return value === INHERIT_MODEL || MODEL_REF.test(value) || CUSTOM_MODEL_REF.test(value)
}

/**
 * Which model references this plugin will accept.
 *
 * Until 1.0.7 the answer was a fixed list of three `custom:builtin:zai-coding-plan:*`
 * refs. The 1.0.6 certification put all three through a governed run on a host
 * that resolves providers under `account:zai-individual-coding-plan`, and every
 * one of them died at dispatch with `provider-not-found` - on the provider
 * PREFIX, not the model name. The only setting that worked was `inherit`, which
 * is the absence of the feature the product is named for.
 *
 * A plugin cannot enumerate a host's providers, so it has no business deciding
 * which ones exist. It validates the SHAPE of a reference and lets the host
 * answer the rest. What it owes the operator instead is that the answer arrives
 * early and in plain words - see `dispatch_unverified` in the report.
 */
function supportedModel(value: string): boolean {
  return validModel(value)
}

/** Thought levels this product knows how to write into a profile. */
const KNOWN_THOUGHT_LEVELS: readonly string[] = ["low", "high", "max", "enabled", "disabled", "off"]

function defaultThoughtLevel(model: string): string {
  return BUILTIN_ZAI_MODEL_CAPABILITIES.get(model)?.has("off") === true
    ? "off"
    : INHERIT_THOUGHT_LEVEL
}

function supportsThoughtLevel(model: string, thoughtLevel: string): boolean {
  if (model === INHERIT_MODEL) return thoughtLevel === INHERIT_THOUGHT_LEVEL
  const known = BUILTIN_ZAI_MODEL_CAPABILITIES.get(model)
  return known ? known.has(thoughtLevel) : KNOWN_THOUGHT_LEVELS.includes(thoughtLevel)
}

function supportedThoughtLevels(model: string): readonly string[] {
  if (model === INHERIT_MODEL) return [INHERIT_THOUGHT_LEVEL]
  return [...(BUILTIN_ZAI_MODEL_CAPABILITIES.get(model) ?? KNOWN_THOUGHT_LEVELS)]
}

/**
 * A pinned model the plugin cannot vouch for.
 *
 * `inherit` is known to dispatch: it is the model the session itself is running
 * on. Anything else is the host's to resolve, and the plugin learns whether it
 * can only when a role is dispatched. Saying so is the difference between a
 * failure that costs seconds and one that costs a full architecture, execution
 * and five verification gates.
 */
function dispatchUnverified(model: string | undefined): boolean {
  return model !== undefined && model !== INHERIT_MODEL
}

function rejectStates(records: readonly ProfileRecord[], denied: ReadonlySet<ProfileState>, action: string): void {
  const blocked = records.filter((record) => denied.has(record.state))
  if (blocked.length > 0) {
    throw new Error(
      `role-profile ${action} refused: ${blocked.map((item) => `${item.role}=${item.state}`).join(", ")}`,
    )
  }
}

function requireConfirmation(actual: string | undefined, expected: string): void {
  if (actual !== expected) throw new Error(`role-profile operation requires confirmation ${expected}`)
}

async function requireSafeDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} is unsafe: ${path}`)
}

async function readBoundedRegularFile(path: string, label: string): Promise<string> {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} is unsafe: ${path}`)
  if (info.size > MAX_PROFILE_BYTES) throw new Error(`${label} exceeds the safety limit: ${path}`)
  return readFile(path, "utf8")
}

async function writeAtomic(target: string, content: string, replace: boolean): Promise<void> {
  const directory = dirname(target)
  await requireSafeDirectory(directory, "project role-profile directory")
  const temporary = join(directory, `.zcode-cycle-${randomUUID()}.tmp`)
  const backup = join(directory, `.zcode-cycle-${randomUUID()}.bak`)
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 })
  try {
    if (!replace) {
      await rename(temporary, target)
      return
    }
    await rename(target, backup)
    try {
      await rename(temporary, target)
    } catch (error) {
      await rename(backup, target).catch(() => undefined)
      throw error
    }
    await rm(backup)
  } finally {
    await rm(temporary, { force: true })
    await rm(backup, { force: true })
  }
}

function report(
  projectRoot: string,
  records: readonly ProfileRecord[],
  changed: boolean,
  pins: Record<string, Pin>,
  /** Why the managed profiles could not be excluded from git, when they could not. */
  gitExcludeWarning?: string | null,
): object {
  // DEFECT-25: what was asked for, against what is on disk and will actually be
  // dispatched. A pin that no longer appears in its profile is reported by name
  // rather than left for the operator to notice from a ledger entry after the
  // verdict has already been rendered.
  const drift = records.flatMap((record) => {
    const pinned = pins[record.role]
    if (!pinned) return []
    const resolved = record.model ?? INHERIT_MODEL
    if (resolved === pinned.model) return []
    return [{ on_disk: resolved, pinned: pinned.model, role: record.role }]
  })
  return {
    changed,
    profile_directory: join(projectRoot, ".zcode", "agents"),
    profiles: records.map(({ digest, file, model, role, state, thought_level }) => ({
      ...(digest ? { digest } : {}),
      ...(dispatchUnverified(model) ? { dispatch_unverified: true } : {}),
      file: `zcode-cycle-${file}`,
      ...(model ? { model } : {}),
      ...(pins[role] ? { model_requested: pins[role]!.model } : {}),
      role,
      state,
      ...(thought_level ? { thought_level } : {}),
    })),
    ready: records.every((record) => record.state === "current") && drift.length === 0,
    requires_session_restart: changed,
    ...(records.some((record) => dispatchUnverified(record.model))
      ? {
          dispatch_unverified_warning:
            `${records
              .filter((record) => dispatchUnverified(record.model))
              .map((record) => `${record.role} on ${record.model}`)
              .join(", ")}. This plugin validates the shape of a model reference; only the host can ` +
            `resolve the provider, and it reports that at dispatch. Probe each pinned role before ` +
            `starting a governed cycle, so a provider-not-found costs seconds rather than a full ` +
            `architecture, execution and verification pass.`,
        }
      : {}),
    ...(gitExcludeWarning
      ? {
          git_exclude_warning:
            `${gitExcludeWarning}. The managed role profiles under .zcode/ will therefore appear as ` +
            `uncommitted project changes, and a governed cycle cannot freeze a candidate while they do. ` +
            `Add .zcode/ to .git/info/exclude, or commit the profiles before starting a cycle.`,
        }
      : {}),
    ...(drift.length > 0
      ? {
          pin_drift: drift,
          warning:
            `${drift.length === 1 ? "a role profile no longer carries" : "role profiles no longer carry"} ` +
            `the model it was pinned to, so ${drift.length === 1 ? "that role" : "those roles"} will be ` +
            `dispatched on ${drift.map((item) => `${item.role} on ${item.on_disk} instead of ${item.pinned}`).join(", ")}. ` +
            `Run cycle_role_profiles repair to restore the pinned model before dispatching, or configure the ` +
            `role to inherit if the pin is no longer wanted.`,
        }
      : {}),
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}
