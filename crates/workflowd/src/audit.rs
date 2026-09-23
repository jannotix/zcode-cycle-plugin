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

/// Records an observation a caller supplied.
///
/// DEFECT-24: everything arriving here is something a session said happened, so
/// a gate outcome recorded through this path is marked `declared`. The control
/// plane records the gates it actually ran through [`record_verified`].
pub fn record(
    store: &mut Store,
    checkpoint_key: &CheckpointKey,
    observation: AuditObservation,
) -> Result<LedgerEntry, AuditError> {
    record_with_provenance(store, checkpoint_key, observation, true)
}

/// Records what the control plane itself did. Never reachable from a client
/// message: the only callers are the daemon's own lifecycle paths.
pub fn record_verified(
    store: &mut Store,
    checkpoint_key: &CheckpointKey,
    observation: AuditObservation,
) -> Result<LedgerEntry, AuditError> {
    record_with_provenance(store, checkpoint_key, observation, false)
}

fn record_with_provenance(
    store: &mut Store,
    checkpoint_key: &CheckpointKey,
    observation: AuditObservation,
    declared: bool,
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
        AuditData::Verification { gate, status } => EventData::Verification {
            declared,
            gate,
            status,
        },
    };
    // DEFECT-10. An observation carrying a role may declare its own model, and a
    // role attesting to its own identity proves nothing. Where the role is known,
    // the managed profile on disk is the authority: it is written by setup,
    // checked against the plugin baseline, and a dispatched role cannot change it
    // without the control plane seeing the drift. A self-declared model is kept
    // only when no profile answers, and never overrides one that does.
    let project_id = ProjectId::from_stable_key(&observation.project_key);
    let model = observation
        .role
        .and_then(|role| role_model(store.path(), project_id, role))
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
        project_id,
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

/// The model a managed role profile pins, resolved through the code index.
///
/// DEFECT-10: `Actor.model` existed in the ledger schema and every construction
/// site passed `None`, so a receipt could not answer "which model approved this
/// candidate" - the question an audit trail exists to answer. The product is
/// named for multi-model orchestration and nothing recorded which model ran.
///
/// The 1.0.3 attempt at this fix resolved the profile from the observation's
/// `project_key`, and never found one. A project key is a stable identifier, not
/// a path: the bridge keeps `project_directory` and `project_key` as separate
/// fields and sends the bare directory name as the key. Joining that with
/// `.zcode/agents` resolved against the daemon's working directory, found
/// nothing, and the miss was indistinguishable from "no model pinned". Four live
/// workflows recorded `null` while a role ran on an explicitly pinned model.
///
/// Where the project lives now comes from the code index, for the same reason
/// freezing takes it from there: a role that could name this path could name one
/// whose profile claims a different model, and a self-attested identity proves
/// nothing.
pub fn role_model(
    database: &std::path::Path,
    project_id: ProjectId,
    role: workflow_core::WorkflowRole,
) -> Option<workflow_ipc::audit::AuditModel> {
    let project_directory = workflow_code_intel::graph::GraphStore::open(database)
        .ok()?
        .load_index_state(project_id)
        .ok()??
        .0;
    read_pinned_model(&project_directory, role)
}

/// Reads the pinned model out of a managed profile in a project directory.
///
/// Split from [`role_model`] so the parsing can be tested on its own and the
/// resolution can be tested through a real store. Testing only this half is what
/// let the 1.0.3 fix ship: the parser was right and the caller handed it a key.
///
/// `inherit` is recorded as such: "the session's model, whichever that was" is a
/// different and weaker claim than a pinned one, and flattening the two would
/// make the record say more than it knows.
pub fn read_pinned_model(
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
    Some(workflow_ipc::audit::AuditModel {
        model: value.to_owned(),
        provider: provider_of(value),
    })
}

/// The provider a model reference names, read the way ZCode reads it.
///
/// ZCode splits `custom:<provider>:<model>` at the first colon and URI-decodes
/// each half; only a `builtin:` provider keeps its second segment. So
/// `custom:account%3Azai-individual-coding-plan:GLM-5.3` names
/// `account:zai-individual-coding-plan`, and
/// `custom:builtin:zai-coding-plan:GLM-5.3` names `builtin:zai-coding-plan`.
/// Until 1.0.10 the ledger recorded the first raw segment: `account%3A...` for
/// the one, and `builtin` for the other. `inherit` has no provider of its own.
fn provider_of(value: &str) -> String {
    if value == "inherit" {
        return "inherit".to_owned();
    }
    let Some(rest) = value.strip_prefix("custom:") else {
        return value.split('/').next().unwrap_or("unknown").to_owned();
    };
    let parts: Vec<&str> = rest.split(':').collect();
    if parts.len() >= 3 && parts[0] == "builtin" {
        return format!("builtin:{}", parts[1]);
    }
    percent_decode(parts[0])
}

/// `decodeURIComponent` for the characters a provider id can carry. Anything
/// that is not a well-formed escape is kept as written, as ZCode does when its
/// own decode fails.
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let escape = (bytes[index] == b'%')
            .then(|| value.get(index + 1..index + 3))
            .flatten()
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        match escape {
            Some(byte) => {
                decoded.push(byte);
                index += 3;
            }
            None => {
                decoded.push(bytes[index]);
                index += 1;
            }
        }
    }
    String::from_utf8(decoded).unwrap_or_else(|_| value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::provider_of;

    #[test]
    fn the_ledger_names_the_provider_zcode_resolves() {
        for (reference, provider) in [
            (
                "custom:account%3Azai-individual-coding-plan:GLM-5.3",
                "account:zai-individual-coding-plan",
            ),
            (
                "custom:builtin:zai-coding-plan:GLM-5.3",
                "builtin:zai-coding-plan",
            ),
            ("custom:minimax:MiniMax-M3", "minimax"),
            ("anthropic/claude-sonnet", "anthropic"),
            ("inherit", "inherit"),
            ("custom:broken%zz:model", "broken%zz"),
        ] {
            assert_eq!(provider_of(reference), provider, "{reference}");
        }
    }
}
