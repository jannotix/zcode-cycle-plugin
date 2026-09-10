import { join } from "node:path"

import { BrowserEvidenceRegistry } from "./browser/browser-evidence.js"
import { BrowserManager } from "./browser/browser-manager.js"
import { attestForVerification, browserRun } from "./browser/browser-ops.js"
import {
  browserCandidates,
  ManagedBrowserSessionFactory,
} from "./browser/managed-browser-session.js"

// Where the browser is looked for is the only part of the managed browser that
// differs by platform, and it is the part Linux has never been observed
// exercising. Exposed from this on-demand module so a test can prove the list
// without a desktop and without loading the browser on the handshake path.
export { browserCandidates }

export interface CycleBrowserRuntime {
  attest(args: Record<string, unknown>): Promise<readonly unknown[]>
  dispose(): Promise<void>
  run(input: {
    readonly command: Record<string, unknown>
    readonly registration: { role: string } | undefined
    readonly sessionId: string
  }): Promise<unknown>
}

export function createBrowserRuntime(options: {
  readonly allowedOrigins?: readonly string[]
  readonly dataDirectory: string
}): CycleBrowserRuntime {
  const registry = new BrowserEvidenceRegistry(join(options.dataDirectory, "browser"))
  const manager = new BrowserManager({
    ...(options.allowedOrigins !== undefined && options.allowedOrigins.length > 0
      ? { allowedOrigins: options.allowedOrigins }
      : {}),
    artifactDirectory: join(options.dataDirectory, "browser"),
    create: (input) =>
      new ManagedBrowserSessionFactory({
        ...(process.env.ZCODE_CYCLE_BROWSER
          ? { browserExecutable: process.env.ZCODE_CYCLE_BROWSER }
          : {}),
        headless: process.env.ZCODE_CYCLE_BROWSER_HEADLESS !== "false",
        projectDirectory: process.env.ZCODE_PROJECT_DIR ?? process.cwd(),
      }).create(input),
    maxSessions: 2,
  })
  return {
    attest: (args) => attestForVerification(args, registry),
    dispose: () => manager.dispose(),
    run: ({ command, registration, sessionId }) =>
      browserRun({ command, manager, registration, registry, sessionId }),
  }
}
