# PDF Intake

## Purpose

A small, foreground-only Obsidian plugin for resolving bibliographic metadata for PDFs already in the vault and safely renaming them after user review in a persistent workspace tab.

## Safety constraints

- PDF files are read only. Never serialize or write PDF binary contents.
- The only file mutation is one `Vault.rename` to the previewed final path after the user selects ready items and explicitly processes them.
- Resolution never renames files. There are no vault-open or file-create handlers.
- Batch processing is limited to a validated existing intake folder; invalid or empty paths never scan the entire vault.
- The optional processed folder must also exist. Check final path conflicts before showing ready status and immediately before every rename. Never overwrite.
- Keep network requests limited to Crossref and Open Library.

## Architecture

- `resolver.ts` is the shared DOI/ISBN resolution primitive for detected and manually supplied identifiers.
- `pdf-text.ts` extracts text from the first few pages using PDF.js with its bundled worker message handler exposed for the supported main-thread fake-worker path.
- `lookup.ts` detects identifiers and queries Crossref/Open Library.
- `intake.ts` validates folders, selects eligible files, generates safe names and final paths, plans conflicts, and performs the guarded Vault rename.
- `view.ts` implements the durable `pdf-intake-view` workspace tab and explicit selection/resolution/processing controls.
- `main.ts` registers the view and one open/focus command; `settings.ts` provides vault-folder suggestions and template settings.

## Validation

```bash
npm run check
npm run build
npm run deploy
```
