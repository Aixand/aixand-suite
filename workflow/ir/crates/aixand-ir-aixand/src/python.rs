//! A Python asyncio loop owned by Rust. All SDK calls run on that loop.
//! No workflow text, operation ID, or catalog field is evaluated as Python code.
use aixand_ir_runner::Failure;
use pyo3::{prelude::*, types::PyDict};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

pub(crate) fn failure(error: PyErr) -> Failure {
    Python::attach(|py| {
        let value = error.value(py);
        let mut details = serde_json::Map::new();
        for name in [
            "code",
            "run_id",
            "session_id",
            "effect_certainty",
            "delivery_id",
            "address",
            "status_code",
        ] {
            if let Ok(attr) = value.getattr(name) {
                if let Ok(text) = attr.extract::<String>() {
                    details.insert(name.into(), text.into());
                } else if let Ok(number) = attr.extract::<i64>() {
                    details.insert(name.into(), number.into());
                }
            }
        }
        if let Ok(agent) = value.getattr("agent") {
            for name in ["run_id", "session_id"] {
                if let Ok(text) = agent.getattr(name).and_then(|v| v.extract::<String>()) {
                    details.insert(name.into(), text.into());
                }
            }
            details.insert(
                "effect_certainty".into(),
                "agent_launched_setup_failed".into(),
            );
        }
        if let Ok(cause) = value.getattr("cause") {
            details.insert("cause".into(), cause.to_string().into());
            if let Ok(text) = cause
                .getattr("effect_certainty")
                .and_then(|v| v.extract::<String>())
            {
                details.insert("effect_certainty".into(), text.into());
            }
        }
        let name = value
            .get_type()
            .name()
            .map(|s| s.to_string())
            .unwrap_or_else(|_| "SdkError".into());
        if matches!(
            name.as_str(),
            "TransportError" | "ProtocolError" | "DeliveryUncertain" | "AcceptanceTimeout"
        ) {
            details
                .entry("effect_certainty".to_string())
                .or_insert("unknown".into());
        }
        Failure::new(&name, error.to_string()).with_details(details.into())
    })
}

type Completion = oneshot::Sender<Result<Py<PyAny>, Failure>>;
struct Pending {
    cancelled: bool,
    task: Option<Py<PyAny>>,
}

#[pyclass]
struct Done {
    sender: Mutex<Option<Completion>>,
}
#[pymethods]
impl Done {
    fn __call__(&self, task: &Bound<'_, PyAny>) {
        if let Some(sender) = self.sender.lock().expect("completion lock").take() {
            let result = task
                .call_method0("result")
                .map(Bound::unbind)
                .map_err(failure);
            let _ = sender.send(result);
        }
    }
}

#[pyclass]
struct Call {
    callable: Py<PyAny>,
    kwargs: Py<PyDict>,
    connection: Option<Py<PyAny>>,
    state: Arc<Mutex<Pending>>,
    sender: Mutex<Option<Completion>>,
}
#[pymethods]
impl Call {
    fn __call__(&self, py: Python<'_>) {
        let sender = self.sender.lock().expect("sender lock").take();
        let Some(sender) = sender else {
            return;
        };
        if self.state.lock().expect("pending lock").cancelled {
            let _ = sender.send(Err(Failure::new(
                "cancelled",
                "SDK call cancelled before dispatch",
            )));
            return;
        }
        let result: PyResult<Bound<'_, PyAny>> = (|| {
            let coroutine = self
                .callable
                .bind(py)
                .call((), Some(self.kwargs.bind(py)))?;
            let awaitable = if let Some(connection) = &self.connection {
                connection
                    .bind(py)
                    .call_method1("wait_for", (&coroutine,))?
            } else {
                coroutine
            };
            let task = py
                .import("asyncio")?
                .call_method1("ensure_future", (awaitable,))?;
            Ok(task)
        })();
        match result {
            Ok(task) => {
                let mut state = self.state.lock().expect("pending lock");
                state.task = Some(task.clone().unbind());
                if state.cancelled {
                    let _ = task.call_method0("cancel");
                }
                drop(state);
                match Py::new(
                    py,
                    Done {
                        sender: Mutex::new(Some(sender)),
                    },
                ) {
                    Ok(done) => {
                        if let Err(e) = task.call_method1("add_done_callback", (done,)) {
                            let _ = task.call_method0("cancel");
                            e.write_unraisable(py, None);
                        }
                    }
                    Err(e) => {
                        let _ = task.call_method0("cancel");
                        e.write_unraisable(py, None);
                    }
                }
            }
            Err(error) => {
                let _ = sender.send(Err(failure(error)));
            }
        }
    }
}

pub(crate) struct PythonLoop {
    loop_: Py<PyAny>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl PythonLoop {
    pub fn start() -> Result<Self, Failure> {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let thread = std::thread::Builder::new()
            .name("aixand-ir-sdk".into())
            .spawn(move || {
                Python::attach(|py| {
                    let result: PyResult<_> = (|| {
                        let asyncio = py.import("asyncio")?;
                        let loop_ = asyncio.call_method0("new_event_loop")?;
                        asyncio.call_method1("set_event_loop", (&loop_,))?;
                        Ok(loop_)
                    })();
                    match result {
                        Ok(loop_) => {
                            if sender.send(Ok(loop_.clone().unbind())).is_err() {
                                let _ = loop_.call_method0("close");
                                return;
                            }
                            if let Err(error) = loop_.call_method0("run_forever") {
                                error.write_unraisable(py, None);
                            }
                            let _ = loop_.call_method0("close");
                        }
                        Err(error) => {
                            let _ = sender.send(Err(failure(error)));
                        }
                    }
                });
            })
            .map_err(|e| Failure::new("sdk_loop", e.to_string()))?;
        let loop_ = receiver
            .recv()
            .map_err(|e| Failure::new("sdk_loop", e.to_string()))??;
        Ok(Self {
            loop_,
            thread: Mutex::new(Some(thread)),
        })
    }

    pub async fn call(
        &self,
        callable: Py<PyAny>,
        kwargs: Py<PyDict>,
        connection: Option<Py<PyAny>>,
    ) -> Result<Py<PyAny>, Failure> {
        let (sender, receiver) = oneshot::channel();
        let state = Arc::new(Mutex::new(Pending {
            cancelled: false,
            task: None,
        }));
        struct Cancel<'a> {
            loop_: &'a Py<PyAny>,
            state: Arc<Mutex<Pending>>,
        }
        impl Drop for Cancel<'_> {
            fn drop(&mut self) {
                Python::attach(|py| {
                    let mut state = self.state.lock().expect("pending lock");
                    state.cancelled = true;
                    if let Some(task) = &state.task
                        && let Ok(cancel) = task.bind(py).getattr("cancel")
                    {
                        let _ = self
                            .loop_
                            .bind(py)
                            .call_method1("call_soon_threadsafe", (cancel,));
                    }
                });
            }
        }
        let _cancel = Cancel {
            loop_: &self.loop_,
            state: state.clone(),
        };
        Python::attach(|py| -> PyResult<()> {
            let call = Py::new(
                py,
                Call {
                    callable,
                    kwargs,
                    connection,
                    state,
                    sender: Mutex::new(Some(sender)),
                },
            )?;
            self.loop_
                .bind(py)
                .call_method1("call_soon_threadsafe", (call,))?;
            Ok(())
        })
        .map_err(failure)?;
        receiver
            .await
            .map_err(|e| Failure::new("sdk_loop", e.to_string()))?
    }

    pub async fn stop(&self) -> Result<(), Failure> {
        // Shutdown generators before closing the loop. The SDK has joined its workers.
        let (callable, kwargs) = Python::attach(|py| -> PyResult<_> {
            Ok((
                self.loop_.bind(py).getattr("shutdown_asyncgens")?.unbind(),
                PyDict::new(py).unbind(),
            ))
        })
        .map_err(failure)?;
        let result = self.call(callable, kwargs, None).await;
        Python::attach(|py| -> PyResult<()> {
            self.loop_.bind(py).call_method1(
                "call_soon_threadsafe",
                (self.loop_.bind(py).getattr("stop")?,),
            )?;
            Ok(())
        })
        .map_err(failure)?;
        let thread = self.thread.lock().expect("thread lock").take();
        if let Some(thread) = thread {
            tokio::task::spawn_blocking(move || thread.join())
                .await
                .map_err(|e| Failure::new("sdk_loop", e.to_string()))?
                .map_err(|_| Failure::new("sdk_loop", "SDK thread panicked"))?;
        }
        result.map(|_| ())
    }
}

impl Drop for PythonLoop {
    fn drop(&mut self) {
        if self.thread.lock().expect("thread lock").is_some() {
            Python::attach(|py| {
                if let Ok(stop) = self.loop_.bind(py).getattr("stop") {
                    let _ = self
                        .loop_
                        .bind(py)
                        .call_method1("call_soon_threadsafe", (stop,));
                }
            });
        }
    }
}
