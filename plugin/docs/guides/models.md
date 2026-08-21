# Per-Role Model Configuration

ZCode Cycle is model-agnostic. Every role inherits your active session
model unless you assign a specific one; assignments live in your local
installation as user-scope agent overrides and never leave your machine.

## Read assignments

`/cycle:models` prints each role's effective model (explicit or
inherit) and reasoning effort.

## Assign a model

`/cycle:models <role> <provider/model>` where role is one of
`architect`, `executor`, `functional-reviewer`, `security-reviewer`,
`arbiter`. The provider/model identifier is the one your ZCode
installation resolves. The override applies after a session restart.

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
