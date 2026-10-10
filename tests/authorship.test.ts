import { describe, expect, it } from "vitest";
import { deriveAuthorship } from "../src/authorship";
import { formatFilename } from "../src/planning";
import {
	createFactoryConfiguration,
	type CanonicalAuthorship,
	type CanonicalBibliographicRecord,
} from "../src/types";

function auth(
	authors: CanonicalAuthorship["authors"],
	overrides: Partial<CanonicalAuthorship> = {},
): CanonicalAuthorship {
	return {
		authors,
		completeness: "complete",
		totalCountKnown: true,
		...overrides,
	};
}

function record(
	authorship: CanonicalAuthorship,
	overrides: Partial<CanonicalBibliographicRecord> = {},
): CanonicalBibliographicRecord {
	return {
		title: "Example Title",
		year: 2023,
		authorship,
		isbns: [],
		provenance: { provider: "crossref", route: "doi", identifier: "10.1234/test" },
		...overrides,
	};
}

describe("canonical authorship and filename representations", () => {
	it("renders the citation-style factory examples in provider order", () => {
		const format = createFactoryConfiguration().metadataAndNaming.filenameFormat;
		expect(
			formatFilename(
				record(auth([{ kind: "person", given: "Jana", family: "Tesar" }])),
				format,
			).filename,
		).toBe("Tesar (2023). Example Title.pdf");
		expect(
			formatFilename(
				record(
					auth([
						{ kind: "person", family: "Chilisa" },
						{ kind: "person", family: "Khumalo" },
					]),
					{
						title: "Decolonizing and Indigenizing Evaluation Practice in Africa",
						year: 2016,
					},
				),
				format,
			).filename,
		).toBe(
			"Chilisa et al. (2016). Decolonizing and Indigenizing Evaluation Practice in Africa.pdf",
		);
	});

	it("keeps seven canonical authors when deriving a shortened filename", () => {
		const authors = Array.from({ length: 7 }, (_, index) => ({
			kind: "person" as const,
			family: `Family${index + 1}`,
		}));
		const canonical = auth(authors);
		const before = JSON.stringify(canonical);
		const result = deriveAuthorship(canonical, {
			selection: "first",
			nameStyle: "family",
			etAl: "conditional",
			nameOrder: "given-family",
			separator: ", ",
		});
		expect(result.value).toBe("Family1 et al.");
		expect(canonical.authors).toHaveLength(7);
		expect(JSON.stringify(canonical)).toBe(before);
	});

	it("preserves supplied compound, particle and accented family names", () => {
		const canonical = auth([
			{ kind: "person", given: "Amina", family: "de la Cruz" },
			{ kind: "person", given: "Zoë", family: "Dvořák" },
		]);
		const result = deriveAuthorship(canonical, {
			selection: "first",
			nameStyle: "family",
			etAl: "never",
			nameOrder: "given-family",
			separator: "; ",
		});
		expect(result.value).toBe("de la Cruz");
		expect(canonical.authors[1]).toEqual({ kind: "person", given: "Zoë", family: "Dvořák" });
	});

	it("trims harmless family-name edges while preserving internal whitespace and diacritics", () => {
		const result = deriveAuthorship(
			auth([{ kind: "person", given: " Zoë ", family: "  de  la Dvořák  " }]),
			{
				selection: "first",
				nameStyle: "family",
				etAl: "never",
				nameOrder: "given-family",
				separator: ", ",
			},
		);
		expect(result).toEqual({ value: "de  la Dvořák", diagnostics: [] });
	});

	it("treats a whitespace-only family as unavailable and uses only a diagnosed literal fallback", () => {
		const format = createFactoryConfiguration().metadataAndNaming.filenameFormat;
		const withLiteral = record(
			auth([
				{
					kind: "person",
					family: "   ",
					literal: "  Bagele Chilisa  ",
				},
			]),
		);
		const fallback = formatFilename(withLiteral, format);
		expect(fallback.filename).toBe("Bagele Chilisa (2023). Example Title.pdf");
		expect(fallback.diagnostics).toContain(
			"Author 1 has no supplied family name; supplied text is retained literally",
		);

		const withoutFallback = record(
			auth([
				{
					kind: "person",
					family: " \t ",
					given: "   ",
					literal: "  ",
				},
			]),
		);
		const unavailable = deriveAuthorship(withoutFallback.authorship, {
			selection: "first",
			nameStyle: "family",
			etAl: "conditional",
			nameOrder: "given-family",
			separator: ", ",
		});
		expect(unavailable.value).toBeNull();
		expect(unavailable.diagnostics).toMatchObject([{ code: "missing-author" }]);
		expect(formatFilename(withoutFallback, format)).toMatchObject({
			filename: null,
			blockedReason: "missing-authorship",
		});
		expect(formatFilename(withoutFallback, format).diagnostics[0]).toBe(
			"Author 1 has no supplied family name or literal",
		);
	});

	it("uses an unstructured name literally and diagnoses the conservative fallback", () => {
		const result = deriveAuthorship(auth([{ kind: "literal", literal: "Bagele Chilisa" }]), {
			selection: "first",
			nameStyle: "family",
			etAl: "never",
			nameOrder: "given-family",
			separator: ", ",
		});
		expect(result.value).toBe("Bagele Chilisa");
		expect(result.diagnostics[0]?.code).toBe("literal-fallback");
	});

	it("keeps an organization literal rather than splitting it into a person", () => {
		const result = deriveAuthorship(
			auth([{ kind: "organization", literal: "International Evaluation Office" }]),
			{
				selection: "first",
				nameStyle: "family",
				etAl: "never",
				nameOrder: "given-family",
				separator: ", ",
			},
		);
		expect(result.value).toBe("International Evaluation Office");
		expect(result.diagnostics[0]?.code).toBe("literal-fallback");
	});

	it("blocks an unresolved first position instead of promoting a later author", () => {
		const authorship = auth([
			{ kind: "unresolved", position: 0, reference: "provider-ref-1" },
			{ kind: "person", family: "Later" },
		]);
		const result = deriveAuthorship(authorship, {
			selection: "first",
			nameStyle: "family",
			etAl: "conditional",
			nameOrder: "given-family",
			separator: ", ",
		});
		expect(result.value).toBeNull();
		expect(result.diagnostics[0]?.code).toBe("unresolved-author");
		expect(authorship.authors).toHaveLength(2);
	});

	it("requires known cardinality for conditional et al. and preserves unresolved later positions", () => {
		const unknownCount = deriveAuthorship(
			auth([{ kind: "person", family: "Tesar" }], {
				totalCountKnown: false,
				completeness: "unknown",
			}),
			{
				selection: "first",
				nameStyle: "family",
				etAl: "conditional",
				nameOrder: "given-family",
				separator: ", ",
			},
		);
		expect(unknownCount.value).toBeNull();
		expect(unknownCount.diagnostics[0]?.code).toBe("unknown-author-count");
		const knownList = auth(
			[
				{ kind: "person", family: "Tesar" },
				{ kind: "unresolved", position: 1 },
			],
			{ completeness: "partial", totalCountKnown: true },
		);
		expect(
			deriveAuthorship(knownList, {
				selection: "first",
				nameStyle: "family",
				etAl: "conditional",
				nameOrder: "given-family",
				separator: ", ",
			}).value,
		).toBe("Tesar et al.");
		expect(knownList.authors).toHaveLength(2);
	});

	it("omits an unavailable year group and blocks missing required title", () => {
		const format = createFactoryConfiguration().metadataAndNaming.filenameFormat;
		expect(
			formatFilename(
				record(auth([{ kind: "person", family: "Tesar" }]), { year: undefined }),
				format,
			).filename,
		).toBe("Tesar. Example Title.pdf");
		expect(
			formatFilename(
				record(auth([{ kind: "person", family: "Tesar" }]), { title: undefined }),
				format,
			).filename,
		).toBeNull();
	});

	it("supports parameterized first/all and name ordering while reporting deferred abbreviations", () => {
		const authorship = auth([
			{ kind: "person", given: "Ada", family: "Lovelace" },
			{ kind: "person", given: "Grace", family: "Hopper" },
		]);
		const base = {
			nameStyle: "full" as const,
			etAl: "never" as const,
			nameOrder: "family-given" as const,
			separator: "; ",
		};
		expect(deriveAuthorship(authorship, { ...base, selection: "all" }).value).toBe(
			"Lovelace Ada; Hopper Grace",
		);
		const unavailable = deriveAuthorship(authorship, {
			...base,
			selection: "first",
			nameStyle: "abbreviated-given",
		});
		expect(unavailable.value).toBeNull();
		expect(unavailable.diagnostics[0]?.code).toBe("unsupported-style");
	});

	it("keeps valid legacy templates exact and separates their full-name output from the factory", () => {
		const canonical = record(
			auth([
				{ kind: "person", given: "Jana", family: "Tesar" },
				{ kind: "person", given: "Bagele", family: "Chilisa" },
			]),
		);
		const legacy = {
			kind: "legacy-template" as const,
			template: "{author} - {year} - {title}",
		};
		const factory = createFactoryConfiguration().metadataAndNaming.filenameFormat;
		expect(legacy.template).toBe("{author} - {year} - {title}");
		expect(formatFilename(canonical, legacy).filename).toBe(
			"Jana Tesar - 2023 - Example Title.pdf",
		);
		expect(formatFilename(canonical, factory).filename).toBe(
			"Tesar et al. (2023). Example Title.pdf",
		);
	});
});
