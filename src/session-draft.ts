import type { RenameApplyOutcome } from "./apply-changes";
import { normalizeDoi, normalizeIsbn } from "./lookup";
import type { IdentificationState, SourceObservation } from "./planning";
import type { IntakeSession, SessionPdf } from "./session";
import type {
	CanonicalAuthor,
	CanonicalAuthorship,
	CanonicalBibliographicRecord,
	CandidateReference,
	FilenameComponent,
	IdentificationEvidence,
	IdentifierCandidateEvidence,
	IdentificationRunSummary,
	LookupRoute,
	LookupSource,
	PendingInspectorForm,
	PersistedApplySummary,
	ProviderAttemptEvidence,
	ProviderBibliographicRecord,
	RepairEvidence,
	SessionConfiguration,
	UserRecordDecision,
} from "./types";

export type DraftApplySummary = PersistedApplySummary;

export type DraftIdentifierEvidence = Omit<IdentifierCandidateEvidence, "rawText">;

export interface DraftIdentificationEvidence extends Omit<
	IdentificationEvidence,
	"identifiers" | "queryContext"
> {
	identifiers: readonly DraftIdentifierEvidence[];
}

export type DraftIdentificationState =
	| { status: "unattempted" }
	| {
			status: "resolved";
			record: CanonicalBibliographicRecord;
			evidence?: DraftIdentificationEvidence;
	  }
	| { status: "needs-user"; reason: string; evidence?: DraftIdentificationEvidence };

export interface SessionDraftItemV1 {
	id: string;
	admissionObservation: SourceObservation;
	sourceObservation: SourceObservation;
	identification: DraftIdentificationState;
	acceptedMachineRecord?: CanonicalBibliographicRecord;
	recordDecision?: UserRecordDecision;
	disposition?: "left-unresolved";
	repairEvidence?: RepairEvidence[];
	identificationHistory?: IdentificationRunSummary[];
	lastApplySummary?: DraftApplySummary;
}

export interface SessionDraftV1 {
	draftVersion: 1;
	draftId: string;
	savedAt: string;
	phase: IntakeSession["phase"];
	setupOpen: boolean;
	setupConcern: IntakeSession["setupConcern"];
	configuration: SessionConfiguration;
	items: SessionDraftItemV1[];
	pendingInspectorForm?: PendingInspectorForm;
	recoveryDiagnostics: string[];
}

export type SessionDraftDecodeResult =
	| { status: "none" }
	| { status: "supported"; draft: SessionDraftV1 }
	| { status: "unavailable"; reason: "malformed" | "unsupported-future" };

const LOOKUP_SOURCES = new Set<LookupSource>(["crossref", "openlibrary"]);
const LOOKUP_ROUTES = new Set<LookupRoute>([
	"doi",
	"isbn",
	"bibliographic-query",
	"openlibrary-search",
]);
const IDENTIFICATION_OUTCOMES = new Set([
	"no-record",
	"request-failed",
	"title-mismatch",
	"corroborated",
	"ambiguous",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Reflect.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const accepted = new Set(allowed);
	return Object.keys(value).every((key) => accepted.has(key));
}

function string(value: unknown, max = 2000): value is string {
	return typeof value === "string" && value.length <= max;
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function integerArray(value: unknown): value is number[] {
	return Array.isArray(value) && value.every((entry: unknown) => Number.isInteger(entry));
}

function relativePath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!value.startsWith("/") &&
		!value.includes("\\") &&
		value.split("/").every((part) => part && part !== "." && part !== "..")
	);
}

function sourceObservation(value: unknown): value is SourceObservation {
	return (
		isRecord(value) &&
		onlyKeys(value, ["path", "mtime", "size"]) &&
		relativePath(value.path) &&
		finite(value.mtime) &&
		finite(value.size) &&
		value.size >= 0
	);
}

function author(value: unknown): CanonicalAuthor | undefined {
	if (!isRecord(value)) return undefined;
	if (value.kind === "person") {
		if (
			(value.given !== undefined && !string(value.given)) ||
			(value.family !== undefined && !string(value.family)) ||
			(value.literal !== undefined && !string(value.literal))
		)
			return undefined;
		return {
			kind: "person",
			...(value.given !== undefined ? { given: value.given } : {}),
			...(value.family !== undefined ? { family: value.family } : {}),
			...(value.literal !== undefined ? { literal: value.literal } : {}),
		};
	}
	if (value.kind === "organization" || value.kind === "literal") {
		return string(value.literal) ? { kind: value.kind, literal: value.literal } : undefined;
	}
	if (
		value.kind === "unresolved" &&
		Number.isInteger(value.position) &&
		(value.reference === undefined || string(value.reference))
	) {
		return {
			kind: "unresolved",
			position: value.position as number,
			...(value.reference !== undefined ? { reference: value.reference } : {}),
		};
	}
	return undefined;
}

function authorship(value: unknown): CanonicalAuthorship | undefined {
	if (
		!isRecord(value) ||
		!Array.isArray(value.authors) ||
		!(["complete", "partial", "unknown"] as unknown[]).includes(value.completeness) ||
		typeof value.totalCountKnown !== "boolean"
	)
		return undefined;
	const authors = value.authors.map(author);
	if (authors.some((entry) => entry === undefined)) return undefined;
	const result = {
		authors: authors as CanonicalAuthor[],
		completeness: value.completeness as CanonicalAuthorship["completeness"],
		totalCountKnown: value.totalCountKnown,
	};
	if (
		result.completeness === "complete" &&
		result.authors.some((entry) => entry.kind === "unresolved")
	) {
		return { ...result, completeness: "partial" };
	}
	if (result.completeness === "complete" && !result.totalCountKnown) {
		return { ...result, completeness: "unknown" };
	}
	return result;
}

function candidateReference(value: unknown): CandidateReference | undefined {
	if (
		!isRecord(value) ||
		!LOOKUP_SOURCES.has(value.provider as LookupSource) ||
		!LOOKUP_ROUTES.has(value.route as LookupRoute) ||
		(value.lookupValue !== undefined && !string(value.lookupValue)) ||
		(value.candidateTitle !== undefined && !string(value.candidateTitle))
	)
		return undefined;
	const direct = value.route === "doi" || value.route === "isbn";
	return {
		provider: value.provider as LookupSource,
		route: value.route as LookupRoute,
		lookupValue: direct && typeof value.lookupValue === "string" ? value.lookupValue : "",
	};
}

function provenance(value: unknown): CanonicalBibliographicRecord["provenance"] | undefined {
	if (!isRecord(value)) return undefined;
	if (value.kind === "user-edited") {
		if (value.basedOn === undefined) return { kind: "user-edited" };
		const basedOn = candidateReference(value.basedOn);
		return basedOn ? { kind: "user-edited", basedOn } : undefined;
	}
	if (
		!LOOKUP_SOURCES.has(value.provider as LookupSource) ||
		!LOOKUP_ROUTES.has(value.route as LookupRoute) ||
		(value.identifier !== undefined && !string(value.identifier)) ||
		(value.query !== undefined && !string(value.query))
	)
		return undefined;
	const direct = value.route === "doi" || value.route === "isbn";
	return {
		provider: value.provider as LookupSource,
		route: value.route as LookupRoute,
		...(direct && typeof value.identifier === "string" ? { identifier: value.identifier } : {}),
	};
}

function publicationDate(
	value: unknown,
): CanonicalBibliographicRecord["publicationDate"] | undefined {
	if (!isRecord(value)) return undefined;
	if (
		value.provider === "crossref" &&
		["published", "published-print", "published-online", "issued"].includes(
			String(value.source),
		) &&
		integerArray(value.dateParts)
	) {
		return {
			provider: "crossref",
			source: value.source as "published" | "published-print" | "published-online" | "issued",
			dateParts: [...value.dateParts],
		};
	}
	if (value.provider === "openlibrary" && value.source === "publish-date" && string(value.text)) {
		return { provider: "openlibrary", source: "publish-date", text: value.text };
	}
	return undefined;
}

function bibliographicRecord(value: unknown): CanonicalBibliographicRecord | undefined {
	if (
		!isRecord(value) ||
		(value.title !== undefined && !string(value.title)) ||
		(value.year !== undefined && (!Number.isInteger(value.year) || !finite(value.year))) ||
		(value.doi !== undefined && !string(value.doi)) ||
		!Array.isArray(value.isbns) ||
		!value.isbns.every((entry) => string(entry)) ||
		(value.journal !== undefined && !string(value.journal)) ||
		(value.publisher !== undefined && !string(value.publisher))
	)
		return undefined;
	const authors = authorship(value.authorship);
	const recordProvenance = provenance(value.provenance);
	const date =
		value.publicationDate === undefined ? undefined : publicationDate(value.publicationDate);
	if (!authors || !recordProvenance || (value.publicationDate !== undefined && !date))
		return undefined;
	return {
		...(typeof value.title === "string" ? { title: value.title } : {}),
		authorship: authors,
		...(typeof value.year === "number" ? { year: value.year } : {}),
		...(date ? { publicationDate: date } : {}),
		...(typeof value.doi === "string" ? { doi: value.doi } : {}),
		isbns: [...value.isbns] as string[],
		...(typeof value.journal === "string" ? { journal: value.journal } : {}),
		...(typeof value.publisher === "string" ? { publisher: value.publisher } : {}),
		provenance: recordProvenance,
	};
}

function providerRecord(value: unknown): ProviderBibliographicRecord | undefined {
	if (
		!isRecord(value) ||
		!LOOKUP_SOURCES.has(value.provider as LookupSource) ||
		!Array.isArray(value.diagnostics)
	)
		return undefined;
	const {
		provider: _provider,
		diagnostics: _diagnostics,
		provenance: _provenance,
		...fields
	} = value;
	const record = bibliographicRecord({
		...fields,
		provenance: { provider: value.provider, route: "doi" },
	});
	if (!record) return undefined;
	return {
		provider: value.provider as LookupSource,
		title: record.title,
		authorship: record.authorship,
		...(record.year !== undefined ? { year: record.year } : {}),
		...(record.publicationDate !== undefined
			? { publicationDate: record.publicationDate }
			: {}),
		...(record.doi !== undefined ? { doi: record.doi } : {}),
		isbns: record.isbns,
		...(record.journal !== undefined ? { journal: record.journal } : {}),
		...(record.publisher !== undefined ? { publisher: record.publisher } : {}),
		diagnostics: value.diagnostics
			.filter((entry): entry is string => string(entry, 120))
			.slice(0, 24),
	};
}

function attempt(value: unknown): ProviderAttemptEvidence | undefined {
	if (
		!isRecord(value) ||
		!LOOKUP_SOURCES.has(value.provider as LookupSource) ||
		!LOOKUP_ROUTES.has(value.route as LookupRoute) ||
		!string(value.lookupValue) ||
		!IDENTIFICATION_OUTCOMES.has(value.outcome as string) ||
		(value.providerTitle !== undefined && !string(value.providerTitle)) ||
		(value.matchedTitleCandidate !== undefined && !string(value.matchedTitleCandidate)) ||
		(value.score !== undefined && !finite(value.score))
	)
		return undefined;
	const candidate =
		value.candidateRecord === undefined ? undefined : providerRecord(value.candidateRecord);
	if (value.candidateRecord !== undefined && !candidate) return undefined;
	const direct = value.route === "doi" || value.route === "isbn";
	return {
		provider: value.provider as LookupSource,
		route: value.route as LookupRoute,
		lookupValue: direct ? value.lookupValue : "",
		outcome: value.outcome as ProviderAttemptEvidence["outcome"],
		...(typeof value.providerTitle === "string"
			? { providerTitle: value.providerTitle.slice(0, 200) }
			: {}),
		...(typeof value.matchedTitleCandidate === "string"
			? { matchedTitleCandidate: value.matchedTitleCandidate.slice(0, 200) }
			: {}),
		...(typeof value.score === "number" ? { score: value.score } : {}),
		...(Array.isArray(value.diagnostics)
			? {
					diagnostics: value.diagnostics
						.filter((entry): entry is string => string(entry, 120))
						.slice(0, 24),
				}
			: {}),
		...(candidate ? { candidateRecord: candidate } : {}),
	};
}

function identificationEvidence(value: unknown): DraftIdentificationEvidence | undefined {
	if (
		!isRecord(value) ||
		!onlyKeys(value, ["identifiers", "attempts", "titleCandidates", "diagnostics"]) ||
		!Array.isArray(value.identifiers) ||
		!Array.isArray(value.attempts) ||
		!Array.isArray(value.titleCandidates) ||
		!Array.isArray(value.diagnostics)
	)
		return undefined;
	const identifiers = value.identifiers.map((entry) => {
		if (
			!isRecord(entry) ||
			!onlyKeys(entry, [
				"type",
				"normalizedValue",
				"valid",
				"pageNumber",
				"textOffset",
				"labeled",
			]) ||
			(entry.type !== "doi" && entry.type !== "isbn") ||
			(entry.normalizedValue !== undefined && !string(entry.normalizedValue, 240)) ||
			typeof entry.valid !== "boolean" ||
			!Number.isInteger(entry.pageNumber) ||
			!Number.isInteger(entry.textOffset) ||
			typeof entry.labeled !== "boolean"
		)
			return undefined;
		const normalizedValue = entry.normalizedValue;
		if (
			(typeof normalizedValue === "string" &&
				(entry.type === "doi"
					? normalizeDoi(normalizedValue) !== normalizedValue
					: normalizeIsbn(normalizedValue) !== normalizedValue)) ||
			(entry.valid && typeof normalizedValue !== "string")
		)
			return undefined;
		return {
			type: entry.type,
			...(typeof normalizedValue === "string" ? { normalizedValue } : {}),
			valid: entry.valid,
			pageNumber: entry.pageNumber as number,
			textOffset: entry.textOffset as number,
			labeled: entry.labeled,
		};
	});
	const attempts = value.attempts.map(attempt);
	if (
		identifiers.some((entry) => entry === undefined) ||
		attempts.some((entry) => entry === undefined)
	)
		return undefined;
	return {
		identifiers: (identifiers as DraftIdentificationEvidence["identifiers"]).slice(0, 64),
		attempts: (attempts as ProviderAttemptEvidence[]).slice(0, 24),
		titleCandidates: value.titleCandidates
			.filter((entry): entry is string => string(entry, 200))
			.slice(0, 5),
		diagnostics: value.diagnostics
			.filter((entry): entry is string => string(entry, 120))
			.slice(0, 24),
	};
}

function identification(value: unknown): DraftIdentificationState | undefined {
	if (!isRecord(value) || typeof value.status !== "string") return undefined;
	if (value.status === "unattempted" || value.status === "identifying")
		return { status: "unattempted" };
	if (value.status === "resolved") {
		const record = bibliographicRecord(value.record);
		const evidence =
			value.evidence === undefined ? undefined : identificationEvidence(value.evidence);
		if (!record || (value.evidence !== undefined && !evidence)) return undefined;
		return { status: "resolved", record, ...(evidence ? { evidence } : {}) };
	}
	if (value.status === "needs-user" && string(value.reason)) {
		const evidence =
			value.evidence === undefined ? undefined : identificationEvidence(value.evidence);
		if (value.evidence !== undefined && !evidence) return undefined;
		return {
			status: "needs-user",
			reason: value.reason.slice(0, 500),
			...(evidence ? { evidence } : {}),
		};
	}
	return undefined;
}

function userDecision(value: unknown): UserRecordDecision | undefined {
	if (!isRecord(value)) return undefined;
	const record = bibliographicRecord(value.record);
	if (!record) return undefined;
	if (value.kind === "selected-candidate") {
		const candidate = candidateReference(value.candidate);
		return candidate ? { kind: "selected-candidate", record, candidate } : undefined;
	}
	if (value.kind === "user-edited-record") {
		if (value.basedOn === undefined) return { kind: "user-edited-record", record };
		const basedOn = candidateReference(value.basedOn);
		return basedOn ? { kind: "user-edited-record", record, basedOn } : undefined;
	}
	return undefined;
}

function repairEvidence(value: unknown): RepairEvidence | undefined {
	if (
		!isRecord(value) ||
		(value.type !== "doi" && value.type !== "isbn") ||
		!string(value.identifier, 240) ||
		!LOOKUP_SOURCES.has(value.provider as LookupSource) ||
		!LOOKUP_ROUTES.has(value.route as LookupRoute) ||
		(value.outcome !== "candidate" &&
			value.outcome !== "no-record" &&
			value.outcome !== "request-failed") ||
		(value.conflictingTitle !== undefined && !string(value.conflictingTitle)) ||
		(value.decision !== undefined &&
			value.decision !== "accepted" &&
			value.decision !== "rejected")
	)
		return undefined;
	const record =
		value.candidateRecord === undefined
			? undefined
			: bibliographicRecord(value.candidateRecord);
	if ((value.outcome === "candidate") !== !!record) return undefined;
	return {
		type: value.type,
		identifier: value.identifier,
		provider: value.provider as LookupSource,
		route: value.route as LookupRoute,
		outcome: value.outcome,
		...(record ? { candidateRecord: record } : {}),
		...(typeof value.conflictingTitle === "string"
			? { conflictingTitle: value.conflictingTitle.slice(0, 200) }
			: {}),
		...(value.decision ? { decision: value.decision } : {}),
	};
}

function runSummary(value: unknown): IdentificationRunSummary | undefined {
	if (
		!isRecord(value) ||
		(value.status !== "accepted" && value.status !== "needs-you") ||
		!Array.isArray(value.attempts) ||
		(value.titleCandidates !== undefined && !Array.isArray(value.titleCandidates))
	)
		return undefined;
	const attempts = value.attempts.map((entry) => {
		if (
			!isRecord(entry) ||
			!LOOKUP_SOURCES.has(entry.provider as LookupSource) ||
			!LOOKUP_ROUTES.has(entry.route as LookupRoute) ||
			!string(entry.lookupValue) ||
			!IDENTIFICATION_OUTCOMES.has(entry.outcome as string) ||
			(entry.providerTitle !== undefined && !string(entry.providerTitle))
		)
			return undefined;
		const direct = entry.route === "doi" || entry.route === "isbn";
		return {
			provider: entry.provider as LookupSource,
			route: entry.route as LookupRoute,
			lookupValue: direct ? entry.lookupValue : "",
			outcome: entry.outcome as ProviderAttemptEvidence["outcome"],
			...(typeof entry.providerTitle === "string"
				? { providerTitle: entry.providerTitle.slice(0, 200) }
				: {}),
		};
	});
	if (attempts.some((entry) => entry === undefined)) return undefined;
	return {
		status: value.status,
		...(typeof value.reason === "string" ? { reason: value.reason.slice(0, 500) } : {}),
		...(Array.isArray(value.titleCandidates)
			? {
					titleCandidates: value.titleCandidates
						.filter((entry): entry is string => string(entry, 200))
						.slice(0, 3),
				}
			: {}),
		attempts: (attempts as IdentificationRunSummary["attempts"]).slice(0, 12),
	};
}

function pendingForm(value: unknown): PendingInspectorForm | undefined {
	if (
		!isRecord(value) ||
		typeof value.itemId !== "string" ||
		value.unsaved !== true ||
		!isRecord(value.values)
	)
		return undefined;
	const fields = value.values;
	const authors = Array.isArray(fields.authors) ? fields.authors.map(author) : [];
	if (
		!string(fields.title) ||
		!string(fields.year) ||
		!string(fields.doi) ||
		!Array.isArray(fields.isbns) ||
		!fields.isbns.every((entry) => string(entry)) ||
		!string(fields.journal) ||
		!string(fields.publisher) ||
		!Array.isArray(fields.authors) ||
		authors.some((entry) => entry === undefined) ||
		!(["complete", "partial", "unknown"] as unknown[]).includes(
			fields.authorshipCompleteness,
		) ||
		typeof fields.totalCountKnown !== "boolean"
	)
		return undefined;
	const safeAuthorship = authorship({
		authors: authors as CanonicalAuthor[],
		completeness: fields.authorshipCompleteness as CanonicalAuthorship["completeness"],
		totalCountKnown: fields.totalCountKnown,
	});
	if (!safeAuthorship) return undefined;
	return {
		itemId: value.itemId,
		unsaved: true,
		values: {
			title: fields.title.slice(0, 500),
			year: fields.year.slice(0, 20),
			doi: fields.doi.slice(0, 300),
			isbns: fields.isbns.slice(0, 32).map((entry) => entry.slice(0, 120)),
			journal: fields.journal.slice(0, 300),
			publisher: fields.publisher.slice(0, 300),
			authors: [...safeAuthorship.authors],
			authorshipCompleteness: safeAuthorship.completeness,
			totalCountKnown: safeAuthorship.totalCountKnown,
		},
	};
}

function sessionConfiguration(value: unknown): SessionConfiguration | undefined {
	if (!isRecord(value) || !isRecord(value.output) || !isRecord(value.metadataAndNaming))
		return undefined;
	let output: SessionConfiguration["output"];
	if (value.output.mode === "current-folders") output = { mode: "current-folders" };
	else if (
		value.output.mode === "vault-folder" &&
		(value.output.folderPath === "" || relativePath(value.output.folderPath))
	)
		output = { mode: "vault-folder", folderPath: value.output.folderPath };
	else return undefined;
	const naming = value.metadataAndNaming;
	if (!isRecord(naming.filenameFormat)) return undefined;
	const format = naming.filenameFormat;
	let filenameFormat: SessionConfiguration["metadataAndNaming"]["filenameFormat"];
	if (
		format.kind === "legacy-template" &&
		string(format.template, 1000) &&
		format.template.trim()
	) {
		const fields = [...format.template.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
		const withoutFields = format.template.replace(/\{([^{}]+)\}/g, "");
		const supported = new Set(["title", "author", "authors", "year", "journal", "publisher"]);
		if (/[{}]/.test(withoutFields) || fields.some((field) => !field || !supported.has(field)))
			return undefined;
		filenameFormat = { kind: "legacy-template", template: format.template };
	} else if (format.kind === "components" && Array.isArray(format.components)) {
		const sanitized: FilenameComponent[] = [];
		for (const component of format.components) {
			if (!isRecord(component)) return undefined;
			if (component.kind === "literal" && string(component.text)) {
				sanitized.push({ kind: "literal", text: component.text });
				continue;
			}
			if (
				component.kind === "field" &&
				["title", "year", "journal", "publisher"].includes(String(component.field)) &&
				(component.prefix === undefined || string(component.prefix)) &&
				(component.suffix === undefined || string(component.suffix))
			) {
				sanitized.push({
					kind: "field",
					field: component.field as "title" | "year" | "journal" | "publisher",
					...(typeof component.prefix === "string" ? { prefix: component.prefix } : {}),
					...(typeof component.suffix === "string" ? { suffix: component.suffix } : {}),
				});
				continue;
			}
			if (component.kind === "authorship" && isRecord(component.presentation)) {
				const presentation = component.presentation;
				if (
					!(["first", "all"] as unknown[]).includes(presentation.selection) ||
					!(["family", "abbreviated-given", "full"] as unknown[]).includes(
						presentation.nameStyle,
					) ||
					!(["never", "conditional"] as unknown[]).includes(presentation.etAl) ||
					!(["given-family", "family-given"] as unknown[]).includes(
						presentation.nameOrder,
					) ||
					!string(presentation.separator)
				)
					return undefined;
				sanitized.push({
					kind: "authorship",
					presentation: {
						selection: presentation.selection as "first" | "all",
						nameStyle: presentation.nameStyle as
							"family" | "abbreviated-given" | "full",
						etAl: presentation.etAl as "never" | "conditional",
						nameOrder: presentation.nameOrder as "given-family" | "family-given",
						separator: presentation.separator,
					},
				});
				continue;
			}
			return undefined;
		}
		filenameFormat = { kind: "components", components: sanitized };
	} else return undefined;
	if (
		naming.embeddedPdfMetadata !== undefined &&
		(!isRecord(naming.embeddedPdfMetadata) ||
			typeof naming.embeddedPdfMetadata.requested !== "boolean")
	)
		return undefined;
	return {
		output,
		metadataAndNaming: {
			filenameFormat,
			...(isRecord(naming.embeddedPdfMetadata)
				? {
						embeddedPdfMetadata: {
							requested: naming.embeddedPdfMetadata.requested as boolean,
						},
					}
				: {}),
		},
	};
}

function item(value: unknown): SessionDraftItemV1 | undefined {
	if (
		!isRecord(value) ||
		!onlyKeys(value, [
			"id",
			"admissionObservation",
			"sourceObservation",
			"identification",
			"acceptedMachineRecord",
			"recordDecision",
			"disposition",
			"repairEvidence",
			"identificationHistory",
			"lastApplySummary",
		]) ||
		!string(value.id, 200) ||
		!sourceObservation(value.admissionObservation) ||
		!sourceObservation(value.sourceObservation)
	)
		return undefined;
	const state = identification(value.identification);
	if (!state) return undefined;
	const acceptedMachineRecord =
		value.acceptedMachineRecord === undefined
			? undefined
			: bibliographicRecord(value.acceptedMachineRecord);
	if (value.acceptedMachineRecord !== undefined && !acceptedMachineRecord) return undefined;
	const decision =
		value.recordDecision === undefined ? undefined : userDecision(value.recordDecision);
	if (value.recordDecision !== undefined && !decision) return undefined;
	if (value.disposition !== undefined && value.disposition !== "left-unresolved")
		return undefined;
	const repairHistory =
		value.repairEvidence === undefined
			? []
			: Array.isArray(value.repairEvidence)
				? value.repairEvidence.map(repairEvidence)
				: undefined;
	const runHistory =
		value.identificationHistory === undefined
			? []
			: Array.isArray(value.identificationHistory)
				? value.identificationHistory.map(runSummary)
				: undefined;
	if (
		!repairHistory ||
		repairHistory.some((entry) => entry === undefined) ||
		!runHistory ||
		runHistory.some((entry) => entry === undefined)
	)
		return undefined;
	let lastApplySummary: DraftApplySummary | undefined;
	if (value.lastApplySummary !== undefined) {
		const summary = value.lastApplySummary;
		if (
			!isRecord(summary) ||
			!["renamed", "blocked", "failed"].includes(String(summary.status))
		)
			return undefined;
		const blockedReasons = new Set([
			"missing-binding",
			"source-changed",
			"source-unavailable",
			"invalid-destination",
			"destination-conflict",
		]);
		if (
			summary.reason !== undefined &&
			(typeof summary.reason !== "string" || !blockedReasons.has(summary.reason))
		)
			return undefined;
		lastApplySummary = {
			status: summary.status as DraftApplySummary["status"],
			...(relativePath(summary.sourcePath) ? { sourcePath: summary.sourcePath } : {}),
			...(relativePath(summary.destinationPath)
				? { destinationPath: summary.destinationPath }
				: {}),
			...(typeof summary.reason === "string"
				? { reason: summary.reason as NonNullable<DraftApplySummary["reason"]> }
				: {}),
		};
	}
	return {
		id: value.id,
		admissionObservation: { ...value.admissionObservation },
		sourceObservation: { ...value.sourceObservation },
		identification: state,
		...(acceptedMachineRecord ? { acceptedMachineRecord } : {}),
		...(decision ? { recordDecision: decision } : {}),
		...(value.disposition ? { disposition: "left-unresolved" as const } : {}),
		...(repairHistory.length
			? { repairEvidence: (repairHistory as RepairEvidence[]).slice(-3) }
			: {}),
		...(runHistory.length
			? { identificationHistory: (runHistory as IdentificationRunSummary[]).slice(-2) }
			: {}),
		...(lastApplySummary ? { lastApplySummary } : {}),
	};
}

function safeIdentification(state: IdentificationState): DraftIdentificationState {
	if (state.status === "unattempted" || state.status === "identifying")
		return { status: "unattempted" };
	if (state.status === "resolved") {
		const record = bibliographicRecord(state.record);
		const evidence = state.evidence ? safeEvidence(state.evidence) : undefined;
		if (!record || (state.evidence && !evidence))
			throw new TypeError("Session identification is not draft-safe");
		return { status: "resolved", record, ...(evidence ? { evidence } : {}) };
	}
	const evidence = state.evidence ? safeEvidence(state.evidence) : undefined;
	if (state.evidence && !evidence) throw new TypeError("Session evidence is not draft-safe");
	return {
		status: "needs-user",
		reason: state.reason.slice(0, 500),
		...(evidence ? { evidence } : {}),
	};
}

function safeEvidence(value: IdentificationEvidence): DraftIdentificationEvidence | undefined {
	return identificationEvidence({
		identifiers: value.identifiers.map((entry) => ({
			type: entry.type,
			...(entry.normalizedValue ? { normalizedValue: entry.normalizedValue } : {}),
			valid: entry.valid,
			pageNumber: entry.pageNumber,
			textOffset: entry.textOffset,
			labeled: entry.labeled,
		})),
		attempts: value.attempts,
		titleCandidates: value.titleCandidates,
		diagnostics: value.diagnostics,
	});
}

export function restoreDraftIdentification(state: DraftIdentificationState): IdentificationState {
	const restoreEvidence = (value: DraftIdentificationEvidence): IdentificationEvidence => ({
		...value,
		identifiers: value.identifiers.map((entry) => ({ ...entry, rawText: "" })),
	});
	if (state.status === "unattempted") return { status: "unattempted" };
	if (state.status === "resolved")
		return {
			status: "resolved",
			record: state.record,
			...(state.evidence ? { evidence: restoreEvidence(state.evidence) } : {}),
		};
	return {
		status: "needs-user",
		reason: state.reason,
		...(state.evidence ? { evidence: restoreEvidence(state.evidence) } : {}),
	};
}

function applySummary(
	outcome: RenameApplyOutcome | undefined,
	existing?: DraftApplySummary,
): DraftApplySummary | undefined {
	if (!outcome) return existing;
	if (outcome.status === "renamed")
		return {
			status: "renamed",
			sourcePath: outcome.sourcePath,
			destinationPath: outcome.destinationPath,
		};
	if (outcome.status === "blocked") return { status: "blocked", reason: outcome.reason };
	return { status: "failed" };
}

function safeItem(value: SessionPdf): SessionDraftItemV1 {
	const decision = value.recordDecision ? userDecision(value.recordDecision) : undefined;
	if (value.recordDecision && !decision)
		throw new TypeError("Session record decision is not draft-safe");
	const acceptedMachineRecord = value.acceptedMachineRecord
		? bibliographicRecord(value.acceptedMachineRecord)
		: undefined;
	if (value.acceptedMachineRecord && !acceptedMachineRecord)
		throw new TypeError("Accepted machine record is not draft-safe");
	const repairs = (value.repairEvidence ?? [])
		.map(repairEvidence)
		.filter((entry): entry is RepairEvidence => !!entry)
		.slice(-3);
	const history = (value.identificationHistory ?? [])
		.map(runSummary)
		.filter((entry): entry is IdentificationRunSummary => !!entry)
		.slice(-2);
	return {
		id: value.id,
		admissionObservation: { ...value.admissionObservation },
		sourceObservation: { ...value.sourceObservation },
		identification: safeIdentification(value.identification),
		...(acceptedMachineRecord ? { acceptedMachineRecord } : {}),
		...(decision ? { recordDecision: decision } : {}),
		...(value.disposition ? { disposition: "left-unresolved" } : {}),
		...(repairs.length ? { repairEvidence: repairs } : {}),
		...(history.length ? { identificationHistory: history } : {}),
		...(applySummary(value.applyOutcome, value.lastApplySummary)
			? { lastApplySummary: applySummary(value.applyOutcome, value.lastApplySummary) }
			: {}),
	};
}

function cleanPendingForm(
	value: PendingInspectorForm | undefined,
): PendingInspectorForm | undefined {
	if (!value) return undefined;
	return pendingForm(value);
}

export function encodeSessionDraft(
	session: IntakeSession,
	draftId: string,
	savedAt = new Date().toISOString(),
): SessionDraftV1 {
	const configuration = sessionConfiguration(session.configuration);
	if (!configuration) throw new TypeError("Session configuration is not draft-safe");
	const pending = cleanPendingForm(session.pendingInspectorForm);
	if (session.pendingInspectorForm && !pending)
		throw new TypeError("Pending inspector form is not draft-safe");
	const draft: SessionDraftV1 = {
		draftVersion: 1,
		draftId,
		savedAt,
		phase: session.phase,
		setupOpen: session.setupOpen,
		setupConcern: session.setupConcern,
		configuration,
		items: session.items.map(safeItem),
		recoveryDiagnostics: [],
		...(pending ? { pendingInspectorForm: pending } : {}),
	};
	return JSON.parse(JSON.stringify(draft)) as SessionDraftV1;
}

export function decodeSessionDraft(value: unknown): SessionDraftDecodeResult {
	if (value === null || value === undefined) return { status: "none" };
	if (isRecord(value) && typeof value.draftVersion === "number" && value.draftVersion > 1) {
		return { status: "unavailable", reason: "unsupported-future" };
	}
	const configuration = isRecord(value) ? sessionConfiguration(value.configuration) : undefined;
	if (
		!isRecord(value) ||
		!onlyKeys(value, [
			"draftVersion",
			"draftId",
			"savedAt",
			"phase",
			"setupOpen",
			"setupConcern",
			"configuration",
			"items",
			"pendingInspectorForm",
			"recoveryDiagnostics",
		]) ||
		value.draftVersion !== 1 ||
		!string(value.draftId, 200) ||
		!string(value.savedAt, 100) ||
		(value.phase !== "setup" && value.phase !== "working") ||
		typeof value.setupOpen !== "boolean" ||
		!(["pdfs", "output", "metadata-and-naming"] as unknown[]).includes(value.setupConcern) ||
		!configuration ||
		!Array.isArray(value.items) ||
		!Array.isArray(value.recoveryDiagnostics)
	)
		return { status: "unavailable", reason: "malformed" };
	const items = value.items.map(item);
	const ids = new Set(items.flatMap((entry) => (entry ? [entry.id] : [])));
	if (items.some((entry) => !entry) || ids.size !== items.length)
		return { status: "unavailable", reason: "malformed" };
	const pending =
		value.pendingInspectorForm === undefined
			? undefined
			: pendingForm(value.pendingInspectorForm);
	if (value.pendingInspectorForm !== undefined && (!pending || !ids.has(pending.itemId)))
		return { status: "unavailable", reason: "malformed" };
	return {
		status: "supported",
		draft: {
			draftVersion: 1,
			draftId: value.draftId,
			savedAt: value.savedAt,
			phase: value.phase,
			setupOpen: value.setupOpen,
			setupConcern: value.setupConcern as SessionDraftV1["setupConcern"],
			configuration,
			items: items as SessionDraftItemV1[],
			...(pending ? { pendingInspectorForm: pending } : {}),
			recoveryDiagnostics: value.recoveryDiagnostics
				.filter((entry): entry is string => string(entry, 120))
				.slice(0, 12),
		},
	};
}
