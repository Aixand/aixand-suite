# Companion packaging and platforms

The downloadable companion is a deterministic Python zipapp, not a native installer or background service. Python 3.11+ and a running companion process are required on the receiving device. File transfer has no third-party runtime dependency; optional managed conversations need compatible installed libraries in a selected interpreter.

## Build contract

From the Suite root, preserve the existing commands:

```sh
python3 -m pip install ./services/connect
python3 services/connect/build_companion.py build/connect/companion.pyz
```

`./dev.sh prepare` also builds the archive. Frontend `npm run dev` and `npm run build` do not rebuild it. Rebuild after companion source changes. [build_companion.py](../../build_companion.py) fixes ZIP timestamps, file order and modes, includes LICENSE and a generated entry point, and explicitly includes receiver/protocol/Codex/snapshot/workspace/manager/profile modules. It excludes `service.py`, tests and optional dependency packages. Consequently sender-side snapshot building is not an advertised zipapp capability, though receiver-side unpacking is bundled.

[pyproject.toml](../../pyproject.toml) defines the `aixand-connect` entry point and optional `managers` extras. Optional resource capture additionally imports orchestration MCP support at request time. Inventory reports absent optional packages rather than installing them.

## Server distribution boundary

[ConnectController](../../../../apps/server/src/connect/connect.module.ts) serves `GET /connect/companion`, selecting absolute `AIXAND_CONNECT_COMPANION` or `build/connect/companion.pyz` relative to Server's working directory. It rejects missing, symlink, empty or over-16-MiB artifacts, returns private/no-store ZIP download headers, and never rebuilds or executes the archive. [connect.spec.ts](../../../../apps/server/src/connect/connect.spec.ts) tests that boundary. Server's application authentication applies separately from companion bearer pairing.

`AIXAND_CONNECT_SOURCE` in [python.ts](../../../../apps/server/src/agents/python.ts) adds the package source path to the bridge environment; installing into `AGENTS_PYTHON` is another loading option. Path configuration does not restore the [missing Connect application handlers](../reference/status.md).

| Platform concern | Present source and limitation |
| --- | --- |
| Sender | POSIX directory-descriptor flags; intended Linux Suite host; sender tests skip non-POSIX |
| Receiver | Windows/macOS/Linux code paths; hard-link-capable destination filesystem required, such as NTFS/APFS/ext4 |
| Bind | Literal private IPv4, TCP 47831 default; firewall/tunnel policy external |
| Direct Codex | Native binary and native login on device; Windows native execution remains unverified |
| Managed chats | Helper readiness explicitly requires POSIX; Agent and Conversation packages together |
| Terminal/desktop | No interactive terminal attachment or remote desktop implementation in this component |
| Windows storage | Use user-specific ACLs; POSIX chmod semantics do not establish equivalent ACL enforcement |

See [receiver setup and pairing qualification](setup.md) for exact launch examples and restart instructions. See [verification](verification.md) for fixture scope and the [retained UI note](../reference/retained-ui.md#historical-qualification-note) for limited historical observations.
