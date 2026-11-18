# Aixand Runner

Submit durable workflows, disconnect and return to their results. Runner is a local Rust service with retained jobs/events and 1–64 workers. Independent graph work may overlap; callers own effect conflicts. Use [IR directly](../ir/README.md) for process-owned execution or the [Python client](python/README.md) for submission.

## When to use Runner

Read [When to use Runner](docs/README.md).

## Installation

Use the [standalone Runner installer](https://installer.aixand.org/aixand-suite/runner)
for the published product, or use Runner as part of full Suite or Server.
Follow the [Suite platform requirements](../../README.md#platform-requirements)
for the published payloads. Standalone product installation preserves shared-store
ownership; it does not start a service or install login startup automatically.

For source development, the example below uses Rust 1.95+ and the sibling
`../ir` workspace. [Product installation](docs/installation.md) covers qualified
artifact builds, shared/private prefixes, state homes, and maintenance. Use a
separate explicit home for each service; never point two services at one home.

## Shared workflow graphs

Read [Shared workflow graphs](docs/lifecycles/scheduling.md).

## Native chat workflows

Read [Native chat workflows](docs/integrations/effect-hosts.md).

## Editing and chaining runs

Read [Editing and chaining runs](docs/lifecycles/plans.md#cli-editing-and-continuation-recipes).

## Run the MVP

From `workflow/runner` with Rust 1.95+ and sibling `../ir`, start the data-only verifier service:

```sh
cargo build --locked
./target/debug/runner --home .runner serve
```

In another terminal:

```sh
./target/debug/runner --home .runner submit examples/verify.json \
  --inputs examples/inputs.json --key verifier-demo
```

Retain the returned job ID and inspect `result JOB-ID` using the same home. Expect completed execution and `passed: true`; acceptance alone is insufficient. Follow the [inspection, retry and cleanup steps](docs/development/verification.md#pure-development-service).

### Verify and finish the example

Read [verification, reconnect and disposal steps](docs/development/verification.md#verify-and-finish-the-example).

## Run under Undercurrent

Read [Run under Undercurrent](docs/development/verification.md#run-under-undercurrent).

## Python client

Read [Python client](python/README.md).

## Operations and validation

Read [Operations and validation](docs/integrations/ir-sdk.md).

### Optional Aixand SDK operations

Read [embedded SDK setup](docs/integrations/ir-sdk.md#optional-embedded-sdk).

## Outcomes and restart behavior

Startup queues interrupted resumable native work for reconciliation; interrupted standalone IR and opaque SDK execution become uncertain. Shutdown suspends resumable work and requests cancellation/cleanup for nonresumable work. Cancellation provides no rollback. Read the [exact recovery and outcome contract](docs/lifecycles/recovery.md).

Portable IR bodies execute sequentially; graph dependencies allow independent overlap. Runner does not isolate external effects between jobs.

## Local protocol and storage

Read [Local protocol and storage](docs/reference/protocol.md).

## Development

Read [Development](docs/development/verification.md#commands-and-prerequisites).

## Agent context

Read [Agent context](docs/integrations/effect-hosts.md#agent-context-example).

## Effect hosts and resource capture

Read [Effect hosts and resource capture](docs/integrations/effect-hosts.md).

## Documentation

Read [Documentation](docs/README.md).

## Component architecture

Read [Component architecture](docs/README.md).
