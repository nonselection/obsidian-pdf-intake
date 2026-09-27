# PDF Intake

A small personal-use Obsidian plugin for resolving bibliographic metadata for PDFs already stored in your vault and safely processing them from a persistent workspace tab.

## Command

- **Open PDF Intake** — Opens or focuses the existing PDF Intake tab and refreshes the configured intake folder.

The workspace view lists PDFs without resolving them automatically. Select files, choose **Resolve selected**, review each final destination, then explicitly choose **Process selected ready files**. Unresolved and failed entries allow another DOI or ISBN to be submitted for lookup.

## Settings

- **Intake folder** — An existing vault folder. Type to search existing folders; a missing folder blocks scanning.
- **Processed files** — Keep renamed files beside their current file or move them into another existing vault folder. A missing destination blocks processing.
- **Filename template** — Supports `{title}`, `{author}`, `{authors}`, `{year}`, `{journal}`, and `{publisher}`. The year comes from the bibliographic lookup.

PDFs are read for text extraction and never modified. Confirmed processing uses one Obsidian Vault rename to the previewed final path, checks for conflicts, and leaves unresolved files unchanged. Metadata requests go only to Crossref and Open Library. No background file watcher is used.

## Development

```bash
npm ci
npm run check
npm run deploy
```

## Attribution

Derived from the MIT-licensed `obsidian-pdf-metadata-plugin` by Luca Gabriel Oelfke. The upstream MIT license is retained.
