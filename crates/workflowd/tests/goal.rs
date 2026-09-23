use std::num::NonZeroUsize;

use tempfile::TempDir;
use workflow_core::{
    CandidateId, GoalId, ReceiptId, WorkflowCommand, WorkflowId, WorkflowMode, WorkflowTimestamp,
};
use workflow_ipc::{GoalControlAction, GoalOperation};
use workflow_ledger::CheckpointKey;
use workflow_store::Store;

fn store(temporary: &TempDir) -> Store {
    Store::open(
        temporary.path().join("workflow.db"),
        NonZeroUsize::new(2).unwrap(),
    )
    .unwrap()
}

#[test]
fn goal_api_persists_focus_plan_and_state() {
    let temporary = TempDir::new().unwrap();
    let mut store = store(&temporary);
    let key = CheckpointKey::from_seed(&[9; 32]);
    let goal_id = GoalId::new();
    workflowd::goal::execute(
        &mut store,
        &key,
        "project",
        GoalOperation::Create {
            constraints: vec!["Use supported dependencies".to_owned()],
            goal_id,
            max_continuations: 5,
            non_goals: vec![],
            objective: "Build a production SaaS".to_owned(),
            session_id: "session".to_owned(),
            success_criteria: vec!["The primary journey passes".to_owned()],
        },
    )
    .unwrap();
    let plan = workflowd::goal::execute(
        &mut store,
        &key,
        "project",
        GoalOperation::SavePlan {
            content: "Versioned architecture".to_owned(),
            goal_id,
            source_session_id: "architect-session".to_owned(),
        },
    )
    .unwrap();
    workflowd::goal::execute(
        &mut store,
        &key,
        "project",
        GoalOperation::Control {
            action: GoalControlAction::MarkReady,
            completion_evidence: None,
            goal_id,
            operation_id: ReceiptId::new(),
            reason: None,
        },
    )
    .unwrap();

    let status = workflowd::goal::execute(
        &mut store,
        &key,
        "project",
        GoalOperation::Status {
            goal_id: None,
            session_id: "session".to_owned(),
        },
    )
    .unwrap();
    assert_eq!(plan["revision"], 1);
    assert_eq!(status["goalId"], goal_id.to_string());
    assert_eq!(status["state"], "ready");
    assert_eq!(status["plan"]["content"], "Versioned architecture");
}

#[test]
fn completion_and_abort_fail_closed_without_required_evidence() {
    let temporary = TempDir::new().unwrap();
    let mut store = store(&temporary);
    let key = CheckpointKey::from_seed(&[9; 32]);
    let goal_id = GoalId::new();
    workflowd::goal::execute(
        &mut store,
        &key,
        "project",
        GoalOperation::Create {
            constraints: vec![],
            goal_id,
            max_continuations: 5,
            non_goals: vec![],
            objective: "Build a production SaaS".to_owned(),
            session_id: "session".to_owned(),
            success_criteria: vec![],
        },
    )
    .unwrap();

    assert!(
        workflowd::goal::execute(
            &mut store,
            &key,
            "project",
            GoalOperation::Control {
                action: GoalControlAction::ApproveCompletion,
                completion_evidence: None,
                goal_id,
                operation_id: ReceiptId::new(),
                reason: None,
            },
        )
        .is_err()
    );
    assert!(
        workflowd::goal::execute(
            &mut store,
            &key,
            "project",
            GoalOperation::Control {
                action: GoalControlAction::Abort,
                completion_evidence: None,
                goal_id,
                operation_id: ReceiptId::new(),
                reason: None,
            },
        )
        .is_err()
    );
}

#[test]
fn completed_milestone_supersedes_cancelled_attempts() {
    let temporary = TempDir::new().unwrap();
    let mut store = store(&temporary);
    let key = CheckpointKey::from_seed(&[9; 32]);
    let goal_id = GoalId::new();
    workflowd::goal::execute(
        &mut store,
        &key,
        "project",
        GoalOperation::Create {
            constraints: vec![],
            goal_id,
            max_continuations: 5,
            non_goals: vec![],
            objective: "Deliver one milestone".to_owned(),
            session_id: "session".to_owned(),
            success_criteria: vec!["The milestone is complete".to_owned()],
        },
    )
    .unwrap();
    workflowd::goal::execute(
        &mut store,
        &key,
        "project",
        GoalOperation::SavePlan {
            content: "Milestone plan".to_owned(),
            goal_id,
            source_session_id: "architect".to_owned(),
        },
    )
    .unwrap();
    for action in [GoalControlAction::MarkReady, GoalControlAction::Activate] {
        workflowd::goal::execute(
            &mut store,
            &key,
            "project",
            GoalOperation::Control {
                action,
                completion_evidence: None,
                goal_id,
                operation_id: ReceiptId::new(),
                reason: None,
            },
        )
        .unwrap();
    }

    let timestamp = WorkflowTimestamp::now();
    let cancelled = WorkflowId::new();
    store
        .apply_workflow_command(
            cancelled,
            "cancelled-intake",
            WorkflowCommand::CompleteIntake,
            timestamp,
        )
        .unwrap();
    store
        .apply_workflow_command(
            cancelled,
            "cancelled-route",
            WorkflowCommand::Route(WorkflowMode::Quick),
            timestamp,
        )
        .unwrap();
    store
        .apply_workflow_command(cancelled, "cancelled", WorkflowCommand::Cancel, timestamp)
        .unwrap();
    store
        .link_goal_workflow(goal_id, cancelled, "release", timestamp)
        .unwrap();

    let completed = WorkflowId::new();
    for (key, command) in [
        ("completed-intake", WorkflowCommand::CompleteIntake),
        (
            "completed-route",
            WorkflowCommand::Route(WorkflowMode::Quick),
        ),
        (
            "completed-candidate",
            WorkflowCommand::CandidateReady(CandidateId::new()),
        ),
        (
            "completed-verification",
            WorkflowCommand::VerificationPassed,
        ),
        (
            "completed-approval",
            WorkflowCommand::Approve {
                mandatory_gates_passed: true,
            },
        ),
        ("completed-delivery", WorkflowCommand::Deliver),
    ] {
        store
            .apply_workflow_command(completed, key, command, timestamp)
            .unwrap();
    }
    store
        .link_goal_workflow(goal_id, completed, "release", timestamp)
        .unwrap();

    let result = workflowd::goal::execute(
        &mut store,
        &key,
        "project",
        GoalOperation::Control {
            action: GoalControlAction::RequestCompletion,
            completion_evidence: None,
            goal_id,
            operation_id: ReceiptId::new(),
            reason: None,
        },
    )
    .unwrap();

    assert_eq!(result["state"], "completing");
}

// DEFECT-18, found by scenario 9 of the live certification: approving a goal's
// completion cited sixty-four zeros as arbiter evidence and the goal moved to
// completed. The gate checked that the field was present and well-formed, never
// that it named an arbiter receipt. Completion is the top-level claim that a
// body of work is done, and the receipt is the only thing tying that claim to a
// governed verdict.

/// Drives a workflow to delivered and records a real arbitration against it,
/// returning the digest of the receipt that was stored.
fn delivered_workflow_with_arbitration(
    store: &mut Store,
    goal_id: GoalId,
    milestone: &str,
) -> (WorkflowId, workflow_core::ContentDigest) {
    let timestamp = WorkflowTimestamp::now();
    let workflow_id = WorkflowId::new();
    let candidate_id = CandidateId::new();
    for (operation, command) in [
        ("intake", WorkflowCommand::CompleteIntake),
        ("route", WorkflowCommand::Route(WorkflowMode::Quick)),
        ("candidate", WorkflowCommand::CandidateReady(candidate_id)),
        ("verification", WorkflowCommand::VerificationPassed),
        (
            "approval",
            WorkflowCommand::Approve {
                mandatory_gates_passed: true,
            },
        ),
        ("delivery", WorkflowCommand::Deliver),
    ] {
        // Idempotency keys are global, so they carry the workflow they belong to.
        store
            .apply_workflow_command(
                workflow_id,
                &format!("{workflow_id}-{operation}"),
                command,
                timestamp,
            )
            .unwrap();
    }

    // The arbitration row references a real candidate, so the test records one
    // rather than asserting against a shape the schema would not accept.
    let manifest = workflow_core::CandidateManifest::new(
        candidate_id,
        Some("base".to_owned()),
        vec![
            workflow_core::CandidateFile::new(
                "src/lib.rs",
                Some(workflow_core::ContentDigest::of(b"content")),
                workflow_core::CandidateFileKind::Modified,
            )
            .unwrap(),
        ],
        workflow_core::CandidateDigests {
            configuration: workflow_core::ContentDigest::of(b"configuration"),
            dependency_state: workflow_core::ContentDigest::of(b"dependencies"),
            diff: workflow_core::ContentDigest::of(b"diff"),
            environment: workflow_core::ContentDigest::of(b"environment"),
        },
        Vec::new(),
    )
    .unwrap()
    .with_delivery_payload_digest(Some(workflow_core::ContentDigest::of(
        &serde_json::to_vec(&[(
            "src/lib.rs",
            workflow_core::ContentDigest::of(b"content").to_string(),
            false,
        )])
        .unwrap(),
    )));
    store
        .save_candidate_once(
            workflow_id,
            &manifest,
            b"diff",
            &[workflow_store::CandidateFilePayload::new(
                "src/lib.rs",
                b"content".to_vec(),
            )],
            timestamp,
        )
        .unwrap();

    let candidate_digest = manifest.digest();
    let verdict = workflow_core::ArbiterVerdict {
        decision: workflow_core::ArbiterDecision::Approved,
        candidate_digest,
        requirements: vec![],
        findings: vec![],
        repair_target: None,
    };
    let receipt = workflow_core::ArbitrationReceipt {
        arbiter_verdict_digest: verdict.digest(),
        candidate_digest,
        candidate_id,
        evidence_ids: std::collections::BTreeSet::new(),
        finalized_at: timestamp,
        functional_review_digest: None,
        id: ReceiptId::new(),
        request_digest: workflow_core::ContentDigest::of(b"request"),
        security_review_digest: None,
        workflow_id,
    };
    store
        .save_arbitration_once(workflow_id, candidate_id, &verdict, &receipt, timestamp)
        .unwrap();
    store
        .link_goal_workflow(goal_id, workflow_id, milestone, timestamp)
        .unwrap();
    (workflow_id, receipt.digest())
}

fn active_goal(store: &mut Store, key: &CheckpointKey) -> GoalId {
    let goal_id = GoalId::new();
    workflowd::goal::execute(
        store,
        key,
        "project",
        GoalOperation::Create {
            constraints: vec![],
            goal_id,
            max_continuations: 5,
            non_goals: vec![],
            objective: "Deliver one milestone".to_owned(),
            session_id: "session".to_owned(),
            success_criteria: vec!["The milestone is complete".to_owned()],
        },
    )
    .unwrap();
    workflowd::goal::execute(
        store,
        key,
        "project",
        GoalOperation::SavePlan {
            content: "Milestone plan".to_owned(),
            goal_id,
            source_session_id: "architect".to_owned(),
        },
    )
    .unwrap();
    for action in [GoalControlAction::MarkReady, GoalControlAction::Activate] {
        workflowd::goal::execute(
            store,
            key,
            "project",
            GoalOperation::Control {
                action,
                completion_evidence: None,
                goal_id,
                operation_id: ReceiptId::new(),
                reason: None,
            },
        )
        .unwrap();
    }
    goal_id
}

fn approve_completion(
    store: &mut Store,
    key: &CheckpointKey,
    goal_id: GoalId,
    evidence: workflow_core::ContentDigest,
) -> Result<serde_json::Value, String> {
    workflowd::goal::execute(
        store,
        key,
        "project",
        GoalOperation::Control {
            action: GoalControlAction::RequestCompletion,
            completion_evidence: None,
            goal_id,
            operation_id: ReceiptId::new(),
            reason: None,
        },
    )
    .unwrap();
    workflowd::goal::execute(
        store,
        key,
        "project",
        GoalOperation::Control {
            action: GoalControlAction::ApproveCompletion,
            completion_evidence: Some(evidence),
            goal_id,
            operation_id: ReceiptId::new(),
            reason: None,
        },
    )
}

#[test]
fn completion_evidence_that_names_no_receipt_is_refused() {
    let temporary = TempDir::new().unwrap();
    let mut store = store(&temporary);
    let key = CheckpointKey::from_seed(&[9; 32]);
    let goal_id = active_goal(&mut store, &key);
    delivered_workflow_with_arbitration(&mut store, goal_id, "release");

    // The exact value that completed a goal during the campaign.
    let zeros: workflow_core::ContentDigest = "0".repeat(64).parse().unwrap();
    let refused = approve_completion(&mut store, &key, goal_id, zeros)
        .expect_err("a digest that names no receipt must not complete a goal");
    assert!(
        refused.contains("arbitration receipt"),
        "the refusal must say what is missing: {refused}"
    );
}

#[test]
fn completion_evidence_that_names_a_recorded_receipt_is_accepted() {
    let temporary = TempDir::new().unwrap();
    let mut store = store(&temporary);
    let key = CheckpointKey::from_seed(&[9; 32]);
    let goal_id = active_goal(&mut store, &key);
    let (_, receipt_digest) = delivered_workflow_with_arbitration(&mut store, goal_id, "release");

    let completed = approve_completion(&mut store, &key, goal_id, receipt_digest)
        .expect("a goal citing a real arbitration receipt completes");
    assert_eq!(completed["state"], "completed");
}

#[test]
fn a_receipt_from_a_workflow_outside_the_goal_does_not_complete_it() {
    let temporary = TempDir::new().unwrap();
    let mut store = store(&temporary);
    let key = CheckpointKey::from_seed(&[9; 32]);
    let goal_id = active_goal(&mut store, &key);
    delivered_workflow_with_arbitration(&mut store, goal_id, "release");

    // A real receipt, governed and recorded - but for another goal's work.
    let other_goal = active_goal(&mut store, &key);
    let (_, foreign_digest) = delivered_workflow_with_arbitration(&mut store, other_goal, "other");

    let refused = approve_completion(&mut store, &key, goal_id, foreign_digest)
        .expect_err("a receipt from unlinked work must not complete this goal");
    assert!(refused.contains("linked to this goal"), "{refused}");
}

// DEFECT-19, found by scenario 9: a workflow could be linked to exactly one
// milestone, re-pointing it was refused, and no unlink existed - so a link made
// in error was permanent and the milestone kept asserting a tie to abandoned
// work.
#[test]
fn a_link_made_in_error_can_be_corrected() {
    let temporary = TempDir::new().unwrap();
    let mut store = store(&temporary);
    let key = CheckpointKey::from_seed(&[9; 32]);
    let goal_id = active_goal(&mut store, &key);
    let timestamp = WorkflowTimestamp::now();
    let workflow_id = WorkflowId::new();
    store
        .apply_workflow_command(
            workflow_id,
            "intake",
            WorkflowCommand::CompleteIntake,
            timestamp,
        )
        .unwrap();
    store
        .link_goal_workflow(goal_id, workflow_id, "wrong-milestone", timestamp)
        .unwrap();

    // The refusal that made it permanent is still right.
    assert!(
        store
            .link_goal_workflow(goal_id, workflow_id, "right-milestone", timestamp)
            .is_err()
    );

    workflowd::goal::execute(
        &mut store,
        &key,
        "project",
        GoalOperation::UnlinkWorkflow {
            goal_id,
            workflow_id,
        },
    )
    .expect("an active goal's link can be removed");

    store
        .link_goal_workflow(goal_id, workflow_id, "right-milestone", timestamp)
        .expect("after unlinking, the workflow can be linked where it belongs");
    let links = store.goal_workflows(goal_id).unwrap();
    assert_eq!(links, vec![(workflow_id, "right-milestone".to_owned())]);
}

#[test]
fn unlinking_something_that_is_not_linked_says_so() {
    let temporary = TempDir::new().unwrap();
    let mut store = store(&temporary);
    let key = CheckpointKey::from_seed(&[9; 32]);
    let goal_id = active_goal(&mut store, &key);
    let refused = workflowd::goal::execute(
        &mut store,
        &key,
        "project",
        GoalOperation::UnlinkWorkflow {
            goal_id,
            workflow_id: WorkflowId::new(),
        },
    )
    .expect_err("there is nothing to unlink");
    assert!(refused.contains("not linked"), "{refused}");
}

/// A completed goal's links are part of what it claims.
#[test]
fn a_terminal_goals_links_cannot_be_rewritten() {
    let temporary = TempDir::new().unwrap();
    let mut store = store(&temporary);
    let key = CheckpointKey::from_seed(&[9; 32]);
    let goal_id = active_goal(&mut store, &key);
    let (workflow_id, receipt_digest) =
        delivered_workflow_with_arbitration(&mut store, goal_id, "release");
    approve_completion(&mut store, &key, goal_id, receipt_digest).unwrap();

    let refused = workflowd::goal::execute(
        &mut store,
        &key,
        "project",
        GoalOperation::UnlinkWorkflow {
            goal_id,
            workflow_id,
        },
    )
    .expect_err("a completed goal's record stands");
    assert!(refused.contains("terminal"), "{refused}");
}
