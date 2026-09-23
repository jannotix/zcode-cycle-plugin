-- DEFECT-22: evidence was keyed on evidence_id alone, and an evidence id comes
-- from the verification *plan*. A repair reuses the plan, so the refrozen
-- candidate arrives carrying the ids the failed candidate already used, and
-- save_evidence_once refused the whole re-run with "evidence for this gate is
-- already recorded with a different identity". A candidate that has been
-- repaired could therefore never be verified again, which is the one thing the
-- repair loop exists to do.
--
-- A gate result belongs to the candidate it was run against, so that is what it
-- is keyed on. Both candidates keep their rows: the failed run stays in the
-- record rather than being overwritten by the run that fixed it.

PRAGMA foreign_keys = OFF;

CREATE TABLE workflow_evidence_next (
    evidence_id TEXT NOT NULL,
    plan_id TEXT NOT NULL REFERENCES workflow_verification_plans(plan_id) ON DELETE CASCADE,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    candidate_id TEXT NOT NULL REFERENCES workflow_candidates(candidate_id) ON DELETE CASCADE,
    mandatory INTEGER NOT NULL CHECK(mandatory IN (0, 1)),
    record_json TEXT NOT NULL,
    output_redacted TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (evidence_id, candidate_id)
) STRICT;

INSERT INTO workflow_evidence_next
    (evidence_id, plan_id, workflow_id, candidate_id, mandatory, record_json,
     output_redacted, created_at)
SELECT evidence_id, plan_id, workflow_id, candidate_id, mandatory, record_json,
       output_redacted, created_at
FROM workflow_evidence;

-- Attempts are a history of re-running one gate, and a re-run is against one
-- candidate, so they carry the candidate too. Existing rows take it from the
-- evidence row they already belonged to.
CREATE TABLE workflow_evidence_attempts_next (
    evidence_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK(attempt > 0),
    record_json TEXT NOT NULL,
    output_redacted TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (evidence_id, candidate_id, attempt),
    FOREIGN KEY (evidence_id, candidate_id)
        REFERENCES workflow_evidence_next(evidence_id, candidate_id) ON DELETE CASCADE
) STRICT;

INSERT INTO workflow_evidence_attempts_next
    (evidence_id, candidate_id, attempt, record_json, output_redacted, created_at)
SELECT attempts.evidence_id, evidence.candidate_id, attempts.attempt,
       attempts.record_json, attempts.output_redacted, attempts.created_at
FROM workflow_evidence_attempts AS attempts
JOIN workflow_evidence AS evidence
  ON evidence.evidence_id = attempts.evidence_id;

DROP TABLE workflow_evidence_attempts;
DROP TABLE workflow_evidence;

ALTER TABLE workflow_evidence_next RENAME TO workflow_evidence;
ALTER TABLE workflow_evidence_attempts_next RENAME TO workflow_evidence_attempts;

CREATE INDEX workflow_evidence_candidate
ON workflow_evidence(candidate_id, evidence_id);

PRAGMA foreign_keys = ON;

INSERT INTO schema_history(version) VALUES (18);
