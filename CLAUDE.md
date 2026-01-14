# PDF Metadata - Obsidian Plugin

## Overview

This plugin extracts embedded metadata from PDF files in an Obsidian vault and makes it accessible through companion notes, index files, or sidecar metadata files. It also supports annotation extraction, thumbnail generation, citation export, and smart renaming via DOI/ISBN lookup.

**Status:** Implemented and functional

## Tech Stack

- **Language:** TypeScript (strict mode)
- **Build:** esbuild
- **PDF Parsing:** pdf-lib (metadata), pdfjs-dist (rendering, text extraction)
- **Framework:** Obsidian Plugin API

## Project Structure

```
src/
  main.ts              # Plugin entry point, commands, lifecycle
  types.ts             # Interfaces, settings, defaults
  extractor.ts         # PDF metadata and text extraction
  generator.ts         # Companion note / index generation
  scanner.ts           # Vault scanning for PDFs
  settings.ts          # Settings tab UI
  modal.ts             # All modals (metadata, rename, duplicates, etc.)
  renamer.ts           # Batch rename logic
  duplicates.ts        # Duplicate detection via content hash
  thumbnail.ts         # Thumbnail generation from PDF pages
  writeback.ts         # Write metadata back to PDF files
  annotations.ts       # PDF annotation extraction
  lookup.ts            # DOI/ISBN lookup via CrossRef/OpenLibrary

styles.css             # Plugin styles
manifest.json          # Obsidian plugin manifest
```

## Features

### Implemented

- **Metadata Extraction**: Extract title, author, subject, keywords, creator, producer, dates, page count
- **Output Modes**: Companion notes, index file, or sidecar files
- **Thumbnail Generation**: Single page, multiple pages, or gallery selection
- **Annotation Extraction**: Highlights, notes, underlines, strikeouts with color support
- **Metadata Write-back**: Modify PDF metadata from Obsidian
- **Batch Rename**: Rename PDFs based on metadata template
- **Smart Rename**: DOI/ISBN lookup via CrossRef and OpenLibrary APIs
- **Duplicate Detection**: Find duplicates by SHA-256 content hash
- **Citation Export**: BibTeX and RIS format export
- **Dataview Integration**: Frontmatter fields for Dataview queries

### Commands

| Command | Description |
|---------|-------------|
| `Scan vault for PDFs` | Process all PDFs in vault |
| `Extract metadata for current PDF` | Extract metadata for active PDF |
| `View PDF metadata` | Show metadata modal with edit option |
| `Generate companion note` | Create companion note for active PDF |
| `Rebuild PDF index` | Regenerate the PDF index file |
| `Batch rename PDFs` | Preview and execute batch rename |
| `Smart rename PDF (DOI/ISBN lookup)` | Lookup metadata online and rename |
| `Find duplicate PDFs` | Scan for duplicate files |
| `Generate thumbnail` | Create thumbnail for active PDF |
| `Select thumbnail page from gallery` | Choose thumbnail page visually |
| `View PDF annotations` | Show annotations in modal |
| `Extract annotations from current PDF` | Add annotations to companion note |
| `Export citation (BibTeX/RIS)` | Export citation in academic format |
| `Sync metadata from companion note` | Write frontmatter back to PDF |

## Core Interfaces

```typescript
interface PdfMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
  creator?: string;
  producer?: string;
  creationDate?: Date;
  modificationDate?: Date;
  pageCount: number;
  fileSize: number;
  filePath: string;
}

interface PdfAnnotation {
  type: "highlight" | "note" | "underline" | "strikeout" | "freetext";
  content?: string;
  page: number;
  color?: string;
  rect?: number[];
  creationDate?: Date;
  modificationDate?: Date;
}

interface LookupResult {
  title?: string;
  authors?: string[];
  year?: number;
  journal?: string;
  publisher?: string;
  doi?: string;
  isbn?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  abstract?: string;
}
```

## External APIs

### CrossRef (DOI Lookup)
- Endpoint: `https://api.crossref.org/works/{DOI}`
- Returns: Title, authors, journal, year, volume, issue, pages, abstract

### OpenLibrary (ISBN Lookup)
- Endpoint: `https://openlibrary.org/isbn/{ISBN}.json`
- Returns: Title, authors, publisher, year

## Settings

Key settings available in the plugin settings tab:

- **Scan Folders**: Limit scanning to specific folders
- **Ignore Patterns**: Glob patterns to exclude
- **Output Mode**: companion / index / sidecar
- **Output Folder**: Where to create companion notes
- **Companion Template**: Customizable note template
- **Thumbnail Settings**: Enable, folder, scale, page selection mode
- **Annotation Settings**: Types to extract, grouping, colors
- **Frontmatter Options**: Type field, file size, keywords as tags
- **Rename Template**: Pattern for batch/smart rename

## Dependencies

```json
{
  "dependencies": {
    "obsidian": "latest",
    "pdf-lib": "^1.17.1",
    "pdfjs-dist": "^4.10.38"
  },
  "devDependencies": {
    "@types/node": "^16.11.6",
    "builtin-modules": "^3.3.0",
    "esbuild": "^0.25.0",
    "typescript": "^5.0.0"
  }
}
```

## Development

```bash
# Install dependencies
npm install

# Build for production
npm run build

# Development mode (watch)
npm run dev

# Deploy to vault (adjust path as needed)
cp main.js styles.css manifest.json ~/vault/.obsidian/plugins/pdf-metadata/
```

## Known Limitations

- **Encrypted PDFs**: Cannot read password-protected files
- **Large PDFs**: Thumbnail generation may be slow for very large files
- **Missing Metadata**: Many PDFs have no embedded metadata
- **API Rate Limits**: CrossRef/OpenLibrary may rate limit frequent requests

## Future Ideas

- OCR integration for scanned PDFs
- Full-text search indexing
- PDF merge/split functionality
- Zotero/Mendeley integration
