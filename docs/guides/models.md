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
