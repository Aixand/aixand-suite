# Aixand Python

Compose native agent sessions, durable messages and runtime handles from Python. Install `aixand-suite-python`; import `aixand`. Requires Python 3.11+. Agent Manager, Carrier and Undercurrent retain their own service responsibilities.

## When to use this SDK

See [when to use this sdk](docs/README.md).

## Installation

In your application virtual environment:

```sh
python -m pip install aixand-suite-python
```

Prepare provider executables, an authenticated profile and a running Undercurrent daemon separately. Plain agents without `address=` do not contact Carrier. Start with the [first direct agent](docs/lifecycles/agent-lifecycle.md#first-direct-agent).

## Install from this workspace

See [install from this workspace](docs/development/verification.md#setup-and-exact-existing-commands).

## Canonical API: no required application object

See [canonical api: no required application object](docs/lifecycles/agent-lifecycle.md#first-direct-agent).

## Verify the first agent

See [verify the first agent](docs/lifecycles/agent-lifecycle.md#first-direct-agent).

## Optional connection scope

See [optional connection scope](docs/architecture/composition.md#explicit-connection-example).

## Carrier-bound agents

See [carrier-bound agents](docs/integrations/carrier.md#bound-agent-illustration).

### Services and ordinary consumers

See [external service setup](docs/integrations/carrier.md#start-an-external-service) and the [ordinary consumer recipe](docs/integrations/carrier.md#ordinary-application-consumer).

### Errors, ownership, and recovery limits

See [recovery](docs/lifecycles/recovery.md), [ownership](docs/architecture/ownership.md), and [supervised reply waits](docs/lifecycles/cleanup.md#supervised-reply-wait).

## Runnable examples

See [runnable examples](docs/development/verification.md#examples-are-different-evidence).

## Validation

See [validation](docs/development/verification.md#setup-and-exact-existing-commands).

## Restore a live Carrier binding

See [restore a live carrier binding](docs/lifecycles/recovery.md#restore-contract).

## Inherited agent context

See [inherited agent context](docs/architecture/composition.md#inherited-context-example).

## Component architecture

See [component architecture](docs/README.md).

[Suite](../../README.md) · [Runner client](../../workflow/runner/python/README.md) · [Support](../../SUPPORT.md) · [License](../../LICENSE)
