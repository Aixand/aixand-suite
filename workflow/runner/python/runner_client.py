"""Local Runner protocol client. No agent, IR, or HTTP dependencies."""
import json
import os
from pathlib import Path
from aixand_local_runtime import connect_local
import time


class RunnerError(RuntimeError):
    def __init__(self, error):
        self.code = error["code"]
        self.details = error.get("details")
        super().__init__(f"{self.code}: {error['message']}")


class Client:
    def __init__(self, home=None, *, timeout=30):
        if home is None:
            home = os.environ.get("RUNNER_HOME")
        if home is None:
            if os.name == "nt" and "XDG_STATE_HOME" not in os.environ:
                home = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local")) / "Aixand/Runner"
            else:
                home = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / "runner"
        self.socket_path = str(Path(home) / "runner.sock")
        self.timeout = timeout

    def request(self, op, **fields):
        payload = json.dumps(dict(op=op, **fields), allow_nan=False).encode() + b"\n"
        if len(payload) > 4 * 1024 * 1024:
            raise ValueError("Request exceeds 4 MiB")
        with connect_local(self.socket_path, timeout=self.timeout) as connection:
            connection.sendall(payload)
            with connection.makefile("rb") as reader:
                raw = reader.readline(16 * 1024 * 1024 + 1)
        if len(raw) > 16 * 1024 * 1024 or not raw.endswith(b"\n"):
            raise ValueError("Invalid or oversized Runner response")
        response = json.loads(raw)
        if not response["ok"]:
            raise RunnerError(response["error"])
        return response["data"]

    def health(self):
        return self.request("health")

    def submit(self, workflow, inputs=None, *, key, metadata=None):
        """Reuse key after a timeout: the original submission may have committed."""
        return self.request("submit", submission=dict(
            key=key, workflow=workflow,
            inputs={} if inputs is None else inputs,
            metadata={} if metadata is None else metadata,
        ))

    def list(self, *, after=0, limit=100):
        return self.request("list", after=after, limit=limit)["jobs"]

    def inspect(self, job_id):
        return self.request("inspect", id=job_id)

    def lookup(self, key):
        return self.request("lookup", key=key)

    def result(self, job_id):
        return self.request("result", id=job_id)

    def cancel(self, job_id):
        return self.request("cancel", id=job_id)

    def cancel_key(self, key):
        """Cancel accepted work or prevent a pending submission from being accepted."""
        return self.request("cancel_key", key=key)

    def resume(self, job_id):
        """Reconcile an uncertain native workflow using its existing effect identities."""
        return self.request("resume", id=job_id)

    def events(self, job_id, *, after=0, limit=100):
        return self.request("events", id=job_id, after=after, limit=limit)

    def plan(self, job_id):
        return self.request("plan", id=job_id)

    def amend(self, job_id, workflow, *, key, expected_revision, authoring=None):
        return self.request("amend", id=job_id, key=key, expected_revision=expected_revision,
                            workflow=workflow, authoring=authoring)

    def hold(self, job_id):
        return self.request("hold", id=job_id)

    def enable_edits(self, job_id, *, key, authoring=None, groups=None, identities=None):
        return self.request("enable_edits", id=job_id, key=key, authoring=authoring,
                            groups={} if groups is None else groups, identities={} if identities is None else identities)

    def release(self, job_id):
        return self.request("release", id=job_id)

    def continue_with(self, job_id, target, *, key, input_map=None):
        return self.request("continue", id=job_id, key=key, target=target,
                            input_map={} if input_map is None else input_map)

    def continuations(self, job_id):
        return self.request("continuations", id=job_id)["continuations"]

    def cancel_continuation(self, continuation_id):
        return self.request("cancel_continuation", id=continuation_id)

    def follow(self, job_id, *, after=0, poll_interval=0.25):
        """Yield retained events until the job settles, including uncertainty."""
        while True:
            page = self.events(job_id, after=after)
            yield from page["events"]
            after = page["next_after"]
            if page["has_more"]:
                continue
            if page["state"] not in {"queued", "running"}:
                return
            time.sleep(poll_interval)
