# Dependencies

Suite owns Runner, IR, and Orchestration MCP. The five managers come from
[Aixand/manager-suite](https://github.com/Aixand/manager-suite).

## Development

From the Suite root:

```sh
./dev.sh prepare
```

Creates `.venv` with Python 3.12.14, verifies first-party wheel hashes, builds
Suite Python packages/Connect companion, and checks dependency compatibility.
Server selects this interpreter. Node packages/native bridges use component setup.

For sibling sources:

```sh
./dev.sh prepare --local-sources
```

Expected siblings: `../manager-suites`, `../aixand-libraries`, `../carrier`, and
`../undercurrent`. Existing per-package `*_SOURCE` overrides remain supported.
Packaged workers ignore source overrides. Vox uses a separate interpreter/lockfile.

## Release inputs

[scripts/runtime/dependencies.lock.json](../../scripts/runtime/dependencies.lock.json)
pins external wheels/native archives and hashes, plus Undercurrent source for Rust
adapters. Release builds use those inputs; packaging `--local-sources` explicitly
opts into sibling Undercurrent source.

Runtime builders install pinned APIs and verified native tools, then build
Suite-owned Runner, IR, and bridges. Runtime locks record resolved packages;
the first-party lock does not pin the entire third-party closure.

The offline kit contains nine products: Undercurrent, Carrier, five managers,
Runner, and Orchestration MCP. From the Suite root, using fresh paths:

```sh
python scripts/package-products.py --build --work FRESH_WORK --output FRESH_KIT
```

Native builders create the kit unless `--product-releases` supplies one.
Individual flags collect existing qualified handoffs; see `--help`.

Orchestration MCP uses root `installation.toml` and
`python scripts/product.py package|verify|export-release`. Libraries stay inside
consumer environments, not separate CLI products.

## Update pins

Review releases, replace lock records, refresh affected Python locks, and qualify
the native kit. Targets require every pinned product's artifact/hash. Shared-store
reuse requires matching manifest hash and product release identity, not only version.
A lock edit does not publish, install, or migrate anything.
