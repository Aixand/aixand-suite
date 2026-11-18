# Sign and deliver native releases

Use this maintainer procedure for the current checkout. Read the [release map](../releases.md)
for distribution ownership. Commands run from the Suite root unless stated otherwise.

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

GitHub delivery filenames identify the application or product, version, platform,
and package purpose without SHA-256 prefixes. The delivery descriptor maps those
readable filenames to the original signed storage paths; checksum and signature
verification still apply. Conflicting readable filenames with different content
are rejected. Native installer exports retain their qualified package names.

Release assets also have human-readable display labels. To preview improvements
for an existing release without changing bytes, filenames, checksums or URLs, run
`node scripts/release/label-assets.mjs suite/vVERSION`; add `--apply` to save them.
Release uploads apply the same labels automatically.

The JSON sidecars are verification records, rather than downloads users install:

- `TESTING.json`, when supplied, records actual platform test coverage and limits,
  including signing status. It is a report, not a test executable.
- `delivery.json` maps signed update feeds and immutable download paths to GitHub
  assets, with their expected sizes and SHA-256 hashes.
- `composition.json` inventories release components, the source revision and asset
  hashes and sizes. `SHA256SUMS` supplies the downloadable checksum list.
- `*-application.json` identifies a native installer; `*-qualification.json`
  records the matching install, recovery and data-retention checks.


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

## Public application names

Use **Aixand Client** for the native frontend-only application, **Aixand Server**
for the backend and its tool runtimes, and **Aixand Suite** for the complete local
application. The internal `desktop` role is presented publicly as Aixand Suite.
The independently released `web` component is labeled **Aixand Client — Web
assets (not an installer)**. Its archives use `aixand-client-web-assets` display
names, so they cannot be mistaken for the installable Client. Developer libraries
and tool components retain their distinct names under Aixand Suite.

These presentation names do not rename internal component IDs, release tags,
installed application identities or signed download paths. The release uploader
applies consistent titles and includes a short product guide automatically.

## Main installer download hub

The `suite/vVERSION` release is the main download hub for all three applications.
Suite native release inputs must include nine `hosted.py` exports: `desktop`,
`client` and `server`, each on Windows x64, macOS ARM64 and Linux x64. Each export
must carry exact matching native qualification and source revision. Qualification
index rows include `role`; native exports are stored under `role/target`.
Individual Client and Server releases continue to contain their own installers.

The release preparer verifies and copies the exact installer bytes, generates
`INSTALLERS.json` and `INSTALLERS-SHA256SUMS`, and places the application/platform
download table first in the release notes. The index records the independently
identified application versions, source revision, release sequence, sizes and
hashes. Component update feeds, installed identities and trust settings are
unchanged. Existing delivery records remain available for updater registration.

To complete an already published, editable Suite release from qualified exports:

```sh
python scripts/release/complete-installer-hub.py \
  --tag suite/vVERSION --directory /qualified/native-exports --output /fresh/hub
```

This prepares files and a publication plan locally. `--apply` additionally checks
each installer against its public component release and exact source tag, adds
only missing assets, verifies GitHub-computed hashes, and updates the download
table and labels. It never replaces existing assets or changes tags. Immutable
releases cannot receive additional assets. Existing release checksum inventories
are retained; `INSTALLERS-SHA256SUMS` specifically covers the nine installers.

