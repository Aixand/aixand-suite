# Select focused verification

Run checks for the component and boundary you changed. Commands below are run
from the Suite root; component READMEs define prerequisites and additional checks.
Use disposable state for execution tests. A focused pass does not establish all
installed platforms, live provider access, or the correctness of a task report.

## Component verification map

| Owning source | Focused check | Scope and prerequisites |
| --- | --- | --- |
| `apps/server` | `npm --prefix apps/server test` | Vitest backend contracts; Node dependencies required |
| `apps/web` | `npm --prefix apps/web run lint` and `npm --prefix apps/web run build` | Static checks and frontend bundle |
| `apps/web` browser behavior | `npm --prefix apps/web test` | Default Playwright services/fixtures, browser runtime, and Rust workflow bridge |
| `apps/desktop` | `npm --prefix apps/web run test:desktop` and `cargo test --manifest-path apps/desktop/src-tauri/transport/Cargo.toml` | Launcher fixtures and native transport; not native installer qualification |
| `mcps/orchestration` | From its directory, `./dev.sh check` and `./dev.sh test` | Package-owned environment; optional integrations have separate prerequisites |
| `services/connect` | `python3 -m unittest discover -s services/connect/tests` | Receiver/sender tests; platform-specific skips are not qualification |
| `services/vox` | From its directory, `uv run --locked python -m unittest discover -s tests -v` | Separate speech environment; optional real-audio tests require explicit setup |
| `workflow/runner` | `cargo test --locked --manifest-path workflow/runner/Cargo.toml` | Durable lifecycle, protocol, and integration fixtures; inspect package requirements |
| `workflow/ir` | `cargo test --locked --manifest-path workflow/ir/Cargo.toml` | Default Rust features; optional SDK/frontend checks have additional setup |
| `sdks/python` | `python3 -m unittest discover -s sdks/python/tests` | Use an interpreter with declared SDK dependencies; opt-in runtime tests are separate |
| Documentation | `python3 -B scripts/checks/check-docs.py --root .` | Offline authored Markdown paths and anchors, not behavioral verification |

See [Web test organization](../../apps/web/README.md#browser-and-integration-tests)
and [runnable examples](../guides/examples.md) before selecting a live script.
Do not run provider-consuming examples against an unrelated production workspace.

## Interpret evidence

Record passed, failed, skipped, and unverified checks with the actual command,
platform, runtime, and scope. Inspect the canonical task/Runner outcome after
execution; successful dispatch does not prove completion. A mock browser flow is
not a real provider login or a native installer test.

Changed diagrams must render and be visually inspected in light and dark themes.
Follow [documentation validation](documentation.md). Keep transient logs and
execution evidence in review artifacts rather than filling public guides with
one workstation's test transcript.
