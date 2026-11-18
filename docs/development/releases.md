# Component and product releases

Registry packages, native runtime compositions and signed delivery have separate
owners and qualification steps. Choose the procedure for the artifact you are
preparing; local build success is not release or native-installation qualification.

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

See [Build and registry validation](releases/registry.md#build-and-registry-validation).

## Registry account setup

See [Registry account setup](releases/registry.md#registry-account-setup).

## Local validation

See [Local validation](releases/registry.md#local-validation).

## Runtime baseline reuse

See [Runtime baseline reuse](releases/composition.md#runtime-baseline-reuse).

## Assemble a product composition

See [Assemble a product composition](releases/composition.md#assemble-a-product-composition).

## Native qualification and GitHub Releases

See [Native qualification and GitHub Releases](releases/composition.md#native-qualification-and-github-releases).

## Signed updates and Cloudflare

See [Signed updates and Cloudflare](releases/delivery.md#signed-updates-and-cloudflare).

### Public application names

See [Public application names](releases/delivery.md#public-application-names).

### Main installer download hub

See [Main installer download hub](releases/delivery.md#main-installer-download-hub).

### GTK 3 GLib security backport

See [GTK 3 GLib security backport](releases/products.md#gtk-3-glib-security-backport).

### Standalone Runner and orchestration MCP delivery

See [Standalone Runner and orchestration MCP delivery](releases/products.md#standalone-runner-and-orchestration-mcp-delivery).

