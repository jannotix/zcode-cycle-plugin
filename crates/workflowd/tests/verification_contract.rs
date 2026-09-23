use std::fs;

use workflow_core::{
    ArchitecturePlan, ContentDigest, EvidenceKind, PlannedTask, Requirement, TaskId,
};
use workflowd::verification::{VerificationExecutor, VerificationPlan, discover};

fn architecture(scopes: Vec<String>, commands: Vec<String>) -> ArchitecturePlan {
    ArchitecturePlan::validate(
        ContentDigest::of(b"request"),
        vec![Requirement {
            acceptance_criteria: vec!["The feature works end to end.".to_owned()],
            id: "REQ-1".to_owned(),
            statement: "Implement the complete feature.".to_owned(),
        }],
        vec![PlannedTask {
            acceptance_criteria: vec!["All required checks pass.".to_owned()],
            dependencies: vec![],
            id: TaskId::new(),
            objective: "Implement the bounded feature.".to_owned(),
            requirement_ids: vec!["REQ-1".to_owned()],
            title: "Feature".to_owned(),
            verification_commands: commands,
            write_scopes: scopes,
        }],
        vec![],
        vec![],
        vec!["Run the complete integration flow.".to_owned()],
    )
    .unwrap()
}

#[test]
fn adapters_declare_commands_preconditions_risk_timeout_and_mandatory_status() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(
        directory.path().join("package.json"),
        r#"{"scripts":{"lint":"lint","test":"test","test:e2e":"e2e","test:a11y":"a11y"}}"#,
    )
    .unwrap();
    fs::write(directory.path().join("bun.lock"), "lock").unwrap();
    let plan = discover(
        directory.path(),
        &architecture(
            vec!["frontend/components/Login.tsx".to_owned()],
            vec!["bun test".to_owned()],
        ),
    )
    .unwrap();

    assert!(plan.gates.iter().all(|gate| {
        !gate.name.is_empty()
            && !gate.precondition.is_empty()
            && gate.timeout_seconds > 0
            && gate.mandatory
    }));
    assert!(
        plan.gates
            .iter()
            .any(|gate| gate.name.starts_with("browser:") && gate.kind == EvidenceKind::Browser)
    );
    assert!(
        plan.gates
            .iter()
            .any(|gate| gate.name.starts_with("accessibility:"))
    );
    assert!(
        plan.gates
            .iter()
            .any(|gate| matches!(gate.executor, VerificationExecutor::SecretScan))
    );
    assert_eq!(plan.evidence_ids().len(), plan.gates.len());
}

#[test]
fn missing_mandatory_database_and_browser_capabilities_block_explicitly() {
    let directory = tempfile::tempdir().unwrap();
    let plan = discover(
        directory.path(),
        &architecture(
            vec!["migrations/001.sql".to_owned(), "ui/page.tsx".to_owned()],
            vec!["project-test".to_owned()],
        ),
    )
    .unwrap();
    let unavailable: Vec<_> = plan
        .gates
        .iter()
        .filter(|gate| matches!(gate.executor, VerificationExecutor::Unavailable { .. }))
        .collect();
    assert_eq!(unavailable.len(), 3);
    assert!(unavailable.iter().all(|gate| gate.mandatory));
}

#[test]
fn unsafe_commands_are_rejected_without_a_shell() {
    let directory = tempfile::tempdir().unwrap();
    for command in ["rm -rf project", "bun test && deploy", "git reset --hard"] {
        assert!(
            discover(
                directory.path(),
                &architecture(vec!["src".to_owned()], vec![command.to_owned()])
            )
            .is_err()
        );
    }

    let value = serde_json::to_value(
        discover(
            directory.path(),
            &architecture(vec!["src".to_owned()], vec!["bun test".to_owned()]),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(serde_json::from_value::<VerificationPlan>(value).is_ok());
}

#[test]
fn conventional_project_adapters_cover_database_browser_accessibility_security_and_package() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(
        directory.path().join("package.json"),
        r#"{"scripts":{"test:database":"db","test:browser":"browser","test:accessibility":"a11y","audit":"audit","license:check":"licenses","package:verify":"package"}}"#,
    )
    .unwrap();
    fs::write(directory.path().join("bun.lock"), "lock").unwrap();
    let plan = discover(
        directory.path(),
        &architecture(
            vec![
                "migrations/001.sql".to_owned(),
                "ui/page.tsx".to_owned(),
                "package.json".to_owned(),
            ],
            vec!["rustc --version".to_owned()],
        ),
    )
    .unwrap();

    for (prefix, kind) in [
        ("database:", EvidenceKind::Database),
        ("browser:", EvidenceKind::Browser),
        ("accessibility:", EvidenceKind::Browser),
        ("security:", EvidenceKind::Security),
        ("package:", EvidenceKind::Package),
    ] {
        assert!(
            plan.gates
                .iter()
                .any(|gate| gate.name.starts_with(prefix) && gate.kind == kind),
            "missing {prefix} adapter"
        );
    }
    assert!(
        plan.gates
            .iter()
            .all(|gate| !matches!(gate.executor, VerificationExecutor::Unavailable { .. }))
    );
}

#[test]
fn dependency_and_packaging_changes_block_without_required_project_adapters() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(
        directory.path().join("package.json"),
        r#"{"scripts":{"test":"test"}}"#,
    )
    .unwrap();
    let plan = discover(
        directory.path(),
        &architecture(
            vec!["package.json".to_owned()],
            vec!["rustc --version".to_owned()],
        ),
    )
    .unwrap();
    let unavailable: Vec<_> = plan
        .gates
        .iter()
        .filter(|gate| matches!(gate.executor, VerificationExecutor::Unavailable { .. }))
        .map(|gate| gate.name.as_str())
        .collect();

    assert!(unavailable.contains(&"security:dependency-vulnerability"));
    assert!(unavailable.contains(&"security:dependency-license"));
    assert!(unavailable.contains(&"package:production-artifact"));
}

// DEFECT-17, found by scenario 8 of the live certification: the mandatory
// browser and accessibility gates attach from the architect's own wording of
// the write scope. Declaring `public` rather than `public/index.html` removed
// both, and an interface with two unnamed interactive controls passed every
// gate in its plan and was promoted.
#[test]
fn a_directory_write_scope_still_attaches_the_user_interface_gates() {
    let directory = tempfile::tempdir().unwrap();
    fs::create_dir_all(directory.path().join("public")).unwrap();
    fs::write(
        directory.path().join("public").join("index.html"),
        "<!doctype html><title>page</title>",
    )
    .unwrap();

    // The coarse scope: a directory, with nothing in the string that reads as
    // user interface.
    let plan = discover(
        directory.path(),
        &architecture(vec!["public".to_owned()], vec!["bun test".to_owned()]),
    )
    .unwrap();

    assert!(
        plan.gates
            .iter()
            .any(|gate| gate.name == "browser:affected-user-flow" && gate.mandatory),
        "a directory scope holding an .html file must still attach the browser gate"
    );
    assert!(
        plan.gates
            .iter()
            .any(|gate| gate.name.starts_with("accessibility:") && gate.mandatory),
        "a directory scope holding an .html file must still attach the accessibility gate"
    );
}

/// A directory with no interface file in it does not gain interface gates.
#[test]
fn expanding_a_scope_does_not_invent_gates_for_a_directory_without_an_interface() {
    let directory = tempfile::tempdir().unwrap();
    fs::create_dir_all(directory.path().join("server")).unwrap();
    fs::write(
        directory.path().join("server").join("main.rs"),
        "fn main() {}",
    )
    .unwrap();

    let plan = discover(
        directory.path(),
        &architecture(vec!["server".to_owned()], vec!["bun test".to_owned()]),
    )
    .unwrap();

    assert!(
        !plan
            .gates
            .iter()
            .any(|gate| gate.name == "browser:affected-user-flow"),
        "expansion must not attach an interface gate where there is no interface"
    );
}

// DEFECT-16, found by scenario 5 of the live certification: a mandatory gate
// whose executor program was an entire shell expression, arguments empty, was
// accepted into the plan. The daemon spawns the program directly, so no such
// executable exists: over two and a half hours the workflow produced no
// evidence, no gate result, no failure and no block.
#[test]
fn a_shell_expression_is_not_a_program_and_cannot_enter_a_plan() {
    for program in [
        "cd public && npx http-server -p 8080",
        "npm test | tee out.log",
        "node server.mjs & sleep 2",
        "bash -c \"npm run build\"",
        "echo $(pwd)",
    ] {
        let gate = workflowd::verification::VerificationGate {
            executor: VerificationExecutor::Command {
                arguments: vec![],
                program: program.to_owned(),
            },
            id: workflow_core::EvidenceId::new(),
            kind: EvidenceKind::Inspection,
            mandatory: true,
            name: "command:shell".to_owned(),
            precondition: "The project command is configured.".to_owned(),
            risk: workflowd::verification::VerificationRisk::ProjectCode,
            timeout_seconds: 600,
        };
        assert!(
            VerificationPlan::validate(workflow_core::VerificationPlanId::new(), vec![gate])
                .is_err(),
            "a gate that cannot be spawned must be refused: {program}"
        );
    }
}

/// The ordinary case keeps working: a real program with real arguments.
#[test]
fn a_plain_program_with_arguments_is_still_accepted() {
    let gate = workflowd::verification::VerificationGate {
        executor: VerificationExecutor::Command {
            arguments: vec!["test".to_owned(), "--run".to_owned()],
            program: "bun".to_owned(),
        },
        id: workflow_core::EvidenceId::new(),
        kind: EvidenceKind::Inspection,
        mandatory: true,
        name: "command:bun test".to_owned(),
        precondition: "The project command is configured.".to_owned(),
        risk: workflowd::verification::VerificationRisk::ProjectCode,
        timeout_seconds: 600,
    };
    assert!(
        VerificationPlan::validate(workflow_core::VerificationPlanId::new(), vec![gate]).is_ok()
    );
}
