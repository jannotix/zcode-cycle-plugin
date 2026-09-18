mod common;

use workflow_ledger::EventData;

/// DEFECT-24: in 1.0.5 a gate the control plane really ran and a gate a session
/// simply asserted serialised to the same `data` - byte for byte - so nothing a
/// reader of the gate record could see told them apart. The signals that did
/// differ sat outside `data`, in a free-text `actor.id` and in whether an
/// evidence row happened to exist.
#[test]
fn a_declared_gate_outcome_is_distinguishable_from_a_verified_one() {
    let verified = EventData::Verification {
        declared: false,
        gate: "test:npm test".to_owned(),
        status: "passed".to_owned(),
    };
    let claimed = EventData::Verification {
        declared: true,
        gate: "test:npm test".to_owned(),
        status: "passed".to_owned(),
    };

    let verified_json = serde_json::to_value(&verified).unwrap();
    let claimed_json = serde_json::to_value(&claimed).unwrap();

    assert_ne!(
        verified_json, claimed_json,
        "the two must not serialise identically - that identity was the defect"
    );
    assert_eq!(claimed_json["declared"], serde_json::json!(true));

    // A gate the control plane ran carries no marker at all, so entries written
    // before this field existed keep their exact bytes and their hashes.
    assert_eq!(
        verified_json,
        serde_json::json!({
            "type": "verification",
            "gate": "test:npm test",
            "status": "passed",
        })
    );
}

/// The field has to survive a round trip, because the whole point is that a
/// reader of a stored entry can still see it.
#[test]
fn the_marker_survives_a_round_trip_and_older_entries_still_load() {
    for declared in [false, true] {
        let event = EventData::Verification {
            declared,
            gate: "build:cargo build".to_owned(),
            status: "failed".to_owned(),
        };
        let encoded = serde_json::to_string(&event).unwrap();
        assert_eq!(
            serde_json::from_str::<EventData>(&encoded).unwrap(),
            event,
            "provenance must not be lost on the way back out"
        );
    }

    // An entry stored by 1.0.5, before the field existed, reads as what it was:
    // written by the control plane.
    let legacy: EventData =
        serde_json::from_str(r#"{"type":"verification","gate":"test:npm test","status":"passed"}"#)
            .unwrap();
    assert_eq!(
        legacy,
        EventData::Verification {
            declared: false,
            gate: "test:npm test".to_owned(),
            status: "passed".to_owned(),
        }
    );
}

/// A declared entry is still a real ledger event: it is recorded, not refused.
/// The record is what makes it answerable later.
#[test]
fn a_declared_gate_outcome_is_still_recorded() {
    let event = common::event_with_data(EventData::Verification {
        declared: true,
        gate: "test:npm test".to_owned(),
        status: "passed".to_owned(),
    });
    let bytes = event.canonical_bytes().unwrap();
    assert!(String::from_utf8_lossy(&bytes).contains("\"declared\":true"));
}
