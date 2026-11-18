# Aixand IR

Define, validate and execute versioned workflow operations in Rust. Portable v0.1 sequences and v0.2 branches use exact catalog contracts; agent readiness is not an application answer. Use [Runner](../runner/README.md) for durable jobs. Document versions are separate from crate releases.

## When to use IR

Read [When to use IR](docs/README.md).

## Installation

For source examples, use Rust 1.95+ and this workspace. No Python installation,
provider account, or external service is needed for the built-in verifier.
From `workflow/ir`, install the CLI locally with:

```sh
cargo install --locked --path crates/aixand-ir-cli
```

The command is `aixand-ir`. The examples below use `cargo run` so you can try the
checkout without installing a global command. Versioned crates and source
artifacts are described in [distribution](docs/distribution.md); optional SDK and
frontend features have additional dependencies in the [SDK setup](docs/integrations/sdk.md#sdk-environment-and-first-run) and [frontend guide](examples/python/README.md).

## Workspace

Read [Workspace](docs/architecture/composition.md).

## Try it

From `workflow/ir` with Rust 1.95+ (no provider or Python required):

```sh
cargo run -p aixand-ir-cli -- run examples/verifier.json --inputs examples/verifier-inputs.json
```

Inspect `result.passed` and `issues`. Failed verification is application data. This data-only example starts no service or agents. See [CLI commands and catalog selection](docs/development.md#commands-and-environments).

## Rust embedding

Read [Rust embedding](docs/lifecycles/execution.md#rust-embedding).

## Existing SDK integration

Read [Existing SDK integration](docs/integrations/sdk.md#sdk-environment-and-first-run).

## Conditional branching

Portable v0.2 adds [structured branches](docs/branching-v0.2.md), without loops, parallel document constructs, retries or durability. Separate [host graph APIs](docs/lifecycles/execution.md#host-graph-apis) can overlap independent operations. Try the [branch fixtures](examples/branching/README.md).

## Restricted Python frontend

Read the [restricted Python frontend guide](examples/python/README.md) for exact lowering, omission and diagnostics. The [generated fixture](examples/python/managed_codex_two_turns.json) and [historical execution evidence](examples/python/evidence/run.json) are retained; this cleanup did not repeat live execution.

## Specification and verification

- [v0.1 normative specification](docs/specification.md)
- [v0.2 branching extension](docs/branching-v0.2.md)
- [Branching implementation and verification](docs/branching-implementation.md)
- [Design decisions](docs/decisions.md)
- [Proposal requirement audit](docs/conformance.md)
- [Schema files](crates/aixand-ir/schemas/)
- [Portable operation catalogs](crates/aixand-ir/catalogs/)
- [Invalid document examples](examples/invalid/)

See [development checks](docs/development.md#commands-and-environments).

## Host-installed SDK applications

Read [Host-installed SDK applications](docs/integrations/sdk.md#application-configuration-and-cleanup).

## Component architecture

Read [Component architecture](docs/README.md).
