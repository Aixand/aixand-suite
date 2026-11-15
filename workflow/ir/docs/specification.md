# Aixand IR v0.1 normative specification

The keywords MUST, MUST NOT and SHOULD express conformance requirements. This specification instantiates the recommendations in the original proposal. [Decisions](decisions.md) records the selected open-question defaults.

## Documents and serialization

A workflow MUST contain exactly `ir_version: "0.1"`, `inputs`, `body`, and `outputs`, with optional string `name` and `description`. Its body MUST be one `{"kind":"sequence","steps":[...]}`. Every step MUST be an operation with `kind`, unique invocation `id`, exact `operation: {id, version}`, and `inputs`. An invocation MUST NOT declare output ports. Empty sequences and empty interface maps are valid.

The schemas in `crates/aixand-ir/schemas` use [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12/json-schema-core). Every structural record is closed. The shared schema publishes expression, type, declaration, identity and node definitions; workflow/catalog schemas embed the same definitions for offline standalone use. Literal data objects and constructed data-object keys are unrestricted strings.

Workflow input/output names, operation port names and invocation IDs MUST match `^[A-Za-z_][A-Za-z0-9_-]*$`. Operation and opaque type IDs MUST match `^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$`. Names are case-sensitive. Exact versions are nonempty immutable strings, without whitespace or range operators (`*^~<>=|`). The core performs exact matching only; it does not resolve aliases or load code from identifiers.

Parsers MUST reject duplicate JSON keys at any depth, invalid Unicode, unsupported variants/fields/versions, and nonportable numeric values. JSON integer tokens are exact and MUST be in −9,007,199,254,740,991..+9,007,199,254,740,991. Floating point tokens denote finite binary64 values. Safe integral floats and integers have identical type semantics; the spellings `1` and `1.0` do not define distinct values. NaN and infinities are forbidden. Frontends MUST reject exact integer source literals that lose precision. Larger exact quantities require documented string encodings. No bytes, timestamps, decimals, sets, tuples, language objects or `undefined` are core value kinds.

Object key ordering is insignificant; array ordering is significant. Canonical serialization MUST use [RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785), including ECMAScript number formatting and UTF-16 property ordering. Pretty JSON is also valid. Canonicalization identifies a representation, not equivalent programs; it does not insert defaults, remove unused operations or rewrite references. A serialization round trip MUST preserve explicit null defaults and omitted arguments. Opaque atoms MUST NOT serialize, even when nested in arrays/objects.

## Declarations and catalogs

A workflow input contains `type`, optional ordinary JSON `default`, and optional `description`. Inputs without defaults MUST be supplied. Unknown supplied inputs MUST be rejected. Supplied values and defaults MUST satisfy their declared types. Defaults are entirely data; IR-looking objects in defaults never become references. Workflow omission is resolved at entry.

A workflow output contains `type`, `value` expression, and optional `description`. Every output MUST be evaluated and checked only after the whole body succeeds. There is no early-return node. `{}` returns no application value.

A catalog contains `contract_version: "0.1"`, `package`, and `operations`. Package metadata contains `id` and `version`, with optional `title` and `description`. An operation definition contains `id`, exact `version`, `inputs`, and `outputs`, with optional `title` and `description`. Its input declarations contain `type` and boolean `required`, with optional `default` and `description`. Defaults MUST satisfy the type and MUST NOT occur on required inputs. A non-required input without a default MUST stay absent. Unknown inputs MUST fail validation. Output declarations contain `type` and optional `description`; every output port MUST be present on success. An unavailable value MUST use a nullable type. An operation with no outputs MUST return `{}`.

Selected catalogs MUST NOT conflict on exact operation identities. Registration is transactional. Portable contracts MUST NOT include imports, executable names, endpoints, command lines, credentials, client instances, adapters, cleanup hooks or implementation settings. Runtime bindings separately associate the full immutable definition with an implementation. Missing, duplicate or incompatible bindings MUST fail preparation.

Each operation MUST document completion, side effects, omission/null semantics, affinity, failure/cancellation and uncertain effects. The bundled catalogs carry this documentation in their descriptions. Operation, package, IR, SDK and executable artifact versions are independent.

## Expressions and runtime values

The only expressions are:

| Expression | Required fields | Behavior |
|---|---|---|
| Literal | `kind: "literal"`, `value` | Entire value is ordinary JSON data, including IR-looking nested objects |
| Input reference | `kind: "ref"`, `source: "input"`, `name` | Reads a declared workflow input |
| Step reference | `kind: "ref"`, `source: "step"`, `step`, `output` | Reads an earlier invocation's declared output |
| Object | `kind: "object"`, `fields` | Evaluates each field expression into a new immutable object |
| Array | `kind: "array"`, `items` | Evaluates expressions in array order into a new immutable array |

References have optional static `path`, default `[]`. String segments select object keys and nonnegative safe integer segments select array elements. `"0"` and `0` differ; dots/slashes are ordinary key characters. Missing keys, out-of-range indexes, null traversal and opaque traversal MUST fail. A reference MUST NOT execute operations, await producers, do remote I/O or inspect opaque fields. Wildcards, computed indexes, interpolation, optional chaining and method dispatch are not expressions.

For step position i, every nested step reference MUST target a position less than i. Unknown inputs, producers or output ports MUST fail validation. This excludes cycles and forward/self references. Unused results remain valid; their producing operations MUST still execute because of possible side effects.

Published data MUST be immutable. Copying an opaque atom MUST preserve identity without cloning or closing its resource. Opaque atoms can be nested only where types permit them. A handle's mutable state remains package-owned. Acknowledging a message MUST NOT change a previously published snapshot; a separate inspection can publish a fresh one. Text MUST NOT be automatically interpreted as JSON, and terminal bytes MUST be decoded by an explicit package contract.

## Types and compatibility

Descriptors have `kind`: `null`, `boolean`, `integer`, `number`, `string`, `array`, `object`, `json` or `opaque`. `array` additionally requires `items`. `object` requires `properties` and a unique `required` list; every required property MUST be declared. `additional` defaults to `false`, or contains a descriptor for additional values. `true` is not a valid additional-property descriptor. `opaque` additionally requires exact nominal `id` and `version`. Non-null/non-json types can contain `nullable: true`. `json` recursively excludes opaque atoms and already permits null.

Compatibility is directional: every possible source value MUST satisfy the target contract. Identical scalar types are compatible; integer flows to number, not generally conversely. Boolean is never numeric. Nullable sources cannot flow to non-nullable targets. Arrays check element types. Objects check guaranteed required properties, declared optional properties, compatible property values and all possible additional properties. Closed targets reject possible extras. Opaque compatibility requires identical nominal ID and version; runtime representation and affinity require additional binding checks.

JSON-only types can flow into `json`; `json` cannot flow into narrower types without an explicit validating package operation. No string-to-number, structural-to-opaque, or other implicit conversion is performed. Literals and constructed values are checked directly against the target, so heterogeneous number literals can form a number array without general union types.

Known impossible paths MUST be rejected statically. Optional properties, array indexes and potentially null/dynamic containers MUST produce a `runtime_presence` diagnostic and MUST still be checked during evaluation. Warnings do not establish presence or narrow a `json` value. Inheritance, arbitrary unions, recursive descriptors, dependent/refinement types and unrestricted JSON Schema port typing are excluded.

## Validation and execution

Validation has three boundaries:

1. Structural validation requires only the document: supported schema, closed shapes, syntax, duplicate keys and portable values.
2. Semantic validation requires catalogs: unique invocation IDs, exact operations, complete input contracts, references/order/ports, type compatibility, defaults and output promises. Diagnostics identify JSON Pointer locations and, for steps, invocation and operation identity.
3. Preparation/runtime checks additionally require bindings, supplied values and scope information. All bindings and workflow inputs MUST be validated before workflow effects begin. Execution mode MUST support the entire workflow interface, including nested opaque types.

An invocation evaluates inputs, inserts only declared defaults, validates arguments, invokes one resolved binding, waits for completion, validates the complete output record, and publishes that record atomically. Only then can the next step start. No partial successful output record is published. Failure stops later operations and workflow output evaluation. There is no automatic retry, acknowledgment, conversion or scheduling from dependency edges.

Bindings may implement local synchronous computation or asynchronous external work. Their completion boundary is contractual. Spawn may leave a process running; send completion establishes terminal delivery; wait establishes readiness; correlated Carrier replies establish application-visible results. These MUST NOT be conflated.

The runner exposes observations and structured failures outside the workflow. A failure has `code`, `message`, optional structured `details`, with invocation/operation context added by the runner. Cleanup errors are retained alongside the primary failure. A timeout or cancellation MUST NOT be interpreted as rollback or as proof that an external mutation had no effect. Failed mutations MUST NOT be replayed automatically. Logical one-invocation-per-step is not an exactly-once external effect guarantee.

## Scopes and bindings

Scopes provide configuration/credentials, shared clients, opaque payload storage, cleanup and background failure reporting. A token MUST be registered in the accepted live scope and accepted by the binding's native adapter. Nominal agreement alone does not imply ABI compatibility. Session-affinity checks remain in the SDK binding.

Retaining/dropping a token MUST NOT confer ownership or close a resource. Bindings MUST register cleanup before partial setup can fail. Cleanup MUST distinguish detach from stopping owned resources and MUST NOT stop attached resources solely because the scope ends. Background failures MUST interrupt pending affected work. Cancellation MUST be forwarded to pending SDK work, and SDK cleanup MUST join its consumers and work before the loop closes.

Embedded execution may accept/return opaque values only in a compatible caller-owned live scope. Standalone JSON execution accepts/returns ordinary JSON only and rejects opaque interface types during preparation. v0.1 defines no lifetime transfer, resource serialization, automatic reattachment or durable execution state.

The Aixand binding MUST retain native agent identity/state, leave omitted `after` absent, pass explicit null as `None`, and forward explicit receipts without substituting or inspecting fields. The SDK enforces revision and session affinity. Carrier deliveries MUST NOT retarget the latest direct-send boundary. Snapshot outputs contain only deliberately selected fields. `carrier.mailbox.wait` timeout is data; `carrier.message.wait_for_reply` timeout is failure. Application acknowledgment is explicit; private agent acceptance remains SDK plumbing.

## Non-goals and evolution

v0.1 has no branching, loops, parallel blocks, DAG scheduler, streaming outputs, consumer/callback nodes, catch/retry policies, triggers, queues, distributed leases, persistence, replay, checkpoints, recovery, process supervision or readiness detector. Portable definitions do not imply portable execution state. Future control constructs require a new IR version; older validators MUST reject them rather than silently ignore semantics. The optional restricted AST prototype is separate from the core; unsupported source and cleanup scopes MUST be rejected.
