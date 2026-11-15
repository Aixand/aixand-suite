# Aixand installation updates

Desktop and Server use separate application and component update operations.
Provider CLI versions retain their own provider policy. Source development mode
never downloads or installs application updates.

## User controls

The trusted connection window owns **Desktop updates** or **Client updates**.
Native installation requires a reviewed release and consent to close/restart the
application. Client has no local runtime and never updates its connected Server.

Web **Settings > Updates** manages components on the packaged workspace host.
Select the components, review any required companions, download verified payloads,
and confirm their complete installation plan and restart impact. Requests retain
session, exact Origin and CSRF checks. Component checks default to daily;
automatic downloads are opt-in. Neither preference authorizes installation.

Server component commands:

```sh
aixand-server update status
aixand-server update check
aixand-server update plan --select server
aixand-server update download --select server
aixand-server update install --select server
aixand-server update daily off
aixand-server update automatic-download on
```

Use `aixand-server application-update status|check|download|plan|install` for the
whole native package. It replaces independent runtime selections with the new
package baseline. The review names those components; the job retains the exact
previous selection and its immutable payloads for recovery. A changed selection
invalidates the reviewed update before replacement or startup.

Interactive installation displays the licenses and restart impact. Automation
supplies reviewed hashes using `--accept-license SHA256`; `--yes` does not accept
licenses implicitly. Component installation also needs `--restart-consent` when
services must restart. Running agent work must finish or be stopped separately.

## Release identity and trust

Product labels remain `0.1.0-beta`. A positive integer `releaseSequence` orders
candidate Suite builds independently of SemVer. Installed inventories retain
their content hash. Desktop, Server and Client use separate application feeds. The first protocol
supports API protocol 1; incompatible releases are refused.

The configured feed URL forms are `https://downloads.aixand.org/aixand-desktop/latest.json` and
`https://downloads.aixand.org/aixand-server/latest.json`. Each JSON envelope has
`schema`, `keyId`, `payload` (the exact signed UTF-8 JSON string), and an Ed25519
base64 `signature`. Clients trust only the public keys bundled in
`update-config.json`. Payloads contain dates, expiry (at most 90 days), release
sequence, notes, and artifacts indexed by OS/architecture/package format.
Artifact hashes, sizes, runtime identities, product changes and license text are
signed. The highest observed sequence cannot decrease; an observed revision
cannot change content. Redirects and external download origins are refused.

Versioned object paths include the revision: for example
`aixand-server/0.1.0-beta.r12/HASH-setup.exe`. Published paths are immutable.
SemVer build metadata is not used to order releases.

Component envelopes use schema 2 and bind role, native target and component
identities. Their feed path is
`/aixand-suite-components/ROLE/TARGET/latest.json`. Dependency closure requires
exact companion release hashes; a matching version label is insufficient.
Runtime-bound components also pin the application runtime build. Runtime payloads
are staged as verified immutable workspace objects and selected without editing
the sealed application. Other activation owners require their native installer,
product engine or a consumer rebuild; a generic runtime install refuses them.

## Development and qualification scope

The checked-in [update configuration](../../../scripts/runtime/update-config.json)
is disabled. No public feed or channel availability is established by this guide.
Release preparation is owned by the release supervisor; do not enable channels
as part of documentation or source setup.

The [component contract](../../../docs/reference/components.md) describes source
build and activation ownership. Whole-runtime update support does not establish
qualified independent installed component updates. Signing, native repair,
rollback limits and target-specific qualification require separate evidence.

## Installation and recovery

Downloads resume through byte ranges and verify signed size and SHA256 before
activation. A fresh plan binds the installed build, release, shared-product
state and active workspace sessions. Agent sessions must finish or be explicitly
stopped outside the updater; stale plans are refused. Shared product dependency
and ownership checks still apply. First-party beta rebuilds use the engine's
explicit reinstall operation after consent; they do not masquerade as a new
immutable version. Provider software is not upgraded by this operation.

A private helper copies Node outside the replaceable application, stops its
workspace services, saves owned SQLite databases and their WAL/SHM files after
shutdown, installs, reinstalls/verifies the tested product kit, and restarts
previously running services. It preserves the terminal command preference.
Windows starts the helper through a temporary per-user scheduled task so stopping
the workspace Job Object cannot terminate its own updater. Normal callers use a
limited task. A Server already running as administrator retains that privilege
level so the helper can read its existing private files; normal updates do not
request elevation. The task is removed when the helper finishes.

Windows Desktop uses NSIS `/UPDATE`; macOS verifies and replaces the sealed app;
Linux uses its owning DEB/RPM package manager and OS authorization. Linux does
not overwrite files behind its package manager. Server uses its console setup
transaction and retains the previous runtime. Desktop backups are retained on
Windows/macOS. Linux package recovery remains with the package manager.

Update state and recovery files live below the local workspace's
`updates/server`, or Desktop's native app configuration `updates` directory.
Each job retains its state, software backup where supported, and SQLite snapshot
inventory. Provider account directories are excluded from snapshots. Failed
checks do not replace the last successful check time. Interrupted transfers and
helpers are reported and can be reviewed before retrying.

Recovery does **not** automatically restore databases or downgrade stateful
shared products after the new runtime has run. A failed health check retains
recovery files and reports failure. Stop the installation before inspecting its
snapshot and use a reviewed repair procedure that respects the current data schema.
Existing installed applications need one rebuilt installer to acquire the updater.

## Activation ownership and interrupted locks

Native and component updates reserve one workspace activation operation before
worker handoff. Ordinary lifecycle changes are refused until that owner completes.
Workers must match the retained operation and job; stale jobs cannot replay
replacement or overwrite a newer result. Startup checks selected component
payload inventories again and refuses corrupt code or assets without fallback.

Failed or interrupted activation retains its reservation and recovery journal.
Do not remove the reservation to make another update start. First quiesce the
installation and inspect the recorded operation, software selection and any
retained database snapshot. Recovery requires an explicit decision about that
state; automatic takeover and downgrade are not provided.

Short request locks publish complete owner records. Aged empty or truncated
request locks can recover; live or acquiring locks remain protected. Death
inside the short lock-arbitration section instead fails closed. After all
updater and lifecycle callers are quiesced and no lock participant remains,
a reviewed recovery may remove only the empty `<lock>.arbitration` directory.
Preserve `updates/activation.json` and the operation journals: removing an
arbitration directory does not resolve an interrupted activation. Native
filesystem and scheduler crash behavior still require platform qualification.

## Validation

```sh
node --test scripts/runtime/updates.test.mjs scripts/runtime/server-cli.test.mjs scripts/runtime/server-installer.test.mjs
cd apps/server && npx vitest run src/updates/updates.spec.ts
cd ../web && npx playwright test --config playwright.desktop.config.ts
npx playwright test --config playwright.settings.config.ts
```

Download Worker tests belong to the sibling `aixand-installer` repository. Native
installer application and OS authorization still require target qualification
before a feed is promoted; unit tests and browser fixtures do not substitute for
Windows/macOS/Linux upgrade testing.
