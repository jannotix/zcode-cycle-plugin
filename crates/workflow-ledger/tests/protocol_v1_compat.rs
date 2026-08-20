use workflow_ledger::{
    ChainVerification, Checkpoint, CheckpointVerification, LedgerChain, LedgerEntry,
};

const LEGACY_HISTORY: &str = r#"[{"event":{"actor":{"id":"arbiter","model":null,"role":null,"session_id":null},"candidate_id":null,"data":{"type":"workflow","action":"approved"},"event_id":"0190f0a0-0000-7000-8000-000000000001","evidence_ids":[],"files":[],"metadata":{},"project_id":"0190f0a0-0000-7000-8000-000000000002","task_id":null,"timestamp":"2026-08-15T12:00:00Z","workflow_id":null},"hash":"e5c73a4fdab31b64c37d9dbf6b8daa6106d0f7d7738cb69f0993df1e4a43e719","previous_hash":null,"sequence":0}]"#;

const LEGACY_CHECKPOINT: &str = r#"{"head":"e5c73a4fdab31b64c37d9dbf6b8daa6106d0f7d7738cb69f0993df1e4a43e719","public_key":[9,104,30,11,135,113,250,2,255,128,86,161,144,88,128,38,171,37,164,249,170,26,76,9,99,138,112,140,102,129,229,25],"sequence":0,"signature":[133,73,20,96,192,44,208,210,196,116,162,79,199,107,29,244,232,28,217,221,191,71,90,109,75,82,186,255,185,117,27,235,97,142,166,234,161,163,184,244,84,94,226,180,87,143,113,179,55,251,111,222,34,33,110,184,113,248,27,145,21,41,186,2],"signed_at":"2026-08-15T12:00:00Z"}"#;

#[test]
fn protocol_v1_history_and_checkpoint_remain_verifiable() {
    let entries: Vec<LedgerEntry> = serde_json::from_str(LEGACY_HISTORY).unwrap();
    let chain = LedgerChain::from_entries(entries);
    let checkpoint: Checkpoint = serde_json::from_str(LEGACY_CHECKPOINT).unwrap();
    let head = chain.head().unwrap();
    assert!(matches!(
        chain.verify(Some(head)),
        ChainVerification::Valid { entries: 1, .. }
    ));
    assert_eq!(
        checkpoint.verify_embedded(Some((checkpoint.sequence, head))),
        CheckpointVerification::Valid
    );
}
