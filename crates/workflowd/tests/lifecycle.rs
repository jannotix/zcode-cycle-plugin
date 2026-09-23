use std::{
    path::Path,
    process::{Child, Command, Stdio},
    time::Duration,
};

use std::io::ErrorKind;

use tempfile::TempDir;
use workflow_ipc::{
    ClientMessage, ServerMessage,
    auth::Authenticator,
    client::query_health,
    secret::{IpcSecret, load},
    transport::connect,
};

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn start(data_directory: &Path) -> ChildGuard {
    ChildGuard(
        Command::new(env!("CARGO_BIN_EXE_workflowd"))
            .arg("--data-dir")
            .arg(data_directory)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    )
}

async fn wait_for_secret(data_directory: &Path) -> IpcSecret {
    let path = data_directory.join("runtime").join("ipc.secret");
    for _ in 0..250 {
        if let Ok(secret) = load(&path) {
            return secret;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("workflowd did not create its IPC credential");
}

// The credential file is not a readiness signal. `run` writes `ipc.secret`
// first, then opens the store, loads the checkpoint key and verifies the whole
// hash chain, and only then binds its endpoint - so a client that waits for the
// credential and connects immediately can arrive before anything is listening.
// The window is as wide as `verify_store` takes, which is why this passed for
// months and then failed three tests at once on a loaded CI runner.
//
// The shipped bridge already gets this right: it treats the credential as
// permission to *try*, and retries until the daemon answers. This mirrors that,
// and the unix arm below, which has always retried.
#[cfg(windows)]
async fn health(_data_directory: &Path, secret: &IpcSecret) -> workflow_ipc::HealthReport {
    for _ in 0..250 {
        match connect(&secret.endpoint_id()).await {
            Ok(stream) => return query_health(stream, secret, 1).await.unwrap(),
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::NotFound | ErrorKind::ConnectionRefused
                ) =>
            {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(error) => panic!("workflowd IPC connection failed: {error}"),
        }
    }
    panic!("workflowd never accepted an IPC connection");
}

#[cfg(unix)]
async fn health(data_directory: &Path, secret: &IpcSecret) -> workflow_ipc::HealthReport {
    let endpoint = data_directory.join("runtime").join("workflow.sock");
    for _ in 0..250 {
        match connect(&endpoint).await {
            Ok(stream) => return query_health(stream, secret, 1).await.unwrap(),
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::NotFound | ErrorKind::ConnectionRefused
                ) =>
            {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(error) => panic!("workflowd IPC connection failed: {error}"),
        }
    }
    panic!("workflowd did not create its IPC endpoint");
}

#[tokio::test]
async fn daemon_starts_reports_health_and_preserves_state_across_restart() {
    let temporary = TempDir::new().unwrap();
    let mut daemon = start(temporary.path());
    let secret = wait_for_secret(temporary.path()).await;
    let first = health(temporary.path(), &secret).await;
    assert_eq!(first.protocol_version, workflow_core::PROTOCOL_VERSION);
    assert_eq!(first.schema_version, workflow_store::CURRENT_SCHEMA_VERSION);
    assert_eq!(first.schema_mode, "read_write");
    daemon.0.kill().unwrap();
    daemon.0.wait().unwrap();

    let _restarted_daemon = start(temporary.path());
    let restarted = health(temporary.path(), &secret).await;
    assert_eq!(restarted, first);
    assert!(temporary.path().join("control-plane.db").is_file());
}

#[tokio::test]
async fn concurrent_daemon_start_converges_on_one_process() {
    let temporary = TempDir::new().unwrap();
    let _daemon = start(temporary.path());
    let secret = wait_for_secret(temporary.path()).await;
    health(temporary.path(), &secret).await;
    let mut duplicate = start(temporary.path());
    let status = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(status) = duplicate.0.try_wait().unwrap() {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("duplicate daemon did not exit");
    assert!(!status.success());
    health(temporary.path(), &secret).await;
}

#[cfg(windows)]
async fn open_stream(
    data_directory: &Path,
) -> impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin {
    let secret = load(data_directory.join("runtime").join("ipc.secret")).unwrap();
    connect(&secret.endpoint_id()).await.unwrap()
}

#[cfg(unix)]
async fn open_stream(
    data_directory: &Path,
) -> impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin {
    let endpoint = data_directory.join("runtime").join("workflow.sock");
    for _ in 0..250 {
        match connect(&endpoint).await {
            Ok(stream) => return stream,
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::NotFound | ErrorKind::ConnectionRefused
                ) =>
            {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(error) => panic!("workflowd IPC connection failed: {error}"),
        }
    }
    panic!("workflowd did not create its IPC endpoint");
}

/// A payload that does not match the protocol must be answered, not dropped.
///
/// The verdict below is the one an arbiter actually produced during live
/// certification. Its field names are all correct and three of its values are
/// not: "approve" instead of "approved", prose strings where Finding structs
/// belong, and free text where an EvidenceId belongs. Before this fix the
/// daemon closed the connection without a word and the caller saw only
/// "workflowd disconnected before responding".
#[tokio::test]
async fn a_malformed_request_is_rejected_by_name_and_the_connection_survives() {
    let temporary = TempDir::new().unwrap();
    let _daemon = start(temporary.path());
    let secret = wait_for_secret(temporary.path()).await;
    health(temporary.path(), &secret).await;

    let stream = open_stream(temporary.path()).await;
    let mut channel = workflow_ipc::channel::JsonChannel::new(stream);
    let challenge = match channel.receive::<ServerMessage>().await.unwrap() {
        ServerMessage::Challenge(challenge) => challenge,
        other => panic!("expected a challenge, got {other:?}"),
    };
    channel
        .send(&ClientMessage::Authenticate(Authenticator::respond(
            secret.as_bytes(),
            &challenge,
        )))
        .await
        .unwrap();

    let malformed = serde_json::json!({
        "type": "submit_arbitration",
        "request_id": 41_u64,
        "project_key": "fixture",
        "workflow_id": "b386deab-b976-4715-9468-49ee2e733b17",
        "candidate_id": "be8037db-6106-45e8-a0bc-874c5e448c74",
        "verdict": {
            "decision": "approve",
            "candidate_digest":
                "3c15417ee940bd5b6fbc4e168e157403b1d5b529c2b16bd539f226d2afc267a3",
            "requirements": [],
            "findings": ["all mandatory gates passed"],
            "repair_target": serde_json::Value::Null,
        },
    });
    channel.send(&malformed).await.unwrap();

    match channel
        .receive::<ServerMessage>()
        .await
        .expect("the daemon closed the connection instead of answering")
    {
        ServerMessage::Error {
            request_id,
            code,
            message,
        } => {
            assert_eq!(request_id, Some(41));
            assert_eq!(code, "malformed_request");
            assert!(
                message.contains("does not match the control-plane protocol"),
                "the rejection must say what happened, got: {message}"
            );
        }
        other => panic!("expected a malformed_request rejection, got {other:?}"),
    }

    // A protocol rejection is not fatal: the same connection still serves.
    channel
        .send(&ClientMessage::Health { request_id: 42 })
        .await
        .unwrap();
    match channel.receive::<ServerMessage>().await.unwrap() {
        ServerMessage::Health { request_id, .. } => assert_eq!(request_id, 42),
        other => panic!("expected health on the same connection, got {other:?}"),
    }
}
