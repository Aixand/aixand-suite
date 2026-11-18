# Build and test Connect

Start with the owning boundary, then qualify the integration that calls it. Companion tests can establish receiver and helper behavior without proving that current Server dispatch exposes it. Use isolated state and fake providers; no paid or live provider calls are required for the component suite.

## Build from source

From the Suite root:

```sh
python3 -m pip install ./services/connect
python3 services/connect/build_companion.py build/connect/companion.pyz
```

See [packaging](packaging.md) for deterministic archive contents and platform requirements.

## Load the Server integration

`AIXAND_CONNECT_SOURCE` selects the directory containing `aixand_connect`; alternatively install it in the `AGENTS_PYTHON` environment. These loading settings do not supply the missing application dispatch described in [integration status](../reference/status.md).

## Run tests

From `services/connect`:

```sh
PYTHONPATH=. python3 -m unittest discover -s tests -v
```

On Windows the existing command is `py -3 -m unittest discover -s tests -v`; POSIX sender/snapshot and native process fixture coverage has platform skips. Avoid running tests directly in a checkout when preserving all source bytes is required: copy the component into an isolated temporary directory, disable bytecode writes, and run there.

| Test file | Coverage and evidence limit |
| --- | --- |
| [test_connect.py](../../tests/test_connect.py) | Real loopback HTTP pairing, streaming, checksum/no-overwrite, path constraints, cancellation tombstones, lock and receiver/sender restart recovery; no real NetBird API |
| [test_codex.py](../../tests/test_codex.py) | Fake native stdio process, approvals, thread/session binding, event gaps, mutation deduplication, observation and idle eviction; no provider login qualification |
| [test_managers.py](../../tests/test_managers.py) | Authenticated HTTP facade, argument allowlists, pinned interpreter/route, unavailable runtime, timeout uncertainty and bundled helper |
| [test_managed_conversations.py](../../tests/test_managed_conversations.py) | Optional SDK fixture workers, retained references, operations, approvals, no replacement/replay, legacy binding rejection; requires installed SDKs |
| [test_optional_resource_managers.py](../../tests/test_optional_resource_managers.py) | Base readiness independent of optional resource manager packages; requires installed Agent/Conversation libraries |
| [test_snapshot.py](../../tests/test_snapshot.py) | Git current/untracked source, exclusions, collision/traversal/link checks, checksums, no-overwrite and publication recovery |

## Cross-component review

[Server protocol tests](../../../../apps/server/src/agents/connect-protocol.spec.ts) validate input schemas. [Download tests](../../../../apps/server/src/connect/connect.spec.ts) verify artifact delivery. [Web Connect documentation](../../../../apps/web/docs/modules/connect.md) links browser fixtures; mocked sockets qualify interaction and presentation only. Consult [Server implementation status](../../../../apps/server/docs/implementation-status.md) before selecting historical bridge test commands: some referenced legacy test modules are absent.

For archive changes, build twice to temporary paths, compare hashes and inspect ZIP members. Check `--help`/`--version` without starting a listener. For publication changes, use the site sync script with an isolated Suite overlay: it checks manifest schema, one H1, prohibited markup, file links and Markdown anchors before producing preview output. Diagrams additionally require `accTitle` and `accDescr`; source-only diagrams need no fabricated screenshots.

The staged delivery report records checks actually run for this documentation change, including failures and environment restrictions. Commands described on this page are supported reading paths, not claims that every check passed in the current environment.

## Run from the Suite root

The original source-checkout command remains:

```sh
cd services/connect
PYTHONPATH=. python3 -m unittest discover -s tests -v
```
