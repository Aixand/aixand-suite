# IR implementation and conformance map

This map relates the supported IR contracts to implementation and focused checks. Requirements are grounded in the normative [specification](specification.md), portable artifacts, Rust implementation, and executable tests. The recommended design decisions are recorded in [decisions.md](decisions.md).

## Requirement evidence

Paths below are relative to `workflow/ir`. Tests are executable requirements, not substitutes for the specification.

| Contract | Authoritative implementation/artifact | Verification |
|---|---|---|
| Separate portable IR, catalogs, bindings and runner | Separate core, runner, verifier, SDK-adapter and frontend crates; SDK/PyO3 dependencies absent from core/runner manifests | `cargo tree -p aixand-ir`, `cargo tree -p aixand-ir-runner`; generic verifier execution |
| Workflow interface, required inputs, valid defaults, unknown supplied inputs, post-body outputs, empty maps | `model.rs`, `validation.rs`, runner `prepare` and `execute` | `explicit_null_defaults_survive_round_trip_and_required_defaults_fail`, `defaults_null_and_omission_are_distinct_and_inputs_are_checked`, `output_paths_are_evaluated_only_after_body_and_enforce_presence` |
| One root sequence, ordered effects, full invocation completion, failure stops later work | Closed `Sequence`/`Operation` variants; runner invocation loop | `sequence_retains_unused_effects_and_awaits_each_operation`, `invalid_outputs_are_never_published_and_stop_later_steps`, structural invalid corpus |
| Generic exact-version operation IDs, unique invocation IDs, no invocation output redeclarations | Identity model, catalog registry, semantic checker, schemas | `invocation_and_port_rules`, `structural_records_are_closed_and_versions_are_exact` |
| Literal, unified reference, object and array construction; nested literal expressions remain data | `Expression`, `Reference`, `evaluate`, direct target checks | `literal_contents_are_not_expressions`, `construction_checks_each_child_without_losing_heterogeneous_precision`, verifier constructed payload execution |
| Ordinary JSON, safe exact integers, finite binary64, bool distinct, no extra native value kinds | Strict parser, native `Value`, publication normalization, type checks and canonicalizer | `strict_json_rejects_duplicate_keys_unsafe_integers_nonfinite_and_surrogates`, `native_integral_floats_use_the_same_integer_representation_between_bindings`, scalar compatibility and JCS tests |
| Scoped opaque atoms, identity-preserving references, nested atoms, no serialization/fabrication | Core token identity, immutable `Arc` containers; separate scope payload store | `runtime_presence_and_opaque_identity`, `opaque_values_require_registered_live_scope_and_cannot_escape_json`, `fabricated_binding_output_is_rejected_even_with_correct_nominal_type`, nested opaque type test |
| Static paths, string key/index distinction, arbitrary data keys, presence diagnostics and runtime checks | Semantic path checker and evaluator | `paths_diagnose_uncertainty_and_distinguish_keys_from_indexes`, `runtime_presence_and_opaque_identity`, output presence test |
| Missing vs null; immutable snapshots vs mutable resources; no automatic text decoding | Presence-preserving default deserializer, untouched binding kwargs, selected snapshots, explicit decode operation | Default/omission tests, real SDK wait tests, real Carrier snapshot/ack test |
| Operation definition shape, exact matching, valid defaults, complete output records, descriptive semantics | Portable Aixand and verifier catalogs; catalog validation and runtime registry | Catalog validation, registration transaction test, invalid output tests, catalog documentation completeness check |
| Runtime metadata excluded from portable catalogs; one completion boundary; no automatic retry/ack/conversion | Closed schemas and separate `Binding` trait/registry | Unsupported-field corpus; uncertain-effect and explicit-ack tests |
| All nine structural/nominal kinds, nullable rules, object extra/required rules, no implicit narrowing | `model.rs`, `types.rs`, shared schema | Scalar/container and additional-property/nullable/nested-opaque compatibility tests; default/type errors |
| Session affinity and representation compatibility beyond nominal identity | Scope `get` downcast; SDK receipt validation | Foreign-session receipt test, fabricated/foreign/expired atom tests |
| Draft 2020-12 workflow/catalog/shared schemas, closed tagged variants, identifiers, duplicates | Three published schema files and strict JSON entry points | `schemas_and_examples_conform`, shared-definition parity, structural/invalid corpus tests |
| Stable JSON round-trip and RFC 8785 canonicalization | `json.rs` using `serde_json_canonicalizer`; no custom JCS algorithm | JCS number/UTF-16 ordering test and complete example round trips |
| Complete explicit research example | `examples/research-explicit.json` | Catalog semantic validation, SDK explicit receipt tests |
| Structural, semantic, preparation and runtime validation stages; contextual diagnostics | `schema.rs`, `validation.rs`, runner `prepare`/`execute`, `Diagnostic` and `Failure` | Structural corpus, invocation rules, all-bindings preparation, value/presence/invalid-output tests |
| Resolve every compatible binding and validate interface before effects | Preparation resolves the full sequence, then validates inputs/mode before execution | `missing_later_binding_is_detected_before_first_effect`, binding-conflict and interface tests |
| Resource cleanup registration, detach vs stop-owned, attached-resource distinction | `Scope`, `Cleanup`, SDK installation before invocation, existing SDK connection close | Preparation/primary-failure cleanup tests, owned-vs-attached test, partial setup failure test, repeated-get/explicit-stop test |
| Managed background failure propagation, cancellation, uncertain effects and primary error retention | Scope failure signal; Rust-to-asyncio cancellation; SDK `connection.wait_for`; failure details | Runner background/cancellation tests, real consumer failure test, pending SDK I/O cancellation/join test, uncertainty/partial-launch tests |
| Embedded opaque results vs standalone JSON lifetime; no transfer mechanism | `run`, `run_json`, `run_scoped_json`, recursive interface gate | Embedded/foreign/expired/escaping opaque tests and configured-scope preparation cleanup |
| Timeout result vs timeout failure, no partial record publication, no replay | Catalog behavior and SDK forwarding, complete-record validation | Real Carrier timeout distinction, invalid record and uncertain-effect no-retry tests |
| Faithful Python mapping, omitted vs explicit receipts, property lowering, final results, rejection of unsupported scopes/code | Optional Rust AST prototype; `examples/research.py`, implicit JSON example | `faithful_implicit_lowering_matches_hand_authored_document`, explicit/null/public-property test, unsupported-code test |
| Explicit future evolution; rejected alternatives remain absent | Closed versioned schemas; no DAG/control/retry/persistence fields; scope payloads separate | Unknown-field/unsupported-control corpus, forward/self reference tests; source and schema audit |
| Design decisions | `docs/decisions.md` and runtime policies | Direct consistency review against model, catalogs and scope APIs |
| Full included v0.1 scope and explicit excluded features | Normative specification, crate boundaries and closed schemas | All suites and source audit; no general compiler or provider-specific core behavior |
| Decisions, normative spec, valid/invalid examples, independent schema/validation library | Decisions/spec docs, examples, core crate | Schema/example/corpus tests and core-only test command |
| Small catalog covering spawn/send/wait/stop/mailbox/message/correlation/ack/extraction | `crates/aixand-ir/catalogs/aixand.json` (15 operations) | Every definition validates; SDK operation tests cover each dispatch mapping |
| Separate minimal runner with fake bindings | `aixand-ir-runner`; synthetic test bindings | Ordering/publication/failure/cancellation/scope tests |
| Real existing SDK bindings | `aixand-ir-aixand`, all production adapter/scheduling code in Rust | Actual Aixand/Carrier/Undercurrent classes tested over controlled runtime/HTTP boundaries |
| Independent package | `aixand-ir-verifier` and portable verifier catalog | Independent constructed-payload test; CLI execution returns typed passed/failed data |
| Optional frontend lowering | Optional `aixand-ir-frontend`; no general compiler in core | Equality with hand-authored implicit sequence, explicit receipts, unsupported-code rejection |

## Mandatory domain cases

| Domain case | Test evidence in `crates/aixand-ir-aixand/tests/sdk.rs` |
|---|---|
| Omitted versus null `after` | `real_sdk_wait_omission_null_explicit_and_screen_decoding` |
| Receipt without revision | `real_sdk_revisionless_receipts_and_foreign_sessions_fail` |
| Preserve previous eligible receipt after a revisionless send | `revisionless_second_send_preserves_prior_eligible_receipt` |
| Foreign-session receipt | `real_sdk_revisionless_receipts_and_foreign_sessions_fail` |
| Carrier delivery between direct sends | `real_carrier_delivery_between_direct_sends_preserves_wait_boundary` |
| Explicit application acknowledgment | `real_carrier_snapshots_are_immutable_and_ack_is_explicit` |
| Uncertain effects | `real_sdk_uncertain_effect_details_and_owned_cleanup` |
| Partial setup/launch diagnostics | `real_sdk_partial_setup_failure_retains_run_identity` |
| Managed consumer failure interrupts waiting | `real_consumer_failure_interrupts_carrier_reply_wait` |
| Cancellation joins pending work before cleanup | `pending_sdk_io_is_cancelled_and_joined_before_scope_close` |
| Shared handle state and explicit stop | `repeated_get_retains_handle_state_and_explicit_stop_is_not_repeated` |
| Wait result arrays and correlated reply without acknowledgment | `mailbox_wait_publishes_capabilities_and_reply_is_correlated_without_ack` |

Invalid binding output publication is tested in the runner suite with missing, wrong-type and extra outputs. A binding panic also becomes a contextual failure while cleanup still runs.

## Verification commands and limits

From `workflow/ir`, with the SDK fixture environment prepared:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test -p aixand-ir -p aixand-ir-runner -p aixand-ir-verifier
AIXAND_IR_SDK_SITE_PACKAGES="$PWD/.venv/lib/python3.14/site-packages" cargo test --workspace --all-features
cargo run -p aixand-ir-cli -- validate examples/research-explicit.json
cargo run -p aixand-ir-cli -- validate examples/research-implicit.json
cargo run -p aixand-ir-cli -- validate examples/team.json
cargo run -p aixand-ir-cli -- run examples/verifier.json --inputs examples/verifier-inputs.json
cargo run -p aixand-ir-cli --features frontend -- lower-python examples/research.py
```

The SDK suite imports the sibling SDKs and uses their real composition, receipt, Carrier client/message and cleanup behavior. Its runtime and HTTP boundaries are controlled fixtures. It does not establish availability of a live provider, manager profile, credentials, daemon, or messaging service. Live launches are not a conformance prerequisite. No visual editor is implemented in v0.1; its interoperable artifact is the same validated, versioned workflow document. The frontend prototype does not claim arbitrary Python support.
