# PDF Metadata - Obsidian Plugin

## Overview

This plugin extracts embedded metadata from PDF files in an Obsidian vault and makes it accessible through companion notes, index files, or sidecar metadata files.

**Status:** Concept / Not yet implemented

## Tech Stack

- **Language:** TypeScript (strict mode)
- **Build:** esbuild
- **PDF Parsing:** pdf-lib or pdf-parse
- **Framework:** Obsidian Plugin API

## Project Structure (Planned)

```
src/
  main.ts              # Plugin entry point, commands, lifecycle
  types.ts             # Interfaces, settings, defaults
  extractor.ts         # PDF metadata extraction logic
  generator.ts         # Companion note / index generation
  scanner.ts           # Vault scanning for PDFs
  watcher.ts           # File watcher for new PDFs
  settings.ts          # Settings tab UI
  modal.ts             # Metadata view/edit modal

styles.css             # Plugin styles
```

## Core Concepts

### PDF Metadata Extraction

```typescript
interface PdfMetadata {
  // Standard PDF properties
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
  creator?: string;       // Application that created the PDF
  producer?: string;      // PDF producer
  creationDate?: Date;
  modificationDate?: Date;

  // Derived properties
  pageCount: number;
  fileSize: number;       // In bytes
  filePath: string;       // Vault-relative path
}
```

### Extraction with pdf-lib

```typescript
import { PDFDocument } from 'pdf-lib';

async function extractMetadata(file: TFile, vault: Vault): Promise<PdfMetadata> {
  const buffer = await vault.readBinary(file);
  const pdf = await PDFDocument.load(buffer);

  const title = pdf.getTitle();
  const author = pdf.getAuthor();
  const subject = pdf.getSubject();
  const keywords = pdf.getKeywords()?.split(',').map(k => k.trim());
  const creator = pdf.getCreator();
  const producer = pdf.getProducer();
  const creationDate = pdf.getCreationDate();
  const modificationDate = pdf.getModificationDate();
  const pageCount = pdf.getPageCount();

  return {
    title,
    author,
    subject,
    keywords,
    creator,
    producer,
    creationDate,
    modificationDate,
    pageCount,
    fileSize: buffer.byteLength,
    filePath: file.path,
  };
}
```

### Alternative: pdf-parse

```typescript
import pdf from 'pdf-parse';

async function extractWithPdfParse(file: TFile, vault: Vault): Promise<PdfMetadata> {
  const buffer = await vault.readBinary(file);
  const data = await pdf(Buffer.from(buffer));

  return {
    title: data.info?.Title,
    author: data.info?.Author,
    subject: data.info?.Subject,
    keywords: data.info?.Keywords?.split(',').map(k => k.trim()),
    creator: data.info?.Creator,
    producer: data.info?.Producer,
    creationDate: data.info?.CreationDate ? new Date(data.info.CreationDate) : undefined,
    modificationDate: data.info?.ModDate ? new Date(data.info.ModDate) : undefined,
    pageCount: data.numpages,
    fileSize: buffer.byteLength,
    filePath: file.path,
  };
}
```

## Output Modes

### 1. Companion Notes

```typescript
function generateCompanionNote(metadata: PdfMetadata, template: string): string {
  const frontmatter = generateFrontmatter(metadata);
  const body = template
    .replace('{{title}}', metadata.title || 'Untitled')
    .replace('{{embed}}', `![[${metadata.filePath}]]`);

  return `---\n${frontmatter}---\n\n${body}`;
}

function generateFrontmatter(metadata: PdfMetadata): string {
  const lines: string[] = [];

  if (metadata.title) lines.push(`title: "${metadata.title}"`);
  if (metadata.author) lines.push(`author: "${metadata.author}"`);
  if (metadata.subject) lines.push(`subject: "${metadata.subject}"`);
  if (metadata.keywords?.length) {
    lines.push(`keywords: [${metadata.keywords.join(', ')}]`);
  }
  if (metadata.creationDate) {
    lines.push(`created: ${metadata.creationDate.toISOString().split('T')[0]}`);
  }
  lines.push(`pages: ${metadata.pageCount}`);
  lines.push(`source: "[[${metadata.filePath}]]"`);

  return lines.join('\n') + '\n';
}
```

### 2. Index Note

```typescript
function generateIndexNote(allMetadata: PdfMetadata[]): string {
  const header = '| File | Title | Author | Pages | Created |\n|------|-------|--------|-------|---------|';

  const rows = allMetadata.map(m => {
    const file = `[[${m.filePath}]]`;
    const title = m.title || '-';
    const author = m.author || '-';
    const pages = m.pageCount;
    const created = m.creationDate?.toISOString().split('T')[0] || '-';
    return `| ${file} | ${title} | ${author} | ${pages} | ${created} |`;
  });

  return `# PDF Index\n\n${header}\n${rows.join('\n')}`;
}
```

### 3. Sidecar Files

```typescript
function getSidecarPath(pdfPath: string): string {
  return `${pdfPath}.metadata.md`;
}

async function writeSidecar(metadata: PdfMetadata, vault: Vault): Promise<void> {
  const sidecarPath = getSidecarPath(metadata.filePath);
  const content = generateCompanionNote(metadata, '# {{title}}\n\n{{embed}}');

  await vault.create(sidecarPath, content);
}
```

## Vault Scanning

```typescript
async function scanVault(vault: Vault, settings: Settings): Promise<TFile[]> {
  const pdfs: TFile[] = [];

  for (const file of vault.getFiles()) {
    if (file.extension !== 'pdf') continue;
    if (shouldIgnore(file.path, settings.ignorePatterns)) continue;
    if (!isInScanFolders(file.path, settings.scanFolders)) continue;

    pdfs.push(file);
  }

  return pdfs;
}

function shouldIgnore(path: string, patterns: string[]): boolean {
  return patterns.some(pattern => {
    const regex = new RegExp(pattern.replace('*', '.*'));
    return regex.test(path);
  });
}
```

## File Watcher

```typescript
function setupWatcher(plugin: Plugin, settings: Settings): void {
  plugin.registerEvent(
    plugin.app.vault.on('create', async (file) => {
      if (!(file instanceof TFile)) return;
      if (file.extension !== 'pdf') return;
      if (!settings.watchForNewPdfs) return;

      const metadata = await extractMetadata(file, plugin.app.vault);
      await handleNewPdf(metadata, settings);
    })
  );
}
```

## Settings

```typescript
interface PdfMetadataSettings {
  scanFolders: string[];           // Folders to scan, empty = all
  ignorePatterns: string[];        // Glob patterns to ignore
  outputMode: 'companion' | 'index' | 'sidecar';
  outputFolder: string;            // For companion notes
  indexPath: string;               // For index mode
  autoScanOnOpen: boolean;
  watchForNewPdfs: boolean;
  companionTemplate: string;       // Customizable template
  overwriteExisting: boolean;
}

const DEFAULT_SETTINGS: PdfMetadataSettings = {
  scanFolders: [],
  ignorePatterns: ['**/node_modules/**', '**/.obsidian/**'],
  outputMode: 'companion',
  outputFolder: 'PDF Notes',
  indexPath: 'PDF Index.md',
  autoScanOnOpen: false,
  watchForNewPdfs: true,
  companionTemplate: '# {{title}}\n\n{{embed}}\n\n## Notes\n\n',
  overwriteExisting: false,
};
```

## Commands

```typescript
// In onload():
this.addCommand({
  id: 'scan-vault-pdfs',
  name: 'Scan vault for PDFs',
  callback: () => this.scanAndProcess(),
});

this.addCommand({
  id: 'extract-current-pdf',
  name: 'Extract metadata for current PDF',
  checkCallback: (checking) => {
    const file = this.app.workspace.getActiveFile();
    if (file?.extension !== 'pdf') return false;
    if (!checking) this.extractSingle(file);
    return true;
  },
});

this.addCommand({
  id: 'rebuild-pdf-index',
  name: 'Rebuild PDF index',
  callback: () => this.rebuildIndex(),
});
```

## Dependencies

```json
{
  "dependencies": {
    "obsidian": "latest",
    "pdf-lib": "^1.17.1"
  },
  "devDependencies": {
    "@types/node": "^16.11.6",
    "esbuild": "^0.25.0",
    "typescript": "^5.0.0"
  }
}
```

## Potential Issues

- **Large PDFs**: May need streaming or chunked reading
- **Encrypted PDFs**: pdf-lib can't read encrypted files without password
- **Corrupted PDFs**: Need error handling for malformed files
- **Missing metadata**: Many PDFs have no embedded metadata
- **Character encoding**: Non-ASCII characters in metadata may need handling
- **Performance**: Scanning hundreds of PDFs could be slow

## Future Features

- **OCR integration**: Extract text from scanned PDFs
- **Thumbnail extraction**: Generate preview images
- **Full-text indexing**: Index PDF content for search
- **Write-back**: Modify PDF metadata from Obsidian
- **Batch rename**: Rename PDFs based on metadata
- **Duplicate detection**: Find duplicate PDFs by content hash

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Development mode
npm run dev
```

## Testing

1. Create test vault with various PDFs
2. Include: PDFs with full metadata, empty metadata, encrypted, corrupted
3. Test each output mode
4. Test file watcher with new PDF drops
5. Test performance with 100+ PDFs
