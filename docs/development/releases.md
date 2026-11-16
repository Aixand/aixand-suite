# Component and product releases

Suite releases have three layers: registry packages, independent component/product
artifacts, and native applications assembled from a tested composition. The
workflows in this checkout prepare those layers. Local tests and build artifacts
do not establish a published release or native platform qualification.

## Distribution ownership

| Component | Registry | Installed Suite delivery |
| --- | --- | --- |
| Python SDK (`aixand-suite-python`) | PyPI | Rebuild its consuming environment |
| Runner Client (`aixand-suite-runner-client`) | PyPI | Rebuild its consuming environment |
| Connect (`aixand-suite-connect`) | PyPI | Signed companion payload |
| Vox (`aixand-vox`) | PyPI | Signed payload with private voice interpreter |
| Orchestration (`aixand-suite-orchestration-mcp`) | PyPI | Owning product engine |
| IR workspace public crates | crates.io | Rebuild consuming Rust products |
| Runner (`aixand-job-runner`) | crates.io and native product artifacts | Owning product engine |
| Server | No npm publication | Signed runtime payload or native Server setup |
| Web | No npm publication | Signed Web assets; Client embeds them in its native package |
| Desktop and Client | No language registry | Native installer |

Keep the monorepo. Existing namespaced tags select the owning component version;
Python `0.1.0b0` corresponds to product/tag spelling `0.1.0-beta`. Versions can
advance separately. Do not decrease published beta package versions to rename the
public launch alpha. Suite's version identifies a composition, not a requirement
that every component share its version.

## Build and registry validation

From the Suite root:

```sh
python3 -B scripts/check-release-versions.py
python3 -B scripts/release/registry.py python --component python-sdk --output build/python-registry
python3 -B scripts/release/registry.py cargo-plan --component ir --output build/crates-plan.json
```

The Python command uses a clean source copy, builds a wheel and source distribution,
rebuilds the wheel from that source distribution, compares package contents, and
checks name, version and licence metadata. It writes hashes in `registry.json` and
`SHA256SUMS`. Its output directory must be fresh.

**Python and Rust package releases** supports a manual validation-only run.
Python validation installs the wheel and checks imports in a fresh environment.
Vox installation is a large dependency operation; runtime/audio qualification is
separate. Component tags publish registry packages only after the corresponding
GitHub environment permits the job. A manual publishing run must select the exact
tag and matching component. No registry publication occurs during local tests.

Configure each PyPI project or pending publisher for repository
`Aixand/aixand-suite`, workflow `registry-release.yml`, and environment
`pypi-<distribution-name>` (for example, `pypi-aixand-suite-python`). Use the exact
distribution and environment names selected by that workflow.
The publish job uses OIDC; no PyPI token is needed. See
[PyPI Trusted Publishing](https://docs.pypi.org/trusted-publishers/using-a-publisher/).
Configure a restricted `CARGO_REGISTRY_TOKEN` in environment `crates-io` for Rust.
Restrict publishing environments to reviewed release tags before using them.

Rust release planning checks path dependencies for registry versions and orders
all local dependencies, including development dependencies. Publish IR through
its own release before Runner; Runner refuses to publish missing IR dependencies
implicitly. Its Windows Undercurrent dependency now declares `=0.1.0-beta`; that
exact external crate must also be available before publication. Runner's native
source inputs continue to use the pinned, checksum-verified Undercurrent source.
Cargo's full publish dry run needs dependencies to exist on crates.io, so a first
multi-crate publication cannot be fully dry-run against an empty registry.
Existing crate versions are refused rather than overwritten. After a partial
publication, inspect the retained `crates-result.json` and resolve the remaining
versions explicitly; the workflow does not silently resume a partial release.
See [Cargo publishing](https://doc.rust-lang.org/cargo/reference/publishing.html).

## Runtime baseline reuse

Published alpha.2 Runner/MCP handoffs declare macOS 26.5.1, Windows
10.0.26200, or Linux glibc 2.35 minimums. Full Suite and Server embed those
handoffs. Never lower a published manifest's baseline without rebuilding and
qualifying a new release. Explicit `AIXAND_RELEASE_SEQUENCE=0` build-only jobs
on older hosts instead build and installation-test unpublished local candidates.
Release builds retain the strict baseline check and canonical release identity.

**Build an independent component** accepts the three baseline inputs for Server
or Vox: `baseline-artifact-id`, `baseline-run-id`, and
`baseline-archive-sha256`. Select one exact target. Use the archive digest from the
reviewed Desktop baseline receipt, not from an untrusted download.

The workflow authenticates a successful first-party default-branch run before
fetching its archive. Source changes must belong to the selected component.
Changes to Server's native bridges, other components, or shared build inputs need
a cold runtime build. A cold verification run rejects baseline inputs.

Server recompiles its backend using the baseline dependencies. Vox copies the
baseline voice interpreter and dependencies, compares installed requirement
metadata, installs the new Vox wheel without dependency resolution, and runs
`uv pip check`. Changed Vox dependencies require a cold runtime build. A baseline
without a voice environment cannot supply Vox. Enable `include-voice` in the
native installer workflow when preparing a voice baseline.

Cold Server packaging stages the backend already compiled by the native builder;
it does not compile it a second time. Pure Python SDK/client artifacts build once
per automatic matrix instead of once per native target.

## Assemble a product composition

`compose.py` replaces selected runtime-owned payloads in a fresh copy of an exact
baseline. It checks archive hashes, native target, interpreter baseline identity,
component companion releases, payload roots and executable modes. It retains the
baseline's exact product kit and verifies the original runtime remains unchanged.

A local composition lock has these fields:

| Field | Meaning |
| --- | --- |
| `schema` | `1` |
| `version` | Suite/native package version |
| `sequence` | Positive application sequence greater than the baseline's sequence |
| `role` | `server` or `desktop` |
| `target` | Exact supported native target |
| `manifestSha256` | Reviewed baseline manifest hash |
| `modesSha256` | Reviewed baseline executable-mode hash |
| `components` | Array of `{id, file, sha256}`; `file` is relative to the lock |

Use actual values from verified release receipts. Libraries and product-engine
artifacts cannot be overlaid as runtime components.

```sh
python3 -B scripts/release/compose.py --runtime build/baseline/runtime --lock build/composition-lock.json --output build/composed
```

Add `--native-installers --desktop apps/desktop` on the matching native host to
package Desktop; Server packages its console setup. Desktop source version must
match the composition version. The output remains unqualified until native
installation checks pass. Runtime selection is quiesced at installation time by
the existing updater; composition preparation never changes an installed app.

**Assemble pinned product composition** reads a committed
`release/compositions/*.json` recipe. It has `{schema: 1, runtime, composition}`.
`runtime` holds the exact GitHub runtime archive `url` and `sha256`.
`composition` has the lock fields above, with each component expressed as
`{id, url, sha256}` instead of a local file. Only fixed Suite GitHub Release URLs
are accepted. The download command verifies bytes before extraction/assembly.
Previously released components may come from different commits and versions.
Client continues to use its existing Web/native assembly route without a backend.

Product kit replacement still uses `scripts/package-products.py` with explicit
qualified handoffs. Composition retains that kit; it does not replace Runner or
orchestration by copying a library or wheel over an installed product. Collect
those products' exact released handoffs when preparing the next baseline.

## Native qualification and GitHub Releases

Use a reviewed positive `release-sequence` when building native applications for
publication. Zero is the build-only default and cannot enter a signed application
update feed. Sequences are assigned by the release owner across workflows; do not
infer ordering from independent workflow run numbers.

Test each exact native installer for install, ownership, recovery, and uninstall
with data preserved. Retain the real platform evidence. `hosted.py` exports native
packages only when the qualification assertion matches their bytes, role, version,
source revision, sequence and all required checks. No workflow manufactures that
assertion from unit tests.

**Export qualified native release** accepts a committed
`release/qualification/*.json` index containing an `artifacts` array. Each row
names `target`, `sequence`, `package` under authenticated `build/release-inputs`,
and `qualification`, the path to actual platform proof. The index can be committed
before a build and point at proof later retained in that build's artifacts.
Select the native release tag as the workflow ref. Its output can feed signing
and GitHub release preparation.

**Prepare or publish GitHub release** accepts a tag and exact Actions artifact IDs
from a successful first-party run at that same tag commit. It rejects PR/fork
inputs and expired artifacts before download. It rechecks deliverables and writes
`composition.json` plus `SHA256SUMS`; archives are preserved, not rebuilt.
`publish: false` creates a draft when the workflow is run. `publish: true` creates
a public release. Public native releases require hosted qualification exports.
The workflow uses environment `github-release`; it never replaces existing assets.
Use this only when publication is authorized. Local implementation checks do not
run this workflow or create a draft.

## Signed updates and Cloudflare

**Prepare signed update delivery** uses environment `update-signing` and its
`UPDATE_SIGNING_KEY` secret. The key must match the public trust embedded in the
built applications and the installer service. The workflow writes it to a private
temporary file and removes that file after signing. The key is never an artifact.

Select the release tag and trusted build artifacts, plus a committed
`release/updates/*.json` descriptor. Component descriptors have `origin`, `role`,
`target`, `sequence`, and a `components` array of `{id, file, licenses}`.
`licenses` contains reviewed `{id, file}` entries. Application descriptors have
`product`, `version`, `sequence`, `origin`, `notes`, and `artifacts`; each artifact
names `target`, `kind`, `file`, and its exact `runtime` directory, or Client's
`metadata` file. Paths refer to authenticated `build/release-inputs` files.
Application descriptors may instead supply `runtimeArchive`, pointing at the
build's runtime tarball, and an optional reviewed `runtimeArchiveSha256`. The
workflow authenticates the producing Actions run first, verifies and extracts
that exact archive, checks its runtime inventory, and resolves its runtime path
for signing. Native installers themselves are never unpacked by this step. Signed application preparation requires enabled trust baked
into the original package.

Product descriptors select an exact native target and `products` entries with
`id`, canonical archive `file`, `qualification`, and `compatibleBuilds`. The
qualification report must record a successful native upgrade, restart and data
retention check for that exact product release and each permitted runtime build.
An engine-only test report cannot authorize a product feed. Product installation
uses the owning engine; it does not overlay libraries or reset an installation.

Feed `sequence` is a monotonic metadata revision. Native artifacts retain a
separate `releaseSequence`, identifying the actual compiled application. Feed
renewal advances metadata expiry and revision while preserving package version,
build, digest and release sequence, so renewal does not reinstall unchanged
software. Existing signed metadata and object paths remain immutable.

The private sibling installer repository registers and serves these feeds. Local
Cloudflare OAuth can deploy the service. Its optional GitHub renewal workflow
requires its own deployment credentials and remains disabled until configured;
local authentication is not copied into repository secrets.

The offline signers produce candidate feeds. `delivery.mjs` flattens their objects
into immutable GitHub assets and `delivery.json`, preserving the signed download
paths. The signing run retains original build inputs so the GitHub release
workflow can prepare both normal release files and signed delivery objects from
one authenticated run.

The sibling `aixand-installer` Worker has a separate, initially empty update catalog.
It serves feed envelopes and streams registered GitHub objects at
`downloads.aixand.org`, including Range/HEAD requests. It never redirects updater
clients to another origin or discovers latest releases during requests.

After an authorized public GitHub release, the installer repository command is:

```sh
npm run updates:register -- web/v0.1.0-beta
```

This previews registration after checking public GitHub asset bytes, feed
signatures, expiration, exact paths and monotonic sequences. `--write` explicitly
updates the local catalog. Native application feeds additionally require the
qualified native release already registered in the existing Suite application
catalog. Old immutable objects remain registered when a feed advances. Each feed
must be renewed before expiry using a new signed sequence.

Cloudflare deployment remains separate. The checked-in route configuration now
includes `downloads.aixand.org`; confirm its existing ownership/routing before an
authorized deployment. No deployment is performed by these release workflows.
The checked-in Suite update configurations remain disabled. For a future native
build, repository variable `SUITE_UPDATE_TRUST_JSON` can supply the reviewed public
configuration with `schema`, `enabled`, `origin`, and fingerprint-keyed `keys`.
The workflow validates Ed25519 public keys, writes a runner-temporary file, and
passes its path through `AIXAND_UPDATE_CONFIG`/`AIXAND_CLIENT_UPDATE_CONFIG`.
It does not edit source or inject private keys. An absent variable preserves the
disabled source defaults. Baseline reuse retains the trust already baked into that
baseline; it cannot retrofit updater trust into an old application. Enabling a public
channel requires a rebuilt installer with the intended enabled trust, qualified
native packages, registered public bytes and a deployed feed.

## Registry account setup

For PyPI, configure a GitHub Trusted Publisher for each of `aixand-suite-python`,
`aixand-suite-runner-client`, `aixand-suite-connect`, and `aixand-suite-orchestration-mcp`.
Use owner `Aixand`, repository `aixand-suite`, workflow filename
`registry-release.yml`, and environment `pypi-<distribution-name>`. For example,
Connect uses `pypi-aixand-suite-connect`. Existing projects use their
Publishing settings; new names use a pending publisher. No PyPI API-token secret
is required. When pending-publisher slots are full, publish the first three
projects before registering the orchestration publisher with environment
`pypi-aixand-suite-orchestration-mcp`. Vox is excluded from this alpha's publication.

For crates.io, the publishing account must have a verified email and permission
to publish the selected crate names. Store its API token as
`CARGO_REGISTRY_TOKEN`, either in the repository's Actions secrets or in the
`crates-io` environment. Limit the token to publishing new crates and updating
existing versions, with crate patterns `aixand-ir*` and `aixand-job-runner`.
Publish IR before Runner: Runner consumes the published IR crates and the
independently published `aixand-undercurrent-platform-windows` dependency.

The IR release contains `aixand-ir`, `aixand-ir-runner`, `aixand-ir-verifier`,
`aixand-ir-frontend`, `aixand-ir-aixand`, and `aixand-ir-cli`. The Runner release
publishes `aixand-job-runner`. Neither job needs access to owner-management or
yank permissions. Keep credentials in GitHub's secret storage, never source or
release artifacts.

## Local validation

```sh
python3 -B -m unittest discover -s tests/release -v
node --test tests/release/*.test.mjs scripts/runtime/component-updates.test.mjs
python3 scripts/checks/check-docs.py --root .
```

In `aixand-installer`, run `npm test` and `npm run build`. The build is Wrangler's
dry run. Windows/macOS/Linux native installation, audio behavior, registry
permissions and production Cloudflare routing require their own validation.


### GTK 3 GLib security backport

Desktop uses the reviewed local `apps/desktop/src-tauri/vendor/glib` source
because its GTK 3 dependencies require GLib 0.18. The registry version 0.18.5
contains RUSTSEC-2024-0429 (GHSA-wrw7-89jp-8q8g). The local copy applies the
upstream mutable out-pointer correction from gtk-rs/gtk-rs-core PR 1343,
commit `05dff0ee696f9bcd8617cd48c4b812d046d440cb`.

`AIXAND-SECURITY-BACKPORT.json` records the original crate digest and patched
file identities. The version checker verifies the reviewed file and ensures
Cargo uses this local source. The original copyright and MIT license are kept
with the source and included in the application's license assets.

Run the optimized regression before changing this backport:

```sh
cargo test --locked --release \
  --manifest-path apps/desktop/src-tauri/security-tests/Cargo.toml \
  --test variant-str-iter
```

The regression exercises forward, reverse, indexed, and final element access.
It passes with the backport; the same optimized test against the original
registry source crashes. Restore a maintained upstream dependency when GTK
compatibility permits, rather than removing this fix to change a scanner result.


### Standalone Runner and orchestration MCP delivery

The [product bundle exporter](../../scripts/release/product-bundle.py) wraps an
already qualified native product handoff. It preserves the artifact manifest,
product release identity, descriptor, and installed-product proof. It adds the
same product engine used by Suite, with a checksum-pinned Python bootstrap;
end users do not need Python, Rust, or uv installed separately.

```sh
python -B scripts/release/product-bundle.py runner \
  --handoff /path/to/qualified/runner/handoff --output /path/to/fresh/bundles
python -B scripts/release/product-bundle.py orchestration-mcp \
  --handoff /path/to/qualified/mcp/handoff --output /path/to/fresh/bundles
```

Supported qualified targets are Linux x86_64 GNU, macOS ARM64, and Windows
x86_64. Windows bundles use ZIP; POSIX bundles use tar.gz. The exporter rejects
links, unexpected artifact files, mismatched installed-product proof, and outputs
inside the handoff. It copies only the qualified inventory and known sidecars.
It does not rebuild the product or replace an existing local archive.

Publish these bundles to the owning component's namespaced GitHub release with
`COMPONENT-native-SHA256SUMS` and scoped native bootstrap qualification. Keep the
registry distribution files and their original `SHA256SUMS` unchanged. Never
replace public same-version bytes. The hosted registrar checks the public archive,
product/manifest identities, installed-product proof, and helper digest before
selecting a channel. Suite Shared can reuse the independently installed product
only when its release identity matches the kit; version labels alone are
insufficient. Keep bootstrap, installation-layer, and full application native
qualification scopes explicit.


Suite native builds pin published Runner and MCP bundles separately under
`suiteProducts` in `scripts/runtime/dependencies.lock.json`. A matching component
version reuses those verified handoff bytes instead of recompiling its product
kit. The reviewed source-content fingerprint must also match; changed source at
an already published version is rejected before downloading. Bump that component
version to build and qualify a new handoff, then register its public bytes and
update its source/asset pins. Generated build files and Markdown changes do not
invalidate a product pin. Keep the MCP tool workspace version aligned with its
own component, independently of the Suite application version.

The source fingerprint covers each product's own source and release configuration.
Upstream library updates do not silently replace dependencies inside an already
published product: its canonical bundle remains frozen. Bump the owning product
version when deliberately refreshing those bundled dependencies.

Rootful Linux container builds restore ownership of their marked build staging
tree to the invoking user before exporting baseline metadata. Rootless builds
already have the correct ownership and skip this step. Ownership changes do not
follow links or reach outside that dedicated staging tree.
