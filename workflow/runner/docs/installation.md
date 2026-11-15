# Runner installation

Runner is an independent native product: `runner` plus the
`aixand-runner-client` Python client. The client uses the `aixand-lib-local-runtime`
library for local IPC. Installing Runner does not install other Aixand CLIs,
start a service, register login tasks, or change PATH.

The packaged native executable has no embedded Python SDK. Pure IR jobs need
no other service. Chat and chat graph operations require an explicitly selected
compatible effect host; use `runner --home HOME serve --effect-host SOCKET`.
The `--suite-socket` compatibility alias remains available. Merely installing
Runner does not supply that host, providers, authentication, or model access.
The optional Cargo `sdk` feature still imports the Suite's Python SDK and is an
explicit source-build option, outside the independent product.

## Build and qualify

Use native Linux x86_64/arm64, macOS x86_64/arm64, or Windows x86_64.
The native CI matrix runs on each platform; another platform's successful job
does not qualify a target. Linux CI jobs build on Ubuntu 22.04. Local artifacts
record their actual host baseline in the manifest; this workstation's newer
GNU libc does not establish Ubuntu 22.04 compatibility.
Build inputs must use this sibling layout:

    products/
      aixand-libraries/
        filesystem/
        local-runtime/
      undercurrent/
      aixand-suite/
        workflow/runner/
        workflow/ir/

IR and the Windows IPC helper are linked Rust libraries, not services.
The local-runtime and filesystem libraries go into the installed client's own environment.
Their source identities and locks are recorded in the assembly manifest.
Pin and review those source revisions before a public release. Source checkout
alone is insufficient: this directory must have a committed Git identity before
`release-check` can approve publication.

`./dev.sh develop` installs the pinned Rust toolchain and creates a separate
`tools/.venv` containing the development client and shared libraries.
On Windows use `.\dev.ps1`. Neither command changes a sibling's environment.

Run:

    ./dev.sh check
    ./dev.sh test
    python -B scripts/build_installers.py --output dist/installers

Use a fresh output directory for every build. Existing release bytes and reports
are never overwritten. The native tests use `RUNNER_TEST_PYTHON`; the helper
selects the development environment. Linux also tests the optional SDK build,
without making that feature part of the distributed binary.

The result contains `runner/`, `sdk/`, `bootstrap/`, verification reports,
`lifecycle.json`, and two immutable `handoff/` directories. The SDK is a library
component with a wheelhouse; it has no managed CLI or running service.
Proof for the SDK uses an explicitly selected Python environment.
The product includes CPython 3.12.14 for its installer and client, verified against
the target-specific archive hash. The Runner service itself is native.

Development needs Rust, uv, and Python 3.11+. Building also needs network access
to obtain locked crates, pinned build tools, and the runtime archive, or an
already populated verified cache. Payload installation does not resolve packages
from a registry: both client and platform wheels are included. Interpreter and
third-party notices accompany the artifact. Regenerate the native notice
inventory after changing Cargo inputs:

    python -B scripts/third_party_licenses.py generate

Missing crate notices are saved from their exact upstream VCS revision, with
URLs and hashes in `licenses/inputs/upstream-notices.json`. The collector binds
these revisions to the checksummed crate archives.

## Shared and Suite-owned use

The consumer below is copied into the generated bootstrap. No source checkout is
required to operate an artifact:

    python -I -B consumer.py install --artifact /downloads/runner --prefix /tools/aixand --scope shared --owner user
    python -I -B consumer.py install --artifact /downloads/runner --prefix /suite/runtime --scope private --owner aixand-suite

Use `bootstrap.sh` on POSIX or `bootstrap.ps1` on Windows instead of the Python
command when no suitable Python exists. Its first run downloads and verifies the
pinned runtime unless `AIXAND_INSTALLER_CACHE` already contains it. Artifact
installation itself works offline after that bootstrap step.

The shared prefix exposes `bin/runner` (`runner.exe` on Windows) to any product.
Add that directory to PATH yourself, or use its absolute path. The private
prefix belongs to the Suite and is invoked through its absolute path. Both use
the same qualified product bytes. Scope controls ownership and command placement;
it does not select or isolate job storage.

Always pass different explicit homes when both services are used:

    /tools/aixand/bin/runner --home /data/shared-runner serve --effect-host /run/shared-host
    /suite/runtime/bin/runner --home /data/suite-runner serve --effect-host /run/suite-host

Without `--home` the existing `RUNNER_HOME` / XDG state / Windows LOCALAPPDATA
defaults remain intact. Do not start two services against one home. Python
applications normally install the SDK wheel and platform wheel into their own
environment and use `Client(home=...)`. For the product's bundled client
interpreter, read the `python` field of its installation receipt.

## Lifecycle and data

The consumer supports inspect, plan, install, reinstall, upgrade, exec, uninstall,
and prune with receipt ownership, hashed payloads, JSONL events, and resumable
request IDs. This schema-2 receipt is separate from development/source builds.
An installed binary elsewhere is not silently adopted.

Runner owns `jobs.sqlite3` and related files in its explicit state home.
Reinstall repairs software into a new immutable payload without changing that
home. The installer does not run data migrations or stop a running service.
Before upgrading, stop Runner gracefully and back up its complete state home
while quiesced, including any SQLite WAL files. Exclude transient IPC sockets.
Keep the backup paired with the previous software release. Rollback through the
generic consumer is blocked for this stateful product; recovery requires a
compatible software release and its matching data backup.

Uninstall requires `--stopped` and removes managed commands/software, preserving
job data. Removing a Suite-owned installation tree leaves a shared installation
intact, provided the two have distinct prefixes and homes.

The lifecycle qualifier tests actual CLI/client requests, pure verifier jobs,
idempotency, restart persistence, shared/private isolation, reinstall, corrupt
artifact rejection, quiesced backups, stopped uninstall, and bootstrap without
system Python on the current OS. Its marked upgrade assembly tests installer
activation only; it does not prove compatibility with a future database schema.

## Publication boundary

These commands produce local artifacts. They do not deploy
`installer.aixand.org`, publish a package, enable automatic updates, or sign an
OS installer. The future hosting project can consume the immutable handoffs at
`/runner/install.sh` and `/runner/install.ps1`. Its deployment, download policy,
and the Suite's two installers are separate follow-up work.
