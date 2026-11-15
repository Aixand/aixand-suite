# Validate documentation

From the Suite root, use Python 3.11+ for the offline checks:

```sh
python3 -B tests/tooling/checks/docs_test.py
python3 -B scripts/checks/check-docs.py --root .
```

The checker validates selected authored Markdown, local links and anchors,
headings, fences and Mermaid accessibility descriptions. It does not execute
examples, fetch external URLs or prove technical correctness. Update
[docs-checks.json](../../docs-checks.json) when adding an authored documentation
directory; dependency caches and generated build outputs are not documentation inputs.

With Node 22.13+ and a working Puppeteer Chromium installation, use the locked renderer:

```sh
npm ci --prefix tools/docs
python3 -B scripts/checks/check-docs.py --root . --render-mermaid /tmp/suite-diagrams --mmdc tools/docs/node_modules/.bin/mmdc
```

Use a fresh output directory. Inspect both default and dark previews for clipping,
readable labels and arrow direction. Local Mermaid CLI rendering does not verify
the destination hosting renderer. Follow the [standard](../_standards/standard.md)
and [agent workflow](../_standards/agent-workflow.md); keep transient verification
logs in review artifacts rather than source pages.
