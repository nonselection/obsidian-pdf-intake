import "pdfjs-dist/build/pdf.worker.mjs";
import type { TFile, Vault } from "obsidian";
import * as pdfjsLib from "pdfjs-dist";

export async function extractTextForLookup(
	file: TFile,
	vault: Vault,
	maxPages = 3,
): Promise<string> {
	const buffer = await vault.readBinary(file);
	const pdf = await pdfjsLib.getDocument({
		data: new Uint8Array(buffer),
		disableAutoFetch: true,
		disableStream: true,
	}).promise;
	try {
		const pages: string[] = [];
		for (let pageNumber = 1; pageNumber <= Math.min(maxPages, pdf.numPages); pageNumber++) {
			const page = await pdf.getPage(pageNumber);
			const content = await page.getTextContent();
			pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
		}
		return pages.join("\n");
	} finally {
		await pdf.destroy();
	}
}
