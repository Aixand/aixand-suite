use job_runner::{
    client::Client,
    model::{Job, JobState, Request, Submission},
};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{Value, json};
use std::{
    path::Path,
    process::{Child, Command, Stdio},
    time::Duration,
};
use tempfile::TempDir;

struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn spawn(home: &Path) -> Server {
    Server(
        Command::new(env!("CARGO_BIN_EXE_runner"))
            .arg("--home")
            .arg(home)
            .arg("serve")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    )
}

async fn ready(client: &Client) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while client.request(Request::Health).await.is_err() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn real_process_crash_retains_uncertainty_and_never_replays_the_attempt() {
    let dir = TempDir::new().unwrap();
    let mut server = spawn(dir.path());
    let client = Client::new(dir.path());
    ready(&client).await;
    let mut workflow: Value =
        serde_json::from_str(include_str!("../examples/verify.json")).unwrap();
    let step = workflow["body"]["steps"][0].clone();
    let steps = workflow["body"]["steps"].as_array_mut().unwrap();
    // Real, pure IR operations generate enough durable events to interrupt in flight.
    for i in 0..2000 {
        let mut step = step.clone();
        step["id"] = json!(format!("verify_{i}"));
        steps.push(step);
    }
    let submission = Submission {
        key: "crash".into(),
        workflow,
        inputs: json!({"title":"test","body":"workflow"}),
        metadata: json!({}),
    };
    let submit_client = client.clone();
    let pending_submission = submission.clone();
    let pending = tokio::spawn(async move {
        submit_client
            .request(Request::Submit {
                submission: pending_submission,
            })
            .await
    });
    // Observe the committed attempt independently of Runner's socket handlers.
    // Pure IR work can finish before an inspect response gets CPU or the store lock.
    let database = Connection::open_with_flags(
        dir.path().join("jobs.sqlite3"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let original = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let payload: Option<String> = database
                .query_row(
                    "SELECT payload FROM jobs WHERE submission_key='crash'",
                    [],
                    |row| row.get(0),
                )
                .optional()
                .unwrap();
            if let Some(payload) = payload {
                let job: Job = serde_json::from_str(&payload).unwrap();
                if job.state == JobState::Running {
                    break job;
                }
                assert_eq!(job.state, JobState::Queued);
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    server.0.kill().unwrap();
    server.0.wait().unwrap();
    let id = original.id.clone();
    if let Ok(accepted) = pending.await.unwrap() {
        assert_eq!(accepted["job"]["id"], id);
    }
    let _restarted = spawn(dir.path());
    ready(&client).await;
    let recovered = client
        .request(Request::Inspect { id: id.clone() })
        .await
        .unwrap();
    assert_eq!(recovered["state"], "uncertain");
    assert_eq!(recovered["error"]["code"], "service_interrupted");
    assert_eq!(recovered["attempt_id"], original.attempt_id.unwrap());
    let replay = client
        .request(Request::Submit { submission })
        .await
        .unwrap();
    assert_eq!(replay["job"]["id"], id);
    assert_eq!(replay["replayed"], true);
    assert_eq!(replay["job"]["state"], "uncertain");
}

#[tokio::test]
async fn python_client_and_cli_use_the_live_socket_protocol() {
    let dir = TempDir::new().unwrap();
    let _server = spawn(dir.path());
    let client = Client::new(dir.path());
    ready(&client).await;
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let python =
        Command::new(std::env::var_os("RUNNER_TEST_PYTHON").unwrap_or_else(|| "python3".into()))
            .env("PYTHONPATH", root.join("python"))
            .arg(root.join("examples/submit.py"))
            .arg("--home")
            .arg(dir.path())
            .output()
            .unwrap();
    assert!(
        python.status.success(),
        "{}",
        String::from_utf8_lossy(&python.stderr)
    );
    assert!(String::from_utf8_lossy(&python.stdout).contains("\"passed\": true"));
    let output = Command::new(env!("CARGO_BIN_EXE_runner"))
        .arg("--home")
        .arg(dir.path())
        .arg("submit")
        .arg(root.join("examples/verify.json"))
        .arg("--inputs")
        .arg(root.join("examples/inputs.json"))
        .arg("--key")
        .arg("python-verifier-example")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let replay: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(replay["replayed"], true);
    let id = replay["job"]["id"].as_str().unwrap();
    let events = Command::new(env!("CARGO_BIN_EXE_runner"))
        .arg("--home")
        .arg(dir.path())
        .arg("events")
        .arg(id)
        .arg("--follow")
        .output()
        .unwrap();
    assert!(events.status.success());
    let lines: Vec<Value> = String::from_utf8(events.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines.last().unwrap()["data"]["state"], "completed");
}
