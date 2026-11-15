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
| Connect (`aixand-connect`) | PyPI | Signed companion payload |
| Vox (`aixand-vox`) | PyPI | Signed payload with private voice interpreter |
| Orchestration (`aixand-orchestration-mcp`) | PyPI | Owning product engine |
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
`Aixand/aixand-suite`, workflow `registry-release.yml`, environment `pypi`.
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
`aixand-suite-runner-client`, `aixand-suite-connect`, and `aixand-orchestration-mcp`.
Use owner `Aixand`, repository `aixand-suite`, workflow filename
`registry-release.yml`, and environment `pypi-<distribution-name>`. For example,
Connect uses `pypi-aixand-suite-connect`. Existing projects use their
Publishing settings; new names use a pending publisher. No PyPI API-token secret
is required. When pending-publisher slots are full, publish the first three
projects before registering the orchestration publisher with environment
`pypi-aixand-orchestration-mcp`. Vox is excluded from this alpha's publication.

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
