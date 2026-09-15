use workflow_core::{ProjectId, WorkflowTimestamp};
use workflow_ipc::audit::{AuditData, AuditObservation};
use workflow_ledger::{
    Actor, Checkpoint, CheckpointKey, EventData, LedgerEntry, LedgerEvent, ModelIdentity, Redactor,
};
use workflow_store::{Store, StoreError};

#[derive(Debug)]
pub enum AuditError {
    Event(workflow_ledger::EventError),
    InvalidTimestamp,
    Store(StoreError),
}

impl std::fmt::Display for AuditError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Event(error) => error.fmt(formatter),
            Self::InvalidTimestamp => {
                formatter.write_str("audit timestamp is outside the supported range")
            }
            Self::Store(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for AuditError {}

pub fn record(
    store: &mut Store,
    checkpoint_key: &CheckpointKey,
    observation: AuditObservation,
) -> Result<LedgerEntry, AuditError> {
    let timestamp = i128::from(observation.timestamp_unix_millis)
        .checked_mul(1_000_000)
        .and_then(|value| WorkflowTimestamp::from_unix_timestamp_nanos(value).ok())
        .ok_or(AuditError::InvalidTimestamp)?;
    let data = match observation.data {
        AuditData::Workflow { action } => EventData::Workflow { action },
        AuditData::Tool {
            invocation_digest,
            tool,
        } => EventData::Tool {
            invocation_digest: invocation_digest.to_string(),
            tool,
        },
        AuditData::Permission {
            decision,
            permission,
        } => EventData::Permission {
            decision,
            permission,
        },
        AuditData::Git {
            externally_attributed,
            revision,
        } => EventData::Git {
            externally_attributed,
            revision,
        },
        AuditData::Verification { gate, status } => EventData::Verification { gate, status },
    };
    // DEFECT-10. An observation carrying a role may declare its own model, and a
    // role attesting to its own identity proves nothing. Where the role is known,
    // the managed profile on disk is the authority: it is written by setup,
    // checked against the plugin baseline, and a dispatched role cannot change it
    // without the control plane seeing the drift. A self-declared model is kept
    // only when no profile answers, and never overrides one that does.
    let model = observation
        .role
        .and_then(|role| role_model(&observation.project_key, role))
        .or(observation.model)
        .map(|model| ModelIdentity {
            model: model.model,
            provider: model.provider,
        });
    let event = LedgerEvent::new(
        Actor {
            id: observation.actor_id,
            model,
            role: observation.role,
            session_id: observation.session_id,
        },
        observation.candidate_id,
        data,
        observation.evidence_ids,
        observation.files,
        observation.metadata,
        ProjectId::from_stable_key(&observation.project_key),
        observation.task_id,
        timestamp,
        observation.workflow_id,
        &Redactor::default(),
    )
    .map_err(AuditError::Event)?;
    let entry = store
        .append_ledger_event(event)
        .map_err(AuditError::Store)?;
    if entry.sequence % 100 == 0 {
        let checkpoint = Checkpoint::sign(
            entry.sequence,
            entry.hash,
            entry.event.timestamp,
            checkpoint_key,
        );
        store
            .save_checkpoint(&checkpoint)
            .map_err(AuditError::Store)?;
    }
    Ok(entry)
}

/// The model a managed role profile pins, read from the profile on disk.
///
/// DEFECT-10: `Actor.model` existed in the ledger schema and every construction
/// site passed `None`, so a receipt could not answer "which model approved this
/// candidate" - the question an audit trail exists to answer. The product is
/// named for multi-model orchestration and nothing recorded which model ran.
///
/// The value is read from the managed profile rather than accepted from the
/// role, deliberately. A role that declared its own model would be attesting to
/// its own identity, which proves nothing; the profile is written by setup,
/// verified against the plugin baseline, and a dispatched role cannot change it
/// without the control plane seeing the drift.
///
/// `inherit` is recorded as such: "the session's model, whichever that was" is a
/// different and weaker claim than a pinned one, and flattening the two would
/// make the record say more than it knows.
pub fn role_model(
    project_directory: &str,
    role: workflow_core::WorkflowRole,
) -> Option<workflow_ipc::audit::AuditModel> {
    let role = match role {
        workflow_core::WorkflowRole::Architect => "architect",
        workflow_core::WorkflowRole::Executor => "executor",
        workflow_core::WorkflowRole::FunctionalReviewer => "functional-reviewer",
        workflow_core::WorkflowRole::SecurityArchitectureReviewer => "security-reviewer",
        workflow_core::WorkflowRole::Arbiter => "arbiter",
    };
    let profile = std::path::Path::new(project_directory)
        .join(".zcode")
        .join("agents")
        .join(format!("zcode-cycle-{role}.md"));
    let content = std::fs::read_to_string(profile).ok()?;
    let value = content
        .lines()
        .take_while(|line| !line.starts_with("---") || line.trim() == "---")
        .find_map(|line| line.strip_prefix("model:"))?
        .trim();
    if value.is_empty() {
        return None;
    }
    // ZCode model refs look like custom:builtin:zai-coding-plan:GLM-5.3 or
    // provider/model; "inherit" has no provider of its own.
    let provider = if value == "inherit" {
        "inherit".to_owned()
    } else if let Some(rest) = value.strip_prefix("custom:") {
        rest.split(':').next().unwrap_or("custom").to_owned()
    } else {
        value.split('/').next().unwrap_or("unknown").to_owned()
    };
    Some(workflow_ipc::audit::AuditModel {
        model: value.to_owned(),
        provider,
    })
}
