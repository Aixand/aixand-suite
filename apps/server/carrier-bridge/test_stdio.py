"""Exercise the real bridge process, including startup, pipes and lock ownership."""
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import unittest


class BridgeStdioTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="carrier-stdio-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        config = self.root / "agents.json"
        config.write_text('{"providers": {}}', encoding="utf-8")
        self.environment = {**os.environ, "CARRIER_STATE_DIR": str(self.root / "state"),
            "CARRIER_STATE_DATABASE": str(self.root / "state/suite.db"),
            "CARRIER_URL": "http://127.0.0.1:1", "CARRIER_AUTO_PROVISION": "0",
            "CARRIER_USER_ADDRESS": "suite/local/你好", "CARRIER_AGENT_CONFIG": str(config),
            "CARRIER_USER_CREDENTIALS": str(self.root / "missing.json"),
            "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "PYTHONDONTWRITEBYTECODE": "1"}
        for key in ("CARRIER_INSTANCE_ID", "CARRIER_MAILBOXES_FILE"):
            self.environment.pop(key, None)

    def start(self):
        process = subprocess.Popen([sys.executable, "-B", "-u", str(Path(__file__).with_name("main.py"))],
            env=self.environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(self.stop, process)
        events = queue.Queue()

        def read():
            for line in process.stdout:
                events.put(json.loads(line))
            events.put({"type": "eof"})

        thread = threading.Thread(target=read, daemon=True)
        thread.start()
        return process, events

    @staticmethod
    def stop(process):
        if process.poll() is None:
            process.kill()
        process.wait(timeout=10)
        for stream in (process.stdin, process.stdout, process.stderr):
            stream.close()

    def receive(self, events, kind):
        while True:
            value = events.get(timeout=10)
            if value["type"] == kind:
                return value
            self.assertNotIn(value["type"], ("fatal", "eof"), value)

    def test_unicode_requests_exclusive_owner_and_clean_eof(self):
        first, events = self.start()
        self.receive(events, "ready")
        for identifier, operation in (("请求", "mailboxes"), ("snapshot", "snapshot")):
            first.stdin.write((json.dumps({"id": identifier, "op": operation, "args": {}}, ensure_ascii=False) + "\n").encode())
        first.stdin.flush()
        replies = {value["id"]: value["result"] for value in
                   (self.receive(events, "result"), self.receive(events, "result"))}
        self.assertEqual(replies["请求"][0]["address"], "suite/local/你好")
        self.assertEqual(replies["snapshot"]["messages"], [])
        second, blocked = self.start()
        self.receive(blocked, "fatal")
        self.assertEqual(second.wait(timeout=10), 1)
        first.stdin.close()
        self.assertEqual(first.wait(timeout=10), 0)
        self.assertEqual(first.stderr.read(), b"")
        restarted, ready = self.start()
        self.receive(ready, "ready")
        restarted.stdin.close()
        self.assertEqual(restarted.wait(timeout=10), 0)

    def test_oversized_and_unterminated_requests_fail_and_release_the_lock(self):
        for payload in (b"x" * (1024 * 1024 + 1), b'{"id":"truncated"}'):
            with self.subTest(size=len(payload)):
                process, events = self.start()
                self.receive(events, "ready")
                process.stdin.write(payload)
                process.stdin.close()
                self.assertEqual(self.receive(events, "fatal")["code"], "protocol")
                self.assertEqual(process.wait(timeout=10), 1)
                self.assertEqual(process.stderr.read(), b"")


if __name__ == "__main__":
    unittest.main()
