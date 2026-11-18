# Maintain native component handoffs

Use this maintainer procedure for the current checkout. Read the [release map](../releases.md)
for distribution ownership. Commands run from the Suite root unless stated otherwise.

## GTK 3 GLib security backport

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

## Standalone Runner and orchestration MCP delivery

The [product bundle exporter](../../../scripts/release/product-bundle.py) wraps an
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

