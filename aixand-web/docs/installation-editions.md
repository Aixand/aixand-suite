# Suite installer editions

New releases now build distributed **Desktop** and terminal-only **Server**
packages. See [the current installation guide](../../aixand-server/docs/installation.md).
The standalone behavior below documents existing installations and their upgrade
compatibility; new standalone installers are retired.

The new build produces two alternative installers for each native target.
Both install the same Suite application and retain its existing workspace data.
They select different ownership for the independent products.

| Installer | Product installation | Ordinary product commands | Removing Suite |
| --- | --- | --- | --- |
| Standalone | Private, owned by Aixand Suite | Through `aixand-runtime exec COMMAND` | Private software can be removed; workspace data remains |
| Distributed | Shared, owned by the user | Independently usable outside Suite | Shared products remain installed |

Both downloads carry the product release bytes and their interpreters. Product
activation does not fetch packages from registries. This first implementation
prioritizes offline setup; the distributed download is not a thin network stub.
Provider applications, model downloads, and accounts retain their existing
separate onboarding.

## First use

Open the local workspace and create or enter its password. Before the existing
agent and project onboarding, Suite shows the included products and their terms.

Standalone offers **Activate included tools**. Distributed offers **Install all**.
The latter installs Undercurrent, Runner, Carrier, and all six Manager Suite CLI
products, using their schema-2 installers and separate environments. Resource
Sources and other Python API dependencies remain libraries rather than extra
fake CLI products. Installers resume completed work after interruption; a retry
does not recreate already accepted products.

Installation request IDs are stable for each catalog, product assembly, and
operation. Uninstall preserves request history, so installing a removed product
uses a different ID from an earlier upgrade without deleting that history.

The distributed commands use their usual configuration conventions outside
Suite. Suite passes its own explicit homes to its services and managers.
Configuration and credentials are not silently imported. Previously saved,
explicit manager configuration reuse remains respected.

Distributed setup registers the user-owned UC CLI connection `aixand-suite`
with the actual `<Suite data>/uc` home, verifies that connection, and selects it
on initial setup. Ordinary `uc ls` then shows the same sessions as Suite's
terminals. The permanent `default` connection retains the ordinary
`~/.aixand/undercurrent` home. Use `uc settings set profile default` to switch
back, `uc settings set profile aixand-suite` to select Suite again, or
`uc --connection aixand-suite ls` for one invocation.

The Suite connection disables automatic daemon startup by ordinary commands;
open the local workspace when it is stopped. The selected CLI profile never
redirects Suite, which continues supplying its explicit instance home. Later
setup preserves manual choices; its initialization record is independent of
the release catalog. Standalone does not register global CLI preferences.
PATH executable selection and UC connection selection remain separate settings.

Provider onboarding offers managed installation for Codex, OpenCode, Claude,
GitHub Copilot and Antigravity. Copilot uses its official npm package on Windows;
Antigravity uses its official PowerShell installer.
macOS/Linux also offer the supported native installers and Homebrew recipes.
The Agent Manager catalog controls available methods and prerequisites; npm
requires Node.js 22+ for Copilot. Installation progress is
measured where available, and success requires an executable version check.
Sign-in and profile creation follow installation. Update, repair and removal
use the verified installation method, preserving saved accounts and profiles.

Suite initially uses its included bootstrap services so the web onboarding can
open before the shared products exist. Installation retains compatible running
processes and binds subsequent launches to the installed tools; it does not
interrupt existing work. Restarting local services uses the newly installed
product services and preserves authentication and jobs.

The existing Suite SDK workflow worker and the terminal/workflow bridges remain
internal application components. The public Runner product remains independent,
without an embedded Suite SDK. Python API copies used by Suite are also internal
dependencies; they do not publish product commands into the user's shell.

## Locations and command conflicts

Private software lives in `<Suite data>/software/products`. Shared software lives
in `$XDG_DATA_HOME/aixand/products` (normally `~/.local/share/aixand/products`)
on Linux, `~/Library/Application Support/Aixand/products` on macOS, and
`%LOCALAPPDATA%\Aixand\products` on Windows. These match the individual artifact
installers' defaults, so already installed matching products are reused. Product receipts identify the
owner, exact releases, environments, commands, and runtimes.

POSIX exposes ordinary commands in `~/.local/bin` without shell aliases or
profile edits. Add that directory to PATH if your terminal does not already use
it. Windows registers the shared product command directory in the user's PATH;
open a new terminal afterward. Existing commands belonging to other installations
are retained and reported. Suite uses the installed products by absolute path.

Distributed onboarding checks competing commands before setup and displays their
CLI versions and executable locations. On Windows, choose **Use existing
commands** or **Use newly installed commands**. When another installed copy is
detected, the existing-command choice is selected initially. Otherwise it is
disabled, and newly installed commands are selected automatically. Copies
already managed by this installation do not count as another installed copy.
Setup never chooses a default by comparing version numbers, including
when a product restarts its version series. The completion screen reports the
checked terminal selection separately from the version Suite uses. System PATH
entries can still precede user PATH; PowerShell aliases, functions, and profiles
can override PATH. Existing terminal processes need to be closed and reopened.

Windows native release executables and installed command launchers carry product
version metadata. PowerShell's numeric Version cannot represent a prerelease
suffix: a product at `0.1.0-beta` has numeric version `0.1.0.0` and full
ProductVersion `0.1.0-beta`. Existing binaries are updated by a subsequent product
release; unrelated Cargo installations are preserved.

The new store is separate from the older copied `versions/` toolsets and source
installations. Those receipts and commands are not silently adopted.

To stop Suite and remove only its private product software:

    aixand-runtime stop
    aixand-runtime uninstall-products

The second command never removes the shared product store, including after an
edition switch. It retains Suite authentication, jobs, chats, and manager data.
Windows uninstall invokes this cleanup after stopping its local services.
On Linux/macOS, use these commands before removing the application when private
software cleanup is wanted; app removal itself retains per-user data.

Windows upgrades and reinstalls stop the installed local services, then replace
the entire Suite-owned `runtime` directory. Overwriting individual files would
retain obsolete content-addressed product objects and invalidate the new kit's
exact artifact inventories. The sibling `local` workspace and shared `products`
store remain in place. Setup stops if the old runtime cannot be removed.

Product release versions are immutable. Replacing an unpublished local beta with
different contents under the same version requires an explicit product
`reinstall`; ordinary upgrades require a new version. Reinstalling the Suite
application does not bypass that product rule.

## Native builds

Use a fresh output directory. Preserve previous release outputs. The existing
`--edition legacy` route retains the old runtime/tool-copy packaging for explicit
compatibility work.

    python scripts/package-linux.py --output /new/build-linux --edition both
    python scripts/package-macos.py --output /new/build-macos --edition both

On native Windows:

    .\build-windows.ps1 -OutputDirectory C:\new\build-windows -Edition both

Use `--without-voice` / `-WithoutVoice` for the explicit smaller variant and
`--runtime-only` / `-RuntimeOnly` for runtime archives without desktop installers.
macOS builds require Python 3.11 or newer, Xcode command-line tools, Rust/rustup,
uv and pkg-config. The wrapper downloads checksum-verified Node (including npm)
and selects managed Python 3.12.14 for the embedded workflow bridge.
The Linux wrapper uses its isolated Ubuntu 22.04 container. Windows requires
native MSVC build tools. Build tools are not end-user prerequisites.

Mac builds use headless DMG creation, so SSH builders do not need Finder
automation permission. Existing macOS signing options are preserved. Without a
configured signing identity or `APPLE_SIGNING_IDENTITY`, the application uses an
ad hoc signature for local testing. Public distribution still needs Developer ID
signing and notarization; see [Tauri's macOS signing guide](https://v2.tauri.app/distribute/sign/macos/).

Each wrapper snapshots the declared source inputs, builds the independent product
releases, verifies actual product installations, and assembles a pinned offline
kit. An already qualified native kit can be supplied with `--product-releases`.
To collect existing local handoffs:

    python scripts/package-products.py --output /new/product-kit

Native targets and platform baselines must match. A workstation build with newer
GNU libc does not qualify an Ubuntu 22.04 release. The catalog records component
baselines; macOS bundles use the most restrictive recorded minimum OS version.

Outputs are in `output/installers/standalone` and
`output/installers/distributed`, with per-edition runtime verification,
checksummed archives, separate native installer filenames, and `installers.json`.
The default verification exercises real authenticated web onboarding, terms,
all nine product receipts, normal CLIs, retained work/authentication, restart,
private cleanup, and shared commands with the Suite payload unavailable.

The native workflow is in `.github/workflows/installer-editions.yml`. It builds
Linux x86_64, Windows x86_64, and both macOS architectures independently. These
jobs must actually pass before claiming those targets are qualified. Linux ARM
needs independent Undercurrent product qualification first. OS installer
installation/uninstallation in clean machines, signatures, committed release
inputs, and public hosting remain release work. No command here deploys
`installer.aixand.org`.
