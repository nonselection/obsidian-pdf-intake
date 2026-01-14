import { PdfMetadata } from "./types";

export function generateFrontmatter(metadata: PdfMetadata): string {
	const lines: string[] = [];

	if (metadata.title) {
		lines.push(`title: "${escapeYaml(metadata.title)}"`);
	}
	if (metadata.author) {
		lines.push(`author: "${escapeYaml(metadata.author)}"`);
	}
	if (metadata.subject) {
		lines.push(`subject: "${escapeYaml(metadata.subject)}"`);
	}
	if (metadata.keywords?.length) {
		const escaped = metadata.keywords.map((k) => escapeYaml(k));
		lines.push(`keywords: [${escaped.join(", ")}]`);
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
	lines.push(`source: "[[${metadata.filePath}]]"`);

	return lines.join("\n") + "\n";
}

export function generateCompanionNote(
	metadata: PdfMetadata,
	template: string,
	thumbnailPath?: string,
	annotationsContent?: string
): string {
	const frontmatter = generateFrontmatter(metadata);
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

function getFileNameWithoutExtension(path: string): string {
	const parts = path.split("/");
	const fileName = parts[parts.length - 1];
	return fileName.replace(/\.pdf$/i, "");
}
