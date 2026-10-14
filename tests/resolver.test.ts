import { describe, expect, it, vi } from "vitest";
import type { IdentificationLookups } from "../src/resolver";
import {
	localEvidenceFromPdfText,
	lookupManualIdentifier,
	manualTitleConflict,
	resolveIdentificationEvidence,
} from "../src/resolver";
import type { ProviderBibliographicRecord } from "../src/types";

function record(
	provider: "crossref" | "openlibrary",
	title: string,
	options: {
		author?: string;
		isbns?: readonly string[];
		doi?: string;
		diagnostics?: readonly string[];
	} = {},
): ProviderBibliographicRecord {
	return {
		provider,
		title,
		authorship: {
			authors: options.author ? [{ kind: "literal", literal: options.author }] : [],
			completeness: options.author ? "complete" : "unknown",
			totalCountKnown: !!options.author,
		},
		year: 2022,
		doi: options.doi,
		isbns: options.isbns ?? [],
		journal: undefined,
		publisher: undefined,
		diagnostics: [...(options.diagnostics ?? [])],
	};
}

function lookups(): IdentificationLookups {
	return {
		lookupDoi: vi.fn(() => Promise.resolve({ status: "no-record" as const })),
		lookupIsbn: vi.fn(() => Promise.resolve({ status: "no-record" as const })),
		searchCrossref: vi.fn(() =>
			Promise.resolve({ status: "records" as const, candidates: [] }),
		),
		searchOpenLibrary: vi.fn(() =>
			Promise.resolve({ status: "records" as const, candidates: [] }),
		),
	};
}

function fallbackInput() {
	return {
		pages: [{ pageNumber: 1, text: "No explicit identifiers on this page." }],
		queryContext: "A Bibliographic Work Title and its publication context",
		titleCandidates: ["A Bibliographic Work Title"],
	};
}

function unresolvedAuthorRecord(
	provider: "crossref" | "openlibrary",
	doi: string,
	reference: string,
): ProviderBibliographicRecord {
	return {
		...record(provider, "A Bibliographic Work Title", { doi }),
		authorship: {
			authors: [{ kind: "unresolved", position: 0, reference }],
			completeness: "partial",
			totalCountKnown: true,
		},
	};
}

describe("identifier-first title corroboration", () => {
	it("keeps bounded search context separate from Info and first-page title candidates", () => {
		const extracted = {
			infoTitle: "A Reliable Metadata Title Candidate",
			pages: [
				{
					pageNumber: 1,
					text:
						"doi: 10.1234/cited\nISBN 9780306406157\n" +
						"Front matter with venue, publisher, and useful bibliographic context. ".repeat(
							10,
						),
					segments: [
						{ pageNumber: 1, text: "Journal: Example Review", startOffset: 0 },
						{
							pageNumber: 1,
							text: "A Strong Article Title After Front Matter",
							startOffset: 23,
						},
						{ pageNumber: 1, text: "Another Plausible Work Title", startOffset: 65 },
						{ pageNumber: 1, text: "A Third Plausible Work Title", startOffset: 94 },
						{ pageNumber: 1, text: "A Fourth Plausible Work Title", startOffset: 123 },
						{ pageNumber: 1, text: "A Fifth Plausible Work Title", startOffset: 152 },
					],
				},
			],
		};
		const local = localEvidenceFromPdfText(extracted);
		expect(local.titleCandidates).toEqual([
			"A Reliable Metadata Title Candidate",
			"A Strong Article Title After Front Matter",
			"Another Plausible Work Title",
			"A Third Plausible Work Title",
			"A Fourth Plausible Work Title",
		]);
		expect(local.titleCandidates).not.toContain("A Fifth Plausible Work Title");
		expect(local.queryContext?.length).toBeLessThanOrEqual(500);
		expect(local.queryContext).not.toContain("10.1234/cited");
		expect(local.queryContext).not.toContain("9780306406157");
		expect(local.queryContext).toContain("Front matter with venue");
	});

	it("rejects an unusable Info Title while retaining later plausible first-page segments", () => {
		const local = localEvidenceFromPdfText({
			infoTitle: "Untitled",
			pages: [
				{
					pageNumber: 1,
					text: "Journal: Example Review\nA Plausible Title After Front Matter",
					segments: [
						{ pageNumber: 1, text: "Journal: Example Review", startOffset: 0 },
						{
							pageNumber: 1,
							text: "A Plausible Title After Front Matter",
							startOffset: 24,
						},
					],
				},
			],
		});
		expect(local.titleCandidates).toEqual(["A Plausible Title After Front Matter"]);
	});

	it("retains a cited-reference DOI mismatch and accepts a later matching direct identifier", async () => {
		const providers = lookups();
		vi.mocked(providers.lookupDoi).mockResolvedValue({
			status: "record",
			record: record("crossref", "A Different Cited Work", { doi: "10.1234/cited" }),
		});
		vi.mocked(providers.lookupIsbn).mockResolvedValue({
			status: "record",
			record: record("openlibrary", "Decolonizing and Indigenizing Evaluation Practice", {
				author: "Chilisa",
				isbns: ["9780306406157"],
			}),
		});
		const result = await resolveIdentificationEvidence(
			{
				pages: [
					{
						pageNumber: 1,
						text: "doi: 10.1234/cited\nISBN 978-0-306-40615-7",
					},
				],
				titleCandidates: ["Decolonizing and Indigenizing Evaluation Practice"],
			},
			providers,
		);
		expect(providers.lookupDoi).toHaveBeenCalledWith("10.1234/cited");
		expect(providers.lookupIsbn).toHaveBeenCalledWith("9780306406157");
		expect(result.status).toBe("accepted");
		if (result.status !== "accepted") return;
		expect(result.record).toMatchObject({
			title: "Decolonizing and Indigenizing Evaluation Practice",
			authorship: { completeness: "complete" },
			provenance: { provider: "openlibrary", route: "isbn", identifier: "9780306406157" },
		});
		expect(result.evidence.attempts.map((attempt) => attempt.outcome)).toEqual([
			"title-mismatch",
			"corroborated",
		]);
		expect(result.evidence.attempts[0]?.candidateRecord?.title).toBe("A Different Cited Work");
		expect(providers.searchCrossref).not.toHaveBeenCalled();
		expect(providers.searchOpenLibrary).not.toHaveBeenCalled();
	});

	it("does not accept an exact direct result when local title candidates are absent", async () => {
		const providers = lookups();
		vi.mocked(providers.lookupDoi).mockResolvedValue({
			status: "record",
			record: record("crossref", "A Bibliographic Work Title"),
		});
		const result = await resolveIdentificationEvidence(
			{
				pages: [{ pageNumber: 1, text: "doi: 10.1234/work" }],
				queryContext: "A Bibliographic Work Title, Journal, 2022",
				titleCandidates: [],
			},
			providers,
		);
		expect(result.status).toBe("needs-you");
		expect(providers.searchCrossref).not.toHaveBeenCalled();
		expect(providers.searchOpenLibrary).not.toHaveBeenCalled();
		if (result.status === "needs-you") {
			expect(result.evidence.attempts[0]).toMatchObject({
				outcome: "title-mismatch",
				candidateRecord: { title: "A Bibliographic Work Title" },
			});
			expect(result.evidence.diagnostics).toContain("fallback-title-evidence-unavailable");
		}
	});

	it("keeps compatible corroborated records separate and selects the whole strongest-evidence record", async () => {
		const providers = lookups();
		vi.mocked(providers.lookupDoi).mockResolvedValue({
			status: "record",
			record: record("crossref", "A Bibliographic Work Title", {
				author: "Ada Lovelace",
				doi: "10.1234/first",
			}),
		});
		vi.mocked(providers.lookupIsbn).mockResolvedValue({
			status: "record",
			record: record("openlibrary", "A Bibliographic Work Title", {
				author: "Ada Lovelace",
				isbns: ["9780306406157"],
			}),
		});
		const result = await resolveIdentificationEvidence(
			{
				pages: [
					{
						pageNumber: 1,
						text: "DOI: 10.1234/first\nISBN: 9780306406157",
					},
				],
				titleCandidates: ["A Bibliographic Work Title"],
			},
			providers,
		);
		expect(result.status).toBe("accepted");
		if (result.status !== "accepted") return;
		expect(result.record.provenance).toEqual({
			provider: "crossref",
			route: "doi",
			identifier: "10.1234/first",
		});
		expect(result.record.doi).toBe("10.1234/first");
		expect(result.record.isbns).toEqual([]);
		expect(result.evidence.attempts).toHaveLength(2);
	});

	it("reports conflicting corroborated direct works and does not hide them with fallback", async () => {
		const providers = lookups();
		vi.mocked(providers.lookupDoi).mockResolvedValue({
			status: "record",
			record: record("crossref", "A Bibliographic Work Title", { author: "Ada Lovelace" }),
		});
		vi.mocked(providers.lookupIsbn).mockResolvedValue({
			status: "record",
			record: record("openlibrary", "A Bibliographic Work Title", { author: "Grace Hopper" }),
		});
		const result = await resolveIdentificationEvidence(
			{
				pages: [{ pageNumber: 1, text: "doi: 10.1234/work\nISBN 9780306406157" }],
				titleCandidates: ["A Bibliographic Work Title"],
				queryContext: "A Bibliographic Work Title",
			},
			providers,
		);
		expect(result).toMatchObject({
			status: "needs-you",
			reason: "Multiple different works match the document evidence.",
		});
		expect(providers.searchCrossref).not.toHaveBeenCalled();
		expect(providers.searchOpenLibrary).not.toHaveBeenCalled();
	});

	it("keeps the direct selection independent of provider completion timing", async () => {
		const providers = lookups();
		const completion: string[] = [];
		vi.mocked(providers.lookupDoi).mockImplementation(async (doi) => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			completion.push("doi");
			return {
				status: "record",
				record: record("crossref", "A Bibliographic Work Title", { doi }),
			};
		});
		vi.mocked(providers.lookupIsbn).mockImplementation(() => {
			completion.push("isbn");
			return Promise.resolve({
				status: "record",
				record: record("openlibrary", "A Bibliographic Work Title"),
			});
		});
		const result = await resolveIdentificationEvidence(
			{
				pages: [{ pageNumber: 1, text: "doi: 10.1234/work\nISBN 9780306406157" }],
				titleCandidates: ["A Bibliographic Work Title"],
			},
			providers,
		);
		expect(completion).toEqual(["doi", "isbn"]);
		expect(result.status).toBe("accepted");
		if (result.status === "accepted") {
			expect(result.record.provenance).toMatchObject({
				provider: "crossref",
				route: "doi",
				identifier: "10.1234/work",
			});
		}
	});

	it("attempts all in-budget explicit candidates before any fallback call", async () => {
		const providers = lookups();
		const sequence: string[] = [];
		vi.mocked(providers.lookupDoi).mockImplementation((doi) => {
			sequence.push("doi:" + doi);
			return Promise.resolve({ status: "no-record" });
		});
		vi.mocked(providers.lookupIsbn).mockImplementation((isbn) => {
			sequence.push("isbn:" + isbn);
			return Promise.resolve({ status: "no-record" });
		});
		vi.mocked(providers.searchCrossref).mockImplementation(() => {
			sequence.push("crossref-search");
			return Promise.resolve({ status: "records", candidates: [] });
		});
		vi.mocked(providers.searchOpenLibrary).mockImplementation(() => {
			sequence.push("openlibrary-search");
			return Promise.resolve({ status: "records", candidates: [] });
		});
		await resolveIdentificationEvidence(
			{
				pages: [{ pageNumber: 1, text: "doi: 10.1234/missing ISBN 9780306406157" }],
				titleCandidates: ["A Bibliographic Work Title"],
				queryContext: "A Bibliographic Work Title; journal 2024",
			},
			providers,
		);
		expect(sequence.slice(0, 2)).toEqual(["doi:10.1234/missing", "isbn:9780306406157"]);
		expect(sequence.slice(2)).toEqual(["crossref-search", "openlibrary-search"]);
	});

	it("keeps identifier overflow ambiguous after all in-budget attempts and skips fallback", async () => {
		const providers = lookups();
		const result = await resolveIdentificationEvidence(
			{
				pages: [
					{
						pageNumber: 1,
						text: ["10.1234/one", "10.1234/two", "10.1234/three", "10.1234/four"].join(
							"\n",
						),
					},
				],
				titleCandidates: ["A Bibliographic Work Title"],
				queryContext: "A Bibliographic Work Title",
			},
			providers,
		);
		expect(providers.lookupDoi).toHaveBeenCalledTimes(3);
		expect(providers.searchCrossref).not.toHaveBeenCalled();
		expect(providers.searchOpenLibrary).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			status: "needs-you",
			reason: "More identifiers were found than can be checked safely.",
		});
		if (result.status === "needs-you")
			expect(result.evidence.diagnostics).toContain("identifier-overflow");
	});

	it("does not query invalid identifiers and preserves safe direct/fallback failure evidence", async () => {
		const invalidProviders = lookups();
		const invalid = await resolveIdentificationEvidence(
			{
				pages: [{ pageNumber: 1, text: "doi: 10.123/short ISBN 1234567890" }],
				titleCandidates: ["A Bibliographic Work Title"],
				queryContext: "A Bibliographic Work Title and journal",
			},
			invalidProviders,
		);
		expect(invalidProviders.lookupDoi).not.toHaveBeenCalled();
		expect(invalidProviders.lookupIsbn).not.toHaveBeenCalled();
		if (invalid.status === "needs-you") {
			expect(invalid.evidence.identifiers.some((candidate) => !candidate.valid)).toBe(true);
		}

		const failedProviders = lookups();
		vi.mocked(failedProviders.lookupDoi).mockResolvedValue({ status: "request-failed" });
		vi.mocked(failedProviders.lookupIsbn).mockResolvedValue({ status: "no-record" });
		vi.mocked(failedProviders.searchCrossref).mockResolvedValue({ status: "request-failed" });
		const failed = await resolveIdentificationEvidence(
			{
				pages: [{ pageNumber: 1, text: "DOI: 10.1234/missing ISBN: 9780306406157" }],
				queryContext: "A Bibliographic Work Title and journal",
				titleCandidates: ["A Bibliographic Work Title"],
			},
			failedProviders,
		);
		expect(failed.status).toBe("needs-you");
		if (failed.status === "needs-you") {
			expect(failed.evidence.attempts.map((attempt) => attempt.outcome)).toEqual([
				"request-failed",
				"no-record",
				"request-failed",
				"no-record",
			]);
			expect(JSON.stringify(failed.evidence)).not.toMatch(/stack|private transport/i);
		}
	});

	it("does not make fallback requests without both bounded query and title evidence", async () => {
		const withTitleOnly = lookups();
		await resolveIdentificationEvidence(
			{
				pages: [{ pageNumber: 1, text: "ordinary first-page text" }],
				titleCandidates: ["A Bibliographic Work Title"],
			},
			withTitleOnly,
		);
		expect(withTitleOnly.searchCrossref).not.toHaveBeenCalled();
		expect(withTitleOnly.searchOpenLibrary).not.toHaveBeenCalled();

		const withQueryOnly = lookups();
		await resolveIdentificationEvidence(
			{
				pages: [{ pageNumber: 1, text: "ordinary first-page text" }],
				queryContext: "A Bibliographic Work Title and journal",
				titleCandidates: [],
			},
			withQueryOnly,
		);
		expect(withQueryOnly.searchCrossref).not.toHaveBeenCalled();
		expect(withQueryOnly.searchOpenLibrary).not.toHaveBeenCalled();
	});

	it("compares provider results to exact normalized title candidates, never query context", async () => {
		const providers = lookups();
		vi.mocked(providers.searchCrossref).mockResolvedValue({
			status: "records",
			candidates: [
				{
					record: record("crossref", "Front matter and bibliographic query text"),
					score: 100,
				},
			],
		});
		vi.mocked(providers.searchOpenLibrary).mockResolvedValue({
			status: "records",
			candidates: [
				{
					record: record("openlibrary", "The (Exact) Bibliographic Work Title!"),
				},
			],
		});
		const result = await resolveIdentificationEvidence(
			{
				pages: [{ pageNumber: 1, text: "unused for identifier search" }],
				queryContext: "Front matter and bibliographic query text",
				titleCandidates: ["The Exact Bibliographic Work Title"],
			},
			providers,
		);
		expect(vi.mocked(providers.searchCrossref).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(providers.searchOpenLibrary).mock.invocationCallOrder[0],
		);
		expect(result.status).toBe("accepted");
		if (result.status === "accepted") {
			expect(result.record.title).toBe("The (Exact) Bibliographic Work Title!");
			expect(result.record.provenance).toEqual({
				provider: "openlibrary",
				route: "openlibrary-search",
				query: "Front matter and bibliographic query text",
			});
			expect(result.evidence.attempts[0]?.score).toBe(100);
		}
	});

	it("marks exact-title fallback candidates with conflicting authors as Needs you", async () => {
		const providers = lookups();
		vi.mocked(providers.searchCrossref).mockResolvedValue({
			status: "records",
			candidates: [
				{
					record: record("crossref", "A Bibliographic Work Title", {
						author: "Ada Lovelace",
						doi: "10.1234/shared-conflicting-work",
					}),
				},
			],
		});
		vi.mocked(providers.searchOpenLibrary).mockResolvedValue({
			status: "records",
			candidates: [
				{
					record: record("openlibrary", "A Bibliographic Work Title", {
						author: "Grace Hopper",
						doi: "10.1234/shared-conflicting-work",
					}),
				},
			],
		});
		const result = await resolveIdentificationEvidence(
			{
				pages: [{ pageNumber: 1, text: "no identifier" }],
				queryContext: "A Bibliographic Work Title",
				titleCandidates: ["A Bibliographic Work Title"],
			},
			providers,
		);
		expect(result).toMatchObject({
			status: "needs-you",
			reason: "Fallback evidence does not identify one work.",
		});
	});

	it("keeps same-title fallback records with missing authors and distinct identifiers ambiguous", async () => {
		const providers = lookups();
		vi.mocked(providers.searchCrossref).mockResolvedValue({
			status: "records",
			candidates: [
				{
					record: record("crossref", "A Bibliographic Work Title", {
						doi: "10.1234/work-a",
					}),
				},
			],
		});
		vi.mocked(providers.searchOpenLibrary).mockResolvedValue({
			status: "records",
			candidates: [
				{
					record: record("openlibrary", "A Bibliographic Work Title", {
						doi: "10.1234/work-b",
					}),
				},
			],
		});

		const result = await resolveIdentificationEvidence(fallbackInput(), providers);

		expect(result).toMatchObject({
			status: "needs-you",
			reason: "Fallback evidence does not identify one work.",
			evidence: { diagnostics: ["no-valid-identifiers", "ambiguous-fallback-evidence"] },
		});
		if (result.status === "needs-you") {
			expect(result.evidence.attempts).toHaveLength(2);
			expect(result.evidence.attempts.map((attempt) => attempt.candidateRecord?.doi)).toEqual(
				["10.1234/work-a", "10.1234/work-b"],
			);
		}
	});

	it("keeps same-title records with unresolved non-distinguishing authors ambiguous", async () => {
		const providers = lookups();
		vi.mocked(providers.searchCrossref).mockResolvedValue({
			status: "records",
			candidates: [
				{
					record: unresolvedAuthorRecord(
						"crossref",
						"10.1234/work-a",
						"crossref:author/1",
					),
				},
			],
		});
		vi.mocked(providers.searchOpenLibrary).mockResolvedValue({
			status: "records",
			candidates: [
				{
					record: unresolvedAuthorRecord(
						"openlibrary",
						"10.1234/work-b",
						"openlibrary:author/7",
					),
				},
			],
		});

		const result = await resolveIdentificationEvidence(fallbackInput(), providers);

		expect(result.status).toBe("needs-you");
		if (result.status === "needs-you") {
			expect(result.evidence.diagnostics).toContain("ambiguous-fallback-evidence");
			expect(result.evidence.attempts).toHaveLength(2);
		}
	});

	it("does not prefer a richer same-title record without stable identity evidence", async () => {
		const providers = lookups();
		vi.mocked(providers.searchCrossref).mockResolvedValue({
			status: "records",
			candidates: [
				{
					record: record("crossref", "A Bibliographic Work Title", {
						doi: "10.1234/work-with-author",
						author: "Ada Lovelace",
					}),
				},
			],
		});
		vi.mocked(providers.searchOpenLibrary).mockResolvedValue({
			status: "records",
			candidates: [
				{
					record: record("openlibrary", "A Bibliographic Work Title", {
						doi: "10.1234/work-without-author",
					}),
				},
			],
		});

		const result = await resolveIdentificationEvidence(fallbackInput(), providers);

		expect(result.status).toBe("needs-you");
		if (result.status === "needs-you") {
			expect(result.evidence.diagnostics).toContain("ambiguous-fallback-evidence");
			expect(result.evidence.attempts).toHaveLength(2);
		}
	});

	it("selects one whole deterministic candidate for duplicate stable identities", async () => {
		const sharedDoi = "10.1234/shared-work";
		const crossref2021 = record("crossref", "A Bibliographic Work Title", {
			doi: sharedDoi,
		});
		crossref2021.year = 2021;
		crossref2021.journal = "Crossref Journal 2021";
		const crossref2020 = record("crossref", "A Bibliographic Work Title", {
			doi: sharedDoi,
		});
		crossref2020.year = 2020;
		crossref2020.journal = "Crossref Journal 2020";
		const openLibrary = record("openlibrary", "A Bibliographic Work Title", {
			doi: sharedDoi,
			isbns: ["9780306406157"],
		});
		openLibrary.publisher = "Open Library Publisher";

		const run = async (reverse: boolean, delays: [number, number]) => {
			const providers = lookups();
			const crossrefRecords = reverse
				? [crossref2020, crossref2021]
				: [crossref2021, crossref2020];
			const openLibraryRecords = reverse
				? [
						openLibrary,
						record("openlibrary", "A Bibliographic Work Title", { doi: sharedDoi }),
					]
				: [
						record("openlibrary", "A Bibliographic Work Title", { doi: sharedDoi }),
						openLibrary,
					];
			vi.mocked(providers.searchCrossref).mockImplementation(async () => {
				await new Promise((resolve) => setTimeout(resolve, delays[0]));
				return {
					status: "records",
					candidates: crossrefRecords.map((candidate) => ({ record: candidate })),
				};
			});
			vi.mocked(providers.searchOpenLibrary).mockImplementation(async () => {
				await new Promise((resolve) => setTimeout(resolve, delays[1]));
				return {
					status: "records",
					candidates: openLibraryRecords.map((candidate) => ({ record: candidate })),
				};
			});
			return resolveIdentificationEvidence(fallbackInput(), providers);
		};

		const first = await run(false, [2, 0]);
		const reversed = await run(true, [0, 2]);
		expect(first.status).toBe("accepted");
		expect(reversed.status).toBe("accepted");
		if (first.status === "accepted" && reversed.status === "accepted") {
			expect(reversed.record).toEqual(first.record);
			expect(first.record).toMatchObject({
				year: 2020,
				journal: "Crossref Journal 2020",
				provenance: { provider: "crossref", route: "bibliographic-query" },
			});
			expect(first.record.publisher).toBeUndefined();
			expect(first.evidence.attempts).toHaveLength(4);
			expect(first.evidence.attempts.every((attempt) => attempt.candidateRecord)).toBe(true);
		}
	});

	it("recognizes the same valid ISBN across provider punctuation formats", async () => {
		const providers = lookups();
		vi.mocked(providers.searchCrossref).mockResolvedValue({
			status: "records",
			candidates: [
				{
					record: record("crossref", "A Bibliographic Work Title", {
						isbns: ["978-0-306-40615-7"],
					}),
				},
			],
		});
		vi.mocked(providers.searchOpenLibrary).mockResolvedValue({
			status: "records",
			candidates: [
				{
					record: record("openlibrary", "A Bibliographic Work Title", {
						isbns: ["9780306406157"],
					}),
				},
			],
		});

		const result = await resolveIdentificationEvidence(fallbackInput(), providers);

		expect(result.status).toBe("accepted");
		if (result.status === "accepted") {
			expect(result.record.provenance).toMatchObject({
				provider: "crossref",
				route: "bibliographic-query",
			});
			expect(result.record.isbns).toEqual(["978-0-306-40615-7"]);
		}
		expect(result.evidence.attempts).toHaveLength(2);
	});

	it("remains ambiguous when provider result arrays reverse under varied response timing", async () => {
		const crossref = [
			record("crossref", "A Bibliographic Work Title", { doi: "10.1234/crossref-a" }),
			record("crossref", "A Bibliographic Work Title", { doi: "10.1234/crossref-b" }),
		];
		const openlibrary = [
			record("openlibrary", "A Bibliographic Work Title", { doi: "10.1234/openlibrary-a" }),
			record("openlibrary", "A Bibliographic Work Title", { doi: "10.1234/openlibrary-b" }),
		];
		const run = async (reverse: boolean, delays: [number, number]) => {
			const providers = lookups();
			vi.mocked(providers.searchCrossref).mockImplementation(async () => {
				await new Promise((resolve) => setTimeout(resolve, delays[0]));
				return {
					status: "records",
					candidates: (reverse ? [...crossref].reverse() : crossref).map((candidate) => ({
						record: candidate,
					})),
				};
			});
			vi.mocked(providers.searchOpenLibrary).mockImplementation(async () => {
				await new Promise((resolve) => setTimeout(resolve, delays[1]));
				return {
					status: "records",
					candidates: (reverse ? [...openlibrary].reverse() : openlibrary).map(
						(candidate) => ({
							record: candidate,
						}),
					),
				};
			});
			return resolveIdentificationEvidence(fallbackInput(), providers);
		};

		const first = await run(false, [2, 0]);
		const reversed = await run(true, [0, 2]);
		for (const result of [first, reversed]) {
			expect(result.status).toBe("needs-you");
			if (result.status === "needs-you") {
				expect(result.evidence.diagnostics).toContain("ambiguous-fallback-evidence");
				expect(result.evidence.attempts).toHaveLength(4);
			}
		}
		if (first.status === "needs-you" && reversed.status === "needs-you") {
			expect(reversed.reason).toBe(first.reason);
			expect(reversed.evidence.diagnostics).toEqual(first.evidence.diagnostics);
		}
	});

	it("keeps two title matches ambiguous when another fallback result mismatches", async () => {
		const providers = lookups();
		vi.mocked(providers.searchCrossref).mockResolvedValue({
			status: "records",
			candidates: [
				{
					record: record("crossref", "A Different Cited Work", {
						doi: "10.1234/mismatch",
					}),
				},
				{
					record: record("crossref", "A Bibliographic Work Title", {
						doi: "10.1234/work-a",
					}),
				},
			],
		});
		vi.mocked(providers.searchOpenLibrary).mockResolvedValue({
			status: "records",
			candidates: [
				{
					record: record("openlibrary", "A Bibliographic Work Title", {
						doi: "10.1234/work-b",
					}),
				},
			],
		});

		const result = await resolveIdentificationEvidence(fallbackInput(), providers);

		expect(result.status).toBe("needs-you");
		if (result.status === "needs-you") {
			expect(result.evidence.diagnostics).toContain("ambiguous-fallback-evidence");
			expect(result.evidence.attempts.map((attempt) => attempt.outcome)).toEqual([
				"title-mismatch",
				"corroborated",
				"corroborated",
			]);
			expect(result.evidence.attempts[0]?.candidateRecord?.doi).toBe("10.1234/mismatch");
			expect(
				result.evidence.attempts.slice(1).map((attempt) => attempt.candidateRecord?.doi),
			).toEqual(["10.1234/work-a", "10.1234/work-b"]);
		}
	});

	it("marks partial provider details as diagnostics without treating them as identity ambiguity", async () => {
		const providers = lookups();
		vi.mocked(providers.lookupDoi).mockResolvedValue({
			status: "record",
			record: record("crossref", "A Bibliographic Work Title", {
				diagnostics: ["authors-incomplete"],
			}),
		});
		const result = await resolveIdentificationEvidence(
			{
				pages: [{ pageNumber: 1, text: "doi: 10.1234/work" }],
				titleCandidates: ["A Bibliographic Work Title"],
			},
			providers,
		);
		expect(result.status).toBe("accepted");
		if (result.status === "accepted") {
			expect(result.record.authorship.completeness).toBe("unknown");
			expect(result.evidence.attempts[0]?.diagnostics).toEqual(["authors-incomplete"]);
		}
	});
});

describe("direct manual identifier lookup", () => {
	it("normalizes a DOI and returns one unconfirmed whole candidate without fallback", async () => {
		const providers = lookups();
		vi.mocked(providers.lookupDoi).mockResolvedValue({
			status: "record",
			record: record("crossref", "Provider Work Title", { doi: "10.1234/manual" }),
		});
		const result = await lookupManualIdentifier(
			"doi",
			"doi: https://doi.org/10.1234/manual.",
			providers,
		);
		expect(result).toMatchObject({
			status: "candidate",
			candidate: { provider: "crossref", route: "doi", lookupValue: "10.1234/manual" },
			record: {
				title: "Provider Work Title",
				provenance: { provider: "crossref", route: "doi" },
			},
		});
		expect(providers.lookupDoi).toHaveBeenCalledTimes(1);
		expect(providers.lookupIsbn).not.toHaveBeenCalled();
		expect(providers.searchCrossref).not.toHaveBeenCalled();
		expect(providers.searchOpenLibrary).not.toHaveBeenCalled();
	});

	it("normalizes ISBN checksums and preserves no-record versus request-failed", async () => {
		const providers = lookups();
		const noRecord = await lookupManualIdentifier("isbn", "ISBN-10: 0-306-40615-2", providers);
		expect(noRecord).toMatchObject({
			status: "no-record",
			candidate: { provider: "openlibrary", route: "isbn", lookupValue: "0306406152" },
		});
		vi.mocked(providers.lookupIsbn).mockResolvedValue({ status: "request-failed" });
		await expect(
			lookupManualIdentifier("isbn", "978-0-306-40615-7", providers),
		).resolves.toMatchObject({
			status: "request-failed",
			candidate: { lookupValue: "9780306406157" },
		});
		expect(providers.lookupIsbn).toHaveBeenCalledTimes(2);
	});

	it("rejects invalid identifiers locally and identifies title conflicts for deliberate confirmation", async () => {
		const providers = lookups();
		expect(await lookupManualIdentifier("doi", "not a doi", providers)).toEqual({
			status: "invalid",
		});
		expect(await lookupManualIdentifier("isbn", "9780306406158", providers)).toEqual({
			status: "invalid",
		});
		expect(providers.lookupDoi).not.toHaveBeenCalled();
		expect(providers.lookupIsbn).not.toHaveBeenCalled();
		expect(manualTitleConflict("Different Provider Title", ["PDF Work Title"])).toBe(
			"PDF Work Title",
		);
		expect(manualTitleConflict("pdf work title!", ["PDF Work Title"])).toBeUndefined();
		expect(manualTitleConflict("Provider Title", [])).toBeUndefined();
	});
});
