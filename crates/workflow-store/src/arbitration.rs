use rusqlite::{OptionalExtension, params};
use workflow_core::{
    ArbiterVerdict, ArbitrationReceipt, CandidateId, ContentDigest, WorkflowId, WorkflowTimestamp,
};

use crate::{Store, StoreError, StoreMode};

impl Store {
    pub fn save_arbitration_once(
        &mut self,
        workflow_id: WorkflowId,
        candidate_id: CandidateId,
        verdict: &ArbiterVerdict,
        receipt: &ArbitrationReceipt,
        timestamp: WorkflowTimestamp,
    ) -> Result<bool, StoreError> {
        if self.mode != StoreMode::ReadWrite {
            return Err(StoreError::ReadOnly);
        }
        if receipt.workflow_id != workflow_id
            || receipt.candidate_id != candidate_id
            || receipt.candidate_digest != verdict.candidate_digest
            || receipt.arbiter_verdict_digest != verdict.digest()
        {
            return Err(StoreError::AggregateConflict(
                "the arbiter receipt does not bind the workflow, candidate and verdict it is recorded against",
            ));
        }
        let verdict_json = serde_json::to_string(verdict)?;
        let receipt_json = serde_json::to_string(receipt)?;
        let transaction = self.connection.transaction()?;
        let current: Option<(String, String, String, String)> = transaction
            .query_row(
                "SELECT workflow_id, verdict_json, receipt_digest, receipt_json
                 FROM workflow_arbitration WHERE candidate_id = ?1",
                [candidate_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        if let Some(current) = current {
            let expected = (
                workflow_id.to_string(),
                verdict_json,
                receipt.digest().to_string(),
                receipt_json,
            );
            if current != expected {
                return Err(StoreError::AggregateConflict(
                    "an arbitration verdict is already recorded for this candidate and differs from the one submitted",
                ));
            }
            return Ok(true);
        }
        transaction.execute(
            "INSERT INTO workflow_arbitration
             (candidate_id, workflow_id, verdict_json, receipt_digest, receipt_json, finalized_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                candidate_id.to_string(),
                workflow_id.to_string(),
                verdict_json,
                receipt.digest().to_string(),
                receipt_json,
                timestamp.to_string()
            ],
        )?;
        transaction.commit()?;
        Ok(false)
    }

    /// Every arbitration receipt digest recorded against a workflow.
    ///
    /// DEFECT-18: goal completion asked for "independent arbiter evidence",
    /// accepted a digest and resolved it against nothing, so sixty-four zeros
    /// completed a goal. Completion is the top-level claim that a body of work
    /// is done, and the arbiter receipt is the only thing tying that claim to a
    /// governed verdict. Reading the recorded digests is what lets the caller's
    /// citation be checked instead of believed.
    pub fn workflow_arbitration_receipt_digests(
        &self,
        workflow_id: WorkflowId,
    ) -> Result<Vec<ContentDigest>, StoreError> {
        let mut statement = self
            .connection
            .prepare("SELECT receipt_digest FROM workflow_arbitration WHERE workflow_id = ?1")?;
        let digests = statement
            .query_map([workflow_id.to_string()], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        digests
            .into_iter()
            .map(|value| {
                value.parse().map_err(|_| {
                    StoreError::AggregateConflict(
                        "a stored arbitration row holds a receipt digest this schema cannot parse",
                    )
                })
            })
            .collect()
    }

    pub fn load_arbitration(
        &self,
        candidate_id: CandidateId,
    ) -> Result<Option<(WorkflowId, ArbiterVerdict, ArbitrationReceipt)>, StoreError> {
        let value: Option<(String, String, String)> = self
            .connection
            .query_row(
                "SELECT workflow_id, verdict_json, receipt_json
                 FROM workflow_arbitration WHERE candidate_id = ?1",
                [candidate_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        value
            .map(|(workflow_id, verdict, receipt)| {
                Ok((
                    workflow_id
                        .parse()
                        .map_err(|_| StoreError::AggregateConflict("a stored arbitration row holds a workflow identifier this schema cannot parse"))?,
                    serde_json::from_str(&verdict)?,
                    serde_json::from_str(&receipt)?,
                ))
            })
            .transpose()
    }
}
