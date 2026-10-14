# PDF Intake

A small Obsidian plugin for normalizing the bibliographic envelope of PDFs already stored in a vault. It supports explicit PDF sessions, automatic identification, contextual bibliographic repair, unfinished-session recovery, and reviewed rename-only Apply.

## Command

- **Open PDF Intake** — Opens or focuses the existing PDF Intake workspace view. It does not scan a folder or add PDFs to the session.

New sessions start empty and use the PDFs / Output / Metadata & naming setup concerns. Add PDFs uses the explicit vault-scoped chooser. Begin review automatically identifies current session PDFs; the working surface keeps cards in session order and shows Identifying, Needs you, Ready, No changes needed, and Applied outcomes. The inline inspector supports bounded evidence, direct DOI/ISBN lookup, explicit candidate acceptance, manual record Save, retry, and leaving a Needs-you item unresolved. Apply includes only the current eligible Ready rename subset.

## Settings

- **Workspace edits** — Keep setup changes for future sessions, or apply them only to the current session.
- **Default output** — Keep each PDF in its current folder, choose an existing vault folder, or explicitly choose the vault root.
- **Default filename convention** — The factory format is `<first-author family name>[ et al.] (<year>). <title>`. Valid migrated filename templates are retained exactly.

Legacy intake-folder settings never populate a session. A malformed/empty legacy destination migrates to current source folders; it is not treated as vault root. Plugin data uses a versioned envelope with separate settings/default and unfinished-session namespaces. After the first successful PDF admission, a bounded draft preserves unfinished work and presents a recovery decision after plugin reload. Resume restores the session's saved configuration and membership, then revalidates source paths before recomputing planning.

Canonical authorship preserves full provider order and unresolved positions separately from filename representations. DOI/ISBN evidence is checked against bounded local title candidates before a provider result can become canonical. Identification reads at most the first three PDF pages when review begins; PDF.js remains lazy and isolated. Apply renames paths only and does not write PDF bytes or metadata.

PDF Intake does not modify PDF bytes. Cross-reload source trust uses exact path, PDF extension, and matching finite mtime/size; that is not byte-level identity. Draft recovery does not recover or replay file operations. Mobile/iPad and final visual/accessibility qualification remain incomplete.

## Development

```bash
npm ci
npm run check
npm run deploy
```

`npm run deploy` targets the dedicated development vault. Never use `npm run deploy:actual` without explicit human authorization.

## Attribution

Derived from the MIT-licensed `obsidian-pdf-metadata-plugin` by Luca Gabriel Oelfke. The upstream MIT license is retained.
