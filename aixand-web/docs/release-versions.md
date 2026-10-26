# Coordinated beta versions

Suite, both desktop installer editions, and all first-party runtime products use
`0.1.0-beta`. This includes Undercurrent, Carrier, Runner, Aixand Platform, each
Manager product, the Manager Suite group, and Suite's Python, Connect, MCP, voice,
IR, server, desktop, and runtime helper packages.

Python package manifests, requirements, wheel metadata, and UV locks use
`0.1.0b0`, the canonical PEP 440 spelling of the same beta. Product installer
manifests and CLI output use `0.1.0-beta`. Python requirements explicitly admit
the beta; a stable `>=0.1.0` requirement would reject it. Third-party dependency
versions and protocol/schema versions have separate meanings.

From the Suite directory, check all source metadata and locks with:

```sh
python3 scripts/check-release-versions.py
```

Carrier and the Manager installers declare their SemVer product version
explicitly because their Python wheel versions use PEP 440. Check both when
changing the coordinated release version. Native packaging also checks the
product catalog, so an older qualified product kit must be rebuilt before use
with this release.

Runner's checked-in notice inventory also binds these version manifests and
Cargo locks. After changing them, regenerate it with
`python3 ../runner/scripts/third_party_licenses.py generate` and review the
inventory and notice diff. The source check above verifies that inventory;
regeneration requires the pinned Rust toolchain and cached locked crates.

Existing installers, installed applications, receipts, and verification reports
retain their original versions and hashes. Rebuild and qualify both installer
editions on each target OS to produce the beta release. A source version edit
does not update an installed application or change an existing release artifact.
