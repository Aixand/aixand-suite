# Review a document with a conditional branch

`workflow.py`, independently authored `workflow.json`, and compiler output
`generated.json` represent the same workflow. The existing `verifier.verify`
operation checks whether a document contains `workflow`. The selected arm verifies
an acceptance or revision note; a final operation runs after either arm. Published
outputs use the original pre-branch result. These deterministic operations need
no credentials and create no managed agents.

From `workflow/ir` in the Suite checkout. The first command rewrites the checked-in
`generated.json`; review its diff before retaining it:

```sh
cargo run -p aixand-ir-cli --features frontend -- lower-python examples/branching/workflow.py > examples/branching/generated.json
cargo run -p aixand-ir-cli -- validate examples/branching/generated.json
cargo run -p aixand-ir-cli -- run examples/branching/generated.json --inputs examples/branching/inputs-true.json
cargo run -p aixand-ir-cli -- run examples/branching/generated.json --inputs examples/branching/inputs-false.json
cargo run -p aixand-ir-cli -- schema workflow --ir-version 0.2
```

In the existing Aixand Web Workflows page, connect using the existing workspace
access key and choose **Load Python branch IR** or **Load branching example**.
Both load into the same nested editor. Supply `task` under Run workflow and run:

- `A workflow`: `verify_1 → branch_1 (then) → verify_2 → verify_4`.
- `A project`: `verify_1 → branch_1 (else) → verify_3 → verify_4`.

Only the selected arm has operation events. The output `passed` is respectively
true/false. The independent verifier is a regular catalog operation with a Rust
binding, not a branch-specific primitive or new package. Runtime bindings for
Aixand agents and Carrier remain unchanged and can be used in either arm.

See [v0.2 semantics and limits](../../docs/branching-v0.2.md). Branch-local values
cannot be consumed after a branch; there are no branch outputs or implicit merges.
