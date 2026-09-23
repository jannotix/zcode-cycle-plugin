use std::num::NonZeroUsize;

use workflow_core::{ReceiptId, RiskCategory, UserRoutingPreference, WorkflowId, WorkflowMode};
use workflow_ledger::CheckpointKey;
use workflow_store::Store;
use workflowd::routing::{RoutingRequest, automatic_evidence, decide_and_record};

#[test]
fn automatic_facts_route_cross_layer_database_work_to_full() {
    let evidence = automatic_evidence(
        "Implement the backend, frontend and a database migration.",
        &["migrations/001_users.sql".to_owned()],
    );
    assert!(
        evidence
            .facts
            .iter()
            .any(|fact| fact.category == RiskCategory::CrossLayer)
    );
    assert!(
        evidence
            .facts
            .iter()
            .any(|fact| fact.category == RiskCategory::DatabaseMigration)
    );
}

#[test]
fn route_and_rationale_are_recorded_in_the_project_ledger() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(
        directory.path().join("control-plane.db"),
        NonZeroUsize::new(1).unwrap(),
    )
    .unwrap();
    let key = CheckpointKey::generate().unwrap();
    let result = decide_and_record(
        &mut store,
        &key,
        RoutingRequest {
            critical_downgrade_approval: None,
            evidence: automatic_evidence("Change authentication and the public API", &[]),
            preference: UserRoutingPreference::Auto,
            project_key: "project".to_owned(),
            timestamp_unix_millis: 1,
            workflow_id: WorkflowId::new(),
        },
    )
    .unwrap();

    assert_eq!(result.decision.mode, WorkflowMode::Full);
    assert_eq!(result.ledger_entry.event.metadata["mode"], "full");
    assert!(result.ledger_entry.event.metadata["rationale"].contains("original_request"));
}

#[test]
fn critical_quick_override_needs_a_recorded_receipt() {
    let evidence = automatic_evidence("Apply a database migration", &[]);
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(
        directory.path().join("control-plane.db"),
        NonZeroUsize::new(1).unwrap(),
    )
    .unwrap();
    let key = CheckpointKey::generate().unwrap();
    let workflow_id = WorkflowId::new();
    let denied = decide_and_record(
        &mut store,
        &key,
        RoutingRequest {
            critical_downgrade_approval: None,
            evidence: evidence.clone(),
            preference: UserRoutingPreference::Quick,
            project_key: "project".to_owned(),
            timestamp_unix_millis: 1,
            workflow_id,
        },
    )
    .unwrap();
    assert_eq!(denied.decision.mode, WorkflowMode::Full);
    assert!(denied.decision.downgrade_approval_required);

    let receipt = ReceiptId::new();
    let approved = decide_and_record(
        &mut store,
        &key,
        RoutingRequest {
            critical_downgrade_approval: Some(receipt),
            evidence,
            preference: UserRoutingPreference::Quick,
            project_key: "project".to_owned(),
            timestamp_unix_millis: 2,
            workflow_id,
        },
    )
    .unwrap();
    assert_eq!(approved.decision.mode, WorkflowMode::Quick);
    assert_eq!(approved.decision.downgrade_approval, Some(receipt));
}

fn has(evidence: &workflowd::routing::RoutingEvidence, category: RiskCategory) -> bool {
    evidence.facts.iter().any(|fact| fact.category == category)
}

/// The 1.0.6 certification routed "harden parseToken in auth.js" to `quick`,
/// with auth.js declared as an affected path, because only the request TEXT
/// could raise a critical category. A security change must not depend on the
/// author's choice of words.
#[test]
fn an_authentication_path_raises_the_category_without_the_word() {
    let evidence = automatic_evidence(
        "Harden parseToken so a malformed token cannot pass the expiry check.",
        &["src/auth.js".to_owned()],
    );
    assert!(has(&evidence, RiskCategory::Authentication));
}

#[test]
fn a_path_only_authentication_fact_routes_to_full() {
    let decision = workflow_core::route_workflow(&workflow_core::RoutingInput {
        facts: automatic_evidence("Tidy the token parser.", &["src/auth.js".to_owned()]).facts,
        preference: UserRoutingPreference::Auto,
        critical_downgrade_approval: None,
    });
    assert_eq!(decision.mode, WorkflowMode::Full);
}

/// Markers match whole path tokens. `authors.ts` is not authentication, and a
/// campaign that routed every such file to the full route would cost its users
/// two independent reviews for nothing.
#[test]
fn a_substring_of_a_marker_does_not_raise_the_category() {
    let evidence = automatic_evidence("Update the credits list.", &["src/authors.ts".to_owned()]);
    assert!(!has(&evidence, RiskCategory::Authentication));
}

/// Prose cannot introduce an authentication flaw, so documentation wins.
#[test]
fn documentation_about_authentication_is_documentation() {
    // The request text carries no marker on purpose: this asserts what the PATH
    // contributes. A request that says "sign-in" would raise Authentication from
    // the text, which is correct and is a different rule.
    let evidence = automatic_evidence(
        "Describe the first-run experience.",
        &["docs/security/auth.md".to_owned()],
    );
    assert!(has(&evidence, RiskCategory::Documentation));
    assert!(!has(&evidence, RiskCategory::Authentication));
}

#[test]
fn secret_material_is_classified_by_extension() {
    let evidence = automatic_evidence("Rotate the server key.", &["config/server.pem".to_owned()]);
    assert!(has(&evidence, RiskCategory::Secrets));
}

#[test]
fn ordinary_paths_raise_no_critical_category() {
    let evidence = automatic_evidence("Rename a helper.", &["src/utils.js".to_owned()]);
    assert!(
        !evidence
            .facts
            .iter()
            .any(|fact| fact.category.is_critical())
    );
}
