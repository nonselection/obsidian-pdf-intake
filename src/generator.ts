import { PdfMetadata, PdfMetadataSettings, DEFAULT_SETTINGS } from "./types";

export interface FrontmatterOptions {
	typeField: boolean;
	fileSize: boolean;
	creatorProducer: boolean;
	keywordsAsTags: boolean;
}

const DEFAULT_FRONTMATTER_OPTIONS: FrontmatterOptions = {
	typeField: DEFAULT_SETTINGS.frontmatterTypeField,
	fileSize: DEFAULT_SETTINGS.frontmatterFileSize,
	creatorProducer: DEFAULT_SETTINGS.frontmatterCreatorProducer,
	keywordsAsTags: DEFAULT_SETTINGS.frontmatterKeywordsAsTags,
};

export function generateFrontmatter(
	metadata: PdfMetadata,
	options: FrontmatterOptions = DEFAULT_FRONTMATTER_OPTIONS
): string {
	const lines: string[] = [];

	// Type field for easy Dataview filtering
	if (options.typeField) {
		lines.push(`type: pdf`);
	}

	if (metadata.title) {
		lines.push(`title: "${escapeYaml(metadata.title)}"`);
	}
	if (metadata.author) {
		lines.push(`author: "${escapeYaml(metadata.author)}"`);
	}
	if (metadata.subject) {
		lines.push(`subject: "${escapeYaml(metadata.subject)}"`);
	}

	// Keywords with proper quoting for Dataview
	if (metadata.keywords?.length) {
		const escaped = metadata.keywords.map((k) => `"${escapeYaml(k)}"`);
		lines.push(`keywords: [${escaped.join(", ")}]`);
	}

	// Copy keywords to tags for Obsidian tag system
	if (options.keywordsAsTags && metadata.keywords?.length) {
		const tags = metadata.keywords.map((k) => formatTag(k));
		lines.push(`tags: [${tags.join(", ")}]`);
	}

	if (metadata.creationDate) {
		lines.push(`created: ${formatDate(metadata.creationDate)}`);
	}
	if (metadata.modificationDate) {
		lines.push(`modified: ${formatDate(metadata.modificationDate)}`);
	}
	if (metadata.pageCount > 0) {
		lines.push(`pages: ${metadata.pageCount}`);
	}

	// File size in human-readable format
	if (options.fileSize && metadata.fileSize > 0) {
		lines.push(`fileSize: "${formatFileSize(metadata.fileSize)}"`);
		lines.push(`fileSizeBytes: ${metadata.fileSize}`);
	}

	// Creator and producer (PDF creation software)
	if (options.creatorProducer) {
		if (metadata.creator) {
			lines.push(`creator: "${escapeYaml(metadata.creator)}"`);
		}
		if (metadata.producer) {
			lines.push(`producer: "${escapeYaml(metadata.producer)}"`);
		}
	}

	lines.push(`source: "[[${metadata.filePath}]]"`);

	return lines.join("\n") + "\n";
}

export function generateCompanionNote(
	metadata: PdfMetadata,
	template: string,
	thumbnailPath?: string,
	annotationsContent?: string,
	frontmatterOptions?: FrontmatterOptions
): string {
	const frontmatter = generateFrontmatter(metadata, frontmatterOptions);
	const title = metadata.title || getFileNameWithoutExtension(metadata.filePath);
	const embed = `![[${metadata.filePath}]]`;
	const thumbnail = thumbnailPath ? `![[${thumbnailPath}]]` : "";
	const annotations = annotationsContent || "";

	const body = template
		.replace(/\{\{title\}\}/g, title)
		.replace(/\{\{embed\}\}/g, embed)
		.replace(/\{\{thumbnail\}\}/g, thumbnail)
		.replace(/\{\{annotations\}\}/g, annotations);

	return `---\n${frontmatter}---\n\n${body}`;
}

export function generateIndexNote(allMetadata: PdfMetadata[]): string {
	const header = "| File | Title | Author | Pages | Created |\n|------|-------|--------|-------|---------|";

	const rows = allMetadata.map((m) => {
		const file = `[[${m.filePath}]]`;
		const title = m.title || "-";
		const author = m.author || "-";
		const pages = m.pageCount > 0 ? m.pageCount.toString() : "-";
		const created = m.creationDate ? formatDate(m.creationDate) : "-";
		return `| ${file} | ${title} | ${author} | ${pages} | ${created} |`;
	});

	return `# PDF Index\n\n${header}\n${rows.join("\n")}`;
}

export function getSidecarPath(pdfPath: string): string {
	return `${pdfPath}.metadata.md`;
}

export function getCompanionNotePath(
	pdfPath: string,
	outputFolder: string
): string {
	const fileName = getFileNameWithoutExtension(pdfPath);
	return `${outputFolder}/${fileName}.md`;
}

function escapeYaml(value: string): string {
	return value.replace(/"/g, '\\"').replace(/\n/g, " ");
}

function formatDate(date: Date): string {
	return date.toISOString().split("T")[0];
}

function formatFileSize(bytes: number): string {
	const units = ["B", "KB", "MB", "GB"];
	let size = bytes;
	let unitIndex = 0;

	while (size >= 1024 && unitIndex < units.length - 1) {
		size /= 1024;
		unitIndex++;
	}

	return `${size.toFixed(unitIndex > 0 ? 1 : 0)} ${units[unitIndex]}`;
}

function formatTag(keyword: string): string {
	// Convert keyword to valid Obsidian tag format
	// Remove special characters, replace spaces with hyphens
	return keyword
		.toLowerCase()
		.replace(/[^\w\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function getFileNameWithoutExtension(path: string): string {
	const parts = path.split("/");
	const fileName = parts[parts.length - 1];
	return fileName.replace(/\.pdf$/i, "");
}
