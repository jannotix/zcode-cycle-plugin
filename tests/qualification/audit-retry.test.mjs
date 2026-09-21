import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const SCRIPT = join(ROOT, "scripts", "ci", "audit-with-retry.sh")

// The dependency audit fails the build when it cannot reach the advisory service,
// and that is deliberate: an audit that did not run must never read as a clean
// result. A 503 outage still cost three consecutive runs and a release, so the
// request is retried - and only the request.
//
// These tests exist because the obvious "fix" for a flaky gate is to make it
// tolerant, and a tolerant gate is the defect 1.0.7 closed. What must hold is
// that a real answer is never retried and an unreachable service never passes.

/** A stub `bun` on PATH, so the script's own branching is what is measured. */
function stubEnvironment(script) {
  const directory = mkdtempSync(join(tmpdir(), "audit-retry-"))
  const bun = join(directory, "bun")
  writeFileSync(bun, script, { mode: 0o755 })
  chmodSync(bun, 0o755)
  return directory
}

function runWith(stub, { attempts = "3" } = {}) {
  const directory = stubEnvironment(stub)
  try {
    return spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        AUDIT_RETRY_ATTEMPTS: attempts,
        AUDIT_RETRY_INITIAL_DELAY: "0",
        PATH: `${directory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
      },
    })
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
}

test("an unreachable advisory service is retried and still fails", () => {
  const result = runWith(
    "#!/usr/bin/env bash\necho 'error: audit request failed (status 503)'\nexit 1\n",
  )
  assert.notEqual(result.status, 0, "an audit that never ran must not pass")
  assert.match(
    result.stderr,
    /refusing to report a clean result/u,
    "the final failure must say why, not merely exit",
  )
  assert.match(result.stderr, /retrying in/u, "a transient failure must be retried")
})

test("a real finding is not retried", () => {
  const result = runWith(
    "#!/usr/bin/env bash\necho '1 vulnerability found'\nexit 1\n",
  )
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(
    result.stderr,
    /retrying in/u,
    "a vulnerability is an answer; retrying it would only delay the same verdict",
  )
})

test("a service that recovers within the window passes", () => {
  const marker = join(mkdtempSync(join(tmpdir(), "audit-retry-state-")), "tried")
  const result = runWith(
    `#!/usr/bin/env bash\nif [ -f '${marker.split("\\").join("/")}' ]; then\n  echo 'No vulnerabilities found'\n  exit 0\nfi\ntouch '${marker.split("\\").join("/")}'\necho 'error: audit request failed (status 503)'\nexit 1\n`,
  )
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
