use std::path::Path;

use serde_json::{Value, json};
use workflow_core::{ProjectId, ReceiptId, WorkflowCommand, WorkflowState, WorkflowTimestamp};
use workflow_ipc::ControlOperation;
use workflow_ledger::CheckpointKey;
use workflow_store::Store;

pub fn execute(
    store: &mut Store,
    checkpoint_key: &CheckpointKey,
    worktrees: &Path,
    project_key: &str,
    requested_workflow_id: Option<workflow_core::WorkflowId>,
    operation: ControlOperation,
    operation_id: ReceiptId,
) -> Result<Value, String> {
    if project_key.is_empty() || project_key.len() > 32_768 || project_key.contains('\0') {
        return Err("project key is invalid".to_owned());
    }
    let project_id = ProjectId::from_stable_key(project_key);
    if operation == ControlOperation::Doctor {
        return doctor(store, checkpoint_key, project_id);
    }
    let workflow_id = if let Some(workflow_id) = requested_workflow_id {
        let owner = store
            .load_request(workflow_id)
            .map_err(|error| error.to_string())?
            .map(|(owner, _)| owner);
        if owner != Some(project_id) {
            return Err("workflow does not belong to the project".to_owned());
        }
        workflow_id
    } else {
        store
            .latest_workflow_for_project(project_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "project has no workflow".to_owned())?
    };
    let state = store
        .load_workflow(workflow_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "workflow state does not exist".to_owned())?;
    match operation {
        ControlOperation::Status => Ok(json!({
            "currentCandidate": state.current_candidate(),
            "maximumRepairCycles": state.max_repair_cycles(),
            "mode": state.mode(),
            "repairCycles": state.repair_cycles(),
            "state": state.state(),
            "workflowId": workflow_id,
        })),
        ControlOperation::Tasks => {
            let tasks = store
                .load_workflow_tasks(workflow_id)
                .map_err(|error| error.to_string())?
                .into_iter()
                .map(|(task_id, task)| json!({ "state": task.state(), "taskId": task_id }))
                .collect::<Vec<_>>();
            Ok(json!({ "tasks": tasks, "workflowId": workflow_id }))
        }
        ControlOperation::Evidence => {
            let evidence = state
                .current_candidate()
                .map(|candidate_id| {
                    store
                        .load_candidate_evidence(candidate_id)
                        .map(|records| {
                            records
                                .into_iter()
                                .map(|(record, _, mandatory)| {
                                    json!({ "mandatory": mandatory, "record": record })
                                })
                                .collect::<Vec<_>>()
                        })
                        .map_err(|error| error.to_string())
                })
                .transpose()?
                .unwrap_or_default();
            Ok(json!({
                "candidateId": state.current_candidate(),
                "evidence": evidence,
                "workflowId": workflow_id,
            }))
        }
        ControlOperation::Recovery => recovery(store, worktrees, project_id, workflow_id, &state),
        ControlOperation::Pause
        | ControlOperation::Resume
        | ControlOperation::Cancel
        | ControlOperation::Retry => {
            if operation == ControlOperation::Retry && state.state() == WorkflowState::Delivery {
                return Ok(json!({
                    "duplicate": true,
                    "state": state.state(),
                    "workflowId": workflow_id,
                }));
            }
            if store
                .workflow_delivery_reserved(workflow_id)
                .map_err(|error| error.to_string())?
            {
                return Err("workflow candidate delivery is in progress".to_owned());
            }
            let command = command(operation, state.state());
            let result = store
                .apply_workflow_command(
                    workflow_id,
                    &format!("control:{operation_id}"),
                    command,
                    WorkflowTimestamp::now(),
                )
                .or_else(|error| {
                    if operation == ControlOperation::Retry
                        && state.state() == WorkflowState::Blocked
                    {
                        store.apply_workflow_command(
                            workflow_id,
                            &format!("control:{operation_id}"),
                            WorkflowCommand::ResumeBlocked {
                                additional_cycles: 5,
                            },
                            WorkflowTimestamp::now(),
                        )
                    } else {
                        Err(error)
                    }
                })
                .map_err(|error| error.to_string())?;
            Ok(json!({
                "duplicate": result.duplicate,
                "state": result.state.state(),
                "workflowId": workflow_id,
            }))
        }
        ControlOperation::Doctor => unreachable!("doctor is handled before workflow lookup"),
    }
}

/// One workflow as the doctor reports it: what it is, and which operations the
/// plane would accept on it right now. The operator-facing answer to "can this
/// be resumed" is `nextOperations`, never a reading of the state name.
///
/// The list is not a second copy of the state machine's rules - a copy would
/// drift. Each mutating operation is tried on a clone through the same
/// `command` mapping and `apply` that `execute` uses, including the blocked
/// retry fallback and the refusal while a delivery is reserved.
fn workflow_summary(
    store: &Store,
    workflow_id: workflow_core::WorkflowId,
    state: &workflow_core::Workflow,
) -> Result<Value, String> {
    let delivering = store
        .workflow_delivery_reserved(workflow_id)
        .map_err(|error| error.to_string())?;
    let accepts = |command: WorkflowCommand| state.clone().apply(command).is_ok();
    let mut next_operations = Vec::new();
    if matches!(
        state.state(),
        WorkflowState::Architecture
            | WorkflowState::Execution
            | WorkflowState::QuickExecution
            | WorkflowState::Verification
            | WorkflowState::IndependentReviews
            | WorkflowState::Arbitration
            | WorkflowState::Delivery
    ) {
        next_operations.push("recovery");
    }
    if !delivering {
        for (name, operation) in [
            ("pause", ControlOperation::Pause),
            ("resume", ControlOperation::Resume),
            ("retry", ControlOperation::Retry),
            ("cancel", ControlOperation::Cancel),
        ] {
            let accepted = accepts(command(operation, state.state()))
                || (operation == ControlOperation::Retry
                    && state.state() == WorkflowState::Blocked
                    && accepts(WorkflowCommand::ResumeBlocked {
                        additional_cycles: 5,
                    }));
            if accepted {
                next_operations.push(name);
            }
        }
    }
    Ok(json!({
        "currentCandidate": state.current_candidate(),
        "mode": state.mode(),
        "nextOperations": next_operations,
        "state": state.state(),
        "terminal": state.state().is_terminal(),
        "workflowId": workflow_id,
    }))
}

fn command(operation: ControlOperation, state: WorkflowState) -> WorkflowCommand {
    match operation {
        ControlOperation::Pause => WorkflowCommand::Pause,
        ControlOperation::Resume => WorkflowCommand::Resume,
        ControlOperation::Cancel => WorkflowCommand::Cancel,
        ControlOperation::Retry if state == WorkflowState::Blocked => {
            WorkflowCommand::ResumeInfrastructure
        }
        ControlOperation::Retry => WorkflowCommand::RetryInfrastructure,
        ControlOperation::Doctor
        | ControlOperation::Evidence
        | ControlOperation::Recovery
        | ControlOperation::Status
        | ControlOperation::Tasks => {
            unreachable!("read operation cannot become a workflow command")
        }
    }
}

fn recovery(
    store: &Store,
    worktrees: &Path,
    project_id: ProjectId,
    workflow_id: workflow_core::WorkflowId,
    state: &workflow_core::Workflow,
) -> Result<Value, String> {
    let (_, request) = store
        .load_request(workflow_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "workflow request does not exist".to_owned())?;
    if matches!(
        state.state(),
        WorkflowState::Architecture | WorkflowState::Execution | WorkflowState::QuickExecution
    ) {
        return early_recovery(store, worktrees, project_id, workflow_id, state, &request);
    }
    if !matches!(
        state.state(),
        WorkflowState::Verification
            | WorkflowState::IndependentReviews
            | WorkflowState::Arbitration
            | WorkflowState::Delivery
    ) {
        return Err("workflow is not in a recoverable finalization state".to_owned());
    }
    let plan = store
        .load_architecture(workflow_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "workflow architecture does not exist".to_owned())?;
    let candidate_id = state
        .current_candidate()
        .ok_or_else(|| "workflow has no current candidate".to_owned())?;
    let candidate = store
        .load_candidate(candidate_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "workflow candidate does not exist".to_owned())?;
    if candidate.workflow_id != workflow_id {
        return Err("workflow candidate ownership is invalid".to_owned());
    }
    let (verification_plan_id, _) = store
        .load_latest_verification_plan_for_workflow(workflow_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "workflow verification plan does not exist".to_owned())?;
    let evidence = store
        .load_candidate_evidence(candidate_id)
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|(record, output, mandatory)| {
            json!({ "mandatory": mandatory, "output": output, "record": record })
        })
        .collect::<Vec<_>>();
    let reviews = store
        .load_reviews(candidate_id)
        .map_err(|error| error.to_string())?;
    let executor_session_ids = store
        .load_role_session_ids(workflow_id, workflow_core::WorkflowRole::Executor)
        .map_err(|error| error.to_string())?;
    // "The promotion never began" and "the promotion started and stopped" are
    // opposites to act on, and a workflow sitting in delivery looks identical
    // from the outside. The plane knows which it is — a reservation is taken
    // before any byte moves and a journal is bound once one has — so it says so
    // rather than leaving the caller to infer it from an absence.
    let delivery_reserved = store
        .workflow_delivery_reserved(workflow_id)
        .map_err(|error| error.to_string())?;
    let delivery_journal_digest = store
        .candidate_delivery_journal_digest(workflow_id, candidate_id)
        .map_err(|error| error.to_string())?;
    Ok(json!({
        "candidateDigest": candidate.manifest.digest(),
        "candidateId": candidate_id,
        "deliveryBegan": delivery_reserved || delivery_journal_digest.is_some(),
        "deliveryJournalDigest": delivery_journal_digest,
        "deliveryReserved": delivery_reserved,
        "evidence": evidence,
        "executorSessionIds": executor_session_ids,
        "manifest": candidate.manifest,
        "mode": state.mode(),
        "originalRequest": request.original_text(),
        "plan": plan,
        "reviews": reviews,
        "state": state.state(),
        "verificationPlanId": verification_plan_id,
        "workflowId": workflow_id,
        "worktreePath": worktrees.join(project_id.to_string()).join(workflow_id.to_string()),
    }))
}

fn early_recovery(
    store: &Store,
    worktrees: &Path,
    project_id: ProjectId,
    workflow_id: workflow_core::WorkflowId,
    state: &workflow_core::Workflow,
    request: &workflow_core::RequestRecord,
) -> Result<Value, String> {
    let mode = state
        .mode()
        .ok_or_else(|| "workflow mode does not exist".to_owned())?;
    let candidate = store
        .load_latest_candidate_for_workflow(workflow_id)
        .map_err(|error| error.to_string())?;
    if candidate
        .as_ref()
        .is_some_and(|candidate| candidate.workflow_id != workflow_id)
    {
        return Err("workflow candidate ownership is invalid".to_owned());
    }
    let candidate_revision = candidate
        .as_ref()
        .and_then(|candidate| candidate.manifest.base_revision())
        .map(str::to_owned);
    let ledger_revision = store
        .load_worktree_base_revision(workflow_id)
        .map_err(|error| error.to_string())?;
    let base_revision = match (candidate_revision, ledger_revision) {
        (Some(candidate), Some(ledger)) if candidate != ledger => {
            return Err("workflow worktree base revision is inconsistent".to_owned());
        }
        (Some(candidate), _) => Some(candidate),
        (None, ledger) => ledger,
    };
    if base_revision.as_deref().is_some_and(|revision| {
        !matches!(revision.len(), 40 | 64)
            || revision
                .bytes()
                .any(|byte| !byte.is_ascii_hexdigit() || byte.is_ascii_uppercase())
    }) {
        return Err("workflow worktree base revision is invalid".to_owned());
    }
    let worktree_path = worktrees
        .join(project_id.to_string())
        .join(workflow_id.to_string());
    let worktree_exists = std::fs::symlink_metadata(&worktree_path)
        .map(|_| true)
        .or_else(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                Ok(false)
            } else {
                Err(error)
            }
        })
        .map_err(|error| format!("workflow worktree cannot be inspected: {error}"))?;
    // A worktree exists on disk if and only if a base revision was recorded.
    // When a session dies between those two writes the invariant breaks, and
    // until 1.0.7 recovery refused outright.
    //
    // Refusing was the wrong answer twice over. Recovery only READS: the guards
    // that matter live on prepare_worktree and freeze, and they still hold. And
    // the refusal returned before `originalRequest` was assembled, so the one
    // thing an interrupted operator cannot reconstruct - the immutable request
    // text - was withheld precisely when it was needed. The 1.0.6 certification
    // hit this: the workflow could not continue, could not be reconciled, the
    // request had to be retyped, and the project stayed mutation-locked until
    // the operator discovered the cancel path unaided.
    //
    // So name the inconsistency and hand back everything known about it.
    let worktree_state = match (worktree_exists, base_revision.is_some()) {
        (true, true) | (false, false) => "consistent",
        // A directory was created before its base revision reached the store.
        // Nothing was executed against it; it is safe to discard and re-prepare.
        (true, false) => "orphaned_worktree",
        // The store remembers a base revision whose directory is gone.
        (false, true) => "missing_worktree",
    };

    let mut result = serde_json::Map::new();
    result.insert("worktreeState".to_owned(), json!(worktree_state));
    if worktree_state != "consistent" {
        result.insert(
            "recoveryAction".to_owned(),
            json!(if worktree_state == "orphaned_worktree" {
                "Discard the worktree directory and prepare it again, or cancel the workflow. \
                 No task was executed against it."
            } else {
                "Prepare the worktree again from the recorded base revision, or cancel the \
                 workflow. The recorded base revision is returned as baseRevision."
            }),
        );
    }
    result.insert("mode".to_owned(), json!(mode));
    result.insert("originalRequest".to_owned(), json!(request.original_text()));
    result.insert("requestDigest".to_owned(), json!(request.digest()));
    result.insert("state".to_owned(), json!(state.state()));
    result.insert("workflowId".to_owned(), json!(workflow_id));
    result.insert("worktreePath".to_owned(), json!(worktree_path));
    if let Some(base_revision) = base_revision {
        result.insert("baseRevision".to_owned(), json!(base_revision));
    }
    if matches!(
        state.state(),
        WorkflowState::Execution | WorkflowState::QuickExecution
    ) {
        let plan = store
            .load_architecture(workflow_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "workflow architecture does not exist".to_owned())?;
        result.insert("plan".to_owned(), json!(plan));
    }
    if let Some(candidate) = candidate {
        let arbitration = store
            .load_arbitration(candidate.manifest.candidate_id())
            .map_err(|error| error.to_string())?;
        let repair_feedback = if let Some((owner, verdict, _)) = arbitration {
            if owner != workflow_id {
                return Err("workflow arbitration ownership is invalid".to_owned());
            }
            Some(serde_json::to_string(&verdict).map_err(|error| error.to_string())?)
        } else {
            let failed = store
                .load_candidate_evidence(candidate.manifest.candidate_id())
                .map_err(|error| error.to_string())?
                .into_iter()
                .filter(|(record, _, _)| record.status != workflow_core::EvidenceStatus::Passed)
                .map(|(record, output, mandatory)| {
                    json!({ "mandatory": mandatory, "output": output, "record": record })
                })
                .collect::<Vec<_>>();
            (!failed.is_empty())
                .then(|| serde_json::to_string(&failed).map_err(|error| error.to_string()))
                .transpose()?
        };
        if let Some(repair_feedback) = repair_feedback {
            if repair_feedback.len() > 64 * 1024 {
                return Err("workflow repair feedback exceeds the recovery limit".to_owned());
            }
            result.insert("repairFeedback".to_owned(), json!(repair_feedback));
        }
    }
    Ok(Value::Object(result))
}

fn doctor(
    store: &Store,
    checkpoint_key: &CheckpointKey,
    project_id: ProjectId,
) -> Result<Value, String> {
    crate::history::verify_store(store, checkpoint_key).map_err(|error| error.to_string())?;
    let sample = crate::resources::sample(store.path().parent().unwrap_or_else(|| Path::new(".")));
    // The 1.0.11 campaign's doctor report called a cancelled workflow resumable
    // and said it had no frozen candidate when it had one. Nothing here said
    // either way: the command asked for "active or recoverable workflows" and
    // this result carried none, so the report was inferred. It is stated now,
    // from the same rules the operations enforce.
    let workflows = store
        .recent_workflows_for_project(project_id, 10)
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter_map(|workflow_id| match store.load_workflow(workflow_id) {
            Ok(Some(state)) => Some(workflow_summary(store, workflow_id, &state)),
            Ok(None) => None,
            Err(error) => Some(Err(error.to_string())),
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({
        "workflows": workflows,
        "ledger": "valid",
        "resources": {
            "availableDiskBytes": sample.available_disk_bytes,
            "availableMemoryBytes": sample.available_memory_bytes,
            "cpuUsagePercent": sample.cpu_usage_percent,
            "ownedProcesses": sample.owned_processes,
        },
        "schemaVersion": workflow_store::CURRENT_SCHEMA_VERSION,
        "status": "PASS",
        "storeMode": format!("{:?}", store.mode()),
    }))
}
