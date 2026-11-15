use crate::{Error, Result, model::*};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{Mutex, MutexGuard},
    time::Duration,
};
use uuid::Uuid;

pub(crate) struct Store {
    pub(crate) connection: Mutex<Connection>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let mut c = Connection::open(path)?;
        c.busy_timeout(Duration::from_secs(5))?;
        c.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
        )?;
        let version: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version > 4 {
            return Err(Error::new(
                "storage_version",
                "Database was created by a newer Runner",
            ));
        }
        if version == 0 {
            let tx = c.transaction()?;
            tx.execute_batch(
                "CREATE TABLE jobs (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT NOT NULL UNIQUE, submission_key TEXT NOT NULL UNIQUE,
                request_digest TEXT NOT NULL, state TEXT NOT NULL,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                cancel_requested INTEGER NOT NULL, payload TEXT NOT NULL
            );
            CREATE INDEX jobs_queue ON jobs(state, seq);
            CREATE TABLE events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id TEXT NOT NULL REFERENCES jobs(id),
                recorded_at INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL
            );
            CREATE INDEX events_job ON events(job_id, seq);
            PRAGMA user_version=1;",
            )?;
            tx.commit()?;
        }
        let tx = c.transaction()?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS checkpoints (job_id TEXT PRIMARY KEY REFERENCES jobs(id), data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS cancelled_submissions (submission_key TEXT PRIMARY KEY, cancelled_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS execution_plans (job_id TEXT PRIMARY KEY REFERENCES jobs(id), revision INTEGER NOT NULL,
                workflow TEXT NOT NULL, authoring TEXT, phase TEXT NOT NULL, held INTEGER NOT NULL, engine_digest TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS plan_revisions (job_id TEXT NOT NULL REFERENCES jobs(id), revision INTEGER NOT NULL,
                amendment_key TEXT NOT NULL, request_digest TEXT NOT NULL, workflow TEXT NOT NULL, authoring TEXT, created_at INTEGER NOT NULL,
                PRIMARY KEY(job_id, revision), UNIQUE(job_id, amendment_key));
            CREATE TABLE IF NOT EXISTS operation_runs (job_id TEXT NOT NULL REFERENCES jobs(id), invocation TEXT NOT NULL,
                group_id TEXT NOT NULL, revision INTEGER NOT NULL, definition TEXT NOT NULL, state TEXT NOT NULL, request TEXT,
                PRIMARY KEY(job_id, invocation));
            CREATE TABLE IF NOT EXISTS retired_operations (job_id TEXT NOT NULL REFERENCES jobs(id), invocation TEXT NOT NULL,
                PRIMARY KEY(job_id, invocation));
            CREATE TABLE IF NOT EXISTS pending_adoptions (job_id TEXT PRIMARY KEY REFERENCES jobs(id), request TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS continuations (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES jobs(id),
                registration_key TEXT NOT NULL, request_digest TEXT NOT NULL, target TEXT NOT NULL, input_map TEXT NOT NULL,
                engine_digest TEXT NOT NULL, state TEXT NOT NULL, child_id TEXT REFERENCES jobs(id), error TEXT, created_at INTEGER NOT NULL,
                UNIQUE(parent_id, registration_key));
            PRAGMA user_version=4;")?;
        tx.commit()?;
        Ok(Self {
            connection: Mutex::new(c),
        })
    }

    pub(crate) fn connection(&self) -> Result<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| Error::new("storage", "Database lock poisoned"))
    }

    pub fn existing(&self, key: &str, digest: &str) -> Result<Option<Job>> {
        existing(&*self.connection()?, key, digest)
    }

    pub fn lookup(&self, key: &str) -> Result<Option<Job>> {
        let connection = self.connection()?;
        let id: Option<String> = connection
            .query_row("SELECT id FROM jobs WHERE submission_key=?", [key], |row| {
                row.get(0)
            })
            .optional()?;
        id.map(|id| get(&connection, &id)).transpose()
    }

    pub fn submit(&self, submission: Submission, engine_digest: &str) -> Result<(Job, bool)> {
        let request_digest = submission.digest()?;
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        if let Some(job) = existing(&tx, &submission.key, &request_digest)? {
            return Ok((job, true));
        }
        if tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM cancelled_submissions WHERE submission_key=?)",
            [&submission.key],
            |row| row.get::<_, bool>(0),
        )? {
            return Err(Error::new(
                "cancelled",
                "This submission key was cancelled; use a new key for new work",
            ));
        }
        let time = now();
        let mut job = Job {
            sequence: 0,
            id: format!("JOB-{}", Uuid::new_v4()),
            state: JobState::Queued,
            submission,
            request_digest,
            engine_digest: engine_digest.into(),
            attempt_id: None,
            created_at: time,
            updated_at: time,
            cancel_requested: false,
            result: None,
            error: None,
        };
        tx.execute("INSERT INTO jobs (id,submission_key,request_digest,state,created_at,updated_at,cancel_requested,payload)
            VALUES (?1,?2,?3,'queued',?4,?4,0,'{}')",
            params![job.id, job.submission.key, job.request_digest, time])?;
        job.sequence = tx.last_insert_rowid();
        save(&tx, &job)?;
        crate::plans::initialize(&tx, &job)?;
        event(
            &tx,
            &job.id,
            "queued",
            &json!({"request_digest": job.request_digest, "engine_digest": engine_digest}),
        )?;
        tx.commit()?;
        Ok((job, false))
    }

    pub fn get(&self, id: &str) -> Result<Job> {
        get(&*self.connection()?, id)
    }

    pub fn list(&self, after: i64, limit: usize) -> Result<Vec<JobSummary>> {
        page(after, limit)?;
        let c = self.connection()?;
        let mut statement = c.prepare("SELECT seq,id,submission_key,state,created_at,updated_at,cancel_requested FROM jobs WHERE seq>?1 ORDER BY seq LIMIT ?2")?;
        let rows = statement.query_map(params![after, limit as i64], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, bool>(6)?,
            ))
        })?;
        rows.map(|r| {
            let (sequence, id, key, state, created_at, updated_at, cancel_requested) = r?;
            Ok(JobSummary {
                sequence,
                id,
                key,
                state: serde_json::from_value(json!(state))?,
                created_at,
                updated_at,
                cancel_requested,
            })
        })
        .collect()
    }

    pub fn claim(&self) -> Result<Option<Job>> {
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        let id: Option<String> = tx
            .query_row(
                "SELECT j.id FROM jobs j LEFT JOIN execution_plans p ON p.job_id=j.id WHERE j.state='queued' AND NOT EXISTS(SELECT 1 FROM pending_adoptions a WHERE a.job_id=j.id) AND (COALESCE(p.held,0)=0 OR j.cancel_requested=1 OR json_extract(j.payload,'$.attempt_id') IS NOT NULL) ORDER BY j.seq LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        let Some(id) = id else {
            return Ok(None);
        };
        let mut job = get(&tx, &id)?;
        job.state = JobState::Running;
        job.attempt_id = Some(format!("ATT-{}", Uuid::new_v4()));
        job.updated_at = now();
        save(&tx, &job)?;
        event(&tx, &id, "running", &json!({"attempt_id": job.attempt_id}))?;
        tx.commit()?;
        Ok(Some(job))
    }

    pub fn finish(
        &self,
        id: &str,
        state: JobState,
        result: Option<Value>,
        error: Option<Value>,
    ) -> Result<Job> {
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        let mut job = get(&tx, id)?;
        if job.state != JobState::Running {
            return Err(Error::new("state", "Only a running attempt can finish"));
        }
        job.state = state;
        job.result = result;
        job.error = error;
        job.updated_at = now();
        save(&tx, &job)?;
        event(
            &tx,
            id,
            "finished",
            &json!({"state":state,"attempt_id":job.attempt_id,"error":job.error}),
        )?;
        if state.settled() && state != JobState::Uncertain {
            tx.execute(
                "UPDATE execution_plans SET phase='closed' WHERE job_id=?",
                [id],
            )?;
        }
        if state == JobState::Completed {
            tx.execute(
                "UPDATE continuations SET state='ready' WHERE parent_id=? AND state='waiting'",
                [id],
            )?;
        } else if matches!(
            state,
            JobState::Failed | JobState::Cancelled | JobState::Blocked
        ) {
            tx.execute(
                "UPDATE continuations SET state='skipped' WHERE parent_id=? AND state='waiting'",
                [id],
            )?;
        }
        tx.commit()?;
        Ok(job)
    }

    pub fn cancel(&self, id: &str, resumable: bool) -> Result<Job> {
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        let job = cancel(&tx, id, resumable)?;
        tx.commit()?;
        Ok(job)
    }

    /// Serialize cancellation with submission commit, even during asynchronous preflight.
    pub fn cancel_submission(
        &self,
        key: &str,
        resumable: impl Fn(&Job) -> bool,
    ) -> Result<Option<Job>> {
        if key.trim().is_empty() || key.len() > 256 {
            return Err(Error::new(
                "request",
                "key must contain 1–256 bytes of nonempty text",
            ));
        }
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        tx.execute(
            "INSERT OR IGNORE INTO cancelled_submissions VALUES (?,?)",
            params![key, now()],
        )?;
        let id: Option<String> = tx
            .query_row("SELECT id FROM jobs WHERE submission_key=?", [key], |row| {
                row.get(0)
            })
            .optional()?;
        let job = id
            .map(|id| {
                let job = get(&tx, &id)?;
                let mut effective = job.clone();
                effective.submission.workflow = crate::plans::snapshot(&tx, &job)?.workflow;
                cancel(&tx, &id, resumable(&effective))
            })
            .transpose()?;
        tx.commit()?;
        Ok(job)
    }

    /// Only the exclusive service owner calls this, before starting a worker.
    pub fn recover(&self, resumable: impl Fn(&Job) -> bool) -> Result<usize> {
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        let ids = tx
            .prepare("SELECT id FROM jobs WHERE state='running'")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for id in &ids {
            let mut job = get(&tx, id)?;
            let mut effective = job.clone();
            effective.submission.workflow = crate::plans::snapshot(&tx, &job)?.workflow;
            let resume = resumable(&effective);
            job.state = if resume {
                JobState::Queued
            } else {
                JobState::Uncertain
            };
            job.updated_at = now();
            job.error = if resume {
                None
            } else {
                Some(
                    json!({"code":"service_interrupted","message":"Service stopped before recording an outcome. Inspect existing effects before follow-up work."}),
                )
            };
            save(&tx, &job)?;
            event(
                &tx,
                id,
                if resume { "recovered" } else { "interrupted" },
                &json!({"attempt_id":job.attempt_id,"error":job.error}),
            )?;
        }
        tx.commit()?;
        Ok(ids.len())
    }

    pub fn checkpoint(&self, id: &str) -> Result<Value> {
        let source: Option<String> = self
            .connection()?
            .query_row("SELECT data FROM checkpoints WHERE job_id=?", [id], |row| {
                row.get(0)
            })
            .optional()?;
        Ok(source
            .map(|value| serde_json::from_str(&value))
            .transpose()?
            .unwrap_or(json!({})))
    }

    pub fn save_checkpoint(&self, id: &str, value: &Value) -> Result<()> {
        let source = serde_json::to_string(value)?;
        if source.len() > MAX_RESPONSE_BYTES / 2 {
            return Err(Error::new("checkpoint_limit", "Checkpoint exceeds 8 MiB"));
        }
        self.connection()?.execute("INSERT INTO checkpoints VALUES (?,?) ON CONFLICT(job_id) DO UPDATE SET data=excluded.data", params![id, source])?;
        Ok(())
    }

    pub fn resume(&self, id: &str) -> Result<Job> {
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        let mut job = get(&tx, id)?;
        if job.state != JobState::Uncertain {
            return Err(Error::new(
                "state",
                "Only an uncertain native workflow can be reconciled",
            ));
        }
        job.state = JobState::Queued;
        job.error = None;
        job.updated_at = now();
        save(&tx, &job)?;
        event(&tx, id, "reconcile_requested", &json!({}))?;
        tx.commit()?;
        Ok(job)
    }

    pub fn record_attempt_event(
        &self,
        id: &str,
        data: &Value,
        service_cancelled: bool,
    ) -> Result<()> {
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        event(&tx, id, "ir", data)?;
        let suspended = service_cancelled
            && data["failure"]["code"] == "cancelled"
            && !get(&tx, id)?.cancel_requested;
        if !suspended
            && (data["event"] == "failed"
                || data["event"] == "chat_step" && data["status"] == "failed")
        {
            let uncertain = matches!(
                data["failure"]["code"].as_str(),
                Some("effect_uncertain" | "binding_panic")
            );
            if let Some(invocation) = data["invocation"]
                .as_str()
                .or_else(|| data["failure"]["invocation_id"].as_str())
            {
                tx.execute(
                    "UPDATE operation_runs SET state=? WHERE job_id=? AND invocation=?",
                    params![
                        if uncertain { "uncertain" } else { "failed" },
                        id,
                        invocation
                    ],
                )?;
            }
            if !uncertain {
                tx.execute(
                    "UPDATE execution_plans SET phase='finalizing' WHERE job_id=?",
                    [id],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn events(&self, id: &str, after: i64, limit: usize) -> Result<Events> {
        page(after, limit)?;
        let c = self.connection()?;
        let job = get(&c, id)?;
        let mut statement = c.prepare("SELECT seq,recorded_at,kind,data FROM events WHERE job_id=?1 AND seq>?2 ORDER BY seq LIMIT ?3")?;
        let rows = statement.query_map(params![id, after, (limit + 1) as i64], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?;
        let mut events = Vec::new();
        // Bound pages by bytes as well as rows so large diagnostics remain readable.
        let mut bytes = 0;
        let mut has_more = false;
        for row in rows {
            let (sequence, recorded_at, kind, data) = row?;
            if events.len() == limit
                || (!events.is_empty() && bytes + data.len() > MAX_RESPONSE_BYTES / 2)
            {
                has_more = true;
                break;
            }
            bytes += data.len();
            events.push(Event {
                sequence,
                job_id: id.into(),
                recorded_at,
                kind,
                data: serde_json::from_str(&data)?,
            });
        }
        Ok(Events {
            next_after: events.last().map_or(after, |e| e.sequence),
            events,
            state: job.state,
            has_more,
        })
    }
}

fn cancel(c: &Connection, id: &str, resumable: bool) -> Result<Job> {
    let mut job = get(c, id)?;
    if (matches!(job.state, JobState::Queued | JobState::Running)
        || resumable && job.state == JobState::Uncertain)
        && !job.cancel_requested
    {
        job.cancel_requested = true;
        job.updated_at = now();
        if job.state == JobState::Uncertain {
            job.state = JobState::Queued;
        } else if job.state == JobState::Queued && !(resumable && job.attempt_id.is_some()) {
            job.state = JobState::Cancelled;
        }
        save(c, &job)?;
        if job.state == JobState::Cancelled {
            c.execute(
                "UPDATE continuations SET state='skipped' WHERE parent_id=? AND state='waiting'",
                [id],
            )?;
            c.execute(
                "UPDATE execution_plans SET phase='closed' WHERE job_id=?",
                [id],
            )?;
        }
        event(c, id, "cancel_requested", &json!({"state":job.state}))?;
    }
    Ok(job)
}

fn page(after: i64, limit: usize) -> Result<()> {
    if after < 0 || !(1..=500).contains(&limit) {
        return Err(Error::new(
            "request",
            "after must be nonnegative; limit must be 1–500",
        ));
    }
    Ok(())
}

fn existing(c: &Connection, key: &str, digest: &str) -> Result<Option<Job>> {
    let payload: Option<String> = c
        .query_row(
            "SELECT payload FROM jobs WHERE submission_key=?1",
            [key],
            |r| r.get(0),
        )
        .optional()?;
    payload
        .map(|p| {
            let job: Job = serde_json::from_str(&p)?;
            if job.request_digest != digest {
                return Err(Error::new(
                    "conflict",
                    "Submission key already identifies different content",
                ));
            }
            Ok(job)
        })
        .transpose()
}

pub(crate) fn get(c: &Connection, id: &str) -> Result<Job> {
    let payload: Option<String> = c
        .query_row("SELECT payload FROM jobs WHERE id=?1", [id], |r| r.get(0))
        .optional()?;
    serde_json::from_str(
        &payload.ok_or_else(|| Error::new("not_found", format!("Unknown job {id}")))?,
    )
    .map_err(Into::into)
}

pub(crate) fn save(c: &Connection, job: &Job) -> Result<()> {
    let state = serde_json::to_value(job.state)?;
    c.execute(
        "UPDATE jobs SET state=?1,updated_at=?2,cancel_requested=?3,payload=?4 WHERE id=?5",
        params![
            state.as_str(),
            job.updated_at,
            job.cancel_requested,
            serde_json::to_string(job)?,
            job.id
        ],
    )?;
    Ok(())
}

pub(crate) fn event(c: &Connection, id: &str, kind: &str, data: &Value) -> Result<()> {
    c.execute(
        "INSERT INTO events (job_id,recorded_at,kind,data) VALUES (?1,?2,?3,?4)",
        params![id, now(), kind, serde_json::to_string(data)?],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_one_jobs_survive_the_checkpoint_migration() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("jobs.db");
        let original = Store::open(&path).unwrap();
        let submission = Submission {
            key: "existing".into(),
            workflow: json!({}),
            inputs: json!({}),
            metadata: json!({}),
        };
        let (job, _) = original.submit(submission, "old-engine").unwrap();
        drop(original);
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "DROP TABLE checkpoints; DROP TABLE cancelled_submissions; PRAGMA user_version=1;",
            )
            .unwrap();
        drop(connection);
        let upgraded = Store::open(&path).unwrap();
        assert_eq!(upgraded.lookup("existing").unwrap().unwrap().id, job.id);
        assert_eq!(upgraded.get(&job.id).unwrap().engine_digest, "old-engine");
        upgraded
            .save_checkpoint(&job.id, &json!({"steps":{}}))
            .unwrap();
        assert_eq!(upgraded.checkpoint(&job.id).unwrap(), json!({"steps":{}}));
        assert!(upgraded.lookup("missing").unwrap().is_none());
    }

    #[test]
    fn recovered_native_cancellation_runs_cleanup_instead_of_discarding_the_job() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("jobs.db")).unwrap();
        let submission = Submission {
            key: "native".into(),
            workflow: json!({"format":"aixand.chat-workflow"}),
            inputs: json!({}),
            metadata: json!({}),
        };
        let (job, _) = store.submit(submission, "engine").unwrap();
        store.claim().unwrap();
        store
            .save_checkpoint(&job.id, &json!({"steps":{"audit":{"state":"running"}}}))
            .unwrap();
        store.recover(|_| true).unwrap();
        assert_eq!(store.cancel(&job.id, true).unwrap().state, JobState::Queued);
        assert!(store.claim().unwrap().unwrap().cancel_requested);
        assert_eq!(
            store.checkpoint(&job.id).unwrap()["steps"]["audit"]["state"],
            "running"
        );
    }
}
