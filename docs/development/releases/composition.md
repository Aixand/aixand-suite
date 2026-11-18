# Prepare native runtime compositions

Use this maintainer procedure for the current checkout. Read the [release map](../releases.md)
for distribution ownership. Commands run from the Suite root unless stated otherwise.

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

