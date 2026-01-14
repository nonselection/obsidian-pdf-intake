<div align="center">

# PDF Metadata

**Extract, view, edit and manage PDF metadata in Obsidian**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-0.15.0+-7C3AED?style=flat-square&logo=obsidian&logoColor=white)](https://obsidian.md)

</div>

---

## Features

### Metadata Extraction
- **Auto-extract** — Title, author, subject, keywords, creator, producer, dates
- **Page count & file size** — Automatically calculated
- **Batch processing** — Process entire vault at once

### Companion Notes
Generate markdown notes with full frontmatter:

```yaml
---
title: "Machine Learning in Practice"
author: "Smith, John"
subject: "Computer Science"
keywords: [ML, AI, Neural Networks]
created: 2024-01-15
pages: 42
source: "[[research-paper.pdf]]"
type: pdf
---
```

### Thumbnails
- Generate preview images from any page
- Single page, multiple pages, or gallery selection
- Configurable scale and output folder

### Annotations
Extract highlights, notes, underlines, and strikeouts:
- Color preservation
- Group by page or type
- Include in companion notes

### Smart Rename (DOI/ISBN Lookup)
Automatically fetch metadata from online sources:
- **CrossRef** — Academic papers via DOI
- **OpenLibrary** — Books via ISBN
- Auto-detect identifiers in PDF text
- Template-based renaming: `{author} - {title} ({year})`

### Additional Features
- **Metadata Write-back** — Edit and save metadata to PDF
- **Batch Rename** — Rename multiple PDFs by template
- **Duplicate Detection** — Find duplicates via SHA-256 hash
- **Citation Export** — BibTeX and RIS format
- **Dataview Integration** — Query PDFs with Dataview

---

## Commands

| Command | Description |
|---------|-------------|
| `Scan vault for PDFs` | Process all PDFs and generate notes |
| `View PDF metadata` | Show metadata modal with edit option |
| `Generate companion note` | Create note for current PDF |
| `Smart rename PDF (DOI/ISBN lookup)` | Fetch metadata online and rename |
| `Batch rename PDFs` | Rename multiple PDFs by template |
| `Find duplicate PDFs` | Detect duplicates by content |
| `Generate thumbnail` | Create preview image |
| `Select thumbnail page from gallery` | Choose page visually |
| `View PDF annotations` | Show extracted annotations |
| `Extract annotations from current PDF` | Add to companion note |
| `Export citation (BibTeX/RIS)` | Export citation |
| `Sync metadata from companion note` | Write frontmatter to PDF |

---

## Output Modes

### Companion Notes
One markdown note per PDF in a dedicated folder:
```
PDF Notes/
├── paper1.md
├── paper2.md
└── thesis.md
```

### Index Note
Single file listing all PDFs:
```markdown
# PDF Library

| File | Title | Author | Pages |
|------|-------|--------|-------|
| [[paper1.pdf]] | Machine Learning | Smith | 42 |
```

### Sidecar Files
Metadata files alongside PDFs:
```
papers/
├── research.pdf
├── research.pdf.metadata.md
```

---

## Dataview Examples

**List PDFs by author:**
```dataview
TABLE author, pages, created
FROM ""
WHERE type = "pdf"
SORT author ASC
```

**Find PDFs with keyword:**
```dataview
LIST
FROM ""
WHERE contains(keywords, "machine learning")
```

**PDFs created this year:**
```dataview
TABLE title, author
FROM ""
WHERE type = "pdf" AND created >= date(2024-01-01)
```

---

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Output Mode | companion / index / sidecar | companion |
| Output Folder | Where to save notes | PDF Notes |
| Watch for new PDFs | Auto-process new PDFs | true |
| Generate Thumbnails | Create preview images | false |
| Thumbnail Scale | Size percentage | 30% |
| Thumbnail Page | Which page (0 = last) | 1 |
| Extract Annotations | Include in notes | false |
| Annotation Types | highlight, note, underline, strikeout | all |
| Rename Template | Pattern for renaming | `{author} - {title}` |

---

## Installation

### Manual
1. Download latest release
2. Extract to `.obsidian/plugins/pdf-metadata/`
3. Enable in Settings → Community plugins

### From Source
```bash
git clone https://github.com/username/obsidian-pdf-metadata.git
cd obsidian-pdf-metadata
npm install
npm run build
cp main.js manifest.json styles.css /path/to/vault/.obsidian/plugins/pdf-metadata/
```

---

## Technical Details

### Supported Metadata Fields

| Field | PDF Property |
|-------|--------------|
| Title | `/Title` |
| Author | `/Author` |
| Subject | `/Subject` |
| Keywords | `/Keywords` |
| Creator | `/Creator` |
| Producer | `/Producer` |
| Created | `/CreationDate` |
| Modified | `/ModDate` |

### External APIs

| Service | Use Case | Endpoint |
|---------|----------|----------|
| CrossRef | DOI lookup | `api.crossref.org/works/{doi}` |
| OpenLibrary | ISBN lookup | `openlibrary.org/isbn/{isbn}.json` |

### Libraries
- **pdf-lib** — Metadata extraction and write-back
- **pdfjs-dist** — Thumbnail rendering, text extraction, annotations

---

## Related Plugins

- **Block Properties** — Add metadata to individual blocks
- **Typed Links** — Semantic relationship types for links
- **Dataview** — Query and display data

---

## License

[MIT](LICENSE)
