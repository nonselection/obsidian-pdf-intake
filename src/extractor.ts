import { TFile, Vault } from "obsidian";
import { PDFDocument } from "pdf-lib";
import { PdfMetadata } from "./types";

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
