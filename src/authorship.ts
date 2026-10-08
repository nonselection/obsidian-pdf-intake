import type { AuthorshipPresentation, CanonicalAuthor, CanonicalAuthorship } from "./types";

export type AuthorshipDiagnostic =
	| { code: "literal-fallback"; position: number; message: string }
	| { code: "missing-author"; message: string }
	| { code: "unresolved-author"; position: number; message: string }
	| { code: "unknown-author-count"; message: string }
	| { code: "unsupported-style"; message: string };

export interface AuthorshipDerivation {
	value: string | null;
	diagnostics: AuthorshipDiagnostic[];
}

function usableNamePart(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function authorText(
	author: CanonicalAuthor,
	style: AuthorshipPresentation["nameStyle"],
	order: AuthorshipPresentation["nameOrder"],
	position: number,
	diagnostics: AuthorshipDiagnostic[],
): string | null {
	if (author.kind === "unresolved") {
		diagnostics.push({
			code: "unresolved-author",
			position,
			message: `Author ${position + 1} is unresolved`,
		});
		return null;
	}

	if (author.kind === "organization" || author.kind === "literal") {
		const literal = usableNamePart(author.literal);
		if (!literal) {
			diagnostics.push({
				code: "missing-author",
				message: `Author ${position + 1} has no usable supplied name`,
			});
			return null;
		}
		if (style === "family") {
			diagnostics.push({
				code: "literal-fallback",
				position,
				message: `Author ${position + 1} is retained as a literal; no family name was inferred`,
			});
		}
		return literal;
	}

	if (style === "abbreviated-given") {
		diagnostics.push({
			code: "unsupported-style",
			message: "Abbreviated-given rendering is reserved but unavailable in this slice",
		});
		return null;
	}

	if (style === "family") {
		const family = usableNamePart(author.family);
		if (family) return family;
		const suppliedLiteral = usableNamePart(author.literal) ?? usableNamePart(author.given);
		if (!suppliedLiteral) {
			diagnostics.push({
				code: "missing-author",
				message: `Author ${position + 1} has no supplied family name or literal`,
			});
			return null;
		}
		diagnostics.push({
			code: "literal-fallback",
			position,
			message: `Author ${position + 1} has no supplied family name; supplied text is retained literally`,
		});
		return suppliedLiteral;
	}

	const literal = usableNamePart(author.literal);
	if (literal) {
		diagnostics.push({
			code: "literal-fallback",
			position,
			message: `Author ${position + 1} is retained as supplied; no name parts were inferred`,
		});
		return literal;
	}

	const given = usableNamePart(author.given);
	const family = usableNamePart(author.family);
	if (!given && !family) {
		diagnostics.push({
			code: "missing-author",
			message: `Author ${position + 1} has no usable supplied name`,
		});
		return null;
	}
	if (!given || !family) return given || family || null;
	return order === "family-given" ? `${family} ${given}` : `${given} ${family}`;
}

/** Derive an output-specific representation without changing canonical authorship. */
export function deriveAuthorship(
	authorship: CanonicalAuthorship,
	presentation: AuthorshipPresentation,
): AuthorshipDerivation {
	const diagnostics: AuthorshipDiagnostic[] = [];
	if (authorship.authors.length === 0) {
		return {
			value: null,
			diagnostics: [{ code: "missing-author", message: "No authors were supplied" }],
		};
	}
	if (presentation.selection === "all" && authorship.completeness !== "complete") {
		return {
			value: null,
			diagnostics: [
				{ code: "unknown-author-count", message: "The complete author list is not known" },
			],
		};
	}
	if (presentation.etAl === "conditional" && !authorship.totalCountKnown) {
		return {
			value: null,
			diagnostics: [
				{ code: "unknown-author-count", message: "The author count is not known" },
			],
		};
	}

	const selected =
		presentation.selection === "first" ? authorship.authors.slice(0, 1) : authorship.authors;
	const rendered: string[] = [];
	for (const [index, author] of selected.entries()) {
		const text = authorText(
			author,
			presentation.nameStyle,
			presentation.nameOrder,
			index,
			diagnostics,
		);
		if (text === null) return { value: null, diagnostics };
		rendered.push(text);
	}
	if (rendered.length === 0) {
		return {
			value: null,
			diagnostics: [{ code: "missing-author", message: "No authors were supplied" }],
		};
	}

	let value = rendered.join(presentation.separator);
	if (presentation.selection === "first" && presentation.etAl === "conditional") {
		if (!authorship.totalCountKnown) {
			return {
				value: null,
				diagnostics: [
					{ code: "unknown-author-count", message: "The author count is not known" },
				],
			};
		}
		if (authorship.authors.length > 1) value += " et al.";
	}
	return { value, diagnostics };
}
