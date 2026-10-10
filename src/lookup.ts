import { requestUrl } from "obsidian";
import type {
	CanonicalAuthor,
	IdentifierCandidateEvidence,
	ProviderBibliographicRecord,
} from "./types";

const CROSSREF_AGENT = "PDFIntake/1.0 (https://obsidian.md)";
const OPEN_LIBRARY_AGENT = "PDFIntake/1.0 (https://obsidian.md)";
export const OPEN_LIBRARY_AUTHOR_DETAIL_BUDGET = 50;
export const MAX_DIRECT_DOIS = 3;
export const MAX_DIRECT_ISBNS = 3;

export interface LookupPageText {
	pageNumber: number;
	text: string;
}

export type LookupOutcome =
	| { status: "record"; record: ProviderBibliographicRecord }
	| { status: "no-record" }
	| { status: "request-failed" };

export interface SearchCandidate {
	record: ProviderBibliographicRecord;
	score?: number;
}

export type SearchOutcome =
	{ status: "records"; candidates: SearchCandidate[] } | { status: "request-failed" };

interface RequestResponse {
	status: number;
	json: unknown;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArray(value: unknown): string[] {
	if (typeof value === "string") return value.trim() ? [value] : [];
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string" && !!entry.trim());
}

function safeRequestFailure(response: RequestResponse): "no-record" | "request-failed" {
	return response.status === 404 ? "no-record" : "request-failed";
}

function unresolvedAuthor(position: number, reference?: string): CanonicalAuthor {
	return { kind: "unresolved", position, ...(reference ? { reference } : {}) };
}

function mapCrossrefAuthors(value: unknown): ProviderBibliographicRecord["authorship"] {
	if (!Array.isArray(value)) {
		return { authors: [], completeness: "unknown", totalCountKnown: false };
	}
	const authors = value.map((entry, position): CanonicalAuthor => {
		const author = asObject(entry);
		if (!author) return unresolvedAuthor(position);
		const given = stringValue(author.given);
		const family = stringValue(author.family);
		if (given || family) {
			return { kind: "person", ...(given ? { given } : {}), ...(family ? { family } : {}) };
		}
		const literal = stringValue(author.name);
		return literal ? { kind: "organization", literal } : unresolvedAuthor(position);
	});
	const complete = authors.every((author) => author.kind !== "unresolved");
	return { authors, completeness: complete ? "complete" : "partial", totalCountKnown: true };
}

function crossrefDateEvidence(
	message: Record<string, unknown>,
): ProviderBibliographicRecord["publicationDate"] | undefined {
	for (const source of ["published", "published-print", "published-online", "issued"] as const) {
		const date = asObject(message[source]);
		const parts = date?.["date-parts"];
		if (!Array.isArray(parts) || !Array.isArray(parts[0])) continue;
		const dateParts = (parts[0] as unknown[]).filter(
			(part): part is number => typeof part === "number" && Number.isInteger(part),
		);
		if (dateParts.length) return { provider: "crossref", source, dateParts };
	}
	return undefined;
}

function yearFromParts(parts: readonly number[] | undefined): number | undefined {
	const year = parts?.[0];
	return year !== undefined && year >= 1000 && year <= 9999 ? year : undefined;
}

function mapCrossrefWork(
	message: Record<string, unknown>,
	fallbackDoi?: string,
): ProviderBibliographicRecord {
	const publicationDate = crossrefDateEvidence(message);
	const authorship = mapCrossrefAuthors(message.author);
	return {
		provider: "crossref",
		title: stringArray(message.title)[0],
		authorship,
		year: yearFromParts(
			publicationDate?.provider === "crossref" ? publicationDate.dateParts : undefined,
		),
		publicationDate,
		doi: stringValue(message.DOI) ?? fallbackDoi,
		isbns: stringArray(message.ISBN),
		journal: stringArray(message["container-title"])[0],
		publisher: stringValue(message.publisher),
		diagnostics: authorship.completeness === "partial" ? ["authors-incomplete"] : [],
	};
}

function openLibraryDate(
	value: unknown,
): ProviderBibliographicRecord["publicationDate"] | undefined {
	const text = stringValue(value);
	return text ? { provider: "openlibrary", source: "publish-date", text } : undefined;
}

function yearFromOpenLibraryDate(text: string | undefined): number | undefined {
	const match = text?.match(/\b(1\d{3}|20\d{2}|21\d{2})\b/);
	return match ? Number(match[1]) : undefined;
}

function asAuthorReference(value: unknown): string | undefined {
	const object = asObject(value);
	const key = stringValue(object?.key) ?? (typeof value === "string" ? value : undefined);
	if (!key || !key.startsWith("/authors/") || key.includes("..") || key.includes("\\")) {
		return undefined;
	}
	return key;
}

function makeOpenLibraryRecord(
	data: Record<string, unknown>,
	options: {
		authors: readonly CanonicalAuthor[];
		completeness: "complete" | "partial" | "unknown";
		totalCountKnown: boolean;
		diagnostics?: readonly string[];
		fallbackIsbn?: string;
	},
): ProviderBibliographicRecord {
	const publicationDate = openLibraryDate(data.publish_date);
	const providerIsbns = [
		...stringArray(data.isbn_10),
		...stringArray(data.isbn_13),
		...stringArray(data.isbn),
	];
	return {
		provider: "openlibrary",
		title: stringValue(data.title),
		authorship: {
			authors: [...options.authors],
			completeness: options.completeness,
			totalCountKnown: options.totalCountKnown,
		},
		year: yearFromOpenLibraryDate(
			publicationDate?.provider === "openlibrary" ? publicationDate.text : undefined,
		),
		publicationDate,
		doi: stringValue(data.doi),
		isbns: providerIsbns.length
			? providerIsbns
			: options.fallbackIsbn
				? [options.fallbackIsbn]
				: [],
		journal: undefined,
		publisher: stringArray(data.publishers)[0],
		diagnostics: [...(options.diagnostics ?? [])],
	};
}

async function requestJson(url: string, agent: string): Promise<RequestResponse> {
	try {
		const response = await requestUrl({ url, headers: { "User-Agent": agent } });
		return { status: response.status, json: response.json };
	} catch {
		return { status: 0, json: null };
	}
}

/** DOI normalization preserves suffix characters except clear prose punctuation and unmatched closers. */
export function normalizeDoi(value: string): string | undefined {
	let doi = value.trim();
	doi = doi.replace(/^doi\s*:\s*/i, "");
	doi = doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
	doi = doi.replace(/^[([{<]+/, "");
	while (/[.,;:]$/.test(doi)) doi = doi.slice(0, -1);
	const closers: [string, string][] = [
		[")", "("],
		["]", "["],
		["}", "{"],
		[">", "<"],
	];
	for (const [closer, opener] of closers) {
		while (doi.endsWith(closer)) {
			const openCount = [...doi].filter((char) => char === opener).length;
			const closeCount = [...doi].filter((char) => char === closer).length;
			if (closeCount <= openCount) break;
			doi = doi.slice(0, -1);
		}
	}
	return /^10\.\d{4,}\/[^\s<>"']+$/i.test(doi) ? doi : undefined;
}

/** ISBN presentation punctuation is removed before checksum validation. */
export function normalizeIsbn(value: string): string | undefined {
	const isbn = value
		.trim()
		.replace(/^ISBN(?:\s*[-:]?\s*(?:10|13))?\s*[-:#]?\s*/i, "")
		.replace(/[\s.():-]/g, "")
		.toUpperCase();
	if (/^\d{9}[\dX]$/.test(isbn)) {
		const sum = [...isbn].reduce((total, char, index) => {
			const digit = char === "X" ? 10 : Number(char);
			return total + digit * (10 - index);
		}, 0);
		return sum % 11 === 0 ? isbn : undefined;
	}
	if (/^\d{13}$/.test(isbn)) {
		const sum = [...isbn.slice(0, 12)].reduce(
			(total, char, index) => total + Number(char) * (index % 2 === 0 ? 1 : 3),
			0,
		);
		const checkDigit = (10 - (sum % 10)) % 10;
		return checkDigit === Number(isbn[12]) ? isbn : undefined;
	}
	return undefined;
}

function labelledAt(text: string, offset: number, label: RegExp): boolean {
	const before = text.slice(Math.max(0, offset - 36), offset);
	return label.test(before);
}

/** Collects first-three-page identifier evidence without discarding order or location. */
export function extractIdentifierCandidates(
	pages: readonly LookupPageText[],
): IdentifierCandidateEvidence[] {
	const evidence: IdentifierCandidateEvidence[] = [];
	for (const page of pages) {
		const doiPattern =
			/(?:\bdoi\s*:?\s*|https?:\/\/(?:dx\.)?doi\.org\/)?10\.\d{4,}\/[^\s<>"']+/gi;
		for (const match of page.text.matchAll(doiPattern)) {
			const rawText = match[0];
			const offset = match.index ?? 0;
			const normalizedValue = normalizeDoi(rawText);
			evidence.push({
				type: "doi",
				rawText,
				...(normalizedValue ? { normalizedValue } : {}),
				valid: !!normalizedValue,
				pageNumber: page.pageNumber,
				textOffset: offset,
				labeled:
					/^\s*(?:doi\s*:|https?:\/\/(?:dx\.)?doi\.org\/)/i.test(rawText) ||
					labelledAt(page.text, offset, /\bdoi\s*:?\s*$/i),
			});
		}
		const isbnPatterns = [
			/\bISBN(?:\s*[-:]?\s*(?:10|13))?\s*[-:#]?\s*[\dXx][\dXx .():-]{7,22}[\dXx](?![\dXx])/gi,
			/(?<![\d])97[89][\d .():-]{9,17}\d(?![\d])/g,
			/(?<![\d])\d{9}[\dXx](?![\dXx])/g,
		];
		for (const pattern of isbnPatterns) {
			for (const match of page.text.matchAll(pattern)) {
				const rawText = match[0];
				const offset = match.index ?? 0;
				const normalizedValue = normalizeIsbn(rawText);
				evidence.push({
					type: "isbn",
					rawText,
					...(normalizedValue ? { normalizedValue } : {}),
					valid: !!normalizedValue,
					pageNumber: page.pageNumber,
					textOffset: offset,
					labeled:
						/^\s*ISBN/i.test(rawText) ||
						labelledAt(
							page.text,
							offset,
							/\bISBN(?:\s*[-:]?\s*(?:10|13))?\s*[-:#]?\s*$/i,
						),
				});
			}
		}
	}
	return deduplicateIdentifierEvidence(evidence);
}

function compareEvidence(
	left: IdentifierCandidateEvidence,
	right: IdentifierCandidateEvidence,
): number {
	return (
		Number(right.labeled) - Number(left.labeled) ||
		left.pageNumber - right.pageNumber ||
		left.textOffset - right.textOffset ||
		(left.type === right.type ? 0 : left.type === "doi" ? -1 : 1)
	);
}

function deduplicateIdentifierEvidence(
	evidence: readonly IdentifierCandidateEvidence[],
): IdentifierCandidateEvidence[] {
	const ranked = [...evidence].sort(compareEvidence);
	const seen = new Set<string>();
	const output: IdentifierCandidateEvidence[] = [];
	for (const candidate of ranked) {
		if (candidate.valid && candidate.normalizedValue) {
			const key = candidate.type + ":" + candidate.normalizedValue.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
		}
		output.push(candidate);
	}
	return output.sort(
		(left, right) =>
			left.pageNumber - right.pageNumber ||
			left.textOffset - right.textOffset ||
			compareEvidence(left, right),
	);
}

export interface RankedIdentifierEvidence {
	candidates: IdentifierCandidateEvidence[];
	overflow: { doi: number; isbn: number };
}

export function rankDirectIdentifierEvidence(
	evidence: readonly IdentifierCandidateEvidence[],
): RankedIdentifierEvidence {
	const valid = evidence.filter((candidate) => candidate.valid && candidate.normalizedValue);
	const dois = valid.filter((candidate) => candidate.type === "doi").sort(compareEvidence);
	const isbns = valid.filter((candidate) => candidate.type === "isbn").sort(compareEvidence);
	const candidates = [
		...dois.slice(0, MAX_DIRECT_DOIS),
		...isbns.slice(0, MAX_DIRECT_ISBNS),
	].sort(compareEvidence);
	return {
		candidates,
		overflow: {
			doi: Math.max(0, dois.length - MAX_DIRECT_DOIS),
			isbn: Math.max(0, isbns.length - MAX_DIRECT_ISBNS),
		},
	};
}

export async function lookupDoi(doi: string): Promise<LookupOutcome> {
	const normalized = normalizeDoi(doi);
	if (!normalized) return { status: "no-record" };
	const response = await requestJson(
		"https://api.crossref.org/works/" + encodeURIComponent(normalized),
		CROSSREF_AGENT,
	);
	if (response.status !== 200) return { status: safeRequestFailure(response) };
	const root = asObject(response.json);
	const message = asObject(root?.message);
	return message
		? { status: "record", record: mapCrossrefWork(message, normalized) }
		: { status: "no-record" };
}

async function lookupOpenLibraryEdition(isbn: string): Promise<LookupOutcome> {
	const normalized = normalizeIsbn(isbn);
	if (!normalized) return { status: "no-record" };
	const response = await requestJson(
		"https://openlibrary.org/isbn/" + normalized + ".json",
		OPEN_LIBRARY_AGENT,
	);
	if (response.status !== 200) return { status: safeRequestFailure(response) };
	const data = asObject(response.json);
	if (!data) return { status: "no-record" };
	const references = Array.isArray(data.authors) ? data.authors : undefined;
	const authors: CanonicalAuthor[] = [];
	const diagnostics = new Set<string>();
	let requests = 0;
	if (references) {
		for (const [position, value] of references.entries()) {
			const reference = asAuthorReference(value);
			if (!reference) {
				authors.push(unresolvedAuthor(position));
				diagnostics.add("authors-incomplete");
				continue;
			}
			if (requests >= OPEN_LIBRARY_AUTHOR_DETAIL_BUDGET) {
				authors.push(unresolvedAuthor(position, reference));
				diagnostics.add("authors-incomplete");
				diagnostics.add("author-detail-safety-budget-reached");
				continue;
			}
			requests++;
			const detail = await requestJson(
				"https://openlibrary.org" + reference + ".json",
				OPEN_LIBRARY_AGENT,
			);
			const detailData = asObject(detail.json);
			const name = detail.status === 200 ? stringValue(detailData?.name) : undefined;
			if (name) authors.push({ kind: "literal", literal: name });
			else {
				authors.push(unresolvedAuthor(position, reference));
				diagnostics.add("authors-incomplete");
			}
		}
	}
	const completeness = !references
		? "unknown"
		: authors.every((author) => author.kind !== "unresolved")
			? "complete"
			: "partial";
	return {
		status: "record",
		record: makeOpenLibraryRecord(data, {
			authors,
			completeness,
			totalCountKnown: !!references,
			diagnostics: [...diagnostics],
			fallbackIsbn: normalized,
		}),
	};
}

export const lookupIsbn = lookupOpenLibraryEdition;

function mapCrossrefSearchCandidate(value: unknown): SearchCandidate | undefined {
	const work = asObject(value);
	if (!work) return undefined;
	const score =
		typeof work.score === "number" && Number.isFinite(work.score) ? work.score : undefined;
	const record = mapCrossrefWork(work);
	return { record, ...(score === undefined ? {} : { score }) };
}

export async function searchCrossrefBibliographic(query: string): Promise<SearchOutcome> {
	const url = new URL("https://api.crossref.org/works");
	url.searchParams.set("query.bibliographic", query);
	url.searchParams.set("rows", "2");
	const response = await requestJson(url.toString(), CROSSREF_AGENT);
	if (response.status !== 200) {
		return response.status === 404
			? { status: "records", candidates: [] }
			: { status: "request-failed" };
	}
	const message = asObject(asObject(response.json)?.message);
	const works = Array.isArray(message?.items) ? message.items : [];
	const candidates = works
		.slice(0, 2)
		.map(mapCrossrefSearchCandidate)
		.filter((candidate): candidate is SearchCandidate => !!candidate);
	return { status: "records", candidates };
}

function mapOpenLibrarySearchCandidate(value: unknown): SearchCandidate | undefined {
	const doc = asObject(value);
	if (!doc) return undefined;
	const names = Array.isArray(doc.author_name) ? doc.author_name : undefined;
	const keys = Array.isArray(doc.author_key) ? doc.author_key : undefined;
	const count = Math.max(names?.length ?? 0, keys?.length ?? 0);
	const authors = Array.from({ length: count }, (_, position): CanonicalAuthor => {
		const name = stringValue(names?.[position]);
		const key = stringValue(keys?.[position]);
		if (name) return { kind: "literal", literal: name };
		return unresolvedAuthor(position, key ? "/authors/" + key : undefined);
	});
	const completeness =
		count === 0
			? "unknown"
			: authors.every((author) => author.kind !== "unresolved")
				? "complete"
				: "partial";
	const data: Record<string, unknown> = {
		title: doc.title,
		publish_date:
			typeof doc.first_publish_year === "number" ? String(doc.first_publish_year) : undefined,
		isbn: doc.isbn,
	};
	const record = makeOpenLibraryRecord(data, {
		authors,
		completeness,
		totalCountKnown: count > 0,
		diagnostics: completeness === "partial" ? ["authors-incomplete"] : [],
	});
	const score =
		typeof doc.score === "number" && Number.isFinite(doc.score) ? doc.score : undefined;
	return { record, ...(score === undefined ? {} : { score }) };
}

export async function searchOpenLibrary(query: string): Promise<SearchOutcome> {
	const url = new URL("https://openlibrary.org/search.json");
	url.searchParams.set("q", query);
	url.searchParams.set("fields", "key,title,author_name,author_key,first_publish_year,isbn");
	url.searchParams.set("limit", "3");
	const response = await requestJson(url.toString(), OPEN_LIBRARY_AGENT);
	if (response.status !== 200) {
		return response.status === 404
			? { status: "records", candidates: [] }
			: { status: "request-failed" };
	}
	const docs = asObject(response.json)?.docs;
	const candidates = (Array.isArray(docs) ? docs : [])
		.slice(0, 3)
		.map(mapOpenLibrarySearchCandidate)
		.filter((candidate): candidate is SearchCandidate => !!candidate);
	return { status: "records", candidates };
}
