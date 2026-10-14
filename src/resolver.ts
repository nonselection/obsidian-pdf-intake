import type { TFile, Vault } from "obsidian";
import {
	extractIdentifierCandidates,
	lookupDoi,
	lookupIsbn,
	normalizeDoi,
	normalizeIsbn,
	rankDirectIdentifierEvidence,
	searchCrossrefBibliographic,
	searchOpenLibrary,
	type LookupOutcome,
	type LookupPageText,
	type SearchOutcome,
} from "./lookup";
import { extractPdfEvidence, IdentificationCancelledError, type PdfTextEvidence } from "./pdf-text";
import type {
	CandidateReference,
	CanonicalBibliographicRecord,
	IdentificationEvidence,
	IdentifierCandidateEvidence,
	LookupRoute,
	LookupSource,
	ProviderAttemptEvidence,
	ProviderBibliographicRecord,
} from "./types";

export interface LocalIdentificationEvidence {
	pages: readonly LookupPageText[];
	titleCandidates: readonly string[];
	queryContext?: string;
	diagnostics?: readonly string[];
}

export type IdentificationResult =
	| {
			status: "accepted";
			record: CanonicalBibliographicRecord;
			evidence: IdentificationEvidence;
	  }
	| {
			status: "needs-you";
			reason: string;
			evidence: IdentificationEvidence;
	  };

export interface IdentificationLookups {
	lookupDoi: (doi: string) => Promise<LookupOutcome>;
	lookupIsbn: (isbn: string) => Promise<LookupOutcome>;
	searchCrossref: (query: string) => Promise<SearchOutcome>;
	searchOpenLibrary: (query: string) => Promise<SearchOutcome>;
}

export interface IdentificationRunOptions {
	shouldCancel?: () => boolean;
}

export type ManualIdentifierType = "doi" | "isbn";

export type ManualIdentifierLookupResult =
	| { status: "candidate"; record: CanonicalBibliographicRecord; candidate: CandidateReference }
	| { status: "no-record" | "request-failed"; candidate: CandidateReference }
	| { status: "invalid" };

const DEFAULT_LOOKUPS: IdentificationLookups = {
	lookupDoi,
	lookupIsbn,
	searchCrossref: searchCrossrefBibliographic,
	searchOpenLibrary,
};

interface CorroboratedRecord {
	record: ProviderBibliographicRecord;
	candidate?: IdentifierCandidateEvidence;
	route: LookupRoute;
	lookupValue: string;
	score?: number;
}

function normalizeTitle(value: string): string {
	return value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/\p{P}+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Direct one-provider lookup for a coordinator-validated manual DOI or ISBN. */
export async function lookupManualIdentifier(
	type: ManualIdentifierType,
	value: string,
	lookups: IdentificationLookups = DEFAULT_LOOKUPS,
): Promise<ManualIdentifierLookupResult> {
	const normalized = type === "doi" ? normalizeDoi(value) : normalizeIsbn(value);
	if (!normalized) return { status: "invalid" };
	const candidate: CandidateReference = {
		provider: type === "doi" ? "crossref" : "openlibrary",
		route: type,
		lookupValue: normalized,
	};
	const outcome =
		type === "doi" ? await lookups.lookupDoi(normalized) : await lookups.lookupIsbn(normalized);
	if (outcome.status !== "record") return { status: outcome.status, candidate };
	return {
		status: "candidate",
		record: canonicalRecord(outcome.record, type, normalized),
		candidate,
	};
}

/** Returns a retained PDF title candidate when a direct manual result disagrees with it. */
export function manualTitleConflict(
	providerTitle: string | undefined,
	localTitles: readonly string[],
): string | undefined {
	if (!providerTitle?.trim() || localTitles.length === 0) return undefined;
	const normalized = normalizeTitle(providerTitle);
	if (localTitles.some((title) => normalizeTitle(title) === normalized)) return undefined;
	return localTitles[0];
}

function safeTitleCandidates(values: readonly string[]): string[] {
	const output: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const candidate = value.trim();
		if (candidate.length < 12 || candidate.length > 200 || !/\p{L}/u.test(candidate)) continue;
		const normalized = normalizeTitle(candidate);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		output.push(candidate);
		if (output.length === 5) break;
	}
	return output;
}

function safeQueryContext(value: string | undefined): string | undefined {
	const query = value?.trim().slice(0, 500);
	return query || undefined;
}

function matchingTitle(
	providerTitle: string | undefined,
	candidates: readonly string[],
): string | undefined {
	if (!providerTitle?.trim()) return undefined;
	const normalized = normalizeTitle(providerTitle);
	if (!normalized) return undefined;
	return candidates.find((candidate) => normalizeTitle(candidate) === normalized);
}

function authorIdentityValue(
	author: ProviderBibliographicRecord["authorship"]["authors"][number],
): string | undefined {
	if (author.kind === "unresolved") return undefined;
	if (author.kind === "organization" || author.kind === "literal") {
		const literal = author.literal.trim();
		return literal ? normalizeTitle(literal) : undefined;
	}
	const name = [author.given, author.family]
		.filter((part): part is string => !!part?.trim())
		.join(" ");
	return name ? normalizeTitle(name) : undefined;
}

function materiallyConflicts(
	left: ProviderBibliographicRecord,
	right: ProviderBibliographicRecord,
): boolean {
	if (normalizeTitle(left.title ?? "") !== normalizeTitle(right.title ?? "")) return true;
	const max = Math.min(left.authorship.authors.length, right.authorship.authors.length);
	for (let index = 0; index < max; index++) {
		const leftValue = authorIdentityValue(left.authorship.authors[index]);
		const rightValue = authorIdentityValue(right.authorship.authors[index]);
		if (leftValue && rightValue && leftValue !== rightValue) return true;
	}
	return false;
}

function canonicalRecord(
	record: ProviderBibliographicRecord,
	route: LookupRoute,
	value: string,
): CanonicalBibliographicRecord {
	const { provider, diagnostics: _diagnostics, ...fields } = record;
	return {
		...fields,
		provenance: {
			provider,
			route,
			...(route === "doi" || route === "isbn" ? { identifier: value } : { query: value }),
		},
	};
}

function createEvidence(
	identifiers: readonly IdentifierCandidateEvidence[],
	attempts: readonly ProviderAttemptEvidence[],
	titleCandidates: readonly string[],
	queryContext: string | undefined,
	diagnostics: readonly string[],
): IdentificationEvidence {
	const boundedDiagnostics = [...new Set(diagnostics)].slice(0, 24);
	return {
		identifiers: identifiers.map((candidate) => ({ ...candidate })),
		attempts: attempts.map((attempt) => ({
			...attempt,
			...(attempt.diagnostics ? { diagnostics: [...attempt.diagnostics] } : {}),
			...(attempt.candidateRecord
				? { candidateRecord: jsonClone(attempt.candidateRecord) }
				: {}),
		})),
		titleCandidates: [...titleCandidates],
		...(queryContext ? { queryContext } : {}),
		diagnostics: boundedDiagnostics,
	};
}

function jsonClone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function toAttempt(
	provider: LookupSource,
	route: LookupRoute,
	lookupValue: string,
	outcome: ProviderAttemptEvidence["outcome"],
	record?: ProviderBibliographicRecord,
	matchedTitleCandidate?: string,
	score?: number,
): ProviderAttemptEvidence {
	return {
		provider,
		route,
		lookupValue,
		outcome,
		...(record?.title ? { providerTitle: record.title.slice(0, 200) } : {}),
		...(matchedTitleCandidate ? { matchedTitleCandidate } : {}),
		...(score === undefined ? {} : { score }),
		...(record?.diagnostics.length
			? { diagnostics: [...record.diagnostics].slice(0, 12) }
			: {}),
		...(record ? { candidateRecord: jsonClone(record) } : {}),
	};
}

function providerForIdentifier(candidate: IdentifierCandidateEvidence): {
	provider: LookupSource;
	route: "doi" | "isbn";
	value: string;
} {
	if (candidate.type === "doi") {
		return {
			provider: "crossref",
			route: "doi",
			value: normalizeDoi(candidate.normalizedValue ?? candidate.rawText) ?? "",
		};
	}
	return {
		provider: "openlibrary",
		route: "isbn",
		value: normalizeIsbn(candidate.normalizedValue ?? candidate.rawText) ?? "",
	};
}

function lookupForRoute(
	route: "doi" | "isbn",
	value: string,
	lookups: IdentificationLookups,
): Promise<LookupOutcome> {
	return route === "doi" ? lookups.lookupDoi(value) : lookups.lookupIsbn(value);
}

function fallbackConflict(records: readonly CorroboratedRecord[]): boolean {
	for (let index = 1; index < records.length; index++) {
		if (records.some((prior) => materiallyConflicts(prior.record, records[index].record)))
			return true;
	}
	return false;
}

function stableIdentityKeys(record: ProviderBibliographicRecord): string[] {
	const keys = new Set<string>();
	const doi = normalizeDoi(record.doi ?? "");
	if (doi) keys.add(`doi:${doi}`);
	for (const isbn of record.isbns) {
		const normalized = normalizeIsbn(isbn);
		if (normalized) keys.add(`isbn:${normalized}`);
	}
	return [...keys];
}

function stableRecordKey(record: ProviderBibliographicRecord): string {
	const authors = record.authorship.authors.map((author) => {
		if (author.kind === "unresolved")
			return [author.kind, author.position, author.reference ?? null];
		if (author.kind === "organization" || author.kind === "literal")
			return [author.kind, author.literal];
		return [author.kind, author.given ?? null, author.family ?? null, author.literal ?? null];
	});
	const publicationDate = record.publicationDate
		? record.publicationDate.provider === "crossref"
			? [
					record.publicationDate.provider,
					record.publicationDate.source,
					[...record.publicationDate.dateParts],
				]
			: [
					record.publicationDate.provider,
					record.publicationDate.source,
					record.publicationDate.text,
				]
		: null;
	return JSON.stringify({
		title: record.title ?? null,
		authors,
		authorshipCompleteness: record.authorship.completeness,
		authorshipTotalCountKnown: record.authorship.totalCountKnown,
		year: record.year ?? null,
		publicationDate,
		doi: record.doi ?? null,
		normalizedDoi: normalizeDoi(record.doi ?? "") ?? null,
		isbns: [...record.isbns],
		journal: record.journal ?? null,
		publisher: record.publisher ?? null,
	});
}

/**
 * A fallback title match is unique only when there is one candidate or all candidates are
 * connected by shared stable identifiers. Compatible metadata alone is not identity evidence.
 */
function uniquelyIdentifiedFallback(
	records: readonly CorroboratedRecord[],
): CorroboratedRecord | undefined {
	if (records.length === 0 || fallbackConflict(records)) return undefined;
	if (records.length === 1) return records[0];

	const parents = records.map((_record, index) => index);
	const find = (index: number): number => {
		if (parents[index] !== index) parents[index] = find(parents[index]);
		return parents[index];
	};
	const union = (left: number, right: number): void => {
		const leftRoot = find(left);
		const rightRoot = find(right);
		if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
	};
	const identityKeys = records.map((entry) => new Set(stableIdentityKeys(entry.record)));
	for (let left = 0; left < records.length; left++) {
		for (let right = left + 1; right < records.length; right++) {
			if ([...identityKeys[left]].some((key) => identityKeys[right].has(key)))
				union(left, right);
		}
	}
	if (new Set(records.map((_record, index) => find(index))).size !== 1) return undefined;

	const providerOrder: Record<LookupSource, number> = { crossref: 0, openlibrary: 1 };
	return [...records].sort((left, right) => {
		const providerDifference =
			providerOrder[left.record.provider] - providerOrder[right.record.provider];
		if (providerDifference !== 0) return providerDifference;
		const leftKey = stableRecordKey(left.record);
		const rightKey = stableRecordKey(right.record);
		return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
	})[0];
}

function finishNeedsYou(
	reason: string,
	identifiers: readonly IdentifierCandidateEvidence[],
	attempts: readonly ProviderAttemptEvidence[],
	titleCandidates: readonly string[],
	queryContext: string | undefined,
	diagnostics: readonly string[],
): IdentificationResult {
	return {
		status: "needs-you",
		reason,
		evidence: createEvidence(identifiers, attempts, titleCandidates, queryContext, diagnostics),
	};
}

/** Identifier-first, exact-title-corroborated resolution with bounded existing-provider fallback. */
export async function resolveIdentificationEvidence(
	local: LocalIdentificationEvidence,
	lookups: IdentificationLookups = DEFAULT_LOOKUPS,
	options: IdentificationRunOptions = {},
): Promise<IdentificationResult> {
	const checkpoint = (): void => {
		if (options.shouldCancel?.()) throw new IdentificationCancelledError();
	};
	checkpoint();
	const allIdentifiers = extractIdentifierCandidates(local.pages);
	const ranked = rankDirectIdentifierEvidence(allIdentifiers);
	const identifierKeys = new Set<string>();
	const identifiers = [
		...ranked.candidates,
		...allIdentifiers.filter((candidate) => !candidate.valid),
		...allIdentifiers.filter(
			(candidate) => candidate.valid && !ranked.candidates.includes(candidate),
		),
	]
		.filter((candidate) => {
			const key = [
				candidate.type,
				candidate.normalizedValue ?? candidate.rawText,
				candidate.pageNumber,
				candidate.textOffset,
			].join(":");
			if (identifierKeys.has(key)) return false;
			identifierKeys.add(key);
			return true;
		})
		.slice(0, 64);
	const titleCandidates = safeTitleCandidates(local.titleCandidates);
	const queryContext = safeQueryContext(local.queryContext);
	const diagnostics = [...(local.diagnostics ?? [])];
	const attempts: ProviderAttemptEvidence[] = [];
	const corroborated: CorroboratedRecord[] = [];
	const candidateOrder = new Map(
		ranked.candidates.map((candidate, index) => [
			candidate.type + ":" + candidate.normalizedValue,
			index,
		]),
	);

	if (allIdentifiers.length > identifiers.length) diagnostics.push("identifier-evidence-bounded");
	if (!ranked.candidates.length) diagnostics.push("no-valid-identifiers");
	if (ranked.overflow.doi || ranked.overflow.isbn) {
		diagnostics.push("identifier-overflow");
	}

	for (const candidate of ranked.candidates) {
		checkpoint();
		const lookup = providerForIdentifier(candidate);
		const outcome = await lookupForRoute(lookup.route, lookup.value, lookups);
		checkpoint();
		if (outcome.status !== "record") {
			attempts.push(toAttempt(lookup.provider, lookup.route, lookup.value, outcome.status));
			diagnostics.push(
				outcome.status === "no-record" ? "provider-no-record" : "provider-request-failed",
			);
			continue;
		}
		const matched = matchingTitle(outcome.record.title, titleCandidates);
		attempts.push(
			toAttempt(
				lookup.provider,
				lookup.route,
				lookup.value,
				matched ? "corroborated" : "title-mismatch",
				outcome.record,
				matched,
			),
		);
		if (matched) {
			corroborated.push({
				record: outcome.record,
				candidate,
				route: lookup.route,
				lookupValue: lookup.value,
			});
		} else {
			diagnostics.push("direct-title-not-corroborated");
		}
	}

	if (ranked.overflow.doi || ranked.overflow.isbn) {
		return finishNeedsYou(
			"More identifiers were found than can be checked safely.",
			identifiers,
			attempts,
			titleCandidates,
			queryContext,
			diagnostics,
		);
	}

	if (corroborated.length) {
		if (fallbackConflict(corroborated)) {
			diagnostics.push("ambiguous-direct-evidence");
			return finishNeedsYou(
				"Multiple different works match the document evidence.",
				identifiers,
				attempts,
				titleCandidates,
				queryContext,
				diagnostics,
			);
		}
		corroborated.sort(
			(left, right) =>
				(candidateOrder.get(left.candidate?.type + ":" + left.candidate?.normalizedValue) ??
					Number.MAX_SAFE_INTEGER) -
				(candidateOrder.get(
					right.candidate?.type + ":" + right.candidate?.normalizedValue,
				) ?? Number.MAX_SAFE_INTEGER),
		);
		const selected = corroborated[0];
		return {
			status: "accepted",
			record: canonicalRecord(selected.record, selected.route, selected.lookupValue),
			evidence: createEvidence(
				identifiers,
				attempts,
				titleCandidates,
				queryContext,
				diagnostics,
			),
		};
	}

	if (!queryContext || !titleCandidates.length) {
		diagnostics.push(
			!queryContext
				? "fallback-query-context-unavailable"
				: "fallback-title-evidence-unavailable",
		);
		return finishNeedsYou(
			"No bibliographic result could be confirmed against this PDF.",
			identifiers,
			attempts,
			titleCandidates,
			queryContext,
			diagnostics,
		);
	}

	const fallbackRecords: CorroboratedRecord[] = [];
	const fallbackProviders: {
		provider: LookupSource;
		route: "bibliographic-query" | "openlibrary-search";
		search: (query: string) => Promise<SearchOutcome>;
	}[] = [
		{ provider: "crossref", route: "bibliographic-query", search: lookups.searchCrossref },
		{ provider: "openlibrary", route: "openlibrary-search", search: lookups.searchOpenLibrary },
	];
	for (const provider of fallbackProviders) {
		checkpoint();
		const result = await provider.search(queryContext);
		checkpoint();
		if (result.status === "request-failed") {
			attempts.push(
				toAttempt(provider.provider, provider.route, queryContext, "request-failed"),
			);
			diagnostics.push("provider-request-failed");
			continue;
		}
		if (result.candidates.length === 0) {
			attempts.push(toAttempt(provider.provider, provider.route, queryContext, "no-record"));
			diagnostics.push("provider-no-record");
			continue;
		}
		for (const candidate of result.candidates) {
			const matched = matchingTitle(candidate.record.title, titleCandidates);
			attempts.push(
				toAttempt(
					provider.provider,
					provider.route,
					queryContext,
					matched ? "corroborated" : "title-mismatch",
					candidate.record,
					matched,
					candidate.score,
				),
			);
			if (matched) {
				fallbackRecords.push({
					record: candidate.record,
					route: provider.route,
					lookupValue: queryContext,
					score: candidate.score,
				});
			}
		}
	}

	if (fallbackRecords.length === 0) {
		diagnostics.push("fallback-unresolved");
		return finishNeedsYou(
			"No provider result matched the PDF title evidence.",
			identifiers,
			attempts,
			titleCandidates,
			queryContext,
			diagnostics,
		);
	}
	const selected = uniquelyIdentifiedFallback(fallbackRecords);
	if (!selected) {
		diagnostics.push("ambiguous-fallback-evidence");
		return finishNeedsYou(
			"Fallback evidence does not identify one work.",
			identifiers,
			attempts,
			titleCandidates,
			queryContext,
			diagnostics,
		);
	}
	return {
		status: "accepted",
		record: canonicalRecord(selected.record, selected.route, queryContext),
		evidence: createEvidence(identifiers, attempts, titleCandidates, queryContext, diagnostics),
	};
}

function plausibleTitle(value: string): string | undefined {
	const title = value.trim();
	if (title.length < 12 || title.length > 200 || !/\p{L}/u.test(title)) return undefined;
	if (/^(?:journal|publisher|article\s+type|preprint)\s*:/i.test(title)) return undefined;
	if (/^(?:doi\s*:?\s*)?10\.\d{4,}\/\S+$/i.test(title)) return undefined;
	if (/^ISBN(?:\s*[-:]?\s*(?:10|13))?\s*[-:#]?\s*[\dXx .():-]+$/i.test(title)) {
		return undefined;
	}
	if (normalizeIsbn(title)) return undefined;
	return title;
}

function stripIdentifiers(text: string): string {
	return text
		.replace(/(?:\bdoi\s*:?\s*|https?:\/\/(?:dx\.)?doi\.org\/)?10\.\d{4,}\/[^\s<>"']+/gi, " ")
		.replace(
			/\bISBN(?:\s*[-:]?\s*(?:10|13))?\s*[-:#]?\s*[\dXx][\dXx .():-]{7,22}[\dXx](?![\dXx])/gi,
			" ",
		)
		.replace(/(?<![\d])97[89][\d .():-]{9,17}\d(?![\d])/g, " ")
		.replace(/(?<![\d])\d{9}[\dXx](?![\dXx])/g, " ");
}

function boundedQueryContext(pageText: string | undefined): string | undefined {
	if (!pageText) return undefined;
	const excerpt = stripIdentifiers(pageText).replace(/\s+/g, " ").trim().slice(0, 500).trim();
	if (excerpt.length < 20 || !/[\p{L}].*[\p{L}]/u.test(excerpt)) return undefined;
	return excerpt;
}

/** Creates distinct, bounded search context and title-match evidence from extracted PDF text. */
export function localEvidenceFromPdfText(extracted: PdfTextEvidence): LocalIdentificationEvidence {
	const firstPage = extracted.pages.find((page) => page.pageNumber === 1);
	const titleCandidates: string[] = [];
	const metadataTitle = extracted.infoTitle ? plausibleTitle(extracted.infoTitle) : undefined;
	if (metadataTitle) titleCandidates.push(metadataTitle);
	let segmentCandidateCount = 0;
	for (const segment of firstPage?.segments ?? []) {
		const title = plausibleTitle(segment.text);
		if (!title) continue;
		titleCandidates.push(title);
		segmentCandidateCount++;
		if (segmentCandidateCount === 4) break;
	}
	return {
		pages: extracted.pages.map((page) => ({ pageNumber: page.pageNumber, text: page.text })),
		titleCandidates: safeTitleCandidates(titleCandidates),
		queryContext: boundedQueryContext(firstPage?.text),
	};
}

/** Extracts bounded local evidence, then runs the same testable provider pipeline. */
export async function identifyPdf(
	file: TFile,
	vault: Vault,
	workerAssetPath: string,
	options: IdentificationRunOptions = {},
	lookups: IdentificationLookups = DEFAULT_LOOKUPS,
): Promise<IdentificationResult> {
	const checkpoint = (): void => {
		if (options.shouldCancel?.()) throw new IdentificationCancelledError();
	};
	try {
		checkpoint();
		const extracted = await extractPdfEvidence(file, vault, 3, workerAssetPath, options);
		checkpoint();
		return await resolveIdentificationEvidence(
			localEvidenceFromPdfText(extracted),
			lookups,
			options,
		);
	} catch (error) {
		if (error instanceof IdentificationCancelledError) throw error;
		return finishNeedsYou(
			"Text evidence could not be read from this PDF.",
			[],
			[],
			[],
			undefined,
			["pdf-extraction-failed"],
		);
	}
}
