"""Suite onboarding projections and profile operations over Agent Manager's public SDK.

This module owns no provider installer, credentials or environment registry.
"""
from copy import deepcopy
import asyncio
import time

from agent_manager import Error

SUPPORTED_PROVIDERS = ("codex", "opencode")
LOGIN_STATUS_MAX_AGE = 60


async def refresh_login(client, profile):
    """Reconcile external native sign-ins without probing on every catalog poll."""
    profile = deepcopy(profile)
    login = profile.get("login") or {}
    checked = login.get("checked_at")
    fresh = isinstance(checked, (int, float)) and 0 <= time.time() - checked < LOGIN_STATUS_MAX_AGE
    if profile.get("provider") == "codex" and not fresh:
        try:
            profile["login"] = await asyncio.wait_for(client.login_status(profile["profile"]), timeout=22)
        except (Error, OSError, asyncio.TimeoutError):
            # A failed probe is uncertainty, not evidence that credentials are missing.
            profile["login"] = {"state": "unknown", "verification": "unavailable"}
    return profile


async def inventory(client, clients):
    snapshot = deepcopy(await client.providers())
    for row in snapshot["providers"]:
        provider = row["provider"]
        if provider == "codex" and provider in clients and row.get("terminalUsable", row.get("usable", False)):
            row["profiles"] = list(await asyncio.gather(*(
                refresh_login(clients[provider], profile) for profile in row.get("profiles", [])
            )))
    return inventory_view(snapshot)


def login_ready(login):
    login = login or {}
    return login.get("state") == "signed-in" or (
        login.get("state") == "unknown" and login.get("verification") == "native-command-completed"
    )


def profile_view(profile, installed=True):
    profile = deepcopy(profile)
    login = profile.get("login") or {}
    ready = installed and (profile.get("provider") == "opencode" or login_ready(login))
    verification = "verified" if login.get("state") == "signed-in" else "unsupported"
    profile.update(identity=profile.get("profile_id"), auth=None, authMode="native")
    profile["readiness"] = {
        **profile.get("readiness", {}), "ready": ready,
        "reason": None if ready else ("Sign in to this native profile." if login.get("state") == "signed-out"
                                     else "Sign-in status needs checking.") if installed else "Install the provider CLI first.",
        "verification": verification if ready else "unchecked",
        "terminal": {"ready": ready, "verification": verification if ready else "unchecked"},
    }
    return profile


def inventory_view(snapshot):
    snapshot = deepcopy(snapshot)
    providers = [row for row in snapshot["providers"] if row["provider"] in SUPPORTED_PROVIDERS]
    for row in providers:
        row["capability"] = {
            **row.get("capability", {}), "provider": row["provider"],
            "authMode": "native", "savedAuth": False,
        }
        row["authentication"] = {**row.get("authentication", {}), "authMode": "native", "savedAuth": False}
        installed = bool(row.get("terminalUsable", row.get("usable", False)))
        row["capability"]["installed"] = installed
        row["profiles"] = [profile_view(profile, installed) for profile in row.get("profiles", [])]
        row["configured"] = installed and bool(row["profiles"])
    snapshot.update(providers=providers, configured=any(row["configured"] for row in providers),
                    inventoryComplete=len(providers) == len(SUPPORTED_PROVIDERS) and all(row.get("available") for row in providers))
    return snapshot


async def get_profile(client, name):
    return profile_view(await refresh_login(client, await client.get_profile(name)))


async def readiness(client, name):
    # Codex needs sign-in. OpenCode can use free models without sign-in.
    profile = await client.get_profile(name)
    if profile.get("provider") == "codex":
        # Codex has a qualified bounded native status probe. Recheck at explicit
        # acceptance rather than treating a cached login as current evidence.
        await client.login_status(name)
    doctor = await client.readiness(name)
    setup = doctor.get("setup") or {}
    installation = doctor.get("installation") or {}
    installed = bool(setup.get("enabled") and setup.get("executable") and not installation.get("error")
                     and (installation.get("compatibility") or {}).get("compatible", True))
    result = profile_view({**profile, "login": doctor.get("login") or profile.get("login")}, installed)
    return {**result["readiness"], "environment_id": profile["environment_id"],
            "profile_id": profile["profile_id"], "login": doctor.get("login")}


async def create_profile(client, arguments):
    if any(arguments.get(key) for key in ("auth", "claudeAccountId", "sdkCredential")):
        raise Error("Native profiles use their own provider login; saved-login assignments are unavailable")
    result = await client.manage_profiles(
        "create_profile", {"name": arguments["profile"], **({"model": arguments["model"]} if arguments.get("model") else {})},
        request_id=arguments.get("key"),
    )
    return {**result, "profile": profile_view(result["profile"])}


async def update_profile(client, arguments):
    changes = arguments["changes"]
    if set(changes) - {"model", "preferred", "preferIfUnset"}:
        raise Error("Native profiles own their provider login. Saved-login assignments are unavailable.")
    target = client.manager.resolve_profile(arguments["profile"])
    profile = await client.get_profile(target)
    if profile["revision"] != arguments["expectedRevision"]:
        raise Error("The profile alias changed. Refresh before retrying.")
    if changes.get("preferred") is False and profile["preferred"]:
        raise Error("Select another default profile before clearing this choice.")
    if "model" in changes and not profile["capabilities"].get("savedModels"):
        raise Error("This provider does not support a saved model selection.")
    if "model" in changes:
        await client.set_model(target, changes["model"], expected_revision=profile["environment_revision"])
    preferred = changes.get("preferred") is True
    if changes.get("preferIfUnset"):
        preferred = preferred or not any(row["preferred"] for row in await client.profiles())
    if preferred:
        await client.set_default_profile(target, expected_revision=profile["revision"])
    return {"profile": profile_view(await client.get_profile(target))}
