# Per-Role Model Configuration

ZCode Cycle remains model-agnostic while roles inherit the active session
model. Explicit per-role overrides are deliberately fail-closed: this release
accepts only the verified Z.ai Coding Plan model and thought-level pairs below,
so it does not write a profile that ZCode may silently ignore or reject.
Assignments are constrained edits to the managed project profiles and never
leave the project.

## Read assignments

`/cycle:models` prints each role's effective model (explicit or
inherit) and reasoning effort.

## Assign a model

`/cycle:models <role> <model-ref|inherit> [thought-level]` where role is one
of `architect`, `executor`, `functional-reviewer`, `security-reviewer`,
`arbiter`. Use `inherit` to follow the primary Agent; omit its thought level,
because ZCode applies `thoughtLevel` only when a specific model is set.

For an explicit assignment, use exactly one of these current built-in model
references and pairs. Do not infer a shorter alias or substitute a similarly
named model from another provider.

| Exact ZCode model reference | Allowed thought levels | Default |
| --- | --- | --- |
| `custom:builtin:zai-coding-plan:GLM-5.3` | `low`, `high`, `max` | `high` |
| `custom:builtin:zai-coding-plan:GLM-5.3-Flash` | `low`, `high`, `max` | `high` |
| `custom:builtin:zai-coding-plan:GLM-5-Turbo` | `enabled`, `off` | `off` |

`nothink` and `medium` are intentionally not accepted by this release. Cycle
rejects any unknown model or pair before changing a managed profile. The tool
preserves the security-critical prompt and tool list; an override applies in a
new session.

## Third-party models

ZCode lets you add models from other providers, and Cycle does not accept them
for a governed role. The control plane verifies each managed profile against a
known baseline, and it cannot check the capabilities or the thought-level
vocabulary of a model it does not know — accepting one would mean recording an
unverified claim about who judged your candidate. A profile edited by hand to
name a third-party model is therefore reported as `managed-drift` by
`/cycle:setup status` rather than being accepted silently.

This applies only to the five governed roles. Your own main session may use any
model ZCode offers.

## What the ledger records

Every event a role produces records the model pinned in its profile, read from
that profile when the event is written. `inherit` is recorded as `inherit`: the
session's model is a weaker claim than a pinned one, and the record does not
flatten the difference.

Read what that claim is, exactly. Cycle cannot see ZCode's dispatch, so the
ledger attests **the model the role was assigned**, not the model that answered.
`/cycle:history` and an exported receipt therefore answer *which model this role
was pinned to when it approved your candidate* — and, because a profile edited
away from its managed baseline is reported as drift and blocks a run, that
assignment is one the control plane has checked. It is not an observation of the
inference itself, and no audit trail written outside the host can make it one.

## A pin that goes missing says so

An assignment is recorded apart from the profile it was written into, outside
the project tree, and the two are compared every time you run `/cycle:setup`.
When a profile no longer carries the model it was assigned, the result names the
role, what was asked for and what is actually on disk, and the command reports
that before anything else.

This exists because the profile's `model:` line used to be both the request and
its resolution. Anything that rewrote the profile from its managed template
erased the request without trace, and the run went ahead on the session model
with the ledger faithfully recording `inherit` — accurate about what it saw, and
silent about what you had asked for. A profile rewritten from its own template
is structurally perfect, so `repair` no longer waits for damage: a pin missing
from the file it was set on is itself the thing to repair.

`/cycle:models <role> inherit` withdraws a pin deliberately, and is not drift.

## Verified and claimed gate results are not the same entry

A gate the control plane ran and a gate a session reported are distinguishable
in the record: a reported one carries `declared`. Only the caller-facing audit
path can set it, and it always does, so a claimed pass cannot be mistaken for a
verified one by anything reading the entry. Entries written before this field
existed carry their original bytes and read as what they were — produced by the
control plane.

## Choosing models

- The **architect** and **arbiter** benefit from the strongest reasoning
  you have: decomposition quality and final judgment dominate their
  outcomes.
- The **executor** benefits from a strong coding model; its work is
  independently verified regardless, so a mismatch surfaces as repair
  cycles, not silent defects.
- Reviewers should differ from the executor where possible — correlated
  blind spots are the failure mode separation of roles exists to prevent.

A cost-conscious assignment (strong architect and arbiter, cheaper
executor and reviewers) is legitimate: the gates, not the models, carry
the correctness guarantee.
