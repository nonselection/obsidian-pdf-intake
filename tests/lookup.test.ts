import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "./obsidian";
import { extractDoi, extractIsbn } from "../src/lookup";
import { resolveBibliographicMetadata } from "../src/resolver";

vi.mock("../src/pdf-text", () => ({ extractTextForLookup: vi.fn() }));

const request = vi.mocked(requestUrl);

describe("identifier extraction", () => {
	it("extracts a DOI from ordinary DOI text", () => {
		expect(extractDoi("doi: 10.1234/example.567.")).toBe("10.1234/example.567");
	});

	it("extracts a DOI URL", () => {
		expect(extractDoi("https://doi.org/10.1234/example")).toBe("10.1234/example");
	});

	it("extracts ISBN-10 and ISBN-13", () => {
		expect(extractIsbn("ISBN-10: 0-306-40615-2")).toBe("0306406152");
		expect(extractIsbn("ISBN-13: 978-0-306-40615-7")).toBe("9780306406157");
	});

	it("rejects malformed identifiers", () => {
		expect(extractDoi("not a DOI: 10.123/example")).toBeNull();
		expect(extractIsbn("ISBN: 12345")).toBeNull();
	});
});

describe("shared bibliographic resolver", () => {
	beforeEach(() => request.mockReset());

	const file = { path: "Inbox/paper.pdf" } as never;
	const vault = { readBinary: vi.fn() } as never;

	it("prefers a DOI and resolves it through Crossref", async () => {
		request.mockResolvedValue({
			status: 200,
			json: {
				message: {
					title: ["Resolved title"],
					author: [{ given: "Ada", family: "Lovelace" }],
					published: { "date-parts": [[1843]] },
				},
			},
		});
		const { extractTextForLookup } = await import("../src/pdf-text");
		vi.mocked(extractTextForLookup).mockResolvedValue(
			"doi: 10.1234/example ISBN 9780306406157",
		);

		const result = await resolveBibliographicMetadata(file, vault);
		expect(result).toMatchObject({
			title: "Resolved title",
			firstAuthor: "Ada Lovelace",
			year: 1843,
			doi: "10.1234/example",
			source: "crossref",
			status: "resolved",
		});
		expect(request).toHaveBeenCalledTimes(1);
		expect(String(request.mock.calls[0][0].url)).toContain("api.crossref.org");
	});

	it("uses ISBN and Open Library when no DOI is present", async () => {
		request.mockResolvedValue({
			status: 200,
			json: { title: "Book title", publish_date: "1999" },
		});
		const { extractTextForLookup } = await import("../src/pdf-text");
		vi.mocked(extractTextForLookup).mockResolvedValue("ISBN-13: 9780306406157");

		const result = await resolveBibliographicMetadata(file, vault);
		expect(result).toMatchObject({
			title: "Book title",
			isbn: "9780306406157",
			year: 1999,
			source: "openlibrary",
			status: "resolved",
		});
		expect(String(request.mock.calls[0][0].url)).toContain("openlibrary.org/isbn/");
	});

	it("falls back to ISBN when Crossref lookup fails", async () => {
		request.mockResolvedValueOnce({ status: 404, json: {} }).mockResolvedValueOnce({
			status: 200,
			json: { title: "Fallback book", publish_date: "2001" },
		});
		const { extractTextForLookup } = await import("../src/pdf-text");
		vi.mocked(extractTextForLookup).mockResolvedValue("10.1234/missing ISBN 9780306406157");

		const result = await resolveBibliographicMetadata(file, vault);
		expect(result).toMatchObject({
			title: "Fallback book",
			source: "openlibrary",
			status: "resolved",
		});
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("resolves a manual replacement identifier through the shared provider path", async () => {
		request.mockResolvedValue({
			status: 200,
			json: { title: "Manual book", publish_date: "2005" },
		});
		const { extractTextForLookup } = await import("../src/pdf-text");
		vi.mocked(extractTextForLookup).mockClear();
		const result = await resolveBibliographicMetadata(file, vault, "ISBN 9780306406157");
		expect(result).toMatchObject({
			title: "Manual book",
			isbn: "9780306406157",
			source: "openlibrary",
			status: "resolved",
		});
		expect(extractTextForLookup).not.toHaveBeenCalled();
	});

	it("returns unresolved without identifiers or provider records", async () => {
		const { extractTextForLookup } = await import("../src/pdf-text");
		vi.mocked(extractTextForLookup).mockResolvedValue("ordinary text only");
		expect((await resolveBibliographicMetadata(file, vault)).status).toBe("unresolved");

		vi.mocked(extractTextForLookup).mockResolvedValue("doi: 10.1234/missing");
		request.mockResolvedValue({ status: 404, json: {} });
		expect((await resolveBibliographicMetadata(file, vault)).status).toBe("unresolved");
	});
});
