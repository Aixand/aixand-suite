# Build and publish language packages

Use this maintainer procedure for the current checkout. Read the [release map](../releases.md)
for distribution ownership. Commands run from the Suite root unless stated otherwise.

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

