import { TFile, Vault } from "obsidian";
import { PDFDocument } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import { PdfMetadata } from "./types";

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = "";

export async function extractMetadata(
	file: TFile,
	vault: Vault
): Promise<PdfMetadata> {
	const buffer = await vault.readBinary(file);
	const uint8Array = new Uint8Array(buffer);

	try {
		const pdf = await PDFDocument.load(uint8Array, {
			ignoreEncryption: true,
		});

		const title = pdf.getTitle();
		const author = pdf.getAuthor();
		const subject = pdf.getSubject();
		const keywordsRaw = pdf.getKeywords();
		const keywords = keywordsRaw
			? keywordsRaw.split(/[,;]/).map((k) => k.trim()).filter(Boolean)
			: undefined;
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
	} catch (error) {
		// Return minimal metadata if PDF parsing fails
		return {
			pageCount: 0,
			fileSize: buffer.byteLength,
			filePath: file.path,
		};
	}
}

export function hasMetadata(metadata: PdfMetadata): boolean {
	return !!(
		metadata.title ||
		metadata.author ||
		metadata.subject ||
		metadata.keywords?.length ||
		metadata.creator ||
		metadata.producer
	);
}

export async function computeContentHash(
	file: TFile,
	vault: Vault
): Promise<string> {
	const buffer = await vault.readBinary(file);
	const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Extract text from PDF pages for identifier detection (DOI/ISBN)
 * Only extracts first few pages where identifiers are typically found
 */
export async function extractTextForLookup(
	file: TFile,
	vault: Vault,
	maxPages: number = 3
): Promise<string> {
	const buffer = await vault.readBinary(file);
	const uint8Array = new Uint8Array(buffer);

	try {
		const pdf = await pdfjsLib.getDocument({
			data: uint8Array,
			disableAutoFetch: true,
			disableStream: true,
		}).promise;

		const pagesToExtract = Math.min(maxPages, pdf.numPages);
		const textParts: string[] = [];

		for (let i = 1; i <= pagesToExtract; i++) {
			const page = await pdf.getPage(i);
			const textContent = await page.getTextContent();
			const pageText = textContent.items
				.map((item) => ("str" in item ? item.str : ""))
				.join(" ");
			textParts.push(pageText);
		}

		return textParts.join("\n");
	} catch (error) {
		console.error("Failed to extract text for lookup:", error);
		return "";
	}
}
