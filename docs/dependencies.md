# Published dependencies

Suite owns `workflow/runner`, `workflow/ir`, and
`mcps/orchestration`. The independent manager repository is
[`Aixand/manager-suite`](https://github.com/Aixand/manager-suite), with five
individually published manager products. Orchestration MCP is built by Suite.

## Development

From the Suite root:

```sh
./dev.sh prepare
```

This creates `.venv` using Python 3.12.14, checks the downloaded first-party wheel
hashes, builds the Suite-owned Python packages, and verifies installed dependency
compatibility. Server uses this interpreter automatically. Preparation does not
start services, change provider accounts, or install global commands. Node packages
and native bridges retain their component build commands.

To use sibling source checkouts deliberately:

```sh
./dev.sh prepare --local-sources
```

The contributor checkout directory remains `../manager-suites`; its GitHub
repository name is singular. Libraries, Carrier and Undercurrent use
`../aixand-libraries`, `../carrier` and `../undercurrent`. Per-package
`AGENTS_MANAGER_SOURCE`, `CONVERSATIONS_MANAGER_SOURCE`, `CARRIER_SOURCE` and other
existing `*_SOURCE` overrides also remain supported. Packaged workers ignore
source overrides.

Vox retains its separate `services/vox` interpreter and lockfile. It uses published
external packages by default; its speech stack is qualified separately.

## Release inputs

`scripts/runtime/dependencies.lock.json` records external first-party package
versions, wheel URLs and SHA-256 hashes; native product release tags, archive URLs
and hashes; and the exact Undercurrent source commit/archive needed by Suite's
Rust terminal and Windows platform adapters. Release builds fetch that pinned
source instead of consulting a developer's sibling checkout. `--local-sources`
on the Linux, macOS or Windows packaging entry point explicitly opts into the
sibling Undercurrent source for adapter development.

Linux and Windows runtime builders install the pinned published API wheels in
Suite's private interpreter and copy bootstrap UC executables from the verified
published native artifact. They build Suite's own Runner, IR and bridges. Resolved
Python package versions are recorded in the resulting runtime lockfile. The
first-party lock does not claim to pin the entire third-party dependency closure.

The offline product kit contains nine assemblies:

- Undercurrent, Carrier and the five individual managers from their exact published
  archives, preserving manifest hashes and product release identities.
- Runner and orchestration MCP built and installation-verified from Suite source.

Build it with `python scripts/package-products.py --build --work FRESH_WORK
--output FRESH_KIT`. The native Suite builders do this automatically unless an
explicit `--product-releases` kit is supplied. Existing qualified handoffs can be
collected using the individual product flags; `--help` lists them. Collection expects the nine assemblies above.

The Suite-owned MCP product uses root `installation.toml` and
`python scripts/product.py package|verify|export-release`. The package-local
orchestration development commands delegate here, using the in-tree schema-2
installer engine. The product identity is declared by the root installation manifest. API libraries stay inside application/product interpreters;
they are not independent CLI products.

Target availability is the intersection of assets for every required pinned
product in `scripts/runtime/dependencies.lock.json`. Builders reject an incomplete
target before fetching product archives. A host-specific source check does not
qualify every target. Adding a target requires reviewed artifacts and hashes.

To update dependencies, review the intended published releases, replace the
matching lock records, refresh affected Python lockfiles, and qualify the native
kit. A matching version label alone does not establish shared-store reuse; the
canonical manifest hash and product release identity must match. No publication,
installation in a user's store, or provider migration is performed by a lock edit.
