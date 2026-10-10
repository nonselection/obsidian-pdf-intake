import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "./obsidian";
import {
	extractIdentifierCandidates,
	lookupDoi,
	lookupIsbn,
	normalizeDoi,
	normalizeIsbn,
	OPEN_LIBRARY_AUTHOR_DETAIL_BUDGET,
	rankDirectIdentifierEvidence,
	searchCrossrefBibliographic,
	searchOpenLibrary,
} from "../src/lookup";

const request = vi.mocked(requestUrl);

describe("identifier normalization and evidence", () => {
	it.each([
		["10.1234/example.567", "10.1234/example.567"],
		["doi: 10.1234/example.567.", "10.1234/example.567"],
		["https://doi.org/10.1234/example", "10.1234/example"],
		["http://dx.doi.org/10.1234/example_(part)", "10.1234/example_(part)"],
		["10.1234/example)", "10.1234/example"],
	])("normalizes DOI evidence %s", (raw, normalized) => {
		expect(normalizeDoi(raw)).toBe(normalized);
	});

	it("preserves meaningful DOI suffix punctuation and rejects malformed DOI shapes", () => {
		expect(normalizeDoi("10.1234/example!")).toBe("10.1234/example!");
		expect(normalizeDoi("10.1234/example,")).toBe("10.1234/example");
		expect(normalizeDoi("10.123/example")).toBeUndefined();
	});

	it("validates ISBN-10 and ISBN-13 checksums after removing presentation punctuation", () => {
		expect(normalizeIsbn("ISBN-10: 0-306-40615-2")).toBe("0306406152");
		expect(normalizeIsbn("ISBN 13: 978.0.306.40615.7")).toBe("9780306406157");
		expect(normalizeIsbn("0-8044-2957-X")).toBe("080442957X");
		expect(normalizeIsbn("0306406153")).toBeUndefined();
		expect(normalizeIsbn("9780306406158")).toBeUndefined();
		expect(normalizeIsbn("1234567890")).toBeUndefined();
	});

	it("retains ordered identifier locations, labels, validity, and strongest deduplicated evidence", () => {
		const text = [
			"doi: 10.1234/example.1.",
			"later 10.1234/example.1",
			"ISBN-13: 978-0-306-40615-7",
			"ISBN: 9780306406158",
		].join("\n");
		const evidence = extractIdentifierCandidates([{ pageNumber: 2, text }]);
		expect(evidence).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "doi",
					rawText: "doi: 10.1234/example.1.",
					normalizedValue: "10.1234/example.1",
					valid: true,
					pageNumber: 2,
					textOffset: 0,
					labeled: true,
				}),
				expect.objectContaining({
					type: "isbn",
					normalizedValue: "9780306406157",
					valid: true,
					pageNumber: 2,
					labeled: true,
				}),
				expect.objectContaining({ type: "isbn", valid: false, labeled: true }),
			]),
		);
		expect(
			evidence.filter((candidate) => candidate.normalizedValue === "10.1234/example.1"),
		).toHaveLength(1);
		expect(
			evidence.find((candidate) => candidate.normalizedValue === "10.1234/example.1")
				?.textOffset,
		).toBe(0);
	});

	it("orders direct candidates by label, page, offset, and only then DOI tie-break", () => {
		const candidates = [
			{
				type: "doi",
				rawText: "a",
				normalizedValue: "10.1234/a",
				valid: true,
				pageNumber: 1,
				textOffset: 0,
				labeled: false,
			},
			{
				type: "isbn",
				rawText: "b",
				normalizedValue: "0306406152",
				valid: true,
				pageNumber: 1,
				textOffset: 0,
				labeled: true,
			},
			{
				type: "doi",
				rawText: "c",
				normalizedValue: "10.1234/c",
				valid: true,
				pageNumber: 1,
				textOffset: 0,
				labeled: true,
			},
			{
				type: "isbn",
				rawText: "d",
				normalizedValue: "9780306406157",
				valid: true,
				pageNumber: 2,
				textOffset: 0,
				labeled: true,
			},
		] as const;
		expect(
			rankDirectIdentifierEvidence(candidates).candidates.map(
				(candidate) => candidate.rawText,
			),
		).toEqual(["c", "b", "d", "a"]);
	});

	it("reports per-type overflow after deduplicating valid identifiers", () => {
		const evidence = extractIdentifierCandidates([
			{
				pageNumber: 1,
				text: [
					"10.1234/one",
					"10.1234/two",
					"10.1234/three",
					"10.1234/four",
					"ISBN 0306406152",
					"ISBN 9780306406157",
					"ISBN 080442957X",
					"ISBN 9781861972712",
				].join("\n"),
			},
		]);
		expect(rankDirectIdentifierEvidence(evidence).overflow).toEqual({ doi: 1, isbn: 1 });
		expect(rankDirectIdentifierEvidence(evidence).candidates).toHaveLength(6);
	});
});

describe("provider-preserving lookup", () => {
	beforeEach(() => {
		request.mockReset();
	});

	it("preserves Crossref author structure, order, unresolved slots, ISBNs, and full date evidence", async () => {
		request.mockResolvedValue({
			status: 200,
			json: {
				message: {
					DOI: "10.1234/work",
					title: ["Provider title"],
					author: [
						{ given: "Ada", family: "Lovelace" },
						{ name: "Research Group" },
						{},
						{ given: "Grace", family: "Hopper" },
					],
					published: { "date-parts": [[2022, 4, 12]] },
					ISBN: ["9780306406157", "0306406152"],
					"container-title": ["Journal"],
					publisher: "Publisher",
				},
			},
		});
		const result = await lookupDoi("10.1234/work");
		expect(result).toMatchObject({
			status: "record",
			record: {
				provider: "crossref",
				title: "Provider title",
				authorship: {
					authors: [
						{ kind: "person", given: "Ada", family: "Lovelace" },
						{ kind: "organization", literal: "Research Group" },
						{ kind: "unresolved", position: 2 },
						{ kind: "person", given: "Grace", family: "Hopper" },
					],
					completeness: "partial",
					totalCountKnown: true,
				},
				year: 2022,
				publicationDate: {
					provider: "crossref",
					source: "published",
					dateParts: [2022, 4, 12],
				},
				doi: "10.1234/work",
				isbns: ["9780306406157", "0306406152"],
				journal: "Journal",
				publisher: "Publisher",
				diagnostics: ["authors-incomplete"],
			},
		});
	});

	it("keeps absent Crossref authorship unknown rather than claiming an empty complete list", async () => {
		request.mockResolvedValue({ status: 200, json: { message: { title: ["A"] } } });
		const result = await lookupDoi("10.1234/work");
		expect(result).toMatchObject({
			status: "record",
			record: {
				authorship: { authors: [], completeness: "unknown", totalCountKnown: false },
			},
		});
	});

	it("preserves every Open Library author reference beyond five and fetches sequentially", async () => {
		const requestOrder: string[] = [];
		request.mockImplementation((options) => {
			if (!options) throw new Error("request options missing");
			const { url } = options;
			requestOrder.push(url);
			if (url.includes("/isbn/")) {
				return Promise.resolve({
					status: 200,
					json: {
						title: "Many-author work",
						authors: Array.from({ length: 7 }, (_, index) => ({
							key: "/authors/OL" + index + "A",
						})),
						publish_date: "April 2004",
						isbn_10: ["0306406152"],
						isbn_13: ["9780306406157"],
						publishers: ["Open Books"],
					},
				});
			}
			return Promise.resolve({
				status: 200,
				json: { name: "Author " + requestOrder.length },
			});
		});
		const result = await lookupIsbn("9780306406157");
		expect(request).toHaveBeenCalledTimes(8);
		expect(requestOrder.slice(1).map((url) => url.split("/").at(-1))).toEqual(
			Array.from({ length: 7 }, (_, index) => "OL" + index + "A.json"),
		);
		expect(result).toMatchObject({
			status: "record",
			record: {
				authorship: {
					authors: Array.from({ length: 7 }, (_, index) => ({
						kind: "literal",
						literal: "Author " + (index + 2),
					})),
					completeness: "complete",
					totalCountKnown: true,
				},
				publicationDate: {
					provider: "openlibrary",
					source: "publish-date",
					text: "April 2004",
				},
				year: 2004,
				isbns: ["0306406152", "9780306406157"],
				publisher: "Open Books",
			},
		});
	});

	it("keeps all positions and caps Open Library author-detail requests at fifty", async () => {
		request.mockImplementation((options) => {
			if (!options) throw new Error("request options missing");
			const { url } = options;
			if (url.includes("/isbn/")) {
				return Promise.resolve({
					status: 200,
					json: {
						title: "Edited collection",
						authors: Array.from({ length: 63 }, (_, index) => ({
							key: "/authors/OL" + index + "A",
						})),
					},
				});
			}
			return Promise.resolve({ status: 200, json: { name: "Name" } });
		});
		const result = await lookupIsbn("9780306406157");
		expect(request).toHaveBeenCalledTimes(1 + OPEN_LIBRARY_AUTHOR_DETAIL_BUDGET);
		if (result.status !== "record") throw new Error("Expected an Open Library record");
		expect(result.record.authorship.authors).toHaveLength(63);
		expect(result.record.authorship.authors[0]).toEqual({ kind: "literal", literal: "Name" });
		expect(result.record.authorship.authors[62]).toEqual({
			kind: "unresolved",
			position: 62,
			reference: "/authors/OL62A",
		});
		expect(result.record.authorship).toMatchObject({
			completeness: "partial",
			totalCountKnown: true,
		});
		expect(result.record.diagnostics).toEqual([
			"authors-incomplete",
			"author-detail-safety-budget-reached",
		]);
		if (result.status !== "record") throw new Error("Expected mapped edition");
		expect(result.record.authorship.authors).toHaveLength(63);
		expect(result.record.authorship.authors[50]).toEqual({
			kind: "unresolved",
			position: 50,
			reference: "/authors/OL50A",
		});
	});

	it("preserves failed Open Library author details as unresolved positions", async () => {
		request.mockResolvedValueOnce({
			status: 200,
			json: {
				title: "Partial",
				authors: [{ key: "/authors/OL1A" }, { key: "/authors/OL2A" }],
			},
		});
		request.mockResolvedValueOnce({ status: 200, json: { name: "Known Name" } });
		request.mockRejectedValueOnce(new Error("private transport detail"));
		const result = await lookupIsbn("9780306406157");
		expect(result).toMatchObject({
			status: "record",
			record: {
				authorship: {
					authors: [
						{ kind: "literal", literal: "Known Name" },
						{ kind: "unresolved", position: 1, reference: "/authors/OL2A" },
					],
					completeness: "partial",
				},
				diagnostics: ["authors-incomplete"],
			},
		});
		expect(JSON.stringify(result)).not.toContain("private transport detail");
	});

	it("uses bounded Crossref and Open Library fallback query contracts", async () => {
		request
			.mockResolvedValueOnce({
				status: 200,
				json: { message: { items: [{ title: ["A"], score: 9 }] } },
			})
			.mockResolvedValueOnce({ status: 200, json: { docs: [{ title: "B" }] } });
		await searchCrossrefBibliographic("title venue excerpt");
		await searchOpenLibrary("title venue excerpt");
		const crossref = new URL(request.mock.calls[0][0].url);
		expect(crossref.searchParams.get("query.bibliographic")).toBe("title venue excerpt");
		expect(crossref.searchParams.get("rows")).toBe("2");
		expect(crossref.searchParams.has("query.title")).toBe(false);
		const openLibrary = new URL(request.mock.calls[1][0].url);
		expect(openLibrary.searchParams.get("q")).toBe("title venue excerpt");
		expect(openLibrary.searchParams.get("fields")).toBe(
			"key,title,author_name,author_key,first_publish_year,isbn",
		);
		expect(openLibrary.searchParams.get("limit")).toBe("3");
	});
});
