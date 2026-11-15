"""Independent SDK framing and error behavior without source import paths."""

import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from runner_client import Client, RunnerError


class Connection:
    def __init__(self, reply):
        self.reply, self.sent = reply, b""

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def sendall(self, value):
        self.sent += value

    def makefile(self, *_):
        return io.BytesIO(self.reply)


class ClientTests(unittest.TestCase):
    def test_explicit_home_and_submission_key_reach_the_protocol(self):
        wire = Connection(
            b'{"ok":true,"data":{"job":{"id":"saved"},"replayed":true}}\n'
        )
        with patch("runner_client.connect_local", return_value=wire) as connect:
            result = Client(Path("/explicit/state"), timeout=2).submit(
                {"name": "pure"}, {}, key="accepted", metadata={"application": "test"}
            )
        self.assertEqual(result["job"]["id"], "saved")
        self.assertEqual(json.loads(wire.sent)["submission"]["key"], "accepted")
        connect.assert_called_once_with(
            str(Path("/explicit/state/runner.sock")), timeout=2
        )

    def test_protocol_error_preserves_code_and_details(self):
        wire = Connection(
            b'{"ok":false,"error":{"code":"conflict","message":"changed","details":{"revision":2}}}\n'
        )
        with patch("runner_client.connect_local", return_value=wire):
            with self.assertRaises(RunnerError) as caught:
                Client("/explicit/state").health()
        self.assertEqual(caught.exception.code, "conflict")
        self.assertEqual(caught.exception.details, {"revision": 2})

    def test_truncated_response_is_rejected(self):
        with patch(
            "runner_client.connect_local", return_value=Connection(b'{"ok":true}')
        ):
            with self.assertRaisesRegex(ValueError, "Invalid or oversized"):
                Client("/explicit/state").health()

    def test_oversized_request_is_rejected_before_connect(self):
        with patch("runner_client.connect_local") as connect:
            with self.assertRaisesRegex(ValueError, "4 MiB"):
                Client("/explicit/state").submit(
                    {}, {"body": "x" * (4 * 1024 * 1024)}, key="large"
                )
        connect.assert_not_called()
