import type { TFile, Vault } from "obsidian";
import { extractDoi, extractIsbn, lookupDoi, lookupIsbn } from "./lookup";
import type { BibliographicMetadata, LookupSource } from "./types";
import { extractTextForLookup } from "./pdf-text";

async function resolveIdentifierText(text: string): Promise<BibliographicMetadata> {
	const doi = extractDoi(text);
	if (doi) {
		const result = await lookupDoi(doi);
		if (result) return asResolved(result, "crossref");
	}

	const isbn = extractIsbn(text);
	if (isbn) {
		const result = await lookupIsbn(isbn);
		if (result) return asResolved(result, "openlibrary");
		return {
			authors: [],
			isbn,
			status: "unresolved",
			error: `No Open Library record found for ${isbn}`,
		};
	}
	if (doi)
		return {
			authors: [],
			doi,
			status: "unresolved",
			error: `No Crossref record found for ${doi}`,
		};
	return { authors: [], status: "unresolved", error: "No DOI or ISBN detected" };
}

function asResolved(
	result: NonNullable<Awaited<ReturnType<typeof lookupDoi>>>,
	source: LookupSource,
): BibliographicMetadata {
	return {
		...result,
		authors: result.authors ?? [],
		firstAuthor: result.authors?.[0],
		source,
		status: "resolved",
	};
}

export async function resolveBibliographicMetadata(
	file: TFile,
	vault: Vault,
	manualIdentifier?: string,
	workerAssetPath?: string,
): Promise<BibliographicMetadata> {
	try {
		if (manualIdentifier?.trim()) return await resolveIdentifierText(manualIdentifier.trim());
		const text = await extractTextForLookup(file, vault, 3, workerAssetPath);
		return await resolveIdentifierText(text);
	} catch (error) {
		return {
			authors: [],
			status: "error",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
