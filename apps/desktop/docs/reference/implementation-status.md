# Desktop implementation status and gaps

The shell, adapters and libraries described here are present in this checkout. Presence of code or tests does not establish that an exact packaged build passed native platform qualification. The following limits affect how developers and agents should interpret the documentation.

| Area | Source-backed implementation | Limit / follow-up |
| --- | --- | --- |
| Desktop versus Client | Separate native feature/config and payload preparation | Do not infer role solely from package label or checked-in version strings |
| Desktop interface | Bundled gateway when script exists; explicit Server-frontend fallback otherwise | Test both payload shapes when preserving historical compatibility |
| Client interface | Bundled assets, IPC session transport, generation cancellation | Six socket paths, text forwarding and fixed byte limits constrain feature compatibility |
| Source export | Allowlisted shell archive, excludes state/build artifacts | The export omits the `vendor/glib` patch directory required by Cargo; self-contained archive builds need separate verification |
| Application versions | Client config is generated from package version or explicit override; build metadata validates selected version | Release preparation must select/align inputs; docs do not declare a current downloadable version |
| Update channels | Disabled checked-in trust; signed validation and native handoff implemented | No public feed availability, successful installation, rollback or signing qualification is claimed |
| Client install result | Returns `started` after spawning owning native installer | Not a receipt that OS installation completed successfully |
| Client storage | Native sessions persist; Windows/Linux browser directories partitioned | macOS browser data intentionally ephemeral; automation shares a context |
| Local availability | Manifest and Node presence check | Not runtime integrity or product-readiness proof |
| Window closure | Cancels interface traffic and gateway | Does not stop Server work or local services |
| Platform security | Private-file checks and vendored GLib fix exist | Native filesystem/ACL, scheduler and installer behavior still need target tests |

## Review paths

| Change under review | Required cross-reference |
| --- | --- |
| New command or capability | [Trust](../architecture/trust.md), [build registration](../../src-tauri/build.rs), [main handlers](../../src-tauri/src/main.rs) |
| Web feature uses new socket/body shape | [Native transport](../integrations/native-transport.md), [Web Client contract](../../../web/docs/client.md) |
| Component refresh/update | [Maintenance](../lifecycles/maintenance.md), [existing update reference](../../../web/docs/updates.md) |
| Packaging or export | [Packaging](../development/packaging.md), [qualification](../development/verification.md) |

Existing Web and Windows references retain detailed interface and installer contracts. Use the [verification map](../development/verification.md) to select fixture or packaged checks.
