use std::{fs, path::Path, process::Command};

use workflow_core::{
    ArchitecturePlan, CandidateId, ContentDigest, EvidenceKind, EvidenceStatus, PlannedTask,
    Requirement, TaskId,
};
use workflow_ipc::ManagedBrowserAttestation;
use workflowd::{
    candidate::freeze,
    verification::{discover, run, run_with_attestations},
};

struct Repository {
    _directory: tempfile::TempDir,
    base: String,
    path: std::path::PathBuf,
}

impl Repository {
    fn new(candidate: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("project");
        fs::create_dir(&path).unwrap();
        git(&path, ["init"]);
        git(&path, ["config", "user.email", "test@example.invalid"]);
        git(&path, ["config", "user.name", "Test User"]);
        git(&path, ["config", "core.hooksPath", ".git/hooks"]);
        git(&path, ["config", "core.autocrlf", "false"]);
        fs::write(path.join("base.txt"), "base\n").unwrap();
        git(&path, ["add", "."]);
        git(&path, ["commit", "-m", "base"]);
        let base = output(&path, ["rev-parse", "HEAD"]);
        fs::write(path.join("candidate.txt"), candidate).unwrap();
        git(&path, ["add", "."]);
        git(&path, ["commit", "-m", "candidate"]);
        Self {
            _directory: directory,
            base,
            path,
        }
    }
}

fn architecture(scopes: Vec<String>) -> ArchitecturePlan {
    ArchitecturePlan::validate(
        ContentDigest::of(b"request"),
        vec![Requirement {
            acceptance_criteria: vec!["Verification passes.".to_owned()],
            id: "REQ-1".to_owned(),
            statement: "Verify the candidate.".to_owned(),
        }],
        vec![PlannedTask {
            acceptance_criteria: vec!["The command succeeds.".to_owned()],
            dependencies: vec![],
            id: TaskId::new(),
            objective: "Run deterministic verification.".to_owned(),
            requirement_ids: vec!["REQ-1".to_owned()],
            title: "Verify".to_owned(),
            verification_commands: vec!["rustc --version".to_owned()],
            write_scopes: scopes,
        }],
        vec![],
        vec![],
        vec!["Run the verification command.".to_owned()],
    )
    .unwrap()
}

#[tokio::test]
async fn commands_capture_normalized_evidence_and_candidate_integrity() {
    let repository = Repository::new("safe change\n");
    let plan = discover(
        &repository.path,
        &architecture(vec!["candidate.txt".to_owned()]),
    )
    .unwrap();
    let frozen = freeze(
        &repository.path,
        &repository.base,
        CandidateId::new(),
        plan.evidence_ids(),
    )
    .unwrap();
    let result = run(
        &repository.path,
        &plan,
        &frozen.manifest,
        &frozen.exact_diff,
        &frozen.exact_files,
    )
    .await
    .unwrap();

    assert!(result.mandatory_passed);
    assert_eq!(result.records.len(), plan.gates.len());
    assert!(result.records.iter().all(|record| {
        record.status == EvidenceStatus::Passed
            && record.candidate_digest == frozen.manifest.digest()
            && !record.tool_version.is_empty()
    }));
    assert!(result.records.iter().any(|record| {
        record.tool == "rustc"
            && record.tool_version.starts_with("rustc ")
            && record.tool_version != "direct-exec-version-unavailable"
    }));
    assert!(
        result
            .records
            .iter()
            .any(|record| record.kind == EvidenceKind::Inspection)
    );
}

// DEFECT-16's runtime half, found by the 1.0.9 live certification: the
// architect planned `start //b node serve.mjs`. `start` is a cmd.exe builtin,
// not an executable, so the gate could not spawn. The runner recorded that as
// a failed gate with no exit code, the record validator refused the pairing,
// and the refusal surfaced as "candidate evidence identifiers do not match the
// plan" - the whole verification abandoned under a message about something
// else, which is the silence DEFECT-16 was fixed to end.
#[tokio::test]
async fn a_gate_that_cannot_start_fails_the_gate_not_the_run() {
    let repository = Repository::new("safe change\n");
    let mut architecture = architecture(vec!["candidate.txt".to_owned()]);
    architecture.tasks[0].verification_commands =
        vec!["zc-no-such-program-anywhere --version".to_owned()];
    let plan = discover(&repository.path, &architecture).unwrap();
    let frozen = freeze(
        &repository.path,
        &repository.base,
        CandidateId::new(),
        plan.evidence_ids(),
    )
    .unwrap();
    let result = run(
        &repository.path,
        &plan,
        &frozen.manifest,
        &frozen.exact_diff,
        &frozen.exact_files,
    )
    .await
    .expect("a gate that cannot start is the gate's answer, not the run's");

    assert!(!result.mandatory_passed);
    let record = result
        .records
        .iter()
        .find(|record| record.tool == "zc-no-such-program-anywhere")
        .unwrap();
    assert_eq!(record.status, EvidenceStatus::Failed);
    assert_eq!(
        record.exit_code, None,
        "no process ran, so no exit code exists"
    );
    assert!(result.outputs[&record.id].starts_with("gate could not start"));
}

#[tokio::test]
async fn unavailable_mandatory_gates_and_seeded_secrets_fail_honestly() {
    // Inert fixture data for the secret-detection gate; assembled from parts
    // so credential scanners do not see a secret-shaped literal in source.
    let seeded_secret = ["sk-", "this-", "is-", "a-", "seeded-", "test-", "secret"].concat();
    let seeded_assignment = ["api", "_key = '", &seeded_secret, "'\n"].concat();
    let repository = Repository::new(&seeded_assignment);
    let plan = discover(
        &repository.path,
        &architecture(vec!["ui/page.tsx".to_owned()]),
    )
    .unwrap();
    let frozen = freeze(
        &repository.path,
        &repository.base,
        CandidateId::new(),
        plan.evidence_ids(),
    )
    .unwrap();
    let result = run(
        &repository.path,
        &plan,
        &frozen.manifest,
        &frozen.exact_diff,
        &frozen.exact_files,
    )
    .await
    .unwrap();

    assert!(!result.mandatory_passed);
    assert!(result.records.iter().any(|record| {
        record.kind == EvidenceKind::Security && record.status == EvidenceStatus::Failed
    }));
    assert!(
        result
            .records
            .iter()
            .any(|record| record.status == EvidenceStatus::Skipped && record.skip_reason.is_some())
    );
}

#[tokio::test]
async fn managed_browser_receipt_satisfies_only_bound_ui_gates() {
    let repository = Repository::new("safe browser change\n");
    let plan = discover(
        &repository.path,
        &architecture(vec!["ui/page.tsx".to_owned()]),
    )
    .unwrap();
    let frozen = freeze(
        &repository.path,
        &repository.base,
        CandidateId::new(),
        plan.evidence_ids(),
    )
    .unwrap();
    let receipt = browser_receipt(&["open", "snapshot", "check", "screenshot", "logs", "close"]);
    let attestation = ManagedBrowserAttestation {
        candidate_digest: frozen.manifest.digest(),
        receipt_digest: ContentDigest::of(receipt.as_bytes()),
        receipt_json: receipt,
        session_id: "executor-session".to_owned(),
    };

    let result = run_with_attestations(
        &repository.path,
        &plan,
        &frozen.manifest,
        &frozen.exact_diff,
        &frozen.exact_files,
        &[attestation],
    )
    .await
    .unwrap();

    assert!(result.mandatory_passed);
    assert!(!result.infrastructure_blocked);
    assert!(
        result
            .records
            .iter()
            .filter(|record| record.kind == EvidenceKind::Browser)
            .all(|record| record.status == EvidenceStatus::Passed
                && record.tool == "zcode-cycle-managed-browser"
                && record.candidate_digest == frozen.manifest.digest())
    );
}

/// The accessibility gate must judge what the snapshot found, not that a
/// snapshot happened. Until 1.0.4 a page whose controls carried no accessible
/// name passed exactly like one where they all did, and the receipt reported
/// "passed" indistinguishably from a gate that had examined something.
#[tokio::test]
async fn an_interface_with_unnamed_controls_fails_the_accessibility_gate() {
    let repository = Repository::new("ui change with unnamed controls\n");
    let plan = discover(
        &repository.path,
        &architecture(vec!["ui/page.tsx".to_owned()]),
    )
    .unwrap();
    let frozen = freeze(
        &repository.path,
        &repository.base,
        CandidateId::new(),
        plan.evidence_ids(),
    )
    .unwrap();
    let receipt = receipt_with_accessibility(
        &["open", "snapshot", "check", "screenshot", "logs", "close"],
        Some((5, 2, vec!["button", "textbox"])),
    );
    let attestation = ManagedBrowserAttestation {
        candidate_digest: frozen.manifest.digest(),
        receipt_digest: ContentDigest::of(receipt.as_bytes()),
        receipt_json: receipt,
        session_id: "executor-session".to_owned(),
    };

    let result = run_with_attestations(
        &repository.path,
        &plan,
        &frozen.manifest,
        &frozen.exact_diff,
        &frozen.exact_files,
        &[attestation],
    )
    .await
    .unwrap();

    let accessibility = result
        .records
        .iter()
        .find(|record| record.invocation.starts_with("accessibility:"))
        .expect("a user-interface change must carry an accessibility gate");
    assert_eq!(accessibility.status, EvidenceStatus::Failed);
    assert!(
        !result.mandatory_passed,
        "an accessibility gate that fails must hold the candidate"
    );
}

/// A receipt from a browser that recorded no summary cannot discharge the gate:
/// there is nothing to judge, and passing on its absence is how the 1.0.3 gate
/// passed on everything.
#[tokio::test]
async fn a_receipt_without_an_accessibility_summary_cannot_pass_the_gate() {
    let repository = Repository::new("ui change with no summary\n");
    let plan = discover(
        &repository.path,
        &architecture(vec!["ui/page.tsx".to_owned()]),
    )
    .unwrap();
    let frozen = freeze(
        &repository.path,
        &repository.base,
        CandidateId::new(),
        plan.evidence_ids(),
    )
    .unwrap();
    let receipt = receipt_with_accessibility(
        &["open", "snapshot", "check", "screenshot", "logs", "close"],
        None,
    );
    let attestation = ManagedBrowserAttestation {
        candidate_digest: frozen.manifest.digest(),
        receipt_digest: ContentDigest::of(receipt.as_bytes()),
        receipt_json: receipt,
        session_id: "executor-session".to_owned(),
    };

    let result = run_with_attestations(
        &repository.path,
        &plan,
        &frozen.manifest,
        &frozen.exact_diff,
        &frozen.exact_files,
        &[attestation],
    )
    .await
    .unwrap();

    let accessibility = result
        .records
        .iter()
        .find(|record| record.invocation.starts_with("accessibility:"))
        .expect("a user-interface change must carry an accessibility gate");
    assert_eq!(accessibility.status, EvidenceStatus::Failed);
    assert!(!result.mandatory_passed);
}

#[tokio::test]
async fn incomplete_or_wrong_candidate_browser_receipts_fail_closed() {
    let repository = Repository::new("safe browser change\n");
    let plan = discover(
        &repository.path,
        &architecture(vec!["ui/page.tsx".to_owned()]),
    )
    .unwrap();
    let frozen = freeze(
        &repository.path,
        &repository.base,
        CandidateId::new(),
        plan.evidence_ids(),
    )
    .unwrap();
    let receipt = browser_receipt(&["open", "check"]);
    let attestations = [ManagedBrowserAttestation {
        candidate_digest: frozen.manifest.digest(),
        receipt_digest: ContentDigest::of(receipt.as_bytes()),
        receipt_json: receipt,
        session_id: "executor-session".to_owned(),
    }];

    let result = run_with_attestations(
        &repository.path,
        &plan,
        &frozen.manifest,
        &frozen.exact_diff,
        &frozen.exact_files,
        &attestations,
    )
    .await
    .unwrap();

    assert!(!result.mandatory_passed);
    assert!(result.infrastructure_blocked);
    assert!(result.records.iter().any(|record| {
        record.kind == EvidenceKind::Browser && record.status == EvidenceStatus::Skipped
    }));
}

fn browser_receipt(operations: &[&str]) -> String {
    receipt_with_accessibility(operations, Some((4, 0, vec![])))
}

/// A receipt whose snapshot carries the accessibility summary the gate judges.
///
/// `summary` is (interactive, unnamed, roles missing a name); `None` builds the
/// pre-1.0.4 shape, where the snapshot said only that it had happened.
fn receipt_with_accessibility(
    operations: &[&str],
    summary: Option<(u32, u32, Vec<&str>)>,
) -> String {
    let actions = operations
        .iter()
        .map(|operation| {
            let mut action = serde_json::json!({
                "digest": ContentDigest::of(operation.as_bytes()).to_string(),
                "operation": operation,
                "timestamp": "2026-08-15T12:00:00.000Z",
                "url": "http://127.0.0.1:8766/index.html",
            });
            if let (true, Some((interactive, unnamed, roles))) =
                (*operation == "snapshot", summary.clone())
            {
                action["accessibility"] = serde_json::json!({
                    "interactive": interactive,
                    "unnamed": unnamed,
                    "unnamedRoles": roles,
                });
            }
            action
        })
        .collect::<Vec<_>>();
    format!(
        "{}\n",
        serde_json::json!({ "actions": actions, "logs": [] })
    )
}

fn git<'a>(repository: &Path, arguments: impl IntoIterator<Item = &'a str>) {
    assert!(
        Command::new("git")
            .arg("-C")
            .arg(repository)
            .args(arguments)
            .status()
            .unwrap()
            .success()
    );
}

fn output<'a>(repository: &Path, arguments: impl IntoIterator<Item = &'a str>) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(arguments)
        .output()
        .unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}
