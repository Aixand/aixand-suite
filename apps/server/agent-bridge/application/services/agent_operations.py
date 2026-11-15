"""Durable provider maintenance and login jobs, using retained native terminals."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.parse
import urllib.request
import uuid

from agent_manager import application_context
from agent_manager.providers.installation import engine as install, updates as update
from agent_manager.errors import Error, BusyError
from agent_manager.storage.files import atomic, private_dir
from agent_manager.storage.locks import locks
from agent_manager.validation import name

ACTIVE = {"queued", "starting", "running", "uncertain"}
MAINTENANCE = {"install", "install-sdk", "setup-command", "update", "repair", "uninstall", "disable", "enable"}
LOGIN = {"profile-login", "check-profile"}
INTERACTIVE_LOGIN = {"profile-login"}




def refresh_provider_path(manager):
    return install.refresh_provider_path(manager)


def read(path, default=None):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


def write(path, value):
    atomic(path, (json.dumps(value, indent=2) + "\n").encode())


def active_profiles(manager):
    with locks(manager.lock_root, "registry", wait=True):
        state = manager.state()
        return [profile for profile in state["profiles"] if manager.active_runs(state, profile)]






def duplicate_profile(manager, profile, new_name):
    from agent_manager.profiles.operations import duplicate_profile as duplicate
    return duplicate(manager, profile, new_name)


class AgentOperations:
    def __init__(self, adapter, *, output):
        self.adapter, self.output = adapter, output
        scope = hashlib.sha256(json.dumps([
            [str(client.manager.root.resolve()), str(client.manager.config_path)]
            for provider, client in adapter.clients.items() if provider in ('codex', 'opencode')
        ] + [adapter.runtime.connection_options["home"]]).encode()).hexdigest()[:20]
        base = Path(os.environ.get("AGENTS_STATE_DIR") or
                    Path(os.environ.get("XDG_STATE_HOME", "~/.local/state")).expanduser() / "aixand" / "agents").expanduser()
        self.root = base / "agent-operations" / scope
        private_dir(self.root / "jobs")
        self.lock = asyncio.Lock()
        self.provider_locks = {provider: asyncio.Lock() for provider in adapter.clients}
        self.task = None
        self.closing = False
        self.native_signins = {}
        # Cover terminal and app-server launches, including Command and Vox.
        for provider, client in adapter.clients.items():
            original = client.spawn

            async def guarded_spawn(*, _provider=provider, _spawn=original, **kwargs):
                async with self.provider_locks[_provider]:
                    if any(row["provider"] == _provider and row["kind"] in MAINTENANCE
                           and row["status"] in {"starting", "running", "uncertain"} for row in self.rows()):
                        raise Error("This provider is being maintained. Wait for the operation to finish before launching.")
                    manager = self.adapter.clients[_provider].manager
                    target = manager.resolve_profile(kwargs.get('profile'))
                    self.handover().check(_provider, target.environment_id)
                    return await _spawn(**kwargs)
            client.spawn = guarded_spawn

    def rows(self):
        rows = [row for path in (self.root / "jobs").glob("*.json")
                if (row := read(path)).get("provider") in self.adapter.clients]
        from agent_manager.profiles.identities import label
        states = {}
        for row in rows:
            manager = self.adapter.clients[row['provider']].manager
            if not callable(getattr(manager, 'state', None)):
                continue
            state = states.setdefault(row['provider'], manager.state())
            identifier = row.get("profileId")
            current = label(state, identifier) if identifier else None
            if current and row.get("profile") != current:
                row["profile"] = current
                write(self.root / "jobs" / (row["id"] + ".json"), row)
        return sorted(rows, key=lambda row: row["createdAt"], reverse=True)

    def save(self, value):
        value["updatedAt"] = time.time() * 1000
        write(self.root / "jobs" / (value["id"] + ".json"), value)
        self.output({"type": "agent-operation-updated", "operation": self.public(value)})

    def handover(self):
        return self.adapter.chat_store().executions.signin_handover()

    async def prepare_signin(self, row):
        row.update(phase='waiting-for-work', message="Checking this profile's active conversations…", blockers=[])
        self.save(row)
        try:
            result = await asyncio.wait_for(self.handover().advance(
                row['provider'], row['environment_id'], row['id']), timeout=30)
            if result['ready']:
                # External terminal/native readers do not belong to this Suite
                # coordinator. Their leases must also be free before opening UI.
                manager = self.adapter.clients[row['provider']].manager
                with locks(manager.lock_root, 'environment-' + row['environment_id']):
                    pass
                row.update(phase='preparing', blockers=[], message='Preparing native sign-in…')
                self.save(row)
                return True
            row['blockers'] = result['blockers']
            chats = self.adapter.chat_store()
            names = {record.get('sdkExecutionId'): record.get('title') or 'Conversation'
                     for (raw,) in chats.db.execute('SELECT record FROM suite_sdk_chats')
                     if (record := json.loads(raw))}
            for blocker in row['blockers']:
                if names.get(blocker.get('execution_id')):
                    blocker['title'] = names[blocker['execution_id']]
            row['message'] = 'Waiting for this profile’s work to finish. Existing conversations and approvals can continue.'
        except BusyError:
            row.update(blockers=[dict(kind='external_session')],
                       message='Close this profile’s native terminal sessions to continue signing in.')
        except Exception:
            row.update(blockers=[dict(kind='activity_unavailable')],
                       message='Could not confirm that this profile is idle. Existing work was preserved. Check component compatibility or cancel sign-in and retry.')
        self.save(row)
        return False

    async def release_signin(self, row):
        if row['kind'] != 'profile-login' or not row.get('environment_id'):
            return True
        return await asyncio.wait_for(self.handover().release(row['provider'], row['environment_id'], row['id']), timeout=30)

    @staticmethod
    def public(value):
        return {key: value.get(key) for key in ("id", "provider", "kind", "profile", "method", "status", "progress",
                "sessionId", "message", "blockers", "createdAt", "updatedAt", "exitCode", "result", "cancellable", "device", "structured", "phase", "sourceChatId", "sourceTurnId", "sourceCallId", "expectedProfileRevision", "origin", "observed", "installationPlan", "versionTarget")}


    def schedule(self):
        if not self.closing and (self.task is None or self.task.done()) and any(self.needs_monitor(row) for row in self.rows()):
            self.task = asyncio.create_task(self.monitor())

    @staticmethod
    def needs_monitor(row):
        return row["status"] in ACTIVE or any(value["phase"] not in {"ready", "superseded", "needs_attention"}
            for value in (row.get("result") or {}).get("recovery", []))


    async def monitor(self):
        while not self.closing:
            try:
                await self.listing()
            except Exception:
                pass  # Retain intent through bridge and daemon outages.
            if not any(self.needs_monitor(row) for row in self.rows()):
                return
            await asyncio.sleep(2)

    async def listing(self):
        async with self.lock:
            for row in self.rows():
                if row["status"] in ACTIVE:
                    async with self.provider_locks[row["provider"]]:
                        try: await self.refresh(row)
                        except Exception: pass
            rows = sorted(self.rows(), key=lambda row: row["createdAt"], reverse=True)
        self.schedule()
        return {"operations": [self.public(row) for row in rows if row["status"] in ACTIVE]
                + [self.public(row) for row in rows if row["status"] not in ACTIVE][:20]}

    def get(self, identifier):
        row = read(self.root / "jobs" / (str(uuid.UUID(identifier)) + ".json"))
        if row is None:
            raise Error("Unknown operation")
        if row["provider"] not in self.adapter.clients:
            raise Error("Unknown operation")
        return self.public(row)

    def challenge(self, identifier):
        identifier = str(uuid.UUID(identifier))
        row = self.get(identifier)
        if row["status"] not in ACTIVE or not row.get("structured"):
            return {"available": False}
        progress = read(self.root / "progress" / (identifier + ".json"), {})
        challenge = progress.get("challenge")
        return {"available": bool(challenge), **({"challenge": challenge} if challenge else {})}


    def assert_profile_idle(self, provider, profile):
        if any(row["provider"] == provider and profile in (row.get("profile"), row.get("assignProfile"))
               and row["status"] in ACTIVE for row in self.rows()):
            raise Error("Wait for this profile's sign-in to finish before changing it")

    def observe_progress(self, row):
        # Manager owns the payload; retained operations only persist and relay it.
        progress = read(self.root / "progress" / (row["id"] + ".json"), {})
        changed = False
        for field in ('phase', 'progress', 'message'):
            if progress.get(field) and row.get(field) != progress[field]:
                row[field] = progress[field]
                changed = True
        return changed

    async def refresh(self, row):
        # Multiple bridge instances may monitor the same durable operation.
        # Never let cancellation race a worker seal/stop in another process.
        with locks(self.root / '.locks', 'lifecycle-' + row['id']):
            current = read(self.root / 'jobs' / (row['id'] + '.json'))
            if current:
                row.update(current)
            if current and current['status'] not in ACTIVE:
                row.update(current)
                return
            await self._refresh(row)

    async def _refresh(self, row):
        if row['status'] in ACTIVE and self.observe_progress(row):
            self.save(row)
        result = read(self.root / "results" / (row["id"] + ".json"))
        if result:
            await self.finish(row, result)
            return
        if row["status"] == "queued":
            if row['kind'] == 'profile-login':
                if not await self.prepare_signin(row):
                    return
            elif await asyncio.to_thread(active_profiles, self.adapter.clients[row["provider"]].manager):
                return
            await self.start(row)
            return
        runtime = await self.adapter.connect_runtime()
        sessions = await runtime.list(name="agent-operation-" + row["id"])
        if not sessions:
            if row["status"] != "uncertain":
                row.update(status="uncertain", message="The operation could not be found. Check its terminal before retrying.")
                self.save(row)
            return
        session = sessions[0]
        if session.id != row.get('sessionId') and row.get('sessionId'):
            row.update(status='uncertain', message='The sign-in terminal changed. Check its terminal before continuing.')
            self.save(row)
            return
        if session.lifecycle in {"stopped", "exited", "failed"}:
            # The worker may have committed while list() was in flight.
            result = read(self.root / "results" / (row["id"] + ".json"))
            if result:
                row["sessionId"] = session.id
                await self.finish(row, result)
                return
            # A stopped worker has no authoritative completion receipt.
            row.update(status="cancelled" if row.get("cancelRequested") else "failed", sessionId=session.id,
                       message="Operation cancelled." if row.get("cancelRequested") else
                       "The operation ended without confirming completion. Check its terminal and setup before retrying.")
            if not await self.release_signin(row):
                row.update(status='uncertain', message='The operation stopped, but profile admission has not been restored. Retry cancellation to reconcile it.')
            (self.root / "progress" / (row["id"] + ".json")).unlink(missing_ok=True)
            self.save(row)
        elif row["status"] != "running" or row.get("sessionId") != session.id:
            row.update(status="running", sessionId=session.id,
                       message="Preparing native sign-in…" if row["kind"] in INTERACTIVE_LOGIN
                       else "Checking login…" if row["kind"] == "check-login" else "Operation in progress…")
            self.save(row)

    async def finish(self, row, result):
        self.observe_progress(row)
        if not await self.release_signin(row):
            row.update(status='uncertain', message='Sign-in ended; waiting to restore profile admission.')
            self.save(row)
            return
        row.update(result)
        if row["kind"] in MAINTENANCE and row["status"] == "succeeded":
            refresh_provider_path(self.adapter.clients[row["provider"]].manager)
        (self.root / "progress" / (row["id"] + ".json")).unlink(missing_ok=True)
        self.save(row)
        self.output({"type": "profiles-changed"})

    async def start(self, row):
        runtime = await self.adapter.connect_runtime()
        row.update(status="starting", message="Starting operation…")
        self.save(row)  # Persist a unique name before the start boundary; never replay an uncertain launch.
        manager = self.adapter.clients[row["provider"]].manager
        spec = {"id": row["id"], "provider": row["provider"], "kind": row["kind"],
                "profile": row.get("profile"),
                **{key: row[key] for key in ("environment_id", "profile_id", "expectedRevision") if key in row},
                "installationRevision": row.get('installationRevision'), "confirmed": row.get('confirmed'), "terminalPolicy": row.get('terminalPolicy'),
                "method": row.get("method"), "config": str(manager.config_path) if manager.config_path else None,
                'installationPlan': row.get('installationPlan'), 'versionTarget': row.get('versionTarget'),
                "home": str(manager.root.parent.resolve()), "device": row.get("device", False),
                **{key: row.get(key) for key in ("structured", "expectedProfileRevision", "expectedProfileIdentity")}}
        write(self.root / "specs" / (row["id"] + ".json"), spec)
        env = {key: os.environ[key] for key in ("PATH", "HOME", "PYTHONPATH", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
               "XDG_CACHE_HOME", "XDG_STATE_HOME", 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'USERPROFILE',
               'LOCALAPPDATA', 'APPDATA', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'AIXAND_PACKAGED_RUNTIME',
               'AIXAND_PROVIDER_BUNDLE_ROOT', 'npm_config_prefix', 'npm_config_cache') if key in os.environ}
        env.update({key: value for key, value in os.environ.items() if key.startswith('AIXAND_PROVIDER_')})
        env.update(TERM="xterm-256color", PYTHONUNBUFFERED="1")
        context = application_context("aixand-suite", "agent-operation", session_kind="job",
            labels={"suite.operation_id": row["id"], "suite.operation_kind": row["kind"],
                    "aixand.operation": row["id"]},
            metadata={"suite.operation_spec": str(self.root / "specs" / (row["id"] + ".json"))})
        try:
            session = await runtime.start([sys.executable, "-u", str(Path(__file__).with_name("agent_operation_worker.py")),
                                           str(self.root), row["id"]],
                                          name="agent-operation-" + row["id"], cwd=self.adapter.cwd, env=env,
                                          detection=False, **context, idempotency_key=row["id"])
        except Exception:
            row.update(status="uncertain", message="Start was not confirmed. Refresh to recover the operation; it was not replayed.")
            self.save(row)
            return
        row.update(status="running", sessionId=session.id,
                   message="Preparing native sign-in…" if row["kind"] in INTERACTIVE_LOGIN
                   else "Operation in progress…")
        self.save(row)

    async def create(self, args):
        key = str(uuid.UUID(args["key"]))
        provider, kind = args["provider"], args["kind"]
        if provider not in self.adapter.clients or kind not in LOGIN | MAINTENANCE:
            raise Error("Unsupported agent operation")
        signature = json.dumps(args, sort_keys=True)
        async with self.lock, self.provider_locks[provider]:
            with locks(self.root / ".locks", "operations", wait=True):
                old = read(self.root / "jobs" / (key + ".json"))
                if old:
                    if old["signature"] != signature:
                        raise Error("Operation key was reused with different arguments")
                    return self.public(old)
                if any(row["provider"] == provider and row["status"] in ACTIVE for row in self.rows()):
                    raise Error("An operation is already active for this provider. Finish or cancel it first.")
                manager = self.adapter.clients[provider].manager
                prepared = await self.adapter.clients[provider].prepare_provider_operation(args)
                profile = args.get('profile')
                target_row = None
                if kind == "profile-login":
                    target_row = await self.adapter.clients[provider].get_profile(profile)
                profiles = await asyncio.to_thread(active_profiles, manager) if kind in MAINTENANCE else []
                if profiles and not args.get("whenIdle"):
                    raise Error("Stop this provider's active agents or choose Update when idle.")
                row = {"id": key, "signature": signature, "provider": provider, "kind": kind, "profileId": manager.state()["profiles"].get(profile, {}).get("id"),
                       "profile": args.get('profile'),
                       "installationRevision": args.get('installationRevision'), "confirmed": args.get('confirmed'), "terminalPolicy": args.get('terminalPolicy'),
                       "device": args.get("device", False), "method": args.get("method"), "createdAt": time.time() * 1000,
                       "structured": args.get("structured", False), "phase": "preparing",
                       "expectedProfileIdentity": target_row["profile_id"] if target_row else None,
                       "expectedProfileRevision": target_row["revision"] if target_row else None,
                       **{field: args.get(field) for field in ("sourceChatId", "sourceTurnId", "sourceCallId")},
                       "status": "queued", "sessionId": None, "cancellable": kind in LOGIN,
                       "message": "Waiting for active agents to finish." if profiles else "Preparing operation…"}
                row.update({field: prepared[field] for field in (
                    "environment_id", "profile_id", "expectedRevision", "installationPlan"
                ) if field in prepared})
                if kind in {'install', 'install-sdk', 'update', 'repair'}:
                    row['versionTarget'] = args.get('versionTarget')
                self.save(row)
            if kind == 'profile-login':
                self.handover().begin(provider, row['environment_id'], row['id'])
                row.update(phase='waiting-for-work', message='Waiting for this profile to become idle before sign-in.')
                self.save(row)
            elif not profiles:
                await self.start(row)
        self.schedule()
        return self.public(row)

    async def cancel(self, identifier):
        identifier = str(uuid.UUID(identifier))
        with locks(self.root / '.locks', 'lifecycle-' + identifier):
            return await self._cancel(identifier)

    async def _cancel(self, identifier):
        identifier = str(uuid.UUID(identifier))
        async with self.lock:
            row = read(self.root / "jobs" / (identifier + ".json"))
            if not row or row["provider"] not in self.adapter.clients:
                raise Error("Unknown operation")
            async with self.provider_locks[row["provider"]]:
                if row["status"] not in ACTIVE:
                    if not await self.release_signin(row):
                        raise Error('Could not restore profile admission; retry cancellation.')
                    return self.public(row)
                if row["status"] == "queued":
                    if not await self.release_signin(row):
                        raise Error('Could not restore profile admission. Existing workers were preserved; retry cancellation.')
                    row.update(status="cancelled", message="Operation cancelled.")
                elif not row["cancellable"]:
                    raise Error("An installation cannot be cancelled after it starts. Follow its progress in Terminals.")
                else:
                    runtime = await self.adapter.connect_runtime()
                    sessions = await runtime.list(name="agent-operation-" + row["id"])
                    row["cancelRequested"] = True
                    self.save(row)
                    if sessions:
                        await runtime.stop(sessions[0].id)
                        await self._refresh(row)
                    else:
                        if not await self.release_signin(row):
                            raise Error('Could not restore profile admission; retry cancellation.')
                        row.update(status="cancelled", message="No running operation found. Check setup before retrying.")
                if row["status"] not in ACTIVE:
                    (self.root / "progress" / (row["id"] + ".json")).unlink(missing_ok=True)
                self.save(row)
        return self.public(row)

    async def resolve(self, identifier):
        identifier = str(uuid.UUID(identifier))
        with locks(self.root / '.locks', 'lifecycle-' + identifier):
            return await self._resolve(identifier)

    async def _resolve(self, identifier):
        """Acknowledge an unconfirmed operation only after confirming its terminal is absent."""
        identifier = str(uuid.UUID(identifier))
        async with self.lock:
            row = read(self.root / "jobs" / (identifier + ".json"))
            if not row or row["provider"] not in self.adapter.clients or row["status"] != "uncertain":
                raise Error("Only an unconfirmed operation can be resolved")
            async with self.provider_locks[row["provider"]]:
                await self._refresh(row)
                if row["status"] != "uncertain":
                    return self.public(row)
                runtime = await self.adapter.connect_runtime()
                if await runtime.list(name="agent-operation-" + row["id"]):
                    raise Error("This operation still has a terminal. Check its progress before resolving it.")
                if not await self.release_signin(row):
                    raise Error('Could not restore profile admission; retry reconciliation.')
                row.update(status="failed", message="Completion remains unconfirmed. Check setup before starting another operation.")
                self.save(row)
        return self.public(row)




    def inspect_provider(self, provider):
        from agent_manager.providers.catalog import inspect_installation
        return {**inspect_installation(self.adapter.clients[provider].manager),
                **read(self.root / "providers" / (provider + ".json"), {})}

    async def providers(self):
        # Manual installers can finish after the bridge starts. Recheck the
        # vendor's user-local directory before probing or offering sign-in.
        for client in self.adapter.clients.values():
            refresh_provider_path(client.manager)
        providers = await asyncio.gather(*[asyncio.to_thread(self.inspect_provider, provider)
                                          for provider in self.adapter.clients])
        for row in providers:
            row["setup"] = await asyncio.to_thread(install.setup_guide, row["provider"])
        return {"providers": providers, "environment": install.environment_info()}

    async def check_updates(self, provider):
        if provider not in install.catalog():
            return await asyncio.to_thread(self.inspect_provider, provider)
        def fetch():
            spec = install.catalog()[provider]
            # Read release metadata only. The existing updater chooses the actual installation method.
            result = {"checkedAt": time.time() * 1000, "latestVersion": None, "updateError": None}
            try:
                if spec.get('npm_package'):
                    url = "https://registry.npmjs.org/" + urllib.parse.quote(spec["npm_package"], safe="@/") + "/latest"
                else:
                    host = install.environment_info()
                    url = spec['release_manifest'].format(platform={'macos': 'darwin'}.get(host['os'], host['os']),
                        architecture={'x64': 'amd64'}.get(host['architecture'], host['architecture']))
                with urllib.request.urlopen(url, timeout=12) as response:
                    data = response.read(128 * 1024 + 1)
                version = json.loads(data)["version"]
                if len(data) > 128 * 1024 or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?", version):
                    raise ValueError("Invalid release metadata")
                result["latestVersion"] = version
            except Exception:
                result["updateError"] = "Could not check published releases. Check the connection and try again."
            write(self.root / "providers" / (provider + ".json"), result)
            return self.inspect_provider(provider)
        return await asyncio.to_thread(fetch)

    async def diagnostics(self, provider):
        info = await asyncio.to_thread(self.inspect_provider, provider)
        checks = [{"label": "Provider executable", "status": "passed" if info["installed"] and info["version"] else "failed",
                   "message": ("Version " + info["version"]) if info["version"] else info["error"] or "Provider not installed."}]
        for sdk in info.get('sdkInstallations', []):
            checks.append(dict(label=sdk['label'], status='passed' if sdk['available'] else 'failed',
                message=f"{sdk['package']} {sdk['version']} is available for chat. Sign-in is checked separately in profile settings."
                    if sdk['available'] else sdk['error']))
        try:
            await self.adapter.connect_runtime()
            checks.append({"label": "Terminal connection", "status": "passed", "message": "Connected."})
        except Exception:
            checks.append({"label": "Terminal connection", "status": "failed", "message": "Reconnect after checking the local terminal service."})
        return {"checks": checks, "checkedAt": time.time() * 1000}

    async def close(self):
        self.closing = True
        await asyncio.gather(*(monitor.close() for monitor in self.native_signins.values()))
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
