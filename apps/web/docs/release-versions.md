# Component versions

Suite's beta composition label is separate from each component's version.
Components may diverge. Read the [component catalog contract](../../../docs/reference/components.md)
for source roots, owning manifests, dependency selection and activation owners.
Python packages use PEP 440 spellings; native product manifests use SemVer.
Protocol and schema versions have separate meanings.

From the Suite root, validate current metadata with:

```sh
python3 scripts/check-release-versions.py
```

A successful source check does not qualify a native installer, update an installed
application or establish a public release. Rebuild affected consumers and verify
the concrete target artifact before making release claims. Release metadata and
runtime update integration are maintained separately from this documentation.
