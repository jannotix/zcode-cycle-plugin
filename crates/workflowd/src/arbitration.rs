//! What the control plane does with an arbiter's verdict before anything is
//! written.
//!
//! A rejection binds. The arbiter is the final judge of *whether the candidate
//! satisfies the request*, not of whether a reviewer's rejection counts: an
//! approval that stands against a live rejection, or over a mandatory gate that
//! did not pass, is refused.
//!
//! The refusal is a decision, not an error. Raising it before the verdict was
//! written left no arbitration row, no history event and nothing new for the
//! orchestrator to read, so the same arbiter was dispatched again with the same
//! inputs and produced the same verdict. Deciding here, and recording the
//! decision beside the verdict, converges in one dispatch even when the arbiter
//! is wrong.

use workflow_core::{ArbiterDecision, RepairTarget, ReviewDecision, ReviewVerdict};

/// Why an approval was refused, and where the work goes back to.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Refusal {
    pub reason: &'static str,
    pub repair_target: RepairTarget,
}

pub const REVIEWER_REJECTED: &str = "an independent reviewer rejected this candidate";
pub const MANDATORY_GATE_FAILED: &str = "a mandatory gate did not pass";

/// Decides whether an arbiter verdict may stand.
///
/// A rejection is always the arbiter's to make and is never refused here; only
/// an approval can contradict something.
#[must_use]
pub fn refusal(
    decision: ArbiterDecision,
    reviews_approved: bool,
    mandatory_gates_passed: bool,
    reviews: &[ReviewVerdict],
) -> Option<Refusal> {
    if decision != ArbiterDecision::Approved {
        return None;
    }
    if !reviews_approved {
        return Some(Refusal {
            reason: REVIEWER_REJECTED,
            repair_target: rejected_repair_target(reviews),
        });
    }
    (!mandatory_gates_passed).then_some(Refusal {
        reason: MANDATORY_GATE_FAILED,
        // Gates prove the implementation, so a gate that did not pass sends the
        // work back to the executor rather than to the architect.
        repair_target: RepairTarget::Execution,
    })
}

/// Where a refused approval sends the work back to.
///
/// A plan defect outranks an implementation finding: if either rejecting
/// reviewer says the architecture is wrong, repairing the implementation
/// against that same plan would produce the same candidate again.
#[must_use]
pub fn rejected_repair_target(reviews: &[ReviewVerdict]) -> RepairTarget {
    if reviews.iter().any(|review| {
        review.decision == ReviewDecision::Rejected
            && review.repair_target == Some(RepairTarget::Architecture)
    }) {
        RepairTarget::Architecture
    } else {
        RepairTarget::Execution
    }
}

#[must_use]
pub const fn repair_target_name(target: RepairTarget) -> &'static str {
    match target {
        RepairTarget::Architecture => "architecture",
        RepairTarget::Execution => "execution",
    }
}
