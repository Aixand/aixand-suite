# Publish docs to the project site

Source Markdown stays in Suite. [publication.json](../publication.json) selects
website pages, stable URL slugs, navigation sections, and ordering.

Selected pages cover getting started, task guides, architecture, reference, and
development. Installation, `quickstart`, and remote-access URLs stay unchanged.
Writing standards, documentation maintenance, publication instructions, and release
operations stay repository-only. Component READMEs remain source links.

## Import

After committing the source docs, run from `project-site`. Replace `SOURCE_SHA`
with the exact 40-character Suite commit containing the manifest and pages.

```sh
npm run docs:sync -- --source ../aixand-suite --repository https://github.com/Aixand/aixand-suite --revision SOURCE_SHA --output .
npm run build
```

The importer reads that commit, not dirty working files. It generates article
metadata, website links between selected pages, commit-pinned GitHub links for
other source files, and content-addressed image assets. Source paths and Markdown
anchors are checked before output is written.

Edit source docs, then import again. Do not hand-edit generated articles.
Existing site pages outside the manifest stay unchanged. Removed/renamed routes
need an explicit cleanup/redirect review; sync does not delete them automatically.

## Preview uncommitted docs

From `project-site`, use a separate output directory:

```sh
npm run docs:sync -- --source ../aixand-suite --repository https://github.com/Aixand/aixand-suite --working-tree --output /tmp/suite-docs-preview
```

Preview pages are marked uncommitted and have no pinned source attribution.
Fallback GitHub links use `main` and may not exist until changes are published.
Do not publish preview output. Importing does not deploy the site.

## Manifest fields

| Field | Meaning |
| --- | --- |
| `schema` | Publication format version; currently `1` |
| `project` | Website project identifier |
| `pages[].file` | Markdown path relative to the manifest directory |
| `pages[].slug` | Stable route under `/<project>/docs/` |
| `pages[].section` / `order` | Navigation group and order |
| `pages[].title` / `description` | Optional overrides; otherwise derived from H1/first paragraph |

The importer accepts ordinary Markdown with one H1. Keep relative source links;
raw HTML, source frontmatter, and root-relative site links are rejected. Runnable
example files remain source links; the importer does not package downloadable
example bundles. Mermaid source passes through to the site's existing renderer.
