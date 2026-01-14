import { TFile, Vault } from "obsidian";
import { PDFDocument } from "pdf-lib";
import { PdfMetadata } from "./types";

export async function writeMetadataToPdf(
	file: TFile,
	metadata: Partial<PdfMetadata>,
	vault: Vault
): Promise<void> {
	const buffer = await vault.readBinary(file);
	const pdf = await PDFDocument.load(buffer);

	if (metadata.title !== undefined) {
		pdf.setTitle(metadata.title || "");
	}
	if (metadata.author !== undefined) {
		pdf.setAuthor(metadata.author || "");
	}
	if (metadata.subject !== undefined) {
		pdf.setSubject(metadata.subject || "");
	}
	if (metadata.keywords !== undefined) {
		pdf.setKeywords(metadata.keywords?.join(", ") || "");
	}
	if (metadata.creator !== undefined) {
		pdf.setCreator(metadata.creator || "");
	}

	pdf.setModificationDate(new Date());

	const newBuffer = await pdf.save();
	await vault.modifyBinary(file, newBuffer);
}

export function parseCompanionFrontmatter(content: string): Partial<PdfMetadata> {
	const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
	if (!frontmatterMatch) {
		return {};
	}

	const frontmatter = frontmatterMatch[1];
	const metadata: Partial<PdfMetadata> = {};

	// Parse title
	const titleMatch = frontmatter.match(/^title:\s*"?([^"\n]+)"?$/m);
	if (titleMatch) {
		metadata.title = titleMatch[1].trim();
	}

	// Parse author
	const authorMatch = frontmatter.match(/^author:\s*"?([^"\n]+)"?$/m);
	if (authorMatch) {
		metadata.author = authorMatch[1].trim();
	}

	// Parse subject
	const subjectMatch = frontmatter.match(/^subject:\s*"?([^"\n]+)"?$/m);
	if (subjectMatch) {
		metadata.subject = subjectMatch[1].trim();
	}

	// Parse keywords (array format: [a, b, c] or yaml list)
	const keywordsMatch = frontmatter.match(/^keywords:\s*\[([^\]]+)\]/m);
	if (keywordsMatch) {
		metadata.keywords = keywordsMatch[1]
			.split(",")
			.map((k) => k.trim().replace(/^["']|["']$/g, ""))
			.filter(Boolean);
	}

	// Parse creator
	const creatorMatch = frontmatter.match(/^creator:\s*"?([^"\n]+)"?$/m);
	if (creatorMatch) {
		metadata.creator = creatorMatch[1].trim();
	}

	return metadata;
}

export function extractSourcePath(content: string): string | null {
	// Look for source: "[[path/to/file.pdf]]" in frontmatter
	const sourceMatch = content.match(/^source:\s*"?\[\[([^\]]+)\]\]"?$/m);
	if (sourceMatch) {
		return sourceMatch[1];
	}
	return null;
}

export async function syncFromCompanion(
	companionFile: TFile,
	vault: Vault
): Promise<{ pdfPath: string; metadata: Partial<PdfMetadata> } | null> {
	const content = await vault.read(companionFile);

	const pdfPath = extractSourcePath(content);
	if (!pdfPath) {
		return null;
	}

	const pdfFile = vault.getAbstractFileByPath(pdfPath);
	if (!(pdfFile instanceof TFile)) {
		return null;
	}

	const metadata = parseCompanionFrontmatter(content);
	await writeMetadataToPdf(pdfFile, metadata, vault);

	return { pdfPath, metadata };
}

export function getCompanionForPdf(
	pdfPath: string,
	outputFolder: string,
	vault: Vault
): TFile | null {
	const fileName = pdfPath.split("/").pop()?.replace(/\.pdf$/i, "") || "";
	const companionPath = `${outputFolder}/${fileName}.md`;

	const file = vault.getAbstractFileByPath(companionPath);
	return file instanceof TFile ? file : null;
}
