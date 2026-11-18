# Aixand Runner Client

Python client for the local Aixand Runner protocol. Install
`aixand-suite-runner-client` and import `runner_client`. It connects through the
shared local-runtime IPC library; it does not install or start Runner, launch
agents by itself, or expose a remote HTTP API.

## When to use this client

Use it when a Python application needs to submit durable workflows, follow their
events, inspect results, or cancel work. For direct agent/message composition,
use [Aixand Python](../../../sdks/python/README.md). For execution definitions,
use [IR](../../ir/README.md). Runner owns scheduling and job storage.

## Installation

In your application's Python 3.11+ environment:

```sh
python -m pip install aixand-suite-runner-client
```

Install the [native Runner service](../README.md#installation) separately. The
client and service must use the same local state home and an OS identity allowed
to access its IPC endpoint. Do not start two services against one home.

## Submit your first job

This checkout includes a data-only verifier requiring no provider login. From
`workflow/runner`, start an installed Runner in one terminal:

```sh
runner --home .runner-python-demo serve
```

In another terminal, from that same directory and with the client installed:

```sh
python examples/submit.py --home .runner-python-demo --key python-verifier-demo
```

The [example](../examples/submit.py) submits [the verifier workflow](../examples/verify.json),
follows its events, and prints the final result. Expect a completed job and an
exported verifier result with `passed: true`. A successful submission only proves
acceptance. Inspect the final outcome and application result separately.

For an existing service, use its absolute home rather than creating the demo
service. A minimal connection check is:

```python
from runner_client import Client

client = Client(home="/absolute/path/to/runner-home")
print(client.health())
```

Replace the path with the actual local home; on Windows use its native absolute
path. `health()` verifies service connectivity, not workflow completion.

## Handle retries, errors, and cleanup

Keep the submission key and job ID. After a timeout, retry the exact submission with the same key or use `lookup(key)`; changed content conflicts. See [retry/error recovery](docs/lifecycles/recovery.md), [observation](docs/lifecycles/observation.md) and [operation reference](docs/reference/operations.md) for cancellation and native reconciliation limits.

When finished with the demo, stop its foreground Runner with Ctrl+C. Retain the
demo home for history, or remove only that disposable directory after service
shutdown. Closing a Python client request does not stop the service or its jobs.

## Further documentation

- [Runner installation and lifecycle](../docs/installation.md)
- [Local protocol and limits](../README.md#local-protocol-and-storage)
- [Workflow amendments and continuations](../README.md#editing-and-chaining-runs)
- [Client implementation](runner_client.py) and [package metadata](pyproject.toml)

[Suite](../../../README.md) · [Support](../../../SUPPORT.md) · [License](../../../LICENSE)

## Component architecture

Read the [component architecture docs](docs/README.md) for ownership, lifecycles, integrations and source/test maps.
