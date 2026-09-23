use std::num::NonZeroUsize;

use workflow_core::{ContentDigest, ProjectId, RequestRecord, WorkflowId, WorkflowTimestamp};
use workflow_store::{Store, StoreError};

// DEFECT-08, found by the live certification: AggregateConflict was a unit
// variant raised from more than fifty conditions and rendered as one sentence,
// "aggregate identifier belongs to a different owner". Every refusal asserted
// ownership, whatever had actually failed, and a live run spent its time
// checking ownership for a conflict caused by a stale digest.
//
// This pins the property rather than the wording: two different conditions must
// produce two different messages, and each must describe its own condition.

fn conflict(result: Result<bool, StoreError>) -> String {
    match result {
        Err(error @ StoreError::AggregateConflict(_)) => error.to_string(),
        other => panic!("expected an aggregate conflict, got {other:?}"),
    }
}

#[test]
fn distinct_conflicts_give_distinct_reasons() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(
        directory.path().join("workflow.db"),
        NonZeroUsize::new(1).unwrap(),
    )
    .unwrap();
    let workflow_id = WorkflowId::new();
    store
        .save_request_once(
            workflow_id,
            ProjectId::new(),
            &RequestRecord::new("request".to_owned(), vec![]),
            WorkflowTimestamp::now(),
        )
        .unwrap();

    let value = serde_json::json!({"required_checks":["existing_implementation"]});
    let digest = ContentDigest::of(&serde_json::to_vec(&value).unwrap());
    store
        .save_constraint_once(
            workflow_id,
            "essentiality",
            digest,
            &value,
            WorkflowTimestamp::now(),
        )
        .unwrap();

    // A kind outside the permitted length.
    let malformed = conflict(store.save_constraint_once(
        workflow_id,
        "",
        digest,
        &value,
        WorkflowTimestamp::now(),
    ));

    // A write-once constraint being rewritten with different content.
    let replacement = serde_json::json!({"required_checks":[]});
    let rewritten = conflict(store.save_constraint_once(
        workflow_id,
        "essentiality",
        ContentDigest::of(&serde_json::to_vec(&replacement).unwrap()),
        &replacement,
        WorkflowTimestamp::now(),
    ));

    assert_ne!(
        malformed, rewritten,
        "two unrelated conditions must not share one message"
    );
    assert!(malformed.contains("64 characters"), "{malformed}");
    assert!(rewritten.contains("already recorded"), "{rewritten}");
    // The old message asserted a cause that was true of neither of these.
    for message in [&malformed, &rewritten] {
        assert!(
            !message.contains("belongs to a different owner"),
            "{message}"
        );
    }
}
