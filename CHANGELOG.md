# Changelog

User-visible changes to Aixand Suite are recorded here. Component versions may
differ; release entries identify the affected components.

## Unreleased

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
