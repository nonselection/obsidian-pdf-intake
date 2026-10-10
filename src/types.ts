export type LookupSource = "crossref" | "openlibrary";
export type LookupRoute = "doi" | "isbn" | "bibliographic-query" | "openlibrary-search";

export type PublicationDateEvidence =
	| {
			provider: "crossref";
			source: "published" | "published-print" | "published-online" | "issued";
			dateParts: readonly number[];
	  }
	| { provider: "openlibrary"; source: "publish-date"; text: string };

export interface SelectedRecordProvenance {
	provider: LookupSource;
	route: LookupRoute;
	identifier?: string;
	query?: string;
}

export type CanonicalAuthor =
	| { kind: "person"; given?: string; family?: string; literal?: string }
	| { kind: "organization"; literal: string }
	| { kind: "literal"; literal: string }
	| { kind: "unresolved"; position: number; reference?: string };

export interface CanonicalAuthorship {
	/** Full provider order, including unresolved positions. Never shortened for a filename. */
	authors: readonly CanonicalAuthor[];
	completeness: "complete" | "partial" | "unknown";
	totalCountKnown: boolean;
}

export interface CanonicalBibliographicRecord {
	title?: string;
	authorship: CanonicalAuthorship;
	year?: number;
	publicationDate?: PublicationDateEvidence;
	doi?: string;
	isbns: readonly string[];
	journal?: string;
	publisher?: string;
	provenance: SelectedRecordProvenance;
}

/** Provider-mapped values before the resolver selects one whole record as canonical. */
export type ProviderBibliographicRecord = Omit<CanonicalBibliographicRecord, "provenance"> & {
	provider: LookupSource;
	diagnostics: readonly string[];
};

export interface IdentifierCandidateEvidence {
	type: "doi" | "isbn";
	rawText: string;
	normalizedValue?: string;
	valid: boolean;
	pageNumber: number;
	textOffset: number;
	labeled: boolean;
}

export type ProviderAttemptOutcome =
	"no-record" | "request-failed" | "title-mismatch" | "corroborated" | "ambiguous";

export interface ProviderAttemptEvidence {
	provider: LookupSource;
	route: LookupRoute;
	lookupValue: string;
	outcome: ProviderAttemptOutcome;
	providerTitle?: string;
	matchedTitleCandidate?: string;
	score?: number;
	diagnostics?: readonly string[];
	candidateRecord?: ProviderBibliographicRecord;
}

export interface IdentificationEvidence {
	identifiers: readonly IdentifierCandidateEvidence[];
	attempts: readonly ProviderAttemptEvidence[];
	titleCandidates: readonly string[];
	queryContext?: string;
	diagnostics: readonly string[];
}

export interface AuthorshipPresentation {
	selection: "first" | "all";
	nameStyle: "family" | "abbreviated-given" | "full";
	etAl: "never" | "conditional";
	nameOrder: "given-family" | "family-given";
	separator: string;
}

export type FilenameComponent =
	| { kind: "literal"; text: string }
	| {
			kind: "field";
			field: "title" | "year" | "journal" | "publisher";
			prefix?: string;
			suffix?: string;
	  }
	| { kind: "authorship"; presentation: AuthorshipPresentation };

export type FilenameFormat =
	| { kind: "legacy-template"; template: string }
	| { kind: "components"; components: readonly FilenameComponent[] };

export interface OutputLocationCurrentFolders {
	mode: "current-folders";
}

export interface OutputLocationVaultFolder {
	mode: "vault-folder";
	/** Empty explicitly means the active vault root. */
	folderPath: string;
}

export type OutputLocation = OutputLocationCurrentFolders | OutputLocationVaultFolder;

export interface MetadataAndNaming {
	filenameFormat: FilenameFormat;
	/** Request intent only; Slice 1 has no embedded metadata writer. */
	embeddedPdfMetadata?: { requested: boolean };
}

export interface SessionConfiguration {
	output: OutputLocation;
	metadataAndNaming: MetadataAndNaming;
}

export type WorkspaceEditPolicy = "future-sessions" | "session-only";

export function createFactoryConfiguration(): SessionConfiguration {
	return {
		output: { mode: "current-folders" },
		metadataAndNaming: {
			filenameFormat: {
				kind: "components",
				components: [
					{
						kind: "authorship",
						presentation: {
							selection: "first",
							nameStyle: "family",
							etAl: "conditional",
							nameOrder: "given-family",
							separator: ", ",
						},
					},
					{ kind: "field", field: "year", prefix: " (", suffix: ")" },
					{ kind: "literal", text: ". " },
					{ kind: "field", field: "title" },
				],
			},
		},
	};
}
