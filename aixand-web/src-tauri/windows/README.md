The NSIS template is based on Tauri CLI **2.12.3**:
https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.3/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi

It is distributed under the MIT license in `TAURI-LICENSE-MIT`. Keep this template
in sync when upgrading the pinned `@tauri-apps/cli` dependency.

Local changes are confined to the maintenance page:

- An explicit **Uninstall Aixand** opens the installed uninstaller without
  `/UPDATE`, even when setup itself was launched with `/UPDATE`.
- Before opening that uninstaller, setup refreshes the known compatible preview
  cleanup helpers from its own archive. `maintenance-update.py` verifies both
  bundled payloads, the old helpers, native executable and runtime seal, then
  updates both helpers, inventory and manifest with rollback on failure. Current helpers
  requires no writes. An incompatible installation stays on maintenance with
  instructions to finish Add/Reinstall first. No services or data are removed
  during this preparation; cancellation can leave the repaired software installed.
  Compatibility covers the original cleanup preview, service access repairs and
  the long-path repair; each software migration is checked before writing any file.
  Windows packaging verifies the actual staged payloads against the migration's
  release pins before bundling. The unmocked release-source test catches stale
  pins even when fixture migration tests pass.
- Successful removal exits setup. Cancellation or failure stays on maintenance;
  it never advances to the installation directory.
- Uninstalling an old version before replacing it passes `/UPDATE`, preserving
  data and shared tools. Interactive choices are honored; passive updates still
  install in place. Passive setup does not read nonexistent radio controls.

`runtime-hooks.nsh` opens the native cleanup checklist during interactive
uninstall. Its cancellation uses NSIS's cancellation exit code, allowing setup
to return to maintenance without a second, misleading error message.

Run `scripts/verify-windows-maintenance.py --languages <generated-nsis-directory>
--runtime <qualified-old-runtime> --native <qualified-distributed-nsis-executable>`
from the exported Suite sources on an interactive Windows desktop. The language
directory contains Tauri's generated `English.nsh`, normally under
`<cargo-target>/<target-triple>/release/nsis/x64`. Tests compile the production
maintenance page verbatim into a tiny fixture setup, using a unique product name,
temporary files and registry keys. They cover reinstall, removal, cancellation,
failure, version changes, passive setup and silent updates. The fixture
uninstaller records arguments and the helper it sees, then removes its fixture
executable. It never runs the desktop executable. The production preparation
macro runs against fixture software only, checking that the refreshed helper is
visible before uninstall, and that refusal preserves the installation.
Supply `--previous-helper <qualified-first-repair>` to also exercise migration
from the earlier service-access repair through the real maintenance page.
Run again with `--edition standalone` and the qualified standalone native executable
to cover that edition. Current helpers and a current process helper paired with
an older provider helper are always included in the maintenance cases.
