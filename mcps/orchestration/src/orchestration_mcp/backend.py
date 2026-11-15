"""Public manager/runtime tools with injected application project operations."""

import asyncio
import os
from pathlib import Path
import uuid

from . import catalog
from .errors import OrchestrationError
from .optional import MODULES, available, require

from . import execution_tools
from .tool_groups.projects import PROJECTS, PROJECT_NAMES


def home_path(value=None):
    return (
        Path(
            value
            or os.environ.get("ORCHESTRATION_HOME")
            or Path(os.environ.get("XDG_STATE_HOME", "~/.local/state")).expanduser()
            / "aixand/orchestration"
        )
        .expanduser()
        .resolve()
    )


class LocalBackend:
    def __init__(
        self,
        *,
        home=None,
        config=None,
        manager_home=None,
        runtime_home=None,
        runner_home=None,
        provider="codex",
        profile="default",
        groups=None,
        output=None,
        context_id=None,
    ):
        self.home = home_path(home)
        self.config, self.manager_home, self.runtime_home = (
            config,
            manager_home,
            runtime_home,
        )
        self.runner_home = runner_home
        self.workflow_adapter = None
        self.workflow_socket = None
        self.provider, self.profile = provider, profile
        self.groups = set(
            groups
            if groups is not None
            else (
                "shared",
                "agents",
                "conversations",
                "terminals",
                "queues",
                "tasks",
                "resources",
            )
        )
        if not self.groups <= {
            "shared",
            "agents",
            "conversations",
            "terminals",
            "resources",
            "workflows",
            "tasks",
            "queues",
            "observations",
            "projects",
        }:
            raise OrchestrationError("validation", "Unknown orchestration tool group")
        self.output = output or (lambda _: None)
        self.instance = context_id or uuid.uuid4().hex
        self.lock = asyncio.Lock()
        self.owner = None
        self.executions = None
        self.project_operations = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        await self.close()

    def capabilities(self):
        integrations = {
            key: {"installed": available(key), "distribution": value[1]}
            for key, value in MODULES.items()
        }
        return {
            "schema": "orchestration-mcp/capabilities-1",
            "application": "orchestration",
            "suite": False,
            "projects": self.project_operations is not None,
            "agents": integrations["agents"]["installed"]
            and integrations["schema"]["installed"],
            "execution_workflows": integrations["runner"]["installed"]
            and integrations["conversations"]["installed"]
            and integrations["carrier"]["installed"]
            and bool(os.environ.get("CARRIER_DATABASE") or self.executions and self.executions.report_transport),
            "task_reports": integrations["carrier"]["installed"]
            and bool(os.environ.get("CARRIER_DATABASE") or self.executions and self.executions.report_transport),
            "conversations": integrations["conversations"]["installed"],
            "terminals": integrations["agents"]["installed"]
            and integrations["runtime"]["installed"],
            "enabled_groups": sorted(self.groups),
            "integrations": integrations,
        }

    def tools(self):
        caps = self.capabilities()
        result = []
        if "agents" in self.groups and caps["agents"]:
            from agent_manager.interfaces.management_contract import LOGIN_TOOLS

            result.extend(
                tool
                for tool in catalog.load("aixand_agents")["tools"]
                if tool["name"] not in LOGIN_TOOLS or caps["terminals"]
            )
        if "resources" in self.groups:
            if any(available(kind) for kind in ("prompts", "skills", "mcps")):
                result.append(
                    {
                        "name": "resource_catalog",
                        "description": "List the available prompt, skill, and MCP libraries. Missing managers are reported independently.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {},
                            "additionalProperties": False,
                        },
                    }
                )
        for group, tools in execution_tools.GROUPS.items():
            if group not in self.groups:
                continue
            if group == "workflows" and (
                not caps["execution_workflows"] or "conversations" not in self.groups
            ):
                continue
            if (
                group == "conversations"
                and not caps["conversations"]
                or group == "terminals"
                and not caps["terminals"]
            ):
                continue
            if group == "queues" and ("conversations" not in self.groups or not caps["conversations"]):
                continue
            if group == "tasks":
                for tool in tools:
                    if tool["name"].startswith("delegate_"):
                        mode = "conversations" if tool["name"] == "delegate_conversation_task" else "terminals"
                        if mode not in self.groups or not caps[mode] or not caps["task_reports"]:
                            continue
                    result.append(tool)
                continue
            result.extend(
                tool
                for tool in tools
                if tool["name"] != "list_execution_agents"
                or caps["integrations"]["agents"]["installed"]
            )
        if "projects" in self.groups and self.project_operations is not None:
            result.extend(PROJECTS)
        return list({tool["name"]: tool for tool in result}.values())

    def execution_workflows(self):
        if self.workflow_adapter is None:
            from .workflows import Workflows

            self.workflow_adapter = Workflows(
                self.execution_services(), runner_home=self.runner_home
            )
        return self.workflow_adapter

    def execution_services(self):
        if self.executions is None:
            self._acquire()
            from .executions import ExecutionServices

            self.executions = ExecutionServices(
                self.home,
                config=self.config,
                manager_home=self.manager_home,
                runtime_home=self.runtime_home,
            )
        return self.executions

    def _acquire(self):
        if self.owner:
            return
        from aixand_filesystem import lock_file

        self.home.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = self.home / "owner.lock"
        self.owner = path.open("a+")
        path.chmod(0o600)
        try:
            lock_file(self.owner)
        except OSError:
            self.owner.close()
            self.owner = None
            raise OrchestrationError(
                "busy",
                "This workspace already has an orchestration host; connect to its socket instead of starting a second owner",
            ) from None

    async def prepare_host(self):
        self._acquire()
        if self.groups & {"tasks", "workflows"}:
            self.execution_services().task_services().start()
        if (
            "workflows" in self.groups
            and "conversations" in self.groups
            and self.capabilities()["execution_workflows"]
        ):
            adapter = self.execution_workflows()
            await adapter.start()
            self.workflow_socket = adapter.socket
        return {
            "home": str(self.home),
            "workflow_socket": str(self.workflow_socket) if self.workflow_socket else None,
        }

    async def execute(self, name, arguments, request_id):
        if (
            not isinstance(arguments, dict)
            or not isinstance(request_id, str)
            or not 1 <= len(request_id) <= 256
        ):
            raise OrchestrationError(
                "validation", "Provide tool arguments and a bounded request identity"
            )
        tool = next((tool for tool in self.tools() if tool["name"] == name), None)
        if tool is None:
            raise OrchestrationError(
                "unavailable",
                "This tool is unavailable in the selected groups or installed integrations",
            )
        if name in PROJECT_NAMES and "projects" in self.groups:
            execution_tools.validate(arguments, tool["inputSchema"])
            return await self.project_operations.execute(name, arguments)
        if name == "inspect_execution_operation" and self.project_operations is not None:
            execution_tools.validate(arguments, tool["inputSchema"])
            project_operation = self.project_operations.inspect(arguments["operation_id"])
            if project_operation is not None:
                return {"operation": project_operation}
        if name in execution_tools.NAMES:
            execution_tools.validate(arguments, tool["inputSchema"])
            if name == "start_conversation":
                if self.project_operations is not None:
                    arguments = self.project_operations.target(arguments)
                elif "project_id" in arguments or "cwd" not in arguments:
                    raise OrchestrationError(
                        "suite_required", "Project IDs require an authenticated Suite context; standalone launches require cwd"
                    )
            if name in execution_tools.WORKFLOW_NAMES:
                return await self.execution_workflows().execute(name, arguments)
            return await self.execution_services().execute(
                name, arguments, enabled_modes=self.groups
            )
        schema = tool["inputSchema"]
        if set(arguments) - set(schema.get("properties", {})) or set(
            schema.get("required", [])
        ) - set(arguments):
            raise OrchestrationError(
                "validation", "Tool arguments do not match its contract"
            )
        async with self.lock:
            if name == "resource_catalog":
                return self.resources()
            require("agents")
            from agent_manager.interfaces.management_mcp import LocalBackend as Profiles

            identity = str(uuid.uuid5(
                uuid.NAMESPACE_URL, str(self.home) + ":" + self.instance + ":" + request_id
            ))
            return await Profiles(config=self.config, home=self.manager_home).execute(
                name, arguments, identity
            )

    @staticmethod
    def resources():
        libraries = {}
        for kind in ("prompts", "skills", "mcps"):
            if not available(kind):
                libraries[kind] = {"available": False, "code": "integration_missing"}
                continue
            module = require(kind)
            manager = module.Manager()
            libraries[kind] = {"available": True, "managed": manager.managed_catalog()}
        return {"libraries": libraries}

    async def close(self):
        if self.workflow_adapter:
            await self.workflow_adapter.close()
        if self.executions:
            await self.executions.close()
        if self.owner:
            self.owner.close()
            self.owner = None
