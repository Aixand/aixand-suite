# Component versions

Suite's beta composition label and each component version are independent. The [component catalog contract](../../../docs/reference/components.md) identifies manifests, dependency selection and activation owners.

| Identity | Meaning |
| --- | --- |
| Composition label | Suite assembly label |
| Python package version | PEP 440 spelling |
| Native product version | SemVer |
| Protocol/schema version | Compatibility contract, separate from package versions |

From the Suite root:

```sh
python3 scripts/check-release-versions.py
```

| Check | Evidence |
| --- | --- |
| Source metadata check | Metadata consistency only |
| Rebuilt consumer and target artifact | Needed to verify a concrete release |
| Native installer/update qualification | Separate from source metadata and documentation |

The source check neither updates an installed application nor establishes a public release. Runtime update integration is maintained separately.
