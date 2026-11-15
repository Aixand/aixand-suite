# Windows installer maintenance

The NSIS template is based on Tauri CLI **2.12.3**:
https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.3/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi

It is distributed under the MIT license in `TAURI-LICENSE-MIT`. Keep this template
in sync when upgrading the pinned `@tauri-apps/cli` dependency.

## Maintain the installer

The maintenance page offers explicit uninstall, reinstall and update operations.
Uninstall opens the installed uninstaller without `/UPDATE`; replacement uses
`/UPDATE` to preserve data and shared tools. Successful removal exits setup;
cancellation or failure returns to maintenance. Passive setup installs in place.

Before removal, `maintenance-update.py` validates bundled cleanup helpers and the
installed runtime seal. Any authorized helper replacement is transactional with
rollback on failure. A refused preparation leaves maintenance open with recovery
instructions. This preparation does not remove services or data.

`runtime-hooks.nsh` opens the cleanup checklist during interactive uninstall.
Cancellation uses NSIS's cancellation exit code and returns to maintenance.

## Verify a change

From the Suite root, inspect `scripts/verify-windows-maintenance.py --help` for
required qualified runtime, generated NSIS language and native executable inputs.
Run the selected maintenance checks on an interactive Windows desktop with fixture
software. Packaging verifies staged cleanup payloads before bundling.
Linux source checks do not qualify native Windows installation or removal.
