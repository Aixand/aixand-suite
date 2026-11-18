"""Private JSONL adapter for managed agents and Suite workspace metadata."""
import asyncio
from dataclasses import asdict
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "shared"))

import agent_manager
from conversation_manager import ConversationError, native_startup_support
from orchestration_mcp.optional import available
import undercurrent
from agent_manager.validation import name as profile_name

MAX_LINE = 1024 * 1024
SUPPORTED_PROVIDERS = ("codex", "opencode")


def sibling(identifier):
    import importlib.util
    spec = importlib.util.spec_from_file_location("suite_" + identifier.replace("/", "_"), Path(__file__).parent / (identifier + ".py"))
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
    if any(item != current and item.casefold() == value.casefold() for item in manager.state()["profiles"]):
        raise agent_manager.Error("A profile with this name already exists for this provider")


class Adapter:
    def __init__(self):
        self.runtime = undercurrent.Client()
        self.clients, self.provider_errors = {}, {}
        for provider in SUPPORTED_PROVIDERS:
            try:
                self.clients[provider] = agent_manager.Client(provider, runtime=self.runtime,
                    labels={"app": "aixand-suite"})
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
            from application.services import agent_operations
            self.operations_module = agent_operations
            self.operations = agent_operations.AgentOperations(self, output=emit)
            for client in self.clients.values():
                agent_operations.refresh_provider_path(client.manager)
        return self.operations

    def management_store(self):
        if self.management is None:
            from application.services.agent_management import AgentManagement
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

    def backend_catalog(self):
        return [dict(id=backend, provider=provider, label=label, available=provider in self.clients and native_startup_support(provider)['supported'],
            default=True, controls={'model': True, 'access': provider == 'codex', 'resources': available('prompts') or available('mcps'), 'suiteTools': True, 'legacyMcpSelection': False},
            reason=self.provider_errors.get(provider) or native_startup_support(provider)['reason'])
            for provider, backend, label in (("codex", "native-codex", "Codex"), ("opencode", "opencode-native", "OpenCode"))]

    async def catalog(self):
        snapshot = await self.provider_inventory()
        return {"profiles": [profile for row in snapshot['providers'] for profile in row.get('profiles', [])],
                "auths": [auth for row in snapshot['providers'] for auth in row.get('auths', [])],
                "capabilities": [row['capability'] for row in snapshot['providers'] if 'capability' in row],
                "cwd": self.cwd, "backends": self.backend_catalog()}

    def require_provider(self, provider):
        if provider not in self.clients:
            reason = self.provider_errors.get(provider, 'Provider is unavailable')
            config = os.environ.get('AGENT_MANAGER_CONFIG')
            location = f' (configuration: {config})' if config else ''
            raise agent_manager.Error(f'Agent Manager could not initialize {provider}{location}: {reason}')
        return self.clients[provider]

    async def provider_inventory(self):
        snapshot = await sibling('application/onboarding').inventory(self.require_provider('codex'), self.clients)
        for row in snapshot['providers']:
            for profile in row.get('profiles', []):
                profile.update(id=row['provider'] + '/' + profile['profile'], auth=None,
                    active_runs=1 if profile['profile'] in row.get('activeProfiles', []) else 0)
        return snapshot

    async def budgets(self, provider, auth):
        if auth is not None:
            raise ValueError("Budget observations select native profiles, not legacy shared logins")
        rows = await self.clients[provider].budgets(cached=True)
        return {"supported": True, "rows": [asdict(row) for row in rows]}

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
        self.require_provider("codex")
        if self.chats is None:
            self.chats = sibling("application/chats").SuiteChats(self, output=emit)
        return self.chats

    async def execute(self, op, args, *, request_id=None):
        if op in ('backend-discovery-get', 'backend-discovery-refresh'):
            if self.discovery is None:
                from application.services.backend_discovery import Discovery
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
            return await self._execute(op, args, request_id=request_id)
        finally:
            self.active_requests -= 1

    async def _execute(self, op, args, *, request_id=None):
        if (args.get('provider') is not None and args['provider'] not in SUPPORTED_PROVIDERS
                or op == 'claude-accounts' or op.startswith('claude-account-')):
            raise ConversationError('unsupported', 'Suite v0.1.0-beta supports Codex and OpenCode')
        if op in {'suite-delegated-tasks', 'suite-delegated-task'}:
            from application.delegated_work import read_delegated_work
            return read_delegated_work(self, op, args)
        if op in {'suite-tools-refresh', 'suite-mcp-context'}:
            chats = self.chat_store()
            record = chats.get(args['chatId'])
            if not record.get('suiteToolContext') or record.get('toolsRevoked'):
                raise ConversationError('unsupported', 'This conversation has no active captured Suite tool context')
            await chats.tools.ensure(record)
            return chats.tools.descriptor(chats.tools.context(record['id'])) if op == 'suite-mcp-context' else chats.tools.inventory(record['id'])
        if op in {'suite-resource-presets', 'workspace-reset'} or op.startswith('command-'):
            raise ConversationError('unsupported', 'Unsupported application feature: ' + op)

        if op.startswith('command-'):
            return await self.chat_store().execute(op, args)
        if op == 'suite-resource-presets':
            return self.chat_store().application.catalog(args.get('provider', 'codex'))
        if op == 'suite-tools-refresh':
            return await self.chat_store().application.upgrade(args['chatId'], args['key'])
        if op == 'suite-mcp-context':
            return await self.chat_store().application.stdio_context(args['chatId'], args['key'])
        if op in {'resource-catalog', 'profile-resources-get', 'profile-resources-set', 'launch-preview', 'instruction-defaults-get', 'instruction-defaults-set'}:
            return await self.chat_store().resource_operation(op, args)
        if op in {"resource-catalog", "profile-resources-get", "profile-resources-set", "launch-preview",
                  "sdk-credentials-list", "sdk-credential-save", "sdk-credential-assign", "sdk-auth-configure"}:
            result = await sibling("application/services/launch_resources").execute(self, op, args)
            if op == "profile-resources-set":
                emit({"type": "resources-changed"})
            elif op in ('sdk-credential-save', 'sdk-credential-assign', 'sdk-auth-configure'):
                emit({"type": "profiles-changed"})
            return result
        if op == "backend-catalog":
            return self.backend_catalog()
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
            return await sibling('application/onboarding').readiness(self.clients[args['provider']], args['profile'])
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
        if op == "agent-profile-check":
            client = self.clients[args['provider']]
            result = await client.manage_profiles('check_profile', {'profile': args['profile']})
            emit({"type": "profiles-changed"})
            return {**result, 'profile': sibling('application/onboarding').profile_view(result['profile'])}
        if op == "agent-profile-update":
            result = await sibling('application/onboarding').update_profile(self.clients[args['provider']], args)
            emit({"type": "profiles-changed"})
            return result
        if op == "agent-profile-get":
            return await sibling('application/onboarding').get_profile(self.clients[args['provider']], args['profile'])
        if op == "agent-management-mcp-context":
            source = self.chat_store().get(args["chatId"])
            if source.get("originChatId") or not source.get("suiteToolContext") or source.get("toolsRevoked") or source.get("profileDeleted"):
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
        if op in {'mcp-chat-status','mcp-chat-reconnect'}:
            return await self.chat_store().mcp_operation(op, args)
        if op.startswith("mcp-"):
            if self.mcps is None:
                import importlib.util
                spec = importlib.util.spec_from_file_location("suite_mcps", Path(__file__).with_name("mcps.py"))
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
            result = await asyncio.to_thread(self.prompts.execute, op, args)
            if op in {"prompts-managed-create", "prompts-managed-import-local", "prompts-save", "prompts-release"} or (op.startswith("prompts-managed-") and op.rsplit("-", 1)[1] in {"ensure", "save", "apply", "rollback", "tracking", "adopt"}):
                emit({"type": "prompts-changed"})
            return result
        if op in ('workspace-reset', 'workflow-run-action') or op.startswith(("chat-", "project-", "spawn-settings-", "approval-settings-", "codex-server-settings-", "connect-")):
            return await self.chat_store().execute(op, args)
        if op == "catalog":
            return await self.catalog()
        if op == "sessions":
            return await self.sessions(args.get("labels"))
        provider = args["provider"]
        client = self.require_provider(provider)
        if op in {"rename-login", "remove-login", "switch-auth"}:
            raise ConversationError('unsupported', 'Native profiles own their provider login. Use the profile terminal to sign in or out.')
        if op in {"rename-profile", "duplicate-profile", "delete-profile"}:
            if op == "delete-profile" and args.get("confirmed") is not True:
                raise ValueError("Profile deletion requires confirmation")
            target = client.manager.resolve_profile(args["profile"])
            profile = await client.get_profile(target)
            if args.get("profileId") and args["profileId"] != profile["profile_id"]:
                raise agent_manager.Error("The profile alias changed. Refresh before retrying.")
            arguments = dict(profile=profile["profile"], expectedRevision=profile["revision"])
            if op != "delete-profile":
                arguments["newName"] = args["newName"]
            result = await client.manage_profiles(op.replace("-", "_"), arguments, request_id=request_id)
            emit({"type": "profiles-changed"})
            return result
        if op == "create-profile":
            result = await sibling('application/onboarding').create_profile(client, args)
            emit({"type": "profiles-changed"})
            return result
        if op == "set-model":
            await client.set_model(args["profile"], args["model"])
            return None
        if op == "models":
            return await client.models(profile=args["profile"], free=args.get("free", False), cwd=args["cwd"], refresh=args.get("refresh", False))
        if op == "reconcile":
            await self.connect_runtime()
            return {"runIds": await client.reconcile()}
        if op == "launch":
            if args.get("resources") or args.get("mcp"):
                raise ValueError("Prepare native terminal resources before launching; legacy resource injection is unavailable")
            await self.connect_runtime()
            agent = await client.spawn(profile=args["profile"], cwd=args["cwd"], model=args.get("model"),
                idempotency_key=request_id, labels=args.get("labels"), metadata=args.get("metadata"))
            return {key: value for key, value in asdict(agent).items() if key != "home"}
        if op == "run-metadata":
            return {"metadata": await client.metadata(args["runId"])}
        if op in ("get", "stop"):
            agent = await client.get(args["runId"])
            state = await agent.stop(force=args.get("force", False)) if op == "stop" else await agent.inspect()
            return {"run_id": agent.run_id, "session_id": agent.session_id, "observation": asdict(state)}
        raise ValueError("Unsupported operation")


async def main():
    adapter = Adapter()
    from provider_updates import ProviderUpdates
    updates = ProviderUpdates(lambda: [path for client in adapter.clients.values()
        for path in (client.manager.state_path,)], emit)
    update_task = asyncio.create_task(updates.run())
    tasks = set()
    async def restore_background():
        try:
            await adapter.chat_store().restore()
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
            result = await adapter.execute(command["op"], command.get("args", {}), request_id=identifier)
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
                  "uncertain": getattr(error, "uncertain", False), "recovery": getattr(error, "recovery", None),
                  "retryable": getattr(error, "retryable", False)})
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
                from orchestration_mcp.services.diagnostics import record
                diagnostic = record(error, operation=command['op'])
                emit({"type": "error", "id": identifier, "code": "unavailable",
                      "diagnosticId": diagnostic,
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
        if adapter.management is not None:
            await adapter.management.close()
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
