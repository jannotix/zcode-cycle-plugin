//! A rejection binds, and refusing an approval that contradicts one is a
//! decision the record keeps rather than an error thrown away.

use std::num::NonZeroUsize;

use workflow_core::{
    ArbiterDecision, CandidateId, ContentDigest, RepairTarget, ReviewDecision, ReviewVerdict,
    WorkflowCommand, WorkflowId, WorkflowMode, WorkflowRole, WorkflowState, WorkflowTimestamp,
};
use workflow_store::Store;
use workflowd::arbitration::{
    MANDATORY_GATE_FAILED, REQUEST_CONSTRAINT_VIOLATED, REVIEWER_REJECTED, refusal,
};
use workflowd::repair::{RepairCause, route};

/// DEFECT-15, found by scenario 5 of the live certification: the stored request
/// said "do not modify any test file", the approved candidate's file list named
/// one, and the approval stood. Judging the candidate against the immutable
/// original request is the arbiter's whole purpose.
#[test]
fn an_approval_that_contradicts_the_immutable_request_is_refused_to_the_executor() {
    let reviews = [
        approved(WorkflowRole::FunctionalReviewer),
        approved(WorkflowRole::SecurityArchitectureReviewer),
    ];
    let refused = refusal(ArbiterDecision::Approved, true, true, &reviews, true)
        .expect("an approval over an explicit request constraint must be refused");
    assert_eq!(refused.reason, REQUEST_CONSTRAINT_VIOLATED);
    // The plan may have been right; the files written were not.
    assert_eq!(refused.repair_target, RepairTarget::Execution);
}

/// Approving reviewers do not make the frozen request say something else.
#[test]
fn a_request_constraint_outranks_every_approval_around_it() {
    let reviews = [
        approved(WorkflowRole::FunctionalReviewer),
        approved(WorkflowRole::SecurityArchitectureReviewer),
    ];
    let refused = refusal(ArbiterDecision::Approved, true, true, &reviews, true).unwrap();
    assert_eq!(refused.reason, REQUEST_CONSTRAINT_VIOLATED);
    // A rejection is still the arbiter's to make and is never refused here.
    assert!(refusal(ArbiterDecision::Rejected, true, true, &reviews, true).is_none());
}

fn review(
    role: WorkflowRole,
    decision: ReviewDecision,
    target: Option<RepairTarget>,
) -> ReviewVerdict {
    ReviewVerdict {
        candidate_digest: ContentDigest::of(b"candidate"),
        decision,
        findings: Vec::new(),
        repair_target: target,
        requirements: Vec::new(),
        role,
    }
}

fn approved(role: WorkflowRole) -> ReviewVerdict {
    review(role, ReviewDecision::Approved, None)
}

fn rejected(role: WorkflowRole, target: RepairTarget) -> ReviewVerdict {
    review(role, ReviewDecision::Rejected, Some(target))
}

#[test]
fn an_approval_that_contradicts_a_rejection_is_refused_toward_the_reviewers_target() {
    for target in [RepairTarget::Execution, RepairTarget::Architecture] {
        let reviews = [
            approved(WorkflowRole::FunctionalReviewer),
            rejected(WorkflowRole::SecurityArchitectureReviewer, target),
        ];
        let refused = refusal(ArbiterDecision::Approved, false, true, &reviews, false)
            .expect("an approval over a live rejection must be refused");
        assert_eq!(refused.reason, REVIEWER_REJECTED);
        assert_eq!(
            refused.repair_target, target,
            "the work goes back where the rejecting reviewer asked"
        );
    }
}

#[test]
fn a_plan_defect_outranks_an_implementation_finding() {
    // Repairing the implementation against a plan another reviewer called wrong
    // would produce the same candidate again.
    let reviews = [
        rejected(WorkflowRole::FunctionalReviewer, RepairTarget::Execution),
        rejected(
            WorkflowRole::SecurityArchitectureReviewer,
            RepairTarget::Architecture,
        ),
    ];
    let refused = refusal(ArbiterDecision::Approved, false, true, &reviews, false).unwrap();
    assert_eq!(refused.repair_target, RepairTarget::Architecture);
}

#[test]
fn an_approval_over_a_failed_mandatory_gate_is_refused_toward_execution() {
    let reviews = [
        approved(WorkflowRole::FunctionalReviewer),
        approved(WorkflowRole::SecurityArchitectureReviewer),
    ];
    let refused = refusal(ArbiterDecision::Approved, true, false, &reviews, false)
        .expect("an approval over a failed mandatory gate must be refused");
    assert_eq!(refused.reason, MANDATORY_GATE_FAILED);
    assert_eq!(refused.repair_target, RepairTarget::Execution);
}

#[test]
fn an_approval_with_both_reviews_and_every_gate_behind_it_stands() {
    let reviews = [
        approved(WorkflowRole::FunctionalReviewer),
        approved(WorkflowRole::SecurityArchitectureReviewer),
    ];
    assert_eq!(
        refusal(ArbiterDecision::Approved, true, true, &reviews, false),
        None
    );
}

#[test]
fn a_rejection_is_never_refused_whatever_the_reviewers_said() {
    // The arbiter may reject work the reviewers approved; only an approval can
    // contradict something.
    let reviews = [
        approved(WorkflowRole::FunctionalReviewer),
        approved(WorkflowRole::SecurityArchitectureReviewer),
    ];
    assert_eq!(
        refusal(ArbiterDecision::Rejected, true, true, &reviews, false),
        None
    );
    assert_eq!(
        refusal(ArbiterDecision::Rejected, false, false, &reviews, false),
        None
    );
}

#[test]
fn a_refused_approval_converges_in_one_dispatch_instead_of_repeating() {
    // The defect this covers: the refusal used to be raised before anything was
    // written, so the workflow stayed in arbitration and the same arbiter was
    // dispatched again with the same inputs. Routing the refusal to repair moves
    // the workflow on, which is what lets one dispatch settle it.
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(
        directory.path().join("workflow.db"),
        NonZeroUsize::new(1).unwrap(),
    )
    .unwrap();
    let workflow_id = WorkflowId::new();
    let candidate_id = CandidateId::new();
    let timestamp = WorkflowTimestamp::now();
    for (key, command) in [
        ("intake", WorkflowCommand::CompleteIntake),
        ("route", WorkflowCommand::Route(WorkflowMode::Full)),
        ("architecture", WorkflowCommand::ArchitectureAccepted),
        ("candidate", WorkflowCommand::CandidateReady(candidate_id)),
        ("verified", WorkflowCommand::VerificationPassed),
        ("reviewed", WorkflowCommand::ReviewsReady),
    ] {
        store
            .apply_workflow_command(workflow_id, key, command, timestamp)
            .unwrap();
    }
    assert_eq!(
        store.load_workflow(workflow_id).unwrap().unwrap().state(),
        WorkflowState::Arbitration
    );

    let reviews = [
        approved(WorkflowRole::FunctionalReviewer),
        rejected(
            WorkflowRole::SecurityArchitectureReviewer,
            RepairTarget::Execution,
        ),
    ];
    let refused = refusal(ArbiterDecision::Approved, false, true, &reviews, false).unwrap();
    let outcome = route(
        &mut store,
        workflow_id,
        candidate_id,
        match refused.repair_target {
            RepairTarget::Architecture => RepairCause::PlanDefect,
            RepairTarget::Execution => RepairCause::ImplementationFinding,
        },
        WorkflowTimestamp::now(),
    )
    .unwrap();

    assert_eq!(
        outcome.state,
        WorkflowState::Execution,
        "a refused approval leaves arbitration instead of inviting the same verdict again"
    );
    assert_eq!(outcome.cycles, 1, "the refusal spends one repair cycle");
}
