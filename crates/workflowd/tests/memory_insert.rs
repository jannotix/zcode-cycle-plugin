use std::{collections::BTreeMap, num::NonZeroUsize};

use tempfile::TempDir;
use workflow_core::ProjectId;
use workflow_ledger::{Actor, EventData, LedgerEvent, Redactor};
use workflow_store::Store;

use workflowd::memory::{self, MemoryCommandError};

fn database() -> (TempDir, std::path::PathBuf) {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("workflow.db");
    (directory, path)
}

fn append_event(path: &std::path::Path, project_id: ProjectId) -> workflow_core::EventId {
    let mut store = Store::open(path, NonZeroUsize::new(1).unwrap()).unwrap();
    let event = LedgerEvent::new(
        Actor {
            id: "workflowd".to_owned(),
            model: None,
            role: None,
            session_id: None,
        },
        None,
        EventData::Workflow {
            action: "memory_source".to_owned(),
        },
        [],
        [],
        BTreeMap::new(),
        project_id,
        None,
        workflow_core::WorkflowTimestamp::now(),
        None,
        &Redactor::default(),
    )
    .unwrap();
    let event_id = event.event_id;
    store.append_ledger_event(event).unwrap();
    event_id
}

#[test]
fn insert_requires_ledger_provenance_and_searches_back() {
    let (_guard, path) = database();
    let project_id = ProjectId::from_stable_key("memory-project");
    let event_id = append_event(&path, project_id);

    let unknown = memory::execute(
        &path,
        "memory-project",
        workflow_ipc::protocol::MemoryOperation::Insert {
            confidence: "user_asserted".to_owned(),
            detail: "A ledger event must back every memory.".to_owned(),
            kind: "convention".to_owned(),
            scope: vec!["memory".to_owned()],
            source_event_ids: vec!["0190f0a0-0000-7000-8000-00000000dead".to_owned()],
            summary: "Provenance is mandatory.".to_owned(),
            title: "Memory provenance".to_owned(),
        },
    );
    assert!(matches!(
        unknown.unwrap_err(),
        MemoryCommandError::UnverifiedProvenance(_)
    ));

    let verified = memory::execute(
        &path,
        "memory-project",
        workflow_ipc::protocol::MemoryOperation::Insert {
            confidence: "verified".to_owned(),
            detail: "Verified confidence is reserved for evidence-backed capture.".to_owned(),
            kind: "convention".to_owned(),
            scope: vec!["memory".to_owned()],
            source_event_ids: vec![event_id.to_string()],
            summary: "Manual memories cannot claim verification.".to_owned(),
            title: "Manual memory confidence".to_owned(),
        },
    );
    assert!(matches!(
        verified.unwrap_err(),
        MemoryCommandError::ManualVerifiedClaim
    ));

    let inserted = memory::execute(
        &path,
        "memory-project",
        workflow_ipc::protocol::MemoryOperation::Insert {
            confidence: "user_asserted".to_owned(),
            detail: "Every memory cites the ledger event that justifies it.".to_owned(),
            kind: "convention".to_owned(),
            scope: vec!["memory".to_owned()],
            source_event_ids: vec![event_id.to_string()],
            summary: "Memories carry ledger provenance.".to_owned(),
            title: "Memory provenance".to_owned(),
        },
    )
    .unwrap();
    let memory_id = inserted["memory_id"].as_str().unwrap().to_owned();

    let found = memory::execute(
        &path,
        "memory-project",
        workflow_ipc::protocol::MemoryOperation::Search {
            confidence: None,
            limit: 10,
            scope: Some("memory".to_owned()),
            text: "provenance".to_owned(),
        },
    )
    .unwrap();
    let entries = found["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["id"].as_str().unwrap(), memory_id);

    let explained = memory::execute(
        &path,
        "memory-project",
        workflow_ipc::protocol::MemoryOperation::Explain {
            memory_id: memory_id.parse().unwrap(),
        },
    )
    .unwrap();
    assert_eq!(
        explained["entry"]["provenance"]["source_event_ids"][0]
            .as_str()
            .unwrap(),
        event_id.to_string()
    );

    memory::execute(
        &path,
        "memory-project",
        workflow_ipc::protocol::MemoryOperation::Remove {
            memory_id: memory_id.parse().unwrap(),
        },
    )
    .unwrap();
    let after = memory::execute(
        &path,
        "memory-project",
        workflow_ipc::protocol::MemoryOperation::Search {
            confidence: None,
            limit: 10,
            scope: None,
            text: "provenance".to_owned(),
        },
    )
    .unwrap();
    assert!(after["entries"].as_array().unwrap().is_empty());
}
