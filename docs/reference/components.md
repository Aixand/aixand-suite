# Component source and activation contract

Use this reference for Suite-wide source, version, and activation boundaries.
The [documentation index](../README.md#find-a-component) maps components to their
entry points; [ownership](../architecture/ownership.md) identifies state authority.

The development checkout declares component boundaries in
[release/components.json](../../release/components.json).
[components.py](../../scripts/release/components.py) validates manifests,
normalizes supported Python prerelease spellings, orders dependencies and selects
affected consumers. Component versions may diverge; the Suite version is a
separate composition label.

| Activation owner | Components | Meaning |
| --- | --- | --- |
| `runtime` | server, web, connect, vox | Runtime-managed payload |
| `native-installer` | desktop | Native shell installer |
| `product-engine` | orchestration-mcp, runner | Product installation engine |
| `consumer-build` | ir, runner-client, python-sdk | Library consumed by another build |

Each catalog entry names a root, owning manifest, format, kind, activation owner,
dependencies and explicit check/build argument arrays. Source build commands are
not activation commands. Matching version labels do not establish compatibility.
The catalog must remain consistent with actual manifests and package inputs.

The [artifact tooling](../../scripts/release/artifacts.py) and runtime updater
are separate implementation boundaries. This page records the current source
contract, not proof that independent installed updates or rollback are qualified.
Reconcile this contract when release tooling changes. No feed publication or
channel enablement is implied.

## Build, review and activate

`python scripts/release/build.py --component ID --target TARGET --output FRESH_DIR`
builds one component locally. Source checks select affected consumers through
`release/components.json`; component tags must match their owning version.
The orchestration product resolves its own version and local dependency pins
from the corresponding Python manifests.

Desktop and Client share a source component but retain distinct native roles.
`desktop/vVERSION` builds Desktop; `client/vVERSION` builds Client. Manual
component builds accept `--component desktop --role desktop|client` or the
`--component client` variant. Native builds must match the host target, and a
supplied runtime must match its recorded platform and architecture. Web component
archives retain their declared target; do not reuse one across targets. Python SDK and
Runner Client releases finish with wheel/source distributions rather than
runtime activation payloads.

Independent Runner builds assemble Runner, IR and pinned Undercurrent sources
inside fresh build inputs. The Windows adapter path remains inside that tree;
a developer sibling checkout is not a release prerequisite.

Runtime candidates are size/hash checked, extracted into immutable workspace
objects and inventoried before selection. The full reviewed plan includes exact
companion releases, license hashes, blockers and required restart consent.
Server and Vox payloads built against a private runtime retain that runtime's
build identity and cannot activate against a different interpreter/ABI baseline.
Changed plans or active work prevent activation. Recovery retains the previous
selection; starting new stateful code prevents automatic downgrade.

Use the [update controls](../../apps/web/docs/updates.md) for installed actions.
Whole-application updates reset independent runtime selections to the incoming
package baseline after retaining a recovery snapshot. Independent product and
consumer-build releases keep their own activation owners.

Fixture validation does not qualify native Windows/macOS/Linux installation,
OS authorizations, live provider behavior or public feed availability.

## Publication and composition

[Release workflows](../development/releases.md) own registry publishing, explicit
GitHub release preparation, pinned runtime composition and signed Cloudflare
delivery. Build-only workflows remain read-only; separate manually selected
workflows prepare or publish GitHub releases and signed update candidates.
Native installation qualification is still required before promotion.

## Dependency-aware build-only CI

`python scripts/release/build_plan.py --base BASE --output build/plan.json`
uses a Git diff to report changed components, transitive consumers, dependency
order, compile matrix and assembly roles. Use `--paths-file FILE` outside a Git
checkout, or repeat `--component ID` and `--target TARGET` for an explicit rebuild.
Client remains a Desktop source variant. Web-only diffs compile Web for each
requested target and select Desktop/Client assembly, with no Server, Runner or
native-shell compilation in that automatic build run.

The **Dependency-aware build-only plan** workflow runs the compile matrix and
uploads its JSON plan, exact build identities and measured timing reports.
It does not automatically discover or promote a runtime baseline. Native roles
listed by a Web-only plan require the separate manual assembly route below.
Manual `clean-build` runs use fresh tool-cache paths without restoring artifact,
npm, uv or compiler caches. Enable `repeat-build` to measure a second local
verified repeat. Builds run on source changes or explicit dispatch.

The component workflow uses `build.py --cache PATH --timing-report FILE`.
Final output caches use exact source/toolchain/target/role identities and verify
bytes and executable modes before reuse. Only default-branch or tag builds
restore/save final caches; PR outputs never become trusted release inputs.
Compiler/download caches use stable paths and may restore compatible prefixes.
The local `build.py --clean-build` flag bypasses final outputs while retaining
tool caches. CI's `clean-build` input additionally disables all persisted cache
restores and selects a separate clean cache root. Full Linux native jobs prepare
the wrapper's exact builder image before identity calculation; cached dispatches
retain that image ID instead of rebuilding its mutable tag during the build.
Timing JSON reports actual cache status, build dispatches and elapsed phases;
it is evidence of that run, not a promised speedup.

For a frontend-only native build, manually run **Desktop, Client and Server
installers** on the default branch with one exact `target`, a
`baseline-artifact-id`, its `baseline-run-id`, and
`baseline-archive-sha256`. Obtain the archive digest from the reviewed cold-build
receipt (`desktop/baseline-identity.json` in that Actions artifact), not from an
untrusted download. The artifact must belong to a successful default-branch run
in this repository; PR/fork baselines are rejected before download. The digest
pins the complete Desktop runtime archive, including its inventory and modes.
The workflow compares that run's exact source commit with the current checkout
before downloading: backend, product, shared build-input or lock changes require
a full native build. Web/Desktop-only and documentation-only differences can
reuse the baseline. This manual route retains its exact backend/product releases;
it does not automatically discover a baseline or infer compatibility from versions.

That route builds target-specific Web, verifies the pinned archive, then invokes
`assemble.py --native-installers --desktop apps/desktop` separately for Desktop
and Client with pinned Web bytes. Desktop also receives the verified runtime
manifest/mode identities; Client requires no local backend. Existing native
packaging and runtime verification run, while Server, Runner, products and Vite
are not rebuilt during assembly. Receipts preserve outstanding native
installation qualification. Omitting baseline inputs, or selecting `clean-build`,
uses the full cold native pipeline. These build and assembly workflows are build-only with read-only contents
permission; no GitHub Release, signing publication or feed update occurs in them.
