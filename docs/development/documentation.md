# Check documentation

From the Suite root, with Python 3.11+:

```sh
python3 -B tests/tooling/checks/docs_test.py
python3 -B scripts/checks/check-docs.py --root .
```

These checks cover selected Markdown, local links/anchors, fences, and Mermaid
accessibility fields. They do not execute examples or check external URLs.
Add authored directories to [docs-checks.json](../../docs-checks.json).

## Render diagrams

With Node 22.13+ and Puppeteer Chromium installed:

```sh
npm ci --prefix tools/docs
python3 -B scripts/checks/check-docs.py --root . --render-mermaid /tmp/suite-diagrams --mmdc tools/docs/node_modules/.bin/mmdc
```

Use a fresh output directory. Inspect light/dark renders for clipping, labels,
and arrow direction. Hosting-renderer compatibility needs separate checking.

## Write and maintain pages

Lead with the answer or action. Keep only necessary context. Link to exact
contracts rather than repeating them. Procedures need prerequisites, steps,
expected results, and relevant cleanup.

Root docs own shared setup and integration; components own local contracts.
Keep examples with their component and link them from the [catalog](../guides/examples.md).
Update incoming links when moving pages. Describe current behavior directly. Retain version-scoped decision records only
when they still explain a supported contract; label superseded constraints.

Follow [standard 0.1.0](../_standards/standard.md). Report passed, failed, and
unverified checks separately.

Website publication uses [the manifest and pinned importer](publication.md).

## Refresh onboarding screenshots

From the Suite root, start the fixture server:

```sh
npm --prefix apps/web run dev -- --host 127.0.0.1 --port 5347 --strictPort
```

In another terminal, with Web dependencies and Playwright Chromium installed:

```sh
node scripts/docs/capture-onboarding.mjs
```

Inspect the five images under `docs/assets/screenshots/onboarding/`. The capture
uses real UI components with simulated data, blocks live API calls, and records
source hashes in `capture.json`. Stop the fixture server with Ctrl+C afterward.

## Refresh workspace screenshots

With the same loopback fixture server running:

```sh
node scripts/docs/capture-workspace.mjs
```

Inspect `docs/assets/screenshots/workspace/`. The script uses simulated messages,
files, and terminal output; it does not execute shell commands or model requests.

## Refresh update screenshots

With the same loopback fixture server running:

```sh
node scripts/docs/capture-updates.mjs
```

Inspect `docs/assets/screenshots/updates/`. Versions and licenses are examples;
no real downloads or installation requests are made.

Capture the example workflow graphs with the same local Web server:

```sh
node scripts/docs/capture-example-workflow.mjs
```

This records five authored drafts in the real builder with fixture authentication.
It does not run agents or submit an MCP workflow. Capture metadata retains the draft
and source hashes beside the images. Layout definitions live in
`scripts/docs/example-workflows.json`; they are screenshot inputs, not runnable MCP submissions.

## Refresh native launcher screenshots

With Web dependencies and Playwright Chromium installed, run from the Suite root:

```sh
node apps/desktop/docs/development/capture-launcher.mjs
```

The helper renders real launcher assets with read-only mocked native responses
and blocks HTTP(S). It records hashes and fixture scope under
`apps/desktop/docs/assets/screenshots/`; it does not qualify native WebView,
transport or installer behavior. See [Desktop verification](../../apps/desktop/docs/development/verification.md).
