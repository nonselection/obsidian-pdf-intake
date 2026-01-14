<div align="center">

# PDF Metadata

**Extract and manage PDF metadata in Obsidian**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-0.15.0+-7C3AED?style=flat-square&logo=obsidian&logoColor=white)](https://obsidian.md)

*Automatically extract embedded metadata from PDFs and make it searchable*

</div>

---

## The Problem

PDFs contain embedded metadata (author, title, keywords, creation date) that Obsidian can't read. Managing a large PDF library means:

- Manually tracking what each PDF contains
- No way to search PDFs by author or subject
- No integration with Obsidian's property system

## The Solution

PDF Metadata automatically extracts embedded metadata from PDFs in your vault and makes it accessible:

```
research-paper.pdf
├── Title: "Machine Learning in Practice"
├── Author: "Smith, John"
├── Subject: "Computer Science"
├── Keywords: "ML, AI, Neural Networks"
├── Created: 2024-01-15
└── Pages: 42
```

---

## Features

### Metadata Extraction

- **Auto-scan** — Detect PDFs in your vault
- **Extract metadata** — Title, author, subject, keywords, dates, page count
- **Batch processing** — Process entire folders at once

### Integration Options

#### Option 1: Companion Notes
Generate a markdown note for each PDF with frontmatter:

```markdown
---
title: "Machine Learning in Practice"
author: "Smith, John"
subject: "Computer Science"
keywords: [ML, AI, Neural Networks]
created: 2024-01-15
pages: 42
source: "[[research-paper.pdf]]"
---

# Machine Learning in Practice

PDF: ![[research-paper.pdf]]

## Notes

(your annotations here)
```

#### Option 2: Index Note
Generate a single index with all PDF metadata:

```markdown
# PDF Library

| File | Title | Author | Keywords |
|------|-------|--------|----------|
| [[paper1.pdf]] | Machine Learning | Smith | ML, AI |
| [[paper2.pdf]] | Database Design | Jones | SQL, NoSQL |
```

#### Option 3: Sidecar Files
Create `.metadata.md` files alongside PDFs:

```
papers/
├── research.pdf
├── research.pdf.metadata.md
├── thesis.pdf
└── thesis.pdf.metadata.md
```

### Search & Query

- **Property search** — Find PDFs by author, subject, keywords
- **Dataview compatible** — Query PDF metadata with Dataview
- **Bases compatible** — Use Obsidian Bases for PDF databases

### Metadata Editing

- **Edit extracted data** — Fix incorrect metadata
- **Add custom fields** — Extend with your own properties
- **Write back** — Optionally write metadata back to PDF

---

## Commands

| Command | Description |
|---------|-------------|
| Scan vault for PDFs | Find all PDFs and extract metadata |
| Extract metadata for current PDF | Process single PDF |
| Generate companion note | Create markdown note for PDF |
| Rebuild PDF index | Regenerate index note |
| Open PDF metadata | View/edit metadata for a PDF |

---

## Settings

| Setting | Description |
|---------|-------------|
| **Scan folders** | Which folders to scan for PDFs |
| **Ignore patterns** | Folders/files to skip |
| **Output mode** | Companion notes, index, or sidecar |
| **Output folder** | Where to create companion notes |
| **Auto-scan** | Scan on vault open |
| **Watch for new PDFs** | Auto-extract when PDFs added |
| **Frontmatter template** | Customize generated frontmatter |

---

## Use Cases

### Academic Research
```markdown
---
title: "Neural Network Architectures"
author: "Chen, Wei"
journal: "Nature"
year: 2024
doi: "10.1234/example"
status: unread
---
```

### Legal Documents
```markdown
---
title: "Contract Agreement"
parties: ["Company A", "Company B"]
date: 2024-03-15
type: contract
status: signed
---
```

### Book Library
```markdown
---
title: "Clean Code"
author: "Robert C. Martin"
isbn: "978-0132350884"
pages: 464
genre: programming
rating: 5
---
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
| Pages | Page count |
| File size | From filesystem |

### Libraries

- **pdf-lib** — PDF parsing and metadata extraction
- **pdf-parse** — Alternative parser for complex PDFs

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
```

---

## Roadmap

- [ ] Core metadata extraction
- [ ] Companion note generation
- [ ] Index note generation
- [ ] Sidecar file mode
- [ ] Auto-scan on vault open
- [ ] Watch for new PDFs
- [ ] Dataview integration
- [ ] Write metadata back to PDF
- [ ] OCR integration for scanned PDFs
- [ ] Thumbnail extraction

---

## Related Plugins

- **Block Properties** — Add metadata to individual blocks
- **Dataview** — Query and display data
- **Zotero Integration** — Academic reference management

---

## License

[MIT](LICENSE)

---

<div align="center">

*Inspired by a community request*

</div>
