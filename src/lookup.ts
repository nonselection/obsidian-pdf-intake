import { requestUrl } from "obsidian";

export interface LookupResult {
	title?: string;
	authors?: string[];
	year?: number;
	journal?: string;
	publisher?: string;
	doi?: string;
	isbn?: string;
}

/**
 * Look up metadata by DOI using CrossRef API
 */
export async function lookupDoi(doi: string): Promise<LookupResult | null> {
	const cleanDoi = cleanDOI(doi);
	if (!cleanDoi) return null;

	const url = `https://api.crossref.org/works/${encodeURIComponent(cleanDoi)}`;

	try {
		const response = await requestUrl({
			url,
			headers: {
				"User-Agent": "PDFIntake/1.0 (https://obsidian.md)",
			},
		});

		if (response.status !== 200) {
			console.error(`CrossRef API returned ${response.status}`);
			return null;
		}

		const data = response.json as Record<string, unknown>;
		return parseCrossRefResponse(data, cleanDoi);
	} catch (error) {
		console.error("CrossRef lookup failed:", error);
		return null;
	}
}

/**
 * Look up metadata by ISBN using OpenLibrary API
 */
export async function lookupIsbn(isbn: string): Promise<LookupResult | null> {
	const cleanIsbn = cleanISBN(isbn);
	if (!cleanIsbn) return null;

	const url = `https://openlibrary.org/isbn/${cleanIsbn}.json`;

	try {
		const response = await requestUrl({
			url,
			headers: {
				"User-Agent": "PDFIntake/1.0 (https://obsidian.md)",
			},
		});

		if (response.status !== 200) {
			console.error(`OpenLibrary API returned ${response.status}`);
			return null;
		}

		const data = response.json as Record<string, unknown>;
		return parseOpenLibraryResponse(data, cleanIsbn);
	} catch (error) {
		console.error("OpenLibrary lookup failed:", error);
		return null;
	}
}

/**
 * Extract DOI from text using regex patterns
 */
export function extractDoi(text: string): string | null {
	// DOI patterns:
	// 10.xxxx/xxxxx
	// doi:10.xxxx/xxxxx
	// https://doi.org/10.xxxx/xxxxx
	// http://dx.doi.org/10.xxxx/xxxxx

	const patterns = [
		/(?:doi[:\s]*)?(?:https?:\/\/(?:dx\.)?doi\.org\/)?10\.\d{4,}\/[^\s\])"'<>]+/gi,
	];

	for (const pattern of patterns) {
		const match = text.match(pattern);
		if (match) {
			return cleanDOI(match[0]);
		}
	}

	return null;
}

/**
 * Extract ISBN from text using regex patterns
 */
export function extractIsbn(text: string): string | null {
	// ISBN patterns:
	// ISBN-13: 978-x-xxx-xxxxx-x
	// ISBN-10: x-xxx-xxxxx-x
	// ISBN: xxxxxxxxxx or xxxxxxxxxxxxx

	const patterns = [
		/ISBN[-:\s]*(?:13[-:\s]*)?(\d{3}[-\s]?\d[-\s]?\d{3}[-\s]?\d{5}[-\s]?\d)/gi,
		/ISBN[-:\s]*(?:10[-:\s]*)?(\d[-\s]?\d{3}[-\s]?\d{5}[-\s]?[\dXx])/gi,
		/\b(97[89]\d{10})\b/g,
		/\b(\d{9}[\dXx])\b/g,
	];

	for (const pattern of patterns) {
		const match = text.match(pattern);
		if (match) {
			return cleanISBN(match[0]);
		}
	}

	return null;
}

/**
 * Clean DOI string
 */
function cleanDOI(doi: string): string | null {
	// Remove common prefixes and clean up
	const clean = doi
		.replace(/^doi[:\s]*/i, "")
		.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
		.trim()
		.replace(/[.,;)\]]+$/, "");

	// Validate DOI format
	if (/^10\.\d{4,}\/\S+$/.test(clean)) {
		return clean;
	}

	return null;
}

/**
 * Clean ISBN string
 */
function cleanISBN(isbn: string): string | null {
	// Remove "ISBN" prefix and non-digit characters (except X for ISBN-10)
	const clean = isbn
		.replace(/^ISBN[-:\s]*(1[03][-:\s]*)?/i, "")
		.replace(/[-\s]/g, "")
		.toUpperCase();

	// Validate ISBN format
	if (/^\d{13}$/.test(clean) || /^\d{9}[\dX]$/.test(clean)) {
		return clean;
	}

	return null;
}

/**
 * Parse CrossRef API response
 */
function parseCrossRefResponse(data: Record<string, unknown>, doi: string): LookupResult {
	const message = data.message as Record<string, unknown>;
	if (!message) return { doi };

	const result: LookupResult = { doi };

	// Title
	const titles = message.title as string[];
	if (titles?.length) {
		result.title = titles[0];
	}

	// Authors
	const authors = message.author as Array<{ given?: string; family?: string }>;
	if (authors?.length) {
		result.authors = authors
			.map((a) => {
				if (a.given && a.family) return `${a.given} ${a.family}`;
				return a.family || a.given || "";
			})
			.filter(Boolean);
	}

	// Year
	const published = message.published as { "date-parts"?: number[][] };
	if (published?.["date-parts"]?.[0]?.[0]) {
		result.year = published["date-parts"][0][0];
	}

	// Journal
	const containerTitle = message["container-title"] as string[];
	if (containerTitle?.length) {
		result.journal = containerTitle[0];
	}

	// Publisher
	if (message.publisher) {
		result.publisher = message.publisher as string;
	}

	return result;
}

/**
 * Parse OpenLibrary API response
 */
async function parseOpenLibraryResponse(
	data: Record<string, unknown>,
	isbn: string,
): Promise<LookupResult> {
	const result: LookupResult = { isbn };

	// Title
	if (data.title) {
		result.title = data.title as string;
	}

	// Authors - OpenLibrary returns author references, need to fetch them
	const authorRefs = data.authors as Array<{ key: string }>;
	if (authorRefs?.length) {
		result.authors = [];
		for (const ref of authorRefs.slice(0, 5)) {
			try {
				const authorUrl = `https://openlibrary.org${ref.key}.json`;
				const authorResponse = await requestUrl({
					url: authorUrl,
					headers: {
						"User-Agent": "PDFIntake/1.0 (https://obsidian.md)",
					},
				});
				if (authorResponse.status === 200) {
					const authorData = authorResponse.json as { name?: unknown };
					if (typeof authorData.name === "string") {
						result.authors.push(authorData.name);
					}
				}
			} catch {
				// Skip failed author lookups
			}
		}
	}

	// Publisher
	const publishers = data.publishers as string[];
	if (publishers?.length) {
		result.publisher = publishers[0];
	}

	// Year from publish_date
	const publishDate = data.publish_date as string;
	if (publishDate) {
		const yearMatch = publishDate.match(/\d{4}/);
		if (yearMatch) {
			result.year = parseInt(yearMatch[0]);
		}
	}

	return result;
}
