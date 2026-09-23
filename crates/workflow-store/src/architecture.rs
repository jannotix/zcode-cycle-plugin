use rusqlite::{OptionalExtension, params};
use workflow_core::{
    ArchitecturePlan, RequestRecord, Workflow, WorkflowId, WorkflowState, WorkflowTimestamp,
};

use crate::{Store, StoreError, StoreMode};

impl Store {
    pub fn save_architecture_once(
        &mut self,
        workflow_id: WorkflowId,
        plan: &ArchitecturePlan,
        timestamp: WorkflowTimestamp,
    ) -> Result<bool, StoreError> {
        if self.mode != StoreMode::ReadWrite {
            return Err(StoreError::ReadOnly);
        }
        let transaction = self.connection.transaction()?;
        let request_json: String = transaction
            .query_row(
                "SELECT request_json FROM workflow_requests WHERE workflow_id = ?1",
                [workflow_id.to_string()],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(StoreError::AggregateConflict("no intake request is recorded for this workflow, so an architecture plan has nothing to bind to"))?;
        let request: RequestRecord = serde_json::from_str(&request_json)?;
        if request.digest() != plan.request_digest {
            return Err(StoreError::RequestDigestMismatch);
        }
        let plan_json = serde_json::to_string(plan)?;
        let current: Option<String> = transaction
            .query_row(
                "SELECT plan_json FROM workflow_architecture WHERE workflow_id = ?1",
                [workflow_id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(current) = current {
            if current == plan_json {
                return Ok(true);
            }
            let state_json: String = transaction.query_row(
                "SELECT state_json FROM workflows WHERE id = ?1",
                [workflow_id.to_string()],
                |row| row.get(0),
            )?;
            let state: Workflow = serde_json::from_str(&state_json)?;
            if state.state() != WorkflowState::Architecture || state.repair_cycles() == 0 {
                return Err(StoreError::AggregateConflict(
                    "an architecture plan is already recorded and the workflow is not in a repair cycle that may replace it",
                ));
            }
            let revision: u32 = transaction.query_row(
                "SELECT COALESCE(MAX(revision), 0) + 1
                 FROM workflow_architecture_versions WHERE workflow_id = ?1",
                [workflow_id.to_string()],
                |row| row.get(0),
            )?;
            transaction.execute(
                "UPDATE workflow_architecture
                 SET request_digest = ?2, plan_digest = ?3, plan_json = ?4, created_at = ?5
                 WHERE workflow_id = ?1",
                params![
                    workflow_id.to_string(),
                    plan.request_digest.to_string(),
                    plan.digest().to_string(),
                    plan_json,
                    timestamp.to_string()
                ],
            )?;
            transaction.execute(
                "INSERT INTO workflow_architecture_versions
                 (workflow_id, revision, request_digest, plan_digest, plan_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    workflow_id.to_string(),
                    revision,
                    plan.request_digest.to_string(),
                    plan.digest().to_string(),
                    plan_json,
                    timestamp.to_string()
                ],
            )?;
            transaction.commit()?;
            return Ok(false);
        }
        transaction.execute(
            "INSERT INTO workflow_architecture
             (workflow_id, request_digest, plan_digest, plan_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                workflow_id.to_string(),
                plan.request_digest.to_string(),
                plan.digest().to_string(),
                plan_json,
                timestamp.to_string()
            ],
        )?;
        transaction.execute(
            "INSERT INTO workflow_architecture_versions
             (workflow_id, revision, request_digest, plan_digest, plan_json, created_at)
             VALUES (?1, 1, ?2, ?3, ?4, ?5)",
            params![
                workflow_id.to_string(),
                plan.request_digest.to_string(),
                plan.digest().to_string(),
                plan_json,
                timestamp.to_string()
            ],
        )?;
        transaction.commit()?;
        Ok(false)
    }

    pub fn load_architecture(
        &self,
        workflow_id: WorkflowId,
    ) -> Result<Option<ArchitecturePlan>, StoreError> {
        let plan: Option<String> = self
            .connection
            .query_row(
                "SELECT plan_json FROM workflow_architecture WHERE workflow_id = ?1",
                [workflow_id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        plan.map(|value| serde_json::from_str(&value))
            .transpose()
            .map_err(StoreError::from)
    }

    pub fn load_architecture_versions(
        &self,
        workflow_id: WorkflowId,
    ) -> Result<Vec<ArchitecturePlan>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT plan_json FROM workflow_architecture_versions
             WHERE workflow_id = ?1 ORDER BY revision",
        )?;
        let rows = statement.query_map([workflow_id.to_string()], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }
}
