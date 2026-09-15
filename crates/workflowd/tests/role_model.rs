use std::fs;

use workflowd::audit::role_model;

// DEFECT-10, found by scenario 13 of the live certification: the arbiter was
// pinned to an explicit model, approved a candidate, and every ledger event
// recorded actor.model = null. A receipt could not say which model judged.
//
// The model is read from the managed profile rather than accepted from the role,
// so these tests pin that source: a profile on disk, parsed the way the control
// plane parses it.

fn profile(directory: &std::path::Path, role: &str, model: &str) {
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
    profile(
        temporary.path(),
        "arbiter",
        "custom:builtin:zai-coding-plan:GLM-5.3-Flash",
    );

    let model = role_model(
        temporary.path().to_str().unwrap(),
        workflow_core::WorkflowRole::Arbiter,
    )
    .expect("a pinned profile must yield a model");

    assert_eq!(model.model, "custom:builtin:zai-coding-plan:GLM-5.3-Flash");
    assert_eq!(model.provider, "builtin");
}

/// "inherit" means the session's model, whichever that was. Recording it as a
/// pinned model would make the receipt claim more than it knows.
#[test]
fn inherit_is_recorded_as_inherit_and_not_flattened() {
    let temporary = tempfile::tempdir().unwrap();
    profile(temporary.path(), "executor", "inherit");

    let model = role_model(
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
    profile(
        temporary.path(),
        "arbiter",
        "custom:builtin:zai-coding-plan:GLM-5.3",
    );
    profile(temporary.path(), "security-reviewer", "inherit");

    let root = temporary.path().to_str().unwrap();
    assert_eq!(
        role_model(root, workflow_core::WorkflowRole::Arbiter)
            .unwrap()
            .model,
        "custom:builtin:zai-coding-plan:GLM-5.3"
    );
    assert_eq!(
        role_model(
            root,
            workflow_core::WorkflowRole::SecurityArchitectureReviewer
        )
        .unwrap()
        .model,
        "inherit"
    );
    // A role with no profile installed yields nothing rather than a guess.
    assert!(role_model(root, workflow_core::WorkflowRole::Architect).is_none());
}

#[test]
fn a_missing_project_directory_yields_nothing() {
    assert!(
        role_model(
            "this-directory-does-not-exist",
            workflow_core::WorkflowRole::Arbiter
        )
        .is_none()
    );
}
