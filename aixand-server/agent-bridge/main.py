"""Private JSONL adapter for managed agents and Suite workspace metadata."""
import asyncio
from dataclasses import asdict
import json
import os
from pathlib import Path
import sys

import agent_manager
import undercurrent
from agent_manager.core import locks, name as profile_name

MAX_LINE = 1024 * 1024


def sibling(identifier):
    import importlib.util
    spec = importlib.util.spec_from_file_location("suite_" + identifier, Path(__file__).with_name(identifier + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def observation(session):
    return {key: getattr(session, key) for key in
            ("lifecycle", "execution", "interaction", "constraint", "health")}


def available_profile_name(manager, value, current=None):
    profile_name(value)
    if value.casefold() == "default":
        raise agent_manager.Error("default is reserved for the native profile")
    if any(item != current and item.casefold() == value.casefold() for item in manager.state()["agents"]):
        raise agent_manager.Error("A profile with this name already exists for this provider")


def delete_profile(manager, profile):
    from agent_manager.management import delete_profile as remove
    return remove(manager, profile)


class Adapter:
    def __init__(self):
        self.runtime = undercurrent.Client()
        from agent_manager.provider_config import load
        self.clients, self.provider_errors = {}, {}
        for provider in load()[0]:
            try:
                self.clients[provider] = agent_manager.Client(provider, runtime=self.runtime,
                    labels={"app": "aixand-suite"}, app_server_group="aixand-suite-server")
            except agent_manager.Error as error:
                self.provider_errors[provider] = str(error)
        self.runtime_lock = asyncio.Lock()
        self.initialized = False
        self.budget_tasks = {}
        self.cwd = str(Path(os.environ.get("AGENTS_CWD") or os.environ.get("TERMINAL_CWD")
                            or Path.home()).expanduser().resolve())
        self.chats = None
        self.prompts = None
        self.mcps = None
        self.skills = None
        self.vox_tools = None
        self.operations = None
        self.operations_module = None
        self.session_library = None
        self.management = None
        self.discovery = None
        self.inventory_task = None
        self.active_requests = 0
        self.resetting = False

    def operation_store(self):
        if self.operations is None:
            import importlib.util
            spec = importlib.util.spec_from_file_location("aixand_agent_operations", Path(__file__).with_name("agent_operations.py"))
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            self.operations_module = module
            self.operations = module.AgentOperations(self, output=emit)
            for client in self.clients.values():
                module.refresh_provider_path(client.manager)
        return self.operations

    def management_store(self):
        if self.management is None:
            from agent_management import AgentManagement
            self.management = AgentManagement(self)
        return self.management

    async def connect_runtime(self):
        async with self.runtime_lock:
            try:
                await self.runtime.connect()
                if not self.initialized:
                    for client in self.clients.values():
                        await client.reconcile()
                    self.initialized = True
            except Exception:
                await self.runtime.close()
                self.runtime = undercurrent.Client()
                for client in self.clients.values():
                    client.runtime = self.runtime
                self.initialized = False
                raise
        return self.runtime

    async def catalog(self):
        snapshot = await self.provider_inventory()
        return {"profiles": [profile for row in snapshot['providers'] for profile in row['profiles']],
                "auths": [auth for row in snapshot['providers'] for auth in row['auths']],
                "capabilities": [row['capability'] for row in snapshot['providers'] if 'capability' in row],
                "cwd": self.cwd, "backends": sibling("backends").catalog(self)}

    async def provider_inventory(self):
        from agent_manager.provider_catalog import catalog
        from agent_manager.install import refresh_provider_path
        if self.inventory_task is None:
            self.inventory_task = asyncio.create_task(asyncio.to_thread(catalog))
        task = self.inventory_task
        try:
            snapshot = await asyncio.shield(task)
            for row in snapshot['providers']:
                provider = row['provider']
                if row.get('available') and provider not in self.clients:
                    self.clients[provider] = agent_manager.Client(provider, runtime=self.runtime,
                        labels={"app": "aixand-suite"}, app_server_group="aixand-suite-server")
                    self.provider_errors.pop(provider, None)
                if provider in self.clients:
                    refresh_provider_path(self.clients[provider].manager)
            return snapshot
        finally:
            if task.done() and self.inventory_task is task:
                self.inventory_task = None

    async def budgets(self, provider, auth):
        client = self.clients[provider]
        from agent_manager.budget import supported
        if not supported(client.manager):
            return {"supported": False, "rows": []}
        key = (provider, auth)
        if key not in self.budget_tasks:
            task = asyncio.create_task(client.budgets(auth))
            self.budget_tasks[key] = task
            task.add_done_callback(lambda _: self.budget_tasks.pop(key, None))
        return {"supported": True, "rows": await asyncio.shield(self.budget_tasks[key])}

    async def sessions(self, labels=None):
        runs = []
        for client in self.clients.values():
            runs.extend(row for row in await client.runs(**({"labels": labels} if labels is not None else {}))
                if row.get('labels', {}).get('purpose') != 'discovery')
        runtime_error = None
        snapshots = {}
        try:
            runtime = await self.connect_runtime()
            ids = [row["session_id"] for row in runs if row["session_id"]]
            if ids:
                snapshots = {session.id: observation(session) for session in await runtime.list(ids=ids)}
        except Exception:
            runtime_error = "Undercurrent is unavailable. Check its daemon, home and Python bridge, then refresh."
        return {"runs": [{**row, "observation": snapshots.get(row["session_id"])} for row in runs],
                "runtimeError": runtime_error}

    def chat_store(self):
        if self.chats is None:
            # Resolve the private sibling module independently of the caller's cwd.
            import importlib.util
            spec = importlib.util.spec_from_file_location("aixand_chats", Path(__file__).with_name("chats.py"))
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            self.chats = module.Chats(self, output=emit)
        return self.chats

    async def execute(self, op, args):
        if op in ('backend-discovery-get', 'backend-discovery-refresh'):
            if self.discovery is None:
                from orchestration_mcp.services.backend_discovery import Discovery
                self.discovery = Discovery(self, emit)
            return await self.discovery.execute(op, args)
        if self.resetting:
            raise agent_manager.Error('Workspace reset is in progress. Try again when it finishes.')
        if op == 'workspace-reset':
            if self.active_requests:
                raise agent_manager.Error('Workspace requests are still in progress. Wait for them to finish and retry the reset.')
            self.resetting = True
            try:
                return await self.chat_store().execute(op, args)
            finally:
                self.resetting = False
        self.active_requests += 1
        try:
            return await self._execute(op, args)
        finally:
            self.active_requests -= 1

    async def _execute(self, op, args):
        if op == 'claude-accounts' or op.startswith('claude-account-'):
            from agent_manager.management import Management
            action = 'list' if op == 'claude-accounts' else op.removeprefix('claude-account-')
            values = {key: value for key, value in args.items() if key != 'key'}
            result = await asyncio.to_thread(Management(self.clients['claude'].manager).execute,
                'claude_account_' + action, values, request_id=args.get('key'))
            if action != 'list':
                emit({'type': 'profiles-changed'})
            return result
        if op.startswith('command-'):
            return await self.chat_store().execute(op, args)
        if op == 'suite-resource-presets':
            return self.chat_store().application.catalog(args.get('provider', 'codex'))
        if op == 'suite-tools-refresh':
            return await self.chat_store().application.upgrade(args['chatId'], args['key'])
        if op == 'suite-mcp-context':
            return await self.chat_store().application.stdio_context(args['chatId'], args['key'])
        if op in {"resource-catalog", "profile-resources-get", "profile-resources-set", "launch-preview",
                  "sdk-credentials-list", "sdk-credential-save", "sdk-credential-assign", "sdk-auth-configure"}:
            result = await sibling("launch_resources").execute(self, op, args)
            if op == "profile-resources-set":
                emit({"type": "resources-changed"})
            elif op in ('sdk-credential-save', 'sdk-credential-assign', 'sdk-auth-configure'):
                emit({"type": "profiles-changed"})
            return result
        if op == "backend-catalog":
            backend_catalog = sibling("backends").catalog
            return backend_catalog(self)
        if op.startswith("skills-"):
            if self.skills is None:
                self.skills = sibling("skills").Skills(self)
            result = await self.skills.execute(op, args)
            if op in {"skills-source-register", "skills-source-unregister", "skills-create", "skills-save", "skills-release", "skills-profile-set"} or op in {"skills-managed-ensure", "skills-managed-adopt", "skills-managed-save", "skills-managed-apply", "skills-managed-rollback", "skills-managed-tracking", "skills-managed-release", "skills-managed-upload-finish"}:
                emit({"type": "skills-changed"})
            return result
        if op in {"session-list", "session-transcript", "session-start"}:
            if self.session_library is None:
                from session_library import SessionLibrary
                self.session_library = SessionLibrary(self)
            if op == "session-list":
                return await self.session_library.listing(args)
            if op == "session-transcript":
                return await self.session_library.transcript(args)
            return await self.session_library.start(args)
        if op == "providers":
            return await self.provider_inventory()
        if op == "agent-profile-readiness":
            from agent_manager.provider_catalog import profile_readiness
            return await asyncio.to_thread(profile_readiness, self.clients[args['provider']].manager, args['profile'])
        if op in {"agent-operations", "agent-operation-start", "agent-operation-cancel", "agent-operation-resolve", "provider-check-updates", "provider-diagnostics"}:
            operations = self.operation_store()
            if op == "agent-operations":
                return await operations.listing()
            if op == "agent-operation-start":
                return await operations.create(args)
            if op == "agent-operation-cancel":
                return await operations.cancel(args["operationId"])
            if op == "agent-operation-resolve":
                if args.get("confirmed") is not True:
                    raise ValueError("Resolution requires acknowledgement")
                return await operations.resolve(args["operationId"])
            if op == "provider-check-updates":
                return await operations.check_updates(args["provider"])
            return await operations.diagnostics(args["provider"])
        if op in {"agent-profile-update", "agent-profile-check"}:
            from agent_manager.management import Management
            manager = self.clients[args['provider']].manager
            tool = 'update_profile' if op == 'agent-profile-update' else 'check_profile'
            result = await asyncio.to_thread(Management(manager).execute, tool,
                {key: args[key] for key in ('profile', 'changes', 'expectedRevision') if key in args},
                request_id=args.get('key'))
            emit({"type": "profiles-changed"})
            return result
        if op == "agent-profile-get":
            from agent_manager.management import inspect_profile
            return await asyncio.to_thread(inspect_profile, self.clients[args["provider"]].manager, args["profile"])
        if op == "agent-management-mcp-context":
            source = self.chat_store().get(args["chatId"])
            if source.get("originChatId") or not source.get("workspaceTools") or source.get("profileDeleted"):
                raise ValueError("MCP context requires a controller conversation")
            return await self.management_store().context(source)
        if op == "agent-management-actions":
            return self.management_store().listing(args["chatId"])
        if op == "agent-login-challenge":
            return self.operation_store().challenge(args["operationId"])
        if op == "vox-tool":
            if self.vox_tools is None:
                import importlib.util
                spec = importlib.util.spec_from_file_location("aixand_vox_tools", Path(__file__).with_name("vox_tools.py"))
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                self.vox_tools = module.VoxTools(self.chat_store())
            return await self.vox_tools.execute(args)
        if op.startswith("mcp-"):
            if self.mcps is None:
                import importlib.util
                spec = importlib.util.spec_from_file_location("aixand_mcps", Path(__file__).with_name("mcps.py"))
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                self.mcps = module.Mcps(self)
            result = await self.mcps.execute(op, args)
            if op in {"mcp-profile-set", "mcp-configure"} or (op.startswith("mcp-managed-") and op.rsplit("-", 1)[1] in {"ensure", "save", "apply", "rollback", "tracking", "bootstrap", "adopt"}):
                emit({"type": "mcps-changed"})
                emit({"type": "resources-changed"})
            return result
        if op.startswith("prompts-"):
            if self.prompts is None:
                import importlib.util
                spec = importlib.util.spec_from_file_location("aixand_prompts", Path(__file__).with_name("prompts.py"))
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                self.prompts = module.Prompts(self)
            return await asyncio.to_thread(self.prompts.execute, op, args)
        if op in ('workspace-reset', 'workflow-run-action') or op.startswith(("chat-", "project-", "spawn-settings-", "approval-settings-", "connect-")):
            return await self.chat_store().execute(op, args)
        if op == "catalog":
            return await self.catalog()
        if op == "sessions":
            return await self.sessions(args.get("labels"))
        provider = args["provider"]
        if provider not in self.clients:
            raise ValueError("Unsupported agent implementation")
        client = self.clients[provider]
        if op in {"rename-login", "remove-login", "rename-profile", "duplicate-profile"}:
            operations = self.operation_store()
            module = self.operations_module
            async with operations.lock, operations.provider_locks[provider]:
                if op in {"rename-login", "remove-login"}:
                    self.operation_store().assert_login_idle(provider, args["auth"])
                    if op == "remove-login" and args.get("confirmed") is not True:
                        raise ValueError("Login removal requires confirmation")
                    result = await asyncio.to_thread(module.change_login, client.manager, args["auth"],
                                                     new_name=args.get("newName"), remove=op == "remove-login",
                                                     expected_identity=args.get('authId'))
                elif op == "rename-profile":
                    operations.assert_profile_idle(provider, args["profile"])
                    await asyncio.to_thread(available_profile_name, client.manager, args["newName"], args["profile"])
                    result = await asyncio.to_thread(client.manager.rename, args["profile"], args["newName"],
                        **({'expected_identity':args['profileId']} if args.get('profileId') else {}))
                else:
                    operations.assert_profile_idle(provider, args["profile"])
                    result = await asyncio.to_thread(module.duplicate_profile, client.manager, args["profile"], args["newName"])
                if op == "rename-login":
                    self.operations.rename_login_metadata(provider, args["auth"], args["newName"])
                if op in {"rename-login", "rename-profile"} and self.chats is not None:
                    field = "auth" if op == "rename-login" else "profile"
                    await self.chats.rename_identity(provider, field, args[field], args["newName"])
                if self.session_library is not None:
                    self.session_library.checked = 0
            emit({"type": "profiles-changed"})
            return result
        if op == "budgets":
            return await self.budgets(provider, args.get("auth"))
        if op == "create-profile":
            operations = self.operation_store()
            async with operations.lock, operations.provider_locks[provider]:
                from agent_manager.management import Management
                result = await asyncio.to_thread(Management(client.manager).execute, 'create_profile',
                    {key: args[key] for key in ('profile', 'auth', 'model', 'claudeAccountId', 'sdkCredential') if key in args}, request_id=args.get('key'))
            emit({"type": "profiles-changed"})
            return result
        if op == "delete-profile":
            if args.get("confirmed") is not True:
                raise ValueError("Profile deletion requires confirmation")
            operations = self.operation_store()
            async with operations.lock, operations.provider_locks[provider]:
                operations.assert_profile_idle(provider, args["profile"])
                result = await asyncio.to_thread(delete_profile, client.manager, args["profile"])
            if self.chats is not None:
                self.management_store().profile_deleted(provider, args["profile"])
            emit({"type": "profiles-changed"})
            return result
        if op == "switch-auth":
            if args["auth"] is None:
                self.operation_store()
                await asyncio.to_thread(self.operations_module.clear_login, client.manager, args["profile"])
            else:
                await client.switch_auth(args["profile"], args["auth"])
            emit({"type": "profiles-changed"})
            return None
        if op == "set-model":
            await client.set_model(args["profile"], args["model"])
            return None
        if op == "models":
            if provider == "codex":
                return await self.chat_store().models(args["profile"])
            return await client.models(profile=args["profile"], free=args.get("free", False), cwd=args["cwd"])
        if op == "reconcile":
            await self.connect_runtime()
            return {"runIds": await client.reconcile()}
        if op == "launch":
            await self.connect_runtime()
            context = agent_manager.application_context("aixand-suite", "terminal", project=args["cwd"],
                inherited=getattr(client, "context", None), labels=args.get("labels"), metadata=args.get("metadata"))
            agent = await client.spawn(profile=args["profile"], cwd=args["cwd"], model=args.get("model"),
                                       **({"resources": args["resources"], **({"mcp": args["mcp"]} if "mcp" in args else {})} if "resources" in args else {"mcp": args["mcp"]} if "mcp" in args else {"resources": {}}), **context)
            return {key: value for key, value in asdict(agent).items() if key != "home"}
        if op == "run-metadata":
            return {"metadata": await client.metadata(args["runId"])}
        if op in ("get", "stop"):
            runtime = await self.connect_runtime()
            agent = await client.get(args["runId"])
            session = (await runtime.stop(agent.session_id, force=args.get("force", False))
                       if op == "stop" else await runtime.inspect(agent.session_id))
            return {"run_id": agent.run_id, "session_id": agent.session_id, "observation": observation(session)}
        raise ValueError("Unsupported operation")


async def main():
    adapter = Adapter()
    from provider_updates import ProviderUpdates
    from agent_manager.provider_software import state_path as software_state_path
    updates = ProviderUpdates(lambda: [path for client in adapter.clients.values()
        for path in (client.manager.state_path, software_state_path(client.manager))], emit)
    update_task = asyncio.create_task(updates.run())
    tasks = set()
    async def restore_background():
        try:
            adapter.operation_store().schedule()
            chats = adapter.chat_store()
            await chats.reconcile_identities()
            chats.identity_task = asyncio.create_task(chats.monitor_identities())
            await chats.application.restore()
            chats.activity.schedule()
            if os.environ.get("SUITE_WORKFLOW_SOCKET"):
                await chats.native_workflows.listen(os.environ["SUITE_WORKFLOW_SOCKET"])
        except Exception as error:
            print(f'Workspace services could not restore: {type(error).__name__}', file=sys.stderr)
    # Local provider discovery remains available while conversation services recover.
    restoration = asyncio.create_task(restore_background())
    tasks.add(restoration)
    restoration.add_done_callback(tasks.discard)
    emit({"type": "ready"})

    async def handle(command):
        identifier = command["id"]
        try:
            result = await adapter.execute(command["op"], command.get("args", {}))
            emit({"type": "result", "id": identifier, "result": result})
            if '-managed-source-' in command['op']:
                kind = command['op'].split('-', 1)[0]
                if command['op'].endswith(('source-settings', 'source-job', 'source-job-start', 'source-cancel')):
                    emit({'type': ('mcps' if kind == 'mcp' else kind) + '-changed'})
                    emit({'type': 'resources-changed'})
            if command["op"] in {"prompts-save", "prompts-release", "prompts-bind", "prompts-unbind", "prompts-source-register", "prompts-source-unregister", "prompts-application-register", "prompts-application-set", "prompts-application-unregister", "prompts-managed-ensure", "prompts-managed-adopt", "prompts-managed-save", "prompts-managed-apply", "prompts-managed-rollback", "prompts-managed-tracking", "prompts-managed-release", "prompts-managed-upload-finish"}:
                emit({"type": "prompts-changed"})
        except agent_manager.LaunchError as error:
            emit({"type": "error", "id": identifier, "code": "launch_uncertain", "runId": error.run_id,
                  "message": "Launch result is unconfirmed. Check Terminals and refresh agents before launching again."})
        except agent_manager.Error as error:
            emit({"type": "error", "id": identifier, "code": getattr(error, "code", "manager"), "message": str(error),
                  "uncertain": getattr(error, "uncertain", False), "recovery": getattr(error, "recovery", None)})
        except undercurrent.UndercurrentError:
            emit({"type": "error", "id": identifier, "code": "runtime",
                  "message": "Undercurrent operation failed. Refresh agents and check Terminals; the request was not retried."})
        except (ValueError, KeyError, TypeError) as error:
            emit({"type": "error", "id": identifier, "code": getattr(error, "code", "invalid_request"),
                  "message": str(error) if hasattr(error, "code") else "Invalid agent request."})
        except Exception as error:
            if hasattr(error, "to_dict"):
                emit({"type": "error", "id": identifier, **error.to_dict()})
            else:
                emit({"type": "error", "id": identifier, "code": "unavailable",
                      "message": "Agent operation failed. Check local SDK configuration and refresh; the request was not retried."})

    try:
        while line := await asyncio.to_thread(sys.stdin.buffer.readline, MAX_LINE + 1):
            if len(line) > MAX_LINE or not line.endswith(b"\n"):
                break
            command = json.loads(line)
            if len(tasks) >= 32:
                emit({"type": "error", "id": command["id"], "code": "busy", "message": "Agent bridge is busy."})
                continue
            task = asyncio.create_task(handle(command))
            tasks.add(task)
            task.add_done_callback(tasks.discard)
    finally:
        # EOF detaches administrative clients. It never stops managed sessions.
        update_task.cancel()
        await asyncio.gather(update_task, return_exceptions=True)
        await asyncio.gather(*tasks, return_exceptions=True)
        if adapter.chats is not None:
            await adapter.chats.close()
        if adapter.discovery is not None:
            await adapter.discovery.close()
        if adapter.operations is not None:
            await adapter.operations.close()
        await adapter.runtime.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        emit({"type": "fatal", "message": "Agent bridge could not initialize. Check the Python SDK environment and Agent Manager configuration."})
