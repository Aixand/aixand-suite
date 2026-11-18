# Publish docs to the project site

Suite owns the source Markdown; publication manifests choose site routes and
navigation. Repository policies, writing standards, release operations and
component package READMEs remain source references.

## Choose the owning manifest

| Area | Manifest |
| --- | --- |
| General docs and examples | `docs/publication.json` |
| Server / Web / Desktop & Client | `apps/server/docs/publication.json`, `apps/web/docs/publication.json`, `apps/desktop/docs/publication.json` |
| Vox / Connect | `services/vox/docs/publication.json`, `services/connect/docs/publication.json` |
| Orchestration MCP | `mcps/orchestration/docs/publication.json` |
| Runner / Workflow IR | `workflow/runner/docs/publication.json`, `workflow/ir/docs/publication.json` |
| Python SDK / Runner Client | `sdks/python/docs/publication.json`, `workflow/runner/python/docs/publication.json` |

## Import

Commit source changes first. From `project-site`, replace `SOURCE_SHA` with the
exact 40-character Suite commit and select the owning manifest:

```sh
npm run docs:sync -- --source ../aixand-suite --repository https://github.com/Aixand/aixand-suite --manifest apps/web/docs/publication.json --revision SOURCE_SHA --output .
npm run build
```

Omit `--manifest` for General. Refresh each affected component. The importer reads
committed bytes, checks paths/anchors, copies content-addressed images, and emits
site links within each manifest plus commit-pinned source links for other files.
Do not hand-edit generated articles. Push source commits before public deployment
so their GitHub source links resolve. Importing never deploys the site.

General provenance is `src/content-imports/aixand-suite.json`; component provenance
is `src/content-imports/aixand-suite/COMPONENT.json`. Keep existing public slugs
when moving source files. Sync leaves files outside its manifest unchanged;
removed routes require an explicit redirect/removal review and generated-file cleanup.

## Preview uncommitted docs

Use a separate output directory from `project-site`:

```sh
npm run docs:sync -- --source ../aixand-suite --repository https://github.com/Aixand/aixand-suite --manifest apps/web/docs/publication.json --working-tree --output /tmp/suite-web-preview
```

Preview output has no pinned source attribution; fallback GitHub links use `main`.
Review it in an isolated site copy. Never deploy it or copy it into production content.

## Manifest fields

| Field | Contract |
| --- | --- |
| `schema` / `project` | `1` / `aixand-suite` |
| `component` | Optional for General; otherwise catalog ID, e.g. `web` |
| `pages[].file` | Unique concrete Markdown file relative to manifest directory; no parent traversal |
| `pages[].collection` | `docs` (default) or `examples` |
| `pages[].slug` | Stable route; component routes equal their ID or start `ID/` |
| `pages[].section` / `order` | Navigation section and integer reading order |
| `pages[].title` / `description` | Optional overrides for H1/first-paragraph defaults |

Use one H1 and source-relative file links. Published sources cannot contain
frontmatter, raw HTML or root-relative site URLs. Mermaid passes through to the
site renderer; examples remain source links rather than downloaded bundles.
Validate links and diagrams using [documentation checks](documentation.md).
