"""A fixture agent invokes its scoped report tool; final text is never its result authority."""

import json

from conversation_manager.fixture_sdk import Driver as BaseDriver
from ..task_reports import ReportBackend


class Driver(BaseDriver):
    async def prompt(self, text, command=None):
        if text == "limit":
            return await super().prompt(text, command)
        descriptors = (self.settings.get("mcp") or {}).get("servers", [])
        descriptor = next(
            (
                value
                for value in descriptors
                if value.get("server_name") == "agent_manager_task_result"
            ),
            None,
        )
        if descriptor:
            if "\nTask: hold" in text:
                return await super().prompt("hold")
            if "\nTask: no-report" not in text:
                path = descriptor["args"][
                    descriptor["args"].index("--context-file") + 1
                ]
                backend = ReportBackend(path)
                await backend.execute(
                    "submit_task_result",
                    {
                        "outcome": "completed",
                        "report": "Carrier fixture report: " + text[-200:],
                        "operation_id": "fixture-report",
                    },
                    "fixture",
                )
            text = (
                json.dumps({"outcome": "completed", "report": "A final-text claim is not a Carrier result"})
                if "\nTask: no-report" in text
                else "The task finished. Its result belongs in Carrier, not this final response."
            )
        return await super().prompt(text, command)


class Services:
    def sdk_driver(
        self, protocol, settings, identity, directory, restore, callbacks, env
    ):
        driver = Driver(settings, identity, directory, restore, callbacks, env)
        driver.protocol = protocol
        return driver


def factory(options):
    return Services()
