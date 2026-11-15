"""Composable agent operations; no mandatory application object."""
import asyncio
import json
from pathlib import Path
import uuid

import agent_manager
from agent_manager.runtime.context import Context, attributes, require_metadata
import undercurrent

from ._agent import Agent
from ._binding import Binding, PROTOCOL
from ._carrier import codex_mcp_arguments
from ._connection import resolve
from ._config import seconds
from .errors import AgentSetupError, AixandError, DeliveryUncertain

AUTO = object()


async def spawn(*, provider="codex", profile="default", cwd=None, args=(), env=None,
                address=None, instructions=None, connection=None, timeout=None,
                detection_profile=None, detection=True, credentials=None,
                receipt_credentials=None, mcp_arguments=None, mcp=None, project=AUTO,
                labels=None, metadata=None, inherit_labels=True, inherit_metadata=True,
                resources=None, application_resources=None, runtime_bindings=None,
                native_config=None):
    """Launch through Agent Manager and optionally own a Carrier inbox binding.

    address provisions a fresh identity, configures MCP before launch, confirms
    setup through Carrier, then starts an inbox consumer. Credential files for
    fresh, preprovisioned identities may be supplied instead. They must not be
    shared with another conversation or receiving owner.

    Codex MCP launch configuration is built in. Other providers can supply a
    synchronous mcp_arguments(url, credentials_path) callback.
    """
    scope = resolve(connection)
    Context().resolve(labels=labels, metadata=metadata,
        inherit_labels=inherit_labels, inherit_metadata=inherit_metadata)
    if timeout is not None:
        seconds(timeout, "timeout")
    if address is None and any(value is not None for value in (credentials, receipt_credentials, mcp_arguments)):
        raise ValueError("Carrier configuration requires address")
    if instructions is not None and not isinstance(instructions, str):
        raise TypeError("instructions must be a string")
    if isinstance(args, (str, bytes)):
        raise ValueError("args must be a sequence of strings")
    if mcp is not None or project is not AUTO or resources is not None or application_resources is not None or runtime_bindings:
        raise ValueError("Current Agent Manager requires native_config or native CLI arguments for provider configuration")
    args = list(args)
    if not all(isinstance(arg, str) for arg in args):
        raise ValueError("args must be a sequence of strings")
    configure = mcp_arguments or (codex_mcp_arguments if provider == "codex" else None)
    if address is not None and configure is None:
        raise ValueError("This provider needs mcp_arguments(url, credentials_path) for Carrier integration")
    async with scope._mutation_lock:
        await scope.open()
        manager = await scope.manager(provider)
        runtime = await scope.runtime()
        context = Context(**getattr(manager, "context", scope.context)).resolve(
            labels=labels, metadata=metadata, inherit_labels=inherit_labels, inherit_metadata=inherit_metadata)
        attributes({**context.labels, "agent_manager.run_id": "0" * 32,
                    "agent_manager.profile": "default"}, "labels", internal=True)
        require_metadata(runtime, context.metadata)
        launch_args = list(args)
        inbox = receipts = None
        if address is not None:
            inbox = await scope._carrier.mailbox(address, credentials=credentials, claim=True)
            if receipt_credentials is None:
                receipt_address = "aixand-receipts/" + uuid.uuid4().hex
            else:
                # The Carrier client will authenticate and verify this identity.
                receipt_address = json.loads(Path(receipt_credentials).expanduser().read_text())["address"]
            receipts = await scope._carrier.mailbox(receipt_address, credentials=receipt_credentials, claim=True)
            extra = configure(scope._carrier.url, scope._carrier.credentials[address])
            if isinstance(extra, (str, bytes)):
                raise ValueError("mcp_arguments must return a sequence of argument strings")
            extra = list(extra)
            if not all(isinstance(arg, str) for arg in extra):
                raise ValueError("mcp_arguments must return a sequence of argument strings")
            launch_args.extend(extra)
        try:
            managed = await manager.spawn(profile=profile, cwd=cwd, args=launch_args, env=env,
                                          detection_profile=detection_profile, detection=detection,
                                          timeout=scope.timeout if timeout is None else timeout,
                                          **({"native_config": native_config} if native_config is not None else {}),
                                          **({**context.as_dict(), "inherit_labels": False, "inherit_metadata": False}
                                             if context.labels or context.metadata or not inherit_labels or not inherit_metadata else {}))
        except agent_manager.LaunchError as error:
            scope._unconfirmed.append({"run_id": error.run_id, "provider": provider,
                                       "address": address, "error": str(error)})
            scope._save()
            raise
        agent = Agent(managed, scope)
        scope._agents[managed.run_id] = agent
        scope._owned.add(managed.run_id)
        scope._save()
        try:
            if inbox is not None:
                agent._binding = Binding(agent, inbox, receipts)
                scope._save()
                setup = (PROTOCOL + "\nYour address is " + address + ".\n"
                         + (instructions or "Wait for a task or incoming peer message.")
                         + "\nThis is setup only. Send the required acceptance receipt, "
                           "then end your turn without starting work or sending other messages.")
                receipt = await agent.send(setup, timeout=timeout)
                await agent._binding.accept(receipt.delivery_id, scope.timeout if timeout is None else timeout)
                agent._pending_acceptance = None
                ready = await agent.wait(after=receipt, timeout=timeout)
                agent._runtime_started_at = getattr(ready, "raw", {}).get("started_at_millis")
                scope._save()
                agent._binding.start()
            elif instructions:
                await agent.send(instructions, timeout=timeout)
            return agent
        except asyncio.CancelledError:
            # The known launch is retained in scope.agents and the manifest.
            raise
        except Exception as error:
            raise AgentSetupError(agent, error) from error


async def get(run_id, *, provider="codex", connection=None):
    """Attach a runtime handle; this does not reconstruct an old Carrier consumer.

    Within a scope, repeated get calls return the same handle and input lock.
    Across scopes, use restore with the original manifest to recover delivery.
    """
    scope = resolve(connection)
    async with scope._mutation_lock:
        if run_id in scope._agents:
            agent = scope._agents[run_id]
            if agent.provider != provider:
                raise ValueError("run_id belongs to a different provider")
            return agent
        manager = await scope.manager(provider)
        managed = await manager.get(run_id)
        agent = Agent(managed, scope)
        scope._agents[run_id] = agent
        scope._save()
        return agent


async def restore(run_id, *, manifest, connection=None):
    """Restore delivery to the same live conversation without replaying input.

    The manifest and journal must come from its original connection. Restoration
    verifies runtime/managed identity, acquires the journal's exclusive lock,
    and refuses ambiguous writes. It never launches or resumes a conversation.
    """
    scope = resolve(connection)
    path = Path(manifest).expanduser().resolve()
    saved = json.loads(path.read_text())
    row = saved.get("agents", {}).get(run_id)
    if not row or not row.get("address") or not row.get("binding"):
        raise ValueError("Manifest has no recoverable Carrier binding for this run")
    if saved["carrier"]["mode"] != "external" or scope._carrier.config.mode != "external":
        raise ValueError("Restoration requires the persistent external Carrier service")
    if saved["carrier"]["url"].rstrip("/") != scope._carrier.url.rstrip("/"):
        raise ValueError("Carrier service differs from the original binding")
    if row.get("uncertain_input"):
        raise DeliveryUncertain("Original input delivery is uncertain; inspect it before recovery")
    journal = Path(row["binding"]["journal"]).resolve()
    if not journal.is_file():
        raise ValueError("Original delivery journal is missing")
    async with scope._mutation_lock:
        if run_id in scope._agents:
            existing = scope._agents[run_id]
            if existing.consumer_active and existing.address == row["address"]:
                return existing
            raise AixandError("Run already has a handle in this connection; use a fresh recovery scope")
        await scope.open()
        runtime = await scope.runtime()
        if runtime.home != saved["runtime_home"]:
            raise ValueError("Runtime differs from the original binding")
        managed = await (await scope.manager(row["provider"])).get(run_id)
        if any(getattr(managed, key) != row[key] for key in
               ("run_id", "provider", "profile", "home", "session_id")):
            raise ValueError("Managed conversation identity has changed")
        snapshot = await runtime.inspect(managed.session_id)
        if snapshot.lifecycle != "running":
            raise AixandError("Only a still-running conversation can be restored")
        if row.get("runtime_started_at") is not None and snapshot.raw.get("started_at_millis") != row["runtime_started_at"]:
            raise AixandError("Original conversation process has changed; recovery was not started")
        credentials = saved["carrier"]["credentials"]
        address, receipt_address = row["address"], row["binding"]["receipt_address"]
        agent = Agent(managed, scope)
        agent._runtime_started_at = row.get("runtime_started_at")
        for key in ("last_receipt", "last_delivery"):
            value = row.get(key)
            if value:
                receipt = undercurrent.InputReceipt(**value)
                if receipt.session_id != managed.session_id:
                    raise ValueError("Saved receipt belongs to a different session")
                setattr(agent, "_" + key, receipt)
        inbox = await scope._carrier.mailbox(address, credentials=credentials[address], claim=True)
        receipts = await scope._carrier.mailbox(receipt_address, credentials=credentials[receipt_address], claim=True)
        binding = Binding(agent, inbox, receipts, journal=journal, restore=True)
        try:
            # Check only while holding the journal lock. A submitting write may
            # have reached the terminal; never turn it into a new write.
            if binding.db.execute("SELECT 1 FROM deliveries WHERE state = 'submitting' LIMIT 1").fetchone():
                raise DeliveryUncertain("Journal contains an uncertain terminal write; recovery was not started")
            agent._binding = binding
            agent._pending_acceptance = row.get("pending_acceptance")
            if agent._pending_acceptance:
                await binding.accept(agent._pending_acceptance, scope.timeout)
                agent._pending_acceptance = None
            scope._agents[run_id] = agent
            if row.get("owned"):
                scope._owned.add(run_id)
            scope._save()
            binding.start()
            return agent
        except BaseException:
            await binding.close()
            raise


async def profiles(*, provider="codex", connection=None):
    return await (await resolve(connection).manager(provider)).profiles()


async def budgets(*, provider="codex", auth=None, connection=None):
    return await (await resolve(connection).manager(provider)).budgets(auth)
