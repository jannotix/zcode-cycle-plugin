use std::fs;
use std::num::NonZeroUsize;

use workflowd::audit::{read_pinned_model, record, role_model};

// DEFECT-10, found by scenario 13 of the live certification: the arbiter was
// pinned to an explicit model, approved a candidate, and every ledger event
// recorded actor.model = null.
//
// The 1.0.3 fix parsed the profile correctly and was handed the wrong input, and
// the tests that shipped with it only ever fed the parser a real directory. They
// were right about the unit and silent about the caller. The test that matters
// here is the last one: it drives the real recording path and reads the model
// back out of the ledger.

fn write_profile(directory: &std::path::Path, role: &str, model: &str) {
    let agents = directory.join(".zcode").join("agents");
    fs::create_dir_all(&agents).unwrap();
    fs::write(
        agents.join(format!("zcode-cycle-{role}.md")),
        format!(
            "---\nname: zcode-cycle:{role}\ndescription: test profile\nmodel: {model}\nthoughtLevel: high\ntools: Read\n---\n\nbody\n"
        ),
    )
    .unwrap();
}

#[test]
fn a_pinned_model_is_read_from_the_managed_profile() {
    let temporary = tempfile::tempdir().unwrap();
    write_profile(
        temporary.path(),
        "arbiter",
        "custom:builtin:zai-coding-plan:GLM-5.3-Flash",
    );

    let model = read_pinned_model(
        temporary.path().to_str().unwrap(),
        workflow_core::WorkflowRole::Arbiter,
    )
    .expect("a pinned profile must yield a model");

    assert_eq!(model.model, "custom:builtin:zai-coding-plan:GLM-5.3-Flash");
    assert_eq!(model.provider, "builtin:zai-coding-plan");
}

/// "inherit" means the session's model, whichever that was. Recording it as a
/// pinned model would make the receipt claim more than it knows.
#[test]
fn inherit_is_recorded_as_inherit_and_not_flattened() {
    let temporary = tempfile::tempdir().unwrap();
    write_profile(temporary.path(), "executor", "inherit");

    let model = read_pinned_model(
        temporary.path().to_str().unwrap(),
        workflow_core::WorkflowRole::Executor,
    )
    .expect("inherit is still an answer");

    assert_eq!(model.model, "inherit");
    assert_eq!(model.provider, "inherit");
}

#[test]
fn each_role_reads_its_own_profile() {
    let temporary = tempfile::tempdir().unwrap();
    write_profile(
        temporary.path(),
        "arbiter",
        "custom:builtin:zai-coding-plan:GLM-5.3",
    );
    write_profile(temporary.path(), "security-reviewer", "inherit");

    let root = temporary.path().to_str().unwrap();
    assert_eq!(
        read_pinned_model(root, workflow_core::WorkflowRole::Arbiter)
            .unwrap()
            .model,
        "custom:builtin:zai-coding-plan:GLM-5.3"
    );
    assert_eq!(
        read_pinned_model(
            root,
            workflow_core::WorkflowRole::SecurityArchitectureReviewer
        )
        .unwrap()
        .model,
        "inherit"
    );
    // A role with no profile installed yields nothing rather than a guess.
    assert!(read_pinned_model(root, workflow_core::WorkflowRole::Architect).is_none());
}

/// A project key is not a path. Passing one where a directory belongs is the
/// mistake that shipped in 1.0.3, and it resolved to nothing rather than failing.
#[test]
fn a_project_key_is_not_a_project_directory() {
    assert!(
        read_pinned_model("zcode-cycle-fixture", workflow_core::WorkflowRole::Arbiter).is_none()
    );
}

#[test]
fn an_unindexed_project_yields_no_model_rather_than_a_guess() {
    let temporary = tempfile::tempdir().unwrap();
    let database = temporary.path().join("workflow.db");
    let _store = workflow_store::Store::open(&database, NonZeroUsize::new(1).unwrap()).unwrap();

    assert!(
        role_model(
            &database,
            workflow_core::ProjectId::from_stable_key("never-indexed"),
            workflow_core::WorkflowRole::Arbiter,
        )
        .is_none()
    );
}

/// The test the 1.0.3 fix needed and did not have: the whole recording path,
/// from an observation carrying a role to the model on the ledger entry.
#[test]
fn recording_an_event_for_a_pinned_role_puts_the_model_on_the_ledger() {
    let temporary = tempfile::tempdir().unwrap();
    let project = temporary.path().join("project");
    fs::create_dir_all(&project).unwrap();
    write_profile(
        &project,
        "arbiter",
        "custom:builtin:zai-coding-plan:GLM-5.3-Flash",
    );

    let database = temporary.path().join("workflow.db");
    let mut store = workflow_store::Store::open(&database, NonZeroUsize::new(1).unwrap()).unwrap();

    // The project key is a stable key; the directory is what the index holds.
    let project_key = "some-project-key";
    let project_id = workflow_core::ProjectId::from_stable_key(project_key);
    workflow_code_intel::graph::GraphStore::open(&database)
        .unwrap()
        .save_index_state(
            project_id,
            project.to_str().unwrap(),
            // The index state stores a 64-character fingerprint.
            &"a".repeat(64),
            workflow_core::WorkflowTimestamp::now(),
        )
        .unwrap();

    let entry = record(
        &mut store,
        &workflow_ledger::CheckpointKey::generate().unwrap(),
        workflow_ipc::audit::AuditObservation {
            actor_id: "workflowd".to_owned(),
            candidate_id: None,
            data: workflow_ipc::audit::AuditData::Workflow {
                action: "arbitration_approved".to_owned(),
            },
            evidence_ids: Default::default(),
            files: Default::default(),
            metadata: Default::default(),
            // Nothing self-declared: the profile is the only source.
            model: None,
            project_key: project_key.to_owned(),
            role: Some(workflow_core::WorkflowRole::Arbiter),
            session_id: None,
            task_id: None,
            timestamp_unix_millis: 1_700_000_000_000,
            workflow_id: None,
        },
    )
    .expect("the observation must record");

    let model = entry
        .event
        .actor
        .model
        .expect("the ledger entry must name the model the arbiter was pinned to");
    assert_eq!(model.model, "custom:builtin:zai-coding-plan:GLM-5.3-Flash");
    assert_eq!(model.provider, "builtin:zai-coding-plan");
}
