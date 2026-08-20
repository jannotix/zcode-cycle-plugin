---
description: Inspect per-role model assignments or assign one until restart
argument-hint: "[role] [provider/model]"
---

Handle model assignment with arguments: $ARGUMENTS

No arguments: read the role agent definitions (architect, executor,
functional-reviewer, security-reviewer, arbiter) and report each role's
effective model (explicit or inherit) and reasoning effort.

With `role provider/model`: validate the model string format, then write a
user-scope agent override for that role in `~/.zcode/agents/` preserving
the role's other settings, and report the change plus that a session
restart makes it effective.

With invalid input: explain the two forms and stop.
