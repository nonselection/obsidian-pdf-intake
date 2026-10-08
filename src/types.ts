export type LookupSource = "crossref" | "openlibrary";
export type ResolutionStatus = "resolved" | "unresolved" | "error";

/** Provider-shaped values remain at the read/lookup boundary until Slice 3 lossless ingestion. */
export interface BibliographicMetadata {
	title?: string;
	authors: string[];
	firstAuthor?: string;
	year?: number;
	doi?: string;
	isbn?: string;
	journal?: string;
	publisher?: string;
	source?: LookupSource;
	status: ResolutionStatus;
	error?: string;
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
	doi?: string;
	isbn?: string;
	journal?: string;
	publisher?: string;
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
