# Development and verification boundaries

Start with the entire [single-file client](../../runner_client.py), then read [protocol models](../../../src/model.rs) and [service dispatch](../../../src/service.rs) for the affected operation. Review [transport](../integrations/transport.md) before changing framing or endpoint behavior. There is no generated schema or separate client model module to update.

## Source and test map

| Concern | Implementation | Verification source |
| --- | --- | --- |
| Home, request framing, wrapper fields, exceptions | [runner_client.py](../../runner_client.py) | [Python client tests](../../../tests/python/test_client.py) |
| Admission key/digest, cancellation fence, event paging | [store.rs](../../../src/store.rs), [model.rs](../../../src/model.rs) | [jobs.rs](../../../tests/jobs.rs) |
| Actual IPC and process restart | [service.rs](../../../src/service.rs), [transport.rs](../../../src/transport.rs) | [process.rs](../../../tests/process.rs) |
| Plan admission, amendments and child registration | [plans.rs](../../../src/plans.rs) | [amendments.rs](../../../tests/amendments.rs) |
| Packaging | [pyproject.toml](../../pyproject.toml) | Installed-package import and dependency checks in the target environment |

## Focused commands

From `workflow/runner`, with Python 3.11+ and the declared local-runtime dependency available:

```sh
PYTHONPATH=python python -m unittest discover -s tests/python -v
```

This source-tree command tests the checkout module. In a disposable environment, install the checkout to test package imports:

```sh
python -m pip install ./python
python -m unittest discover -s tests/python -v
```

The Rust live-socket test invokes `python3` by default with checkout `PYTHONPATH`; `RUNNER_TEST_PYTHON` selects a Python interpreter containing the transport dependency. From the same Runner directory:

```sh
cargo test --locked --test process python_client_and_cli_use_the_live_socket_protocol
cargo test --locked --test jobs
cargo test --locked --test amendments
```

These are suggested scoped checks, not claims that all have run for this documentation change. Retain the broader exact commands in [Runner development](../../../README.md#development).

## Existing verifier path

The existing [client README](../../README.md) retains installation and demo instructions. From `workflow/runner`, use separate terminals:

```sh
runner --home .runner-python-demo serve
```

```sh
python examples/submit.py --home .runner-python-demo --key python-verifier-demo
```

The [example](../../../examples/submit.py) uses [verifier workflow](../../../examples/verify.json) and [inputs](../../../examples/inputs.json). A successful run demonstrates local submission, observation and data-only execution; it does not qualify providers. Inspect `completed` and exported `passed: true` separately. The client never auto-starts the service.

## Implementation-status gaps

| Current boundary | Verification implication |
| --- | --- |
| Four Python mock tests cover explicit home/key framing, structured errors, truncation and request oversize | No dedicated Python tests for every wrapper, home precedence, nonfinite numbers, malformed success shapes, response boundary or follow loop |
| No persistent transport or automatic reconnect | Caller recovery policy and cursor persistence need their own application tests |
| No type models or full response-schema validation | Preserve realistic malformed-peer tests when strengthening validation |
| Shared local-runtime owns Windows descriptor/ACL behavior | Linux mock tests cannot establish Windows correctness |
| Native reconciliation and edit support depend on engine/state | Method presence is insufficient evidence of availability |
| Data-only verifier and fixture tests avoid live effects | Provider readiness and actual remote cleanup require separate qualification |

The docs publish architecture and source contracts, not a claim of live cross-platform qualification. No screenshots are needed for this non-UI component.

## Source submission example

The client uses the shared local-runtime IPC library, without agent or IR
dependencies. With Python 3.11+, install the published client using
`python -m pip install aixand-suite-runner-client`. For source development from
`workflow/runner`, install `python -m pip install ./python`, or use the checkout
with its declared dependencies installed:

```sh
PYTHONPATH=python python examples/submit.py --home .runner
```

```python
import json
from pathlib import Path
from runner_client import Client

client = Client(".runner")
accepted = client.submit(
    json.loads(Path("examples/verify.json").read_text()),
    {"title": "Design", "body": "A workflow invokes operations."},
    key="my-app:verify-1",
)
job_id = accepted["job"]["id"]
for event in client.follow(job_id):
    print(event)
print(client.result(job_id))
```
