#![cfg(unix)]

use job_runner::{
    Submission,
    engine::{Engine, ExecutionJournal, IrEngine},
    graph,
    native::WorkflowEngine,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixListener,
};
use tokio_util::sync::CancellationToken;

async fn response_error(response: Vec<u8>) -> job_runner::Error {
    let temp = tempfile::tempdir().unwrap();
    let socket = temp.path().join("suite.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut reader = BufReader::new(stream);
        let mut request = String::new();
        reader.read_line(&mut request).await.unwrap();
        let _ = reader.get_mut().write_all(&response).await;
    });
    let error = graph::rpc(
        &socket,
        "inspect",
        json!({"job_id":"JOB-test","step_id":"review"}),
    )
    .await
    .unwrap_err();
    server.await.unwrap();
    error
}

#[tokio::test]
async fn empty_and_truncated_replies_are_recoverable_without_logging_payloads() {
    for response in [Vec::new(), br#"{"ok":true,"secret":"DO-NOT-LOG"}"#.to_vec()] {
        let length = response.len();
        let error = response_error(response).await;
        assert_eq!(error.code, "suite_unavailable");
        assert!(error.message.contains("inspect"), "{error}");
        assert!(
            error.message.contains(&format!("{length} bytes")),
            "{error}"
        );
        assert!(!error.message.contains("DO-NOT-LOG"));
    }
}

#[tokio::test]
async fn oversized_replies_have_a_distinct_permanent_error() {
    let error = response_error(vec![b'x'; 4 * 1024 * 1024 + 1]).await;
    assert_eq!(error.code, "suite_response_limit");
    assert!(error.message.contains("inspect"));
    assert!(error.message.contains("4194304"));
}

#[tokio::test]
async fn complete_malformed_replies_are_permanent_without_logging_payloads() {
    for response in [
        b"DO-NOT-LOG\n".to_vec(),
        b"[]\n".to_vec(),
        b"{\"ok\":true}\n".to_vec(),
    ] {
        let error = response_error(response).await;
        assert_eq!(error.code, "suite_protocol");
        assert!(error.message.contains("inspect"));
        assert!(!error.message.contains("DO-NOT-LOG"));
    }
}

#[tokio::test]
async fn native_workflow_reconciles_lost_start_and_inspect_replies_without_duplicate_workers() {
    let temp = tempfile::tempdir().unwrap();
    let socket = temp.path().join("suite.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let created = Arc::new(Mutex::new(BTreeSet::new()));
    let observed_requests = Arc::new(Mutex::new(Vec::new()));
    let identities = created.clone();
    let requests = observed_requests.clone();
    let server = tokio::spawn(async move {
        let mut starts = 0;
        let mut inspections = 0;
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            requests.lock().unwrap().push(request.clone());
            let op = request["op"].as_str().unwrap();
            let data = match op {
                "start" => {
                    starts += 1;
                    identities.lock().unwrap().insert(format!(
                        "{}:{}",
                        request["args"]["job_id"], request["args"]["step"]["id"]
                    ));
                    if starts == 1 {
                        continue;
                    } // Worker exists; its acknowledgment was lost.
                    json!({"state":"running","chat_id":"retained-chat","turn_id":"retained-turn"})
                }
                "inspect" => {
                    inspections += 1;
                    if inspections == 1 {
                        reader.get_mut().write_all(b"{\"ok\":true").await.unwrap();
                        continue;
                    }
                    json!({"state":"completed","chat_id":"retained-chat","turn_id":"retained-turn",
                        "result":{"report":"review evidence","message_id":1}})
                }
                "ack_result" => json!({"acknowledged":true}),
                "publish" => json!({"message_id":2,"inbox":"main"}),
                other => panic!("unexpected operation: {other}"),
            };
            let mut response = serde_json::to_vec(&json!({"ok":true,"data":data})).unwrap();
            response.push(b'\n');
            reader.get_mut().write_all(&response).await.unwrap();
            if op == "publish" {
                break;
            }
        }
    });
    let workflow = WorkflowEngine::new(Arc::new(IrEngine::verifier().unwrap()), socket).unwrap();
    let submission = Submission {
        key: "recovery-test".into(),
        workflow: json!({"format":"aixand.chat-workflow","version":1,"name":"Recovery",
            "project_id":uuid::Uuid::new_v4().to_string(),"origin_chat_id":uuid::Uuid::new_v4().to_string(),
            "profile":"work","steps":[{"id":"review","title":"Review","instruction":"Review saved work"}],"delivery_step":"review"}),
        inputs: json!({}),
        metadata: json!({}),
    };
    let checkpoint = Arc::new(Mutex::new(json!({})));
    let saved = checkpoint.clone();
    let result = tokio::time::timeout(
        Duration::from_secs(8),
        workflow.execute_journaled(
            submission,
            Arc::new(|_| {}),
            CancellationToken::new(),
            ExecutionJournal {
                job_id: "JOB-recovery".into(),
                checkpoint: json!({}),
                persist: Arc::new(move |value| {
                    *saved.lock().unwrap() = value.clone();
                    Ok(())
                }),
                cancel_requested: Arc::new(|| false),
                control: None,
            },
        ),
    )
    .await
    .unwrap()
    .unwrap();
    server.await.unwrap();
    assert_eq!(created.lock().unwrap().len(), 1);
    assert_eq!(result["delivery"]["message_id"], 2);
    let requests = observed_requests.lock().unwrap();
    let starts: Vec<_> = requests.iter().filter(|r| r["op"] == "start").collect();
    assert_eq!(starts.len(), 2);
    assert_eq!(
        starts[0], starts[1],
        "reconciliation must retain the exact start identity and payload"
    );
    assert_eq!(
        checkpoint.lock().unwrap()["steps"]["review"]["chat_id"],
        "retained-chat"
    );
}
