# Goals and Consultation

Work that spans several sessions belongs to a goal, not a workflow.

## Goal lifecycle

Draft → Planning → Ready → Active → Completing → Completed, with pause,
block and abort side paths. Plans are versioned: every save records a
revision with its digest. The objective is immutable; amendments append.

## Milestones and completion gates

Each implementation milestone is a normal governed workflow, linked with
`link_workflow`. Completion is earned, not declared:

- `request_completion` requires at least one linked workflow;
- every linked milestone must have a COMPLETED workflow — cancelled
  does not count;
- `approve_completion` must cite the arbiter's receipt digest as
  `completion_evidence`. No evidence, no completion.

Continuations are bounded (default five): a goal can be continued
across sessions without living forever.

## Consultations without a cycle

`/cycle:architect`, `/cycle:feasibility`,
`/cycle:review-implementation`, `/cycle:review-security` and
`/cycle:arbiter` consult a single role for planning or advisory input.
They are bounded by design: the executor analyzes but never implements
outside a governed workflow; reviewers stay read-only; the arbiter's
outside verdict is advisory — final approval exists only inside a
complete governed workflow, enforced by the control plane's state
machine, not by prompt instructions.
