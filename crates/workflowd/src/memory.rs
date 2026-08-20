use std::collections::BTreeSet;
use std::path::Path;

use serde_json::{Value, json};
use workflow_core::{EventId, ProjectId, WorkflowTimestamp};
use workflow_ipc::protocol::MemoryOperation;
use workflow_memory::{
    ConfidenceClass, MemoryEntry, MemoryKind, MemorySearch, MemoryState, MemoryStore,
    MemoryStoreError, Provenance, RetrievalBudget, compact,
};

#[derive(Debug)]
pub enum MemoryCommandError {
    InvalidConfidence,
    InvalidEventId,
    InvalidKind,
    InvalidProject,
    InvalidScope,
    Ledger(workflow_store::StoreError),
    ManualVerifiedClaim,
    Store(MemoryStoreError),
    UnverifiedProvenance(String),
}

impl std::fmt::Display for MemoryCommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidConfidence => formatter.write_str("memory confidence filter is invalid"),
            Self::InvalidEventId => formatter.write_str("memory provenance event id is invalid"),
            Self::InvalidKind => formatter.write_str("memory kind is invalid"),
            Self::InvalidProject => formatter.write_str("project key cannot be empty"),
            Self::InvalidScope => formatter.write_str("memory scope must contain 1 to 16 entries"),
            Self::Ledger(error) => write!(formatter, "project ledger is unavailable: {error}"),
            Self::ManualVerifiedClaim => formatter.write_str(
                "manual memory cannot claim verified confidence; cite workflow evidence instead",
            ),
            Self::Store(error) => error.fmt(formatter),
            Self::UnverifiedProvenance(event_id) => write!(
                formatter,
                "memory provenance event {event_id} is not in this project's ledger"
            ),
        }
    }
}

impl std::error::Error for MemoryCommandError {}

impl From<MemoryStoreError> for MemoryCommandError {
    fn from(value: MemoryStoreError) -> Self {
        Self::Store(value)
    }
}

pub fn execute(
    database: &Path,
    project_key: &str,
    operation: MemoryOperation,
) -> Result<Value, MemoryCommandError> {
    if project_key.trim().is_empty() {
        return Err(MemoryCommandError::InvalidProject);
    }
    let project_id = ProjectId::from_stable_key(project_key);
    let mut store = MemoryStore::open(database)?;
    match operation {
        MemoryOperation::Search {
            confidence,
            limit,
            scope,
            text,
        } => {
            let confidence = confidence.map(parse_confidence).transpose()?;
            let item_limit = limit.clamp(1, 100);
            let entries = store.search(&MemorySearch {
                confidence,
                from: None,
                include_inactive: false,
                limit: item_limit.saturating_add(1),
                project_id,
                scope,
                text,
                to: None,
            })?;
            Ok(json!({
                "entries": compact(
                    &entries,
                    RetrievalBudget {
                        max_bytes: 32 * 1024,
                        max_items: item_limit,
                    },
                ),
                "truncated": entries.len() > item_limit,
            }))
        }
        MemoryOperation::Explain { memory_id } => Ok(json!({
            "entry": store.get(project_id, memory_id)?,
        })),
        MemoryOperation::Insert {
            confidence,
            detail,
            kind,
            scope,
            source_event_ids,
            summary,
            title,
        } => {
            let confidence = parse_manual_confidence(&confidence)?;
            let kind = parse_kind(&kind)?;
            if scope.is_empty() || scope.len() > 16 {
                return Err(MemoryCommandError::InvalidScope);
            }
            let event_ids = parse_event_ids(&source_event_ids)?;
            let project_ledger = workflow_store::Store::open(
                database,
                std::num::NonZeroUsize::new(1).expect("one is non-zero"),
            )
            .map_err(MemoryCommandError::Ledger)?;
            let ledger = project_ledger
                .load_ledger()
                .map_err(MemoryCommandError::Ledger)?;
            for event_id in &event_ids {
                let known = ledger
                    .entries()
                    .iter()
                    .any(|entry| entry.event.event_id == *event_id);
                if !known {
                    return Err(MemoryCommandError::UnverifiedProvenance(
                        event_id.to_string(),
                    ));
                }
            }
            let entry = MemoryEntry {
                actor: "user".to_owned(),
                confidence,
                created_at: WorkflowTimestamp::now(),
                detail,
                id: workflow_core::MemoryId::new(),
                kind,
                project_id,
                provenance: Provenance {
                    candidate_id: None,
                    evidence_ids: BTreeSet::new(),
                    revision: None,
                    source_event_ids: event_ids,
                },
                scope: BTreeSet::from_iter(scope),
                state: MemoryState::Current,
                summary,
                superseded_by: None,
                title,
            };
            entry.validate().map_err(MemoryStoreError::Domain)?;
            let memory_id = entry.id;
            store.insert(&entry)?;
            Ok(json!({ "memory_id": memory_id }))
        }
        MemoryOperation::Remove { memory_id } => {
            store.revoke(project_id, memory_id)?;
            Ok(json!({ "memory_id": memory_id, "state": "revoked" }))
        }
    }
}

fn parse_confidence(value: String) -> Result<ConfidenceClass, MemoryCommandError> {
    match value.as_str() {
        "inferred" => Ok(ConfidenceClass::Inferred),
        "user_asserted" => Ok(ConfidenceClass::UserAsserted),
        "verified" => Ok(ConfidenceClass::Verified),
        _ => Err(MemoryCommandError::InvalidConfidence),
    }
}

fn parse_manual_confidence(value: &str) -> Result<ConfidenceClass, MemoryCommandError> {
    match value {
        "inferred" => Ok(ConfidenceClass::Inferred),
        "user_asserted" => Ok(ConfidenceClass::UserAsserted),
        _ => Err(MemoryCommandError::ManualVerifiedClaim),
    }
}

fn parse_kind(value: &str) -> Result<MemoryKind, MemoryCommandError> {
    match value {
        "approval" => Ok(MemoryKind::Approval),
        "architecture_decision" => Ok(MemoryKind::ArchitectureDecision),
        "bug_fix" => Ok(MemoryKind::BugFix),
        "command" => Ok(MemoryKind::Command),
        "constraint" => Ok(MemoryKind::Constraint),
        "convention" => Ok(MemoryKind::Convention),
        "failed_approach" => Ok(MemoryKind::FailedApproach),
        _ => Err(MemoryCommandError::InvalidKind),
    }
}

fn parse_event_ids(values: &[String]) -> Result<BTreeSet<EventId>, MemoryCommandError> {
    if values.is_empty() || values.len() > 32 {
        return Err(MemoryCommandError::InvalidEventId);
    }
    values
        .iter()
        .map(|value| {
            value
                .parse::<EventId>()
                .map_err(|_| MemoryCommandError::InvalidEventId)
        })
        .collect()
}
