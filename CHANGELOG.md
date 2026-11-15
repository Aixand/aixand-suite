# Changelog

User-visible changes to Aixand Suite are recorded here. Component versions may
differ; release entries identify the affected components.

## Unreleased

- Adds application, workspace-component and installed-tool inventories to Settings > Updates,
  including independent Manager Suite tools, Runner and orchestration MCP.
- Preserves reviewed independent product selections through restart and repair;
  full application upgrades require qualification for selected tool releases.
- Adds signed product feeds, exact companion planning, stale-plan rejection,
  native product-engine installation and retained partial-failure journals.
- Separates update-feed revisions from compiled package sequences so renewing
  signed metadata does not reinstall unchanged applications.

## 0.1.0-alpha.2

- Updates vulnerable JavaScript dependencies, Python build tools, and SDK
  telemetry dependencies. Updates Vox source dependencies; Vox binaries remain
  excluded from releases.
- Backports the upstream GLib string-variant iterator memory safety fix while
  retaining GTK 3 compatibility. An optimized regression covers iterator access.
- Prevents implicit PowerShell module loading during Windows command discovery.
- Checks runtime installation, repair, removal, and shared ownership in CI.
- Reuses canonical published Runner and MCP handoffs in Suite builds, rejecting
  source changes under an already published component version.
- Keeps IR at its independently released 0.1.0-alpha.1 version.
- Windows installers remain unsigned and macOS applications are not notarized.
  Automatic updates remain disabled.

## 0.1.0-alpha.1

- Organizes applications, services, SDKs, and workflow components in
  dedicated directories.
- Prepares independently versioned component builds, package registry workflows,
  native installers, composition assembly, and GitHub release delivery.
- Includes Client, Desktop, and headless Server installation paths. Vox source is
  available, but packaged voice runtimes are excluded from this release.
- Preserves independently owned shared components during application removal.
- Windows installers are unsigned; macOS applications are not notarized.
  Automatic updates remain disabled for this initial alpha.
- Settings identifies workspace reset as unavailable and directs local cleanup
  to the launcher or Server console instead of submitting an unsupported action.
- Uses the `aixand-suite-python`, `aixand-suite-runner-client`, and
  `aixand-suite-connect` Python distribution names.
