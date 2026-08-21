# Managed Browser QA

The managed browser is how ZCode Cycle turns "the UI works" into
evidence. It is a tool inside the governed workflow, not a separate
interface.

## What it is

Each session launches an isolated browser with a temporary profile that
is destroyed on close. Loopback pages (127.x, localhost) open by
default; every other origin is blocked — navigation AND background
requests — until you explicitly approve that origin after the tool
reports `origin-approval-required`. Filled values are redacted from
logs, snapshots and receipts.

## Who may use it

Interactive actions (click, fill, press, upload) are executor-only;
read-only roles may inspect via snapshot, logs and checks. The PreToolUse
hook enforces the boundary and audits it.

## Evidence

Closing a session persists a receipt: every action with its digest,
timestamp and URL, plus captured logs. For UI-affecting candidates the
daemon adds mandatory gates — `browser:affected-user-flow` requires the
receipt to contain open, check, screenshot, logs, close in order;
`accessibility:affected-user-flow` requires open, snapshot, close. The
orchestrator runs one executor session covering both protocols and
attaches the receipt to verification, bound to the frozen candidate
digest. A skipped browser gate is reported, never hidden.

## Limits

At most two concurrent sessions per project. Screenshots and receipts
live in your user data directory, never in your repository.
