# Independent IR and Runner distribution

IR's model, reference executor, verifier, CLI, frontend and optional SDK adapter
have their own versioned Cargo package boundary. Core/executor/verifier use no
Suite process, Carrier SDK or Python runtime. The optional adapter still delegates
existing SDK operations to `aixand-python`; its runtime requirements are explicit.
Internal dependencies carry versions as well as local development paths.

The source distribution preserves the complete workspace, schemas, catalogs,
examples and test fixtures. Some integration tests intentionally reference shared
workspace examples, so distribute the workspace source artifact for qualification.
Registry publication of individual crates is a separate release action; the local
artifact workflow does not assert that unpublished packages exist on crates.io.

```sh
python3 scripts/package.py package --output /tmp/aixand-ir-release
python3 scripts/package.py verify /tmp/aixand-ir-release
python3 scripts/package.py verify /tmp/aixand-ir-release --check --target-dir /absolute/build-cache
```

The verifier checks the archive checksum, every file checksum, duplicate/path/link
entries and the embedded manifest before compilation. `--check` extracts into an
independent temporary directory and runs offline core, executor and verifier tests.
The configured Cargo dependency cache/toolchain must already be available.
No provider, Suite service, Carrier process or model call is needed.

To qualify Runner outside the Suite checkout, include its source explicitly:

```sh
python3 scripts/package.py package --output /tmp/aixand-runtime-release --runner-source ../runner
python3 scripts/package.py verify /tmp/aixand-runtime-release --check --target-dir /absolute/build-cache
```

This artifact contains `ir/` and `runner/`. Only the artifact's Runner dependency
paths are changed to `../ir/crates/...`; the development checkout is preserved.
Verification also runs Runner's job, graph and transport tests. Operation names,
workflow formats, request fingerprints and retained recovery records stay intact.
Independent applications can use the extracted versioned IR packages or the
existing `runner_client` and `carrier` clients directly.

Artifacts are deterministic for identical source bytes, executable flags and
package versions. Output directories must be unused; no existing release or user
installation is overwritten. Publishing, upgrading and restarting installed
services remain explicit deployment operations.
