import { PdfMetadata } from "./types";

export type CitationFormat = "bibtex" | "ris";

export interface CitationOptions {
	format: CitationFormat;
	citeKey?: string;
	entryType?: BibtexEntryType;
}

export type BibtexEntryType =
	| "article"
	| "book"
	| "inproceedings"
	| "misc"
	| "techreport"
	| "phdthesis"
	| "mastersthesis";

/**
 * Generate a citation from PDF metadata
 */
export function generateCitation(
	metadata: PdfMetadata,
	options: CitationOptions
): string {
	switch (options.format) {
		case "bibtex":
			return generateBibtex(metadata, options);
		case "ris":
			return generateRis(metadata);
		default:
			throw new Error(`Unknown citation format: ${options.format}`);
	}
}

/**
 * Generate a BibTeX citation key from metadata
 */
export function generateCiteKey(metadata: PdfMetadata): string {
	const author = metadata.author
		? metadata.author.split(/[,;&]|\s+and\s+/i)[0].trim().split(/\s+/).pop()?.toLowerCase() || "unknown"
		: "unknown";

	const year = metadata.creationDate
		? metadata.creationDate.getFullYear().toString()
		: "nd";

	const titleWord = metadata.title
		? metadata.title.split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9]/g, "")
		: "untitled";

	return `${author}${year}${titleWord}`;
}

/**
 * Generate BibTeX format citation
 */
function generateBibtex(metadata: PdfMetadata, options: CitationOptions): string {
	const citeKey = options.citeKey || generateCiteKey(metadata);
	const entryType = options.entryType || inferEntryType(metadata);

	const lines: string[] = [];
	lines.push(`@${entryType}{${citeKey},`);

	if (metadata.title) {
		lines.push(`  title = {${escapeBibtex(metadata.title)}},`);
	}

	if (metadata.author) {
		lines.push(`  author = {${formatBibtexAuthor(metadata.author)}},`);
	}

	if (metadata.creationDate) {
		lines.push(`  year = {${metadata.creationDate.getFullYear()}},`);
	}

	if (metadata.subject) {
		lines.push(`  abstract = {${escapeBibtex(metadata.subject)}},`);
	}

	if (metadata.keywords?.length) {
		lines.push(`  keywords = {${metadata.keywords.join(", ")}},`);
	}

	if (metadata.pageCount > 0) {
		lines.push(`  pages = {${metadata.pageCount}},`);
	}

	// Add file reference
	const fileName = metadata.filePath.split("/").pop() || "";
	lines.push(`  file = {${escapeBibtex(fileName)}},`);

	// Remove trailing comma from last entry
	const lastLine = lines[lines.length - 1];
	lines[lines.length - 1] = lastLine.replace(/,$/, "");

	lines.push("}");

	return lines.join("\n");
}

/**
 * Generate RIS format citation
 */
function generateRis(metadata: PdfMetadata): string {
	const lines: string[] = [];

	// Type
	lines.push(`TY  - ${inferRisType(metadata)}`);

	// Title
	if (metadata.title) {
		lines.push(`TI  - ${metadata.title}`);
	}

	// Authors (one per line)
	if (metadata.author) {
		const authors = parseAuthors(metadata.author);
		for (const author of authors) {
			lines.push(`AU  - ${author}`);
		}
	}

	// Year
	if (metadata.creationDate) {
		const year = metadata.creationDate.getFullYear();
		const month = String(metadata.creationDate.getMonth() + 1).padStart(2, "0");
		const day = String(metadata.creationDate.getDate()).padStart(2, "0");
		lines.push(`PY  - ${year}/${month}/${day}`);
		lines.push(`Y1  - ${year}`);
	}

	// Abstract
	if (metadata.subject) {
		lines.push(`AB  - ${metadata.subject}`);
	}

	// Keywords
	if (metadata.keywords?.length) {
		for (const keyword of metadata.keywords) {
			lines.push(`KW  - ${keyword}`);
		}
	}

	// File
	const fileName = metadata.filePath.split("/").pop() || "";
	lines.push(`L1  - ${fileName}`);

	// End record
	lines.push("ER  - ");

	return lines.join("\n");
}

/**
 * Infer BibTeX entry type from metadata
 */
function inferEntryType(metadata: PdfMetadata): BibtexEntryType {
	const title = metadata.title?.toLowerCase() || "";
	const subject = metadata.subject?.toLowerCase() || "";
	const keywords = metadata.keywords?.map((k) => k.toLowerCase()) || [];
	const combined = `${title} ${subject} ${keywords.join(" ")}`;

	if (combined.includes("thesis") || combined.includes("dissertation")) {
		if (combined.includes("phd") || combined.includes("doctoral")) {
			return "phdthesis";
		}
		if (combined.includes("master")) {
			return "mastersthesis";
		}
	}

	if (combined.includes("proceedings") || combined.includes("conference")) {
		return "inproceedings";
	}

	if (combined.includes("report") || combined.includes("technical")) {
		return "techreport";
	}

	if (combined.includes("book") || combined.includes("chapter")) {
		return "book";
	}

	if (combined.includes("journal") || combined.includes("article")) {
		return "article";
	}

	// Default to misc for PDFs without clear type
	return "misc";
}

/**
 * Infer RIS type from metadata
 */
function inferRisType(metadata: PdfMetadata): string {
	const bibtexType = inferEntryType(metadata);

	const typeMap: Record<BibtexEntryType, string> = {
		article: "JOUR",
		book: "BOOK",
		inproceedings: "CPAPER",
		misc: "GEN",
		techreport: "RPRT",
		phdthesis: "THES",
		mastersthesis: "THES",
	};

	return typeMap[bibtexType] || "GEN";
}

/**
 * Parse author string into individual authors
 */
function parseAuthors(authorString: string): string[] {
	// Split by common separators: comma, semicolon, ampersand, "and"
	return authorString
		.split(/[,;&]|\s+and\s+/i)
		.map((a) => a.trim())
		.filter(Boolean);
}

/**
 * Format author for BibTeX (Last, First format)
 */
function formatBibtexAuthor(authorString: string): string {
	const authors = parseAuthors(authorString);
	return authors.join(" and ");
}

/**
 * Escape special characters for BibTeX
 */
function escapeBibtex(value: string): string {
	return value
		.replace(/\\/g, "\\textbackslash{}")
		.replace(/[{}]/g, "\\$&")
		.replace(/&/g, "\\&")
		.replace(/%/g, "\\%")
		.replace(/#/g, "\\#")
		.replace(/_/g, "\\_")
		.replace(/\$/g, "\\$")
		.replace(/~/g, "\\textasciitilde{}")
		.replace(/\^/g, "\\textasciicircum{}");
}

/**
 * Get available citation formats
 */
export function getAvailableFormats(): { value: CitationFormat; label: string }[] {
	return [
		{ value: "bibtex", label: "BibTeX" },
		{ value: "ris", label: "RIS" },
	];
}

/**
 * Get available BibTeX entry types
 */
export function getEntryTypes(): { value: BibtexEntryType; label: string }[] {
	return [
		{ value: "article", label: "Article" },
		{ value: "book", label: "Book" },
		{ value: "inproceedings", label: "Conference Paper" },
		{ value: "techreport", label: "Technical Report" },
		{ value: "phdthesis", label: "PhD Thesis" },
		{ value: "mastersthesis", label: "Master's Thesis" },
		{ value: "misc", label: "Miscellaneous" },
	];
}
