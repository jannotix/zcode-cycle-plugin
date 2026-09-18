use std::collections::BTreeMap;

use workflow_core::{ProjectId, WorkflowId, WorkflowTimestamp};
use workflow_ledger::{Actor, EventData, LedgerEvent, Redactor};

#[allow(dead_code)]
pub fn event(action: &str) -> LedgerEvent {
    event_with_data(EventData::Workflow {
        action: action.to_owned(),
    })
}

#[allow(dead_code)]
pub fn event_with_data(data: EventData) -> LedgerEvent {
    LedgerEvent::new(
        Actor {
            id: "workflowd".to_owned(),
            model: None,
            role: None,
            session_id: None,
        },
        None,
        data,
        [],
        ["src/lib.rs".to_owned()],
        BTreeMap::new(),
        ProjectId::new(),
        None,
        WorkflowTimestamp::parse("2026-08-12T12:00:00Z").unwrap(),
        Some(WorkflowId::new()),
        &Redactor::default(),
    )
    .unwrap()
}
