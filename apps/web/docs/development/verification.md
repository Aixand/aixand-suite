# Development and verification

Select checks by the owning module and its service dependencies. Fixture coverage demonstrates UI behavior; live qualification needs the actual owning services.

## State and boundaries

| Concern | Contract |
| --- | --- |
| Local setup | Follow [local setup](../development.md#develop-locally). Vite proxies Server; AIXAND_SERVER_URL changes the target. |
| Build inputs | Suite prepare builds the Connect companion. Web dev/build do not regenerate it. |
| Static checks | From apps/web run npm run lint and npm run build. |
| UI checks | Choose the relevant Playwright config from package.json and inspect its webServer dependencies. |
| Live checks | The default suite and live scripts can build Rust bridges, start services or use provider resources; inspect before execution. |

## Browser and integration tests

Playwright belongs to this component's development tools. It drives the browser
to check interactions, navigation, authentication, accessibility, and recovery.
It is not required to run the installed application.

| Test path | What it checks |
| --- | --- |
| `tests/` and `playwright.*.config.ts` | Feature-focused browser checks, using the selected configuration's fixtures or services |
| `client-tests/` | Frontend/native Client transport integration fixtures |
| `desktop-tests/` | Desktop connection-window and launcher fixtures |
| `scripts/test-*-live.mjs` | Broader integrations with backend processes and explicitly configured runtimes |

`npm test` uses [the default configuration](../../playwright.config.ts), which builds
the Rust workflow bridge and starts test services. It needs Rust as well as the
Node/browser test toolchain. Focused scripts such as `npm run test:auth`,
`npm run test:agents:ui`, and `npm run test:client` select other configurations.
Install the browser runtime required by Playwright before running browser tests.

Inspect [package.json](../../package.json) and the selected configuration before a run.
Live scripts can use provider resources and require an isolated workspace.
Fixture results do not establish live model access or native installer readiness.
Generated traces and reports belong in ignored `test-results/`.

## Existing development guide

[Develop Suite Web](../development.md) retains the interaction checklist. [Implementation status](../implementation-status.md) lists contract-only paths.

## Source and verification

[README.md](../../README.md), [package.json](../../package.json), [playwright.config.ts](../../playwright.config.ts).

