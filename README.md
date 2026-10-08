# PDF Intake

A small Obsidian plugin for normalizing the bibliographic envelope of PDFs already stored in a vault. The current Slice 1 implementation provides an explicit-session foundation, durable defaults and an honest setup shell. PDF selection, identification, working cards and an enabled Apply flow are not available yet.

## Command

- **Open PDF Intake** — Opens or focuses the existing PDF Intake workspace view. It does not scan a folder or add PDFs to the session.

The shell starts with a fresh empty session and the PDFs / Output / Metadata & naming setup concerns. Add PDFs and Begin review are disabled until later slices provide PDF admission and identification. Output and naming configuration can be inspected and edited now.

## Settings

- **Workspace edits** — Keep setup changes for future sessions, or apply them only to the current session.
- **Default output** — Keep each PDF in its current folder, choose an existing vault folder, or explicitly choose the vault root.
- **Default filename convention** — The factory format is `<first-author family name>[ et al.] (<year>). <title>`. Valid migrated filename templates are retained exactly.

Legacy intake-folder settings never populate a session. A malformed/empty legacy destination migrates to current source folders; it is not treated as vault root. Plugin data uses a versioned envelope with separate settings/default and opaque unfinished-session namespaces. Slice 1 retains that draft namespace but does not restore it.

The canonical authorship model preserves full provider order and uncertainty separately from filename representations. Current provider mapping remains lossy; identification must not be connected to the new session model until ordered authorship and unresolved provider positions can be preserved.

PDF Intake does not modify PDF bytes. Its PDF.js worker remains isolated and lazy for later read-only identification, and the current shell does not initialize extraction.

## Development

```bash
npm ci
npm run check
npm run deploy
```

`npm run deploy` targets the dedicated development vault. Never use `npm run deploy:actual` without explicit human authorization.

## Attribution

Derived from the MIT-licensed `obsidian-pdf-metadata-plugin` by Luca Gabriel Oelfke. The upstream MIT license is retained.
