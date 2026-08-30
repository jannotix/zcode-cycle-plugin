import { createRequire } from "node:module";
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: __accessProp.bind(mod, key),
        enumerable: true
      });
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/role-profiles.ts
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
var MAX_PROFILE_BYTES = 256 * 1024;
var MODEL_REF = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:/-]+$/u;
var CUSTOM_MODEL_REF = /^custom:(?:[A-Za-z0-9._+\/-]|%[0-9A-Fa-f]{2})+:(?:[A-Za-z0-9._:+\/-]|%[0-9A-Fa-f]{2})+$/u;
var THOUGHT_LEVELS = new Set(["low", "medium", "high", "max"]);
var ROLE_PROFILES = [
  { file: "architect.md", role: "architect" },
  { file: "executor.md", role: "executor" },
  { file: "functional-reviewer.md", role: "functional-reviewer" },
  { file: "security-reviewer.md", role: "security-reviewer" },
  { file: "arbiter.md", role: "arbiter" }
];
async function manageRoleProfiles(options) {
  const projectRoot = resolve(options.projectRoot);
  const pluginRoot = resolve(options.pluginRoot);
  await requireSafeDirectory(projectRoot, "project root");
  await requireSafeDirectory(pluginRoot, "plugin root");
  await requireSafeDirectory(join(pluginRoot, "agents"), "plugin role-profile directory");
  const templates = new Map;
  for (const profile of ROLE_PROFILES) {
    const source = join(pluginRoot, "agents", profile.file);
    const content = await readBoundedRegularFile(source, "role-profile template");
    assertCanonicalTemplate(content, profile.role);
    templates.set(profile.role, content);
  }
  const mutating = options.operation !== "status";
  let changed = false;
  const targetDirectory = await roleProfileDirectory(projectRoot, mutating);
  const records = await Promise.all(ROLE_PROFILES.map((profile) => inspectProfile(targetDirectory, profile.role, profile.file, templates.get(profile.role))));
  switch (options.operation) {
    case "status":
      return report(projectRoot, records, false);
    case "install":
      requireConfirmation(options.confirmation, "INSTALL_ZCODE_CYCLE_ROLE_PROFILES");
      rejectStates(records, new Set(["managed-drift", "conflict"]), "install");
      for (const record of records) {
        if (record.state === "missing") {
          await writeAtomic(record.target, templates.get(record.role), false);
          changed = true;
        }
      }
      break;
    case "repair":
      requireConfirmation(options.confirmation, "REPAIR_ZCODE_CYCLE_ROLE_PROFILES");
      rejectStates(records, new Set(["conflict"]), "repair");
      for (const record of records) {
        if (record.state !== "current") {
          const template = templates.get(record.role);
          const settings = record.state === "managed-drift" && record.content ? extractManagedSettings(record.content, record.role) : null;
          const repaired = settings ? template.replace(/^model:.*$/mu, `model: ${settings.model}`).replace(/^thoughtLevel:.*$/mu, `thoughtLevel: ${settings.thought_level}`) : template;
          await writeAtomic(record.target, repaired, record.state !== "missing");
          changed = true;
        }
      }
      break;
    case "configure": {
      requireConfirmation(options.confirmation, "CONFIGURE_ZCODE_CYCLE_ROLE_PROFILE");
      rejectStates(records, new Set(["missing", "managed-drift", "conflict"]), "configure");
      const role = canonicalRole(options.role);
      const model = options.model ?? "inherit";
      if (!validModel(model)) {
        throw new Error("role-profile model must be inherit, provider/model or a ZCode custom:provider:model value");
      }
      const thoughtLevel = options.thoughtLevel ?? "high";
      if (!THOUGHT_LEVELS.has(thoughtLevel)) {
        throw new Error("role-profile thought level must be low, medium, high or max");
      }
      const record = records.find((item) => item.role === role);
      const configured = record.content.replace(/^model:.*$/mu, `model: ${model}`).replace(/^thoughtLevel:.*$/mu, `thoughtLevel: ${thoughtLevel}`);
      if (configured !== record.content) {
        await writeAtomic(record.target, configured, true);
        changed = true;
      }
      break;
    }
    case "remove":
      requireConfirmation(options.confirmation, "REMOVE_ZCODE_CYCLE_ROLE_PROFILES");
      rejectStates(records, new Set(["conflict"]), "remove");
      for (const record of records) {
        if (record.state !== "missing") {
          await rm(record.target);
          changed = true;
        }
      }
      break;
    default:
      throw new Error(`unsupported role-profile operation: ${String(options.operation)}`);
  }
  const afterDirectory = await roleProfileDirectory(projectRoot, false);
  const after = await Promise.all(ROLE_PROFILES.map((profile) => inspectProfile(afterDirectory, profile.role, profile.file, templates.get(profile.role))));
  return report(projectRoot, after, changed);
}
function canonicalRole(value) {
  const role = ROLE_PROFILES.find((item) => item.role === value)?.role;
  if (!role)
    throw new Error("unknown Cycle role profile");
  return role;
}
function marker(role) {
  return `<!-- zcode-cycle-managed-role-profile: ${role} -->`;
}
function assertCanonicalTemplate(content, role) {
  if (!content.includes(marker(role)))
    throw new Error(`role-profile template lacks marker: ${role}`);
  if (!content.includes(`name: zcode-cycle:${role}`)) {
    throw new Error(`role-profile template has the wrong identity: ${role}`);
  }
  if (!/^model: inherit$/mu.test(content) || !/^thoughtLevel: high$/mu.test(content)) {
    throw new Error(`role-profile template has a non-canonical model configuration: ${role}`);
  }
}
async function roleProfileDirectory(projectRoot, create) {
  let current = projectRoot;
  for (const segment of [".zcode", "agents"]) {
    current = join(current, segment);
    try {
      await requireSafeDirectory(current, "project role-profile directory");
    } catch (error) {
      if (!isMissing(error))
        throw error;
      if (!create)
        return null;
      await mkdir(current);
      await requireSafeDirectory(current, "project role-profile directory");
    }
  }
  return current;
}
async function inspectProfile(directory, role, file, template) {
  const target = join(directory ?? "", `zcode-cycle-${file}`);
  if (directory === null)
    return { file, role, state: "missing", target };
  let content;
  try {
    content = await readBoundedRegularFile(target, "installed role profile");
  } catch (error) {
    if (isMissing(error))
      return { file, role, state: "missing", target };
    throw error;
  }
  const configured = configuredProfile(content, template, role);
  return {
    content,
    digest: sha256(content),
    file,
    ...configured === null ? {} : configured,
    role,
    state: configured === null ? content.includes(marker(role)) ? "managed-drift" : "conflict" : "current",
    target
  };
}
function configuredProfile(content, template, role) {
  const settings = extractManagedSettings(content, role);
  if (!settings)
    return null;
  const normalized = content.replace(/^model:.*$/mu, "model: inherit").replace(/^thoughtLevel:.*$/mu, "thoughtLevel: high");
  return normalized === template ? settings : null;
}
function extractManagedSettings(content, role) {
  if (!content.includes(marker(role)))
    return null;
  const models = [...content.matchAll(/^model:\s*(\S+)\s*$/gmu)].map((match) => match[1]);
  const thoughtLevels = [...content.matchAll(/^thoughtLevel:\s*(\S+)\s*$/gmu)].map((match) => match[1]);
  if (models.length !== 1 || thoughtLevels.length !== 1)
    return null;
  const model = models[0];
  const thoughtLevel = thoughtLevels[0];
  if (!validModel(model) || !THOUGHT_LEVELS.has(thoughtLevel))
    return null;
  return { model, thought_level: thoughtLevel };
}
function validModel(value) {
  return value === "inherit" || MODEL_REF.test(value) || CUSTOM_MODEL_REF.test(value);
}
function rejectStates(records, denied, action) {
  const blocked = records.filter((record) => denied.has(record.state));
  if (blocked.length > 0) {
    throw new Error(`role-profile ${action} refused: ${blocked.map((item) => `${item.role}=${item.state}`).join(", ")}`);
  }
}
function requireConfirmation(actual, expected) {
  if (actual !== expected)
    throw new Error(`role-profile operation requires confirmation ${expected}`);
}
async function requireSafeDirectory(path, label) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error(`${label} is unsafe: ${path}`);
}
async function readBoundedRegularFile(path, label) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error(`${label} is unsafe: ${path}`);
  if (info.size > MAX_PROFILE_BYTES)
    throw new Error(`${label} exceeds the safety limit: ${path}`);
  return readFile(path, "utf8");
}
async function writeAtomic(target, content, replace) {
  const directory = dirname(target);
  await requireSafeDirectory(directory, "project role-profile directory");
  const temporary = join(directory, `.zcode-cycle-${randomUUID()}.tmp`);
  const backup = join(directory, `.zcode-cycle-${randomUUID()}.bak`);
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 384 });
  try {
    if (!replace) {
      await rename(temporary, target);
      return;
    }
    await rename(target, backup);
    try {
      await rename(temporary, target);
    } catch (error) {
      await rename(backup, target).catch(() => {
        return;
      });
      throw error;
    }
    await rm(backup);
  } finally {
    await rm(temporary, { force: true });
    await rm(backup, { force: true });
  }
}
function report(projectRoot, records, changed) {
  return {
    changed,
    profile_directory: join(projectRoot, ".zcode", "agents"),
    profiles: records.map(({ digest, file, model, role, state, thought_level }) => ({
      ...digest ? { digest } : {},
      file: `zcode-cycle-${file}`,
      ...model ? { model } : {},
      role,
      state,
      ...thought_level ? { thought_level } : {}
    })),
    ready: records.every((record) => record.state === "current"),
    requires_session_restart: changed
  };
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function isMissing(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
export {
  manageRoleProfiles
};
