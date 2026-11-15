"""Capture executable code and tool contracts into the manager's owned library."""

from io import BytesIO
import hashlib
import json
from pathlib import Path
import sys
import zipfile

from . import PROTOCOL
from .contract import canonical, digest


def bundle(contracts):
    manifest = {
        "schema": "orchestration-mcp/bundle-1",
        "protocol": PROTOCOL,
        "contracts": contracts,
    }
    output = BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        content = {
            "__main__.py": b"from orchestration_mcp.transport import main\nmain()\n",
            "orchestration_mcp/contracts.json": canonical(manifest),
        }
        for name in ("__init__", "contract", "transport"):
            path = Path(__file__).with_name(name + ".py")
            content["orchestration_mcp/" + path.name] = path.read_bytes()
        # Captured stdio adapters must also work when a provider resolves the
        # Python executable outside the publishing virtual environment.
        import aixand_filesystem
        import aixand_local_runtime
        for package in (aixand_filesystem, aixand_local_runtime):
            source = Path(package.__file__).parent
            for path in sorted(source.rglob('*.py')):
                content[package.__name__ + '/' + path.relative_to(source).as_posix()] = path.read_bytes()
        for name, data in sorted(content.items()):
            info = zipfile.ZipInfo(name, (2024, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o400 << 16
            archive.writestr(info, data)
    return output.getvalue()


def publish(manager, contracts, *, publisher_id="orchestration"):
    artifact = manager.capture_artifact(bundle(contracts))
    statuses = {}
    # Revisions are per published definition, retained in the existing manager
    # transaction. Repeated startup is a read; concurrent startup converges.
    for group, value in sorted(contracts.items()):
        definition = {
            "command": sys.executable,
            "args": [artifact["path"], "--group", group, "--contract", value["digest"]],
            "startup_timeout_sec": 60,
            "tool_timeout_sec": 120,
        }
        try:
            previous = manager.managed_status(publisher_id, group)
        except Exception as error:
            if getattr(error, "code", None) != "not_found":
                raise
            previous = None
        revision = (previous or {}).get("upstream", {}).get("revision") or 0
        version = digest(definition)
        if previous is None or previous["upstream"].get("version") != version:
            revision += 1
        try:
            statuses[group] = manager.ensure_registered(
                publisher_id,
                definition,
                server_id=group,
                publisher_revision=revision,
                version=version,
            )
        except Exception as error:
            if getattr(error, "code", None) != "conflict":
                raise
            observed = manager.managed_status(publisher_id, group)
            if observed["upstream"].get("version") != version:
                raise
            statuses[group] = observed
    return {"artifact": artifact, "groups": statuses}


def accepted(manager, group, *, publisher_id="orchestration"):
    value = manager.resolve_managed(publisher_id, group)
    definition = value["definition"]
    args = definition.get("args", [])
    if len(args) != 5 or args[1:4:2] != ["--group", "--contract"] or args[2] != group:
        raise ValueError(
            "The accepted Suite definition needs a compatible bundled adapter"
        )
    path = Path(args[0])
    if (
        path.parent.resolve() != (manager.root / "artifacts").resolve()
        or not path.is_file()
        or path.stat().st_size > 16 * 1024 * 1024
    ):
        raise ValueError(
            "The accepted Suite adapter must be captured in the MCP library"
        )
    raw = path.read_bytes()
    if (
        path.is_symlink()
        or len(raw) > 16 * 1024 * 1024
        or path.stem != hashlib.sha256(raw).hexdigest()
    ):
        raise ValueError("The accepted Suite adapter artifact failed verification")
    with zipfile.ZipFile(BytesIO(raw)) as archive:
        manifest_path = "orchestration_mcp/contracts.json"
        manifest = json.loads(archive.read(manifest_path))
    if manifest.get("protocol") != PROTOCOL:
        raise ValueError("The accepted Suite broker protocol is unsupported")
    contract = manifest["contracts"][group]
    if (
        contract["digest"] != args[4]
        or digest({k: v for k, v in contract.items() if k != "digest"}) != args[4]
    ):
        raise ValueError("The accepted Suite tool contract failed verification")
    return value, contract
