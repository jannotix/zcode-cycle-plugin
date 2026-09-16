// The role-session registry's pure decisions.
//
// Kept out of server.ts because that module is the process entry point: it
// attaches to stdin and starts serving as soon as it is imported, so a test that
// wants to check a decision cannot import it without starting a server. A pure
// function that a test must launch a process to reach is a pure function nobody
// tests.

export interface RoleRegistration {
  readonly kind?: "role"
  readonly project_directory: string
  readonly project_key: string
  readonly registered_at_unix_millis: number
  readonly role: string
  readonly workflow_id: string | null
}

export interface WorkflowLock {
  readonly kind: "workflow_lock"
  readonly project_directory: string
  readonly project_key: string
  readonly registered_at_unix_millis: number
  readonly workflow_id: string
  readonly worktree_path?: string
}

export type RegistryRecord = RoleRegistration | WorkflowLock

export function isRoleRegistration(
  value: RegistryRecord | undefined,
): value is RoleRegistration {
  return value !== undefined && value.kind !== "workflow_lock" && typeof value.role === "string"
}

export function isWorkflowLock(value: RegistryRecord | undefined): value is WorkflowLock {
  return value?.kind === "workflow_lock"
}

/**
 * Which role registrations a sweep should revoke.
 *
 * With a workflow id, that workflow's registrations. Without one, every
 * registration whose workflow no longer holds a lock — a project-level recovery
 * used to be skipped entirely, which left the caller with nothing to do but
 * revoke by hand.
 *
 * A registration naming no workflow is left alone: it is not tied to one, so
 * there is no lock whose absence would make it orphaned, and guessing here would
 * revoke something this sweep has no evidence about.
 *
 * Workflow locks are never returned. A lock is what keeps the main session
 * read-only while its workflow is non-terminal; it has an owner as long as the
 * workflow does.
 */
export function orphanedRegistrationKeys(
  registry: Record<string, RegistryRecord>,
  workflowId?: string,
): string[] {
  const locked = new Set(
    Object.values(registry)
      .filter(isWorkflowLock)
      .map((lock) => lock.workflow_id),
  )
  const keys: string[] = []
  for (const [key, value] of Object.entries(registry)) {
    if (!isRoleRegistration(value)) continue
    const orphaned =
      workflowId === undefined
        ? value.workflow_id !== null && !locked.has(value.workflow_id)
        : value.workflow_id === workflowId
    if (orphaned) keys.push(key)
  }
  return keys
}
