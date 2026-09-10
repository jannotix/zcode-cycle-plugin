// The browser gates are platform-generic except for one thing: where the
// browser is looked for. That list is the only part of the managed browser that
// differs between Windows, where the gates were qualified, and Linux, where they
// have not been observed running. It is a pure function, so it is proven here
// rather than left to a certification row that needs a desktop.

import assert from "node:assert/strict"
import test from "node:test"

import { browserCandidates } from "../dist/browser-runtime.js"

test("Linux looks for the browsers a distribution actually installs", () => {
  const candidates = browserCandidates("linux", {})
  assert.deepEqual(candidates, [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/microsoft-edge-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ])
})

test("the Linux list needs no environment and is never empty", () => {
  // Windows builds its paths from PROGRAMFILES and LOCALAPPDATA, so an empty
  // environment leaves it with nothing to try. Linux paths are absolute, which
  // is why a Linux user gets the named "no browser found" refusal rather than an
  // empty search that reads like a different failure.
  assert.equal(browserCandidates("win32", {}).length, 0)
  assert.ok(browserCandidates("linux", {}).length > 0)
  assert.ok(browserCandidates("darwin", {}).length > 0)
})

test("every candidate is an absolute path, on every platform", () => {
  const environment = {
    LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
    PROGRAMFILES: "C:\\Program Files",
    "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
  }
  for (const platform of ["win32", "darwin", "linux"]) {
    for (const candidate of browserCandidates(platform, environment)) {
      const absolute = candidate.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(candidate)
      assert.ok(absolute, `${platform} candidate is not absolute: ${candidate}`)
    }
  }
})

test("an unknown platform falls back to the Linux list rather than to nothing", () => {
  // Anything that is not Windows or macOS takes the POSIX branch. A browser
  // gate is mandatory once the daemon inserts it, so returning an empty list
  // would turn "we did not look" into a refusal that names the wrong cause.
  assert.deepEqual(browserCandidates("freebsd", {}), browserCandidates("linux", {}))
})
