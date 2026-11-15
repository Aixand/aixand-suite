# Ratified v0.1 decisions

This implementation adopts the recommendations in proposal §13. The implementation language is Rust, as requested during implementation.

| Decision | Adopted behavior |
|---|---|
| Type representation | Small structural algebra; JSON Schema validates documents, not port compatibility |
| Opaque interfaces | Supported in a caller-owned embedded scope; rejected for standalone JSON interface types, recursively |
| Cleanup | Detach by default; stop-owned is an explicit runtime option; attached handles do not acquire ownership |
| Receipts | Nominal opaque `aixand.input_receipt@1`; no field traversal or implicit inspection |
| Namespace | Qualified case-sensitive operation IDs; unique exact identities in selected catalogs; no discovery service |
| Public facts | Separate `run_id` and nullable `address` outputs; selected session/message snapshots rather than reflected SDK records |
| Numbers | Safe exact integers and finite binary64; no boolean-to-number coercion; large exact quantities require package-defined strings |
| Initial catalog | Research and finite team flows plus explicit stop, attachment, inspection, screen decoding and message extraction; independent verifier package |
| Missing/null | Optional arguments without defaults remain absent; explicit null is preserved; workflow omission resolved at entry |
| Catalog format | `contract_version: "0.1"`, independent package version and exact operation versions; no version ranges |
| Runtime ABI | Rust `Arc<dyn Any + Send + Sync>` payload registry with scope membership and adapter checks; nominal equality alone is insufficient |
| SDK reuse | Rust PyO3 adapter retains the existing SDK objects and loop; no duplicate orchestration implementation |
| Frontend | Restricted optional Rust AST prototype for proposal §15.8; general compiler remains excluded |

No retry, persistence, automatic reattachment, streaming, branching, parallel scheduling, or speculative workflow fields have been added. Cancellation and timeouts do not establish absent external effects.
