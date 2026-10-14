import { deriveAuthorship, type AuthorshipDiagnostic } from "./authorship";
import type { CanonicalBibliographicRecord } from "./types";

export interface FilenameFormatResult {
	filename: string | null;
	diagnostics: string[];
	blockedReason?: "missing-title" | "missing-authorship";
}

const LEGACY_FIELDS = new Set(["title", "author", "authors", "year", "journal", "publisher"]);

function parseLegacyTemplate(template: string): { valid: boolean; fields: string[] } {
	const fields: string[] = [];
	const withoutFields = template.replace(/\{([^{}]+)\}/g, (_match, field: string) => {
		fields.push(field);
		return "";
	});
	if (/[{}]/.test(withoutFields) || fields.some((field) => !LEGACY_FIELDS.has(field))) {
		return { valid: false, fields };
	}
	return { valid: true, fields };
}

const TEMPLATE_SAMPLE: CanonicalBibliographicRecord = {
	title: "Example Title",
	authorship: {
		authors: [
			{ kind: "person", family: "Tesar" },
			{ kind: "person", family: "Chilisa" },
		],
		completeness: "complete",
		totalCountKnown: true,
	},
	year: 2023,
	isbns: [],
	journal: "Example Journal",
	publisher: "Example Publisher",
	provenance: { provider: "crossref", route: "doi", identifier: "10.1234/example" },
};

export function sanitizePdfFilename(value: string): string | null {
	const base = value
		.replace(/\.pdf$/i, "")
		// eslint-disable-next-line no-control-regex
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
		.replace(/\s+/g, " ")
		.replace(/\s*-\s*(?=-|$)/g, "")
		.replace(/[. ]+$/g, "")
		.trim()
		.replace(/^[. ]+/g, "")
		.slice(0, 180)
		.trim();
	if (!base) return null;
	const safeBase = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base) ? `_${base}` : base;
	return `${safeBase}.pdf`;
}

function diagnosticsText(diagnostics: AuthorshipDiagnostic[]): string[] {
	return diagnostics.map((diagnostic) => diagnostic.message);
}

export function formatLegacyTemplate(
	recordValue: CanonicalBibliographicRecord,
	template: string,
): FilenameFormatResult {
	const parsed = parseLegacyTemplate(template);
	if (!parsed.valid) {
		return {
			filename: null,
			diagnostics: ["Filename template contains unsupported or unbalanced fields"],
		};
	}
	if (!recordValue.title?.trim()) {
		return {
			filename: null,
			diagnostics: ["A title is required for the current rename preview"],
			blockedReason: "missing-title",
		};
	}
	const values: Record<string, string> = {
		title: recordValue.title,
		year: recordValue.year?.toString() ?? "",
		journal: recordValue.journal ?? "",
		publisher: recordValue.publisher ?? "",
		author: "",
		authors: "",
	};
	const diagnostics: string[] = [];
	if (parsed.fields.includes("author")) {
		const author = deriveAuthorship(recordValue.authorship, {
			selection: "first",
			nameStyle: "full",
			etAl: "never",
			nameOrder: "given-family",
			separator: ", ",
		});
		diagnostics.push(...diagnosticsText(author.diagnostics));
		if (!author.value) {
			return {
				filename: null,
				diagnostics: [...diagnostics, "The template requires a known first author"],
				blockedReason: "missing-authorship",
			};
		}
		values.author = author.value;
	}
	if (parsed.fields.includes("authors")) {
		const authors = deriveAuthorship(recordValue.authorship, {
			selection: "all",
			nameStyle: "full",
			etAl: "never",
			nameOrder: "given-family",
			separator: ", ",
		});
		diagnostics.push(...diagnosticsText(authors.diagnostics));
		if (!authors.value) {
			return {
				filename: null,
				diagnostics: [...diagnostics, "The template requires a complete author list"],
				blockedReason: "missing-authorship",
			};
		}
		values.authors = authors.value;
	}
	const expanded = template.replace(
		/\{([^{}]+)\}/g,
		(_match, field: string) => values[field] ?? "",
	);
	const filename = sanitizePdfFilename(expanded);
	return {
		filename,
		diagnostics: filename
			? diagnostics
			: [...diagnostics, "Filename template produces an empty filename"],
		...(filename ? {} : { blockedReason: "missing-title" as const }),
	};
}

export function isUsableLegacyTemplate(template: string): boolean {
	if (typeof template !== "string" || !template.trim()) return false;
	const parsed = parseLegacyTemplate(template);
	if (!parsed.valid) return false;
	return formatLegacyTemplate(TEMPLATE_SAMPLE, template).filename !== null;
}
