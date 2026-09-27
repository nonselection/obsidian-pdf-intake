import type { TFile } from "obsidian";

export type LookupSource = "crossref" | "openlibrary";
export type ResolutionStatus = "resolved" | "unresolved" | "error";
export type IntakeStatus =
	| "unprocessed"
	| "resolving"
	| "ready"
	| "unresolved"
	| "conflict"
	| "error"
	| "processed"
	| "unchanged";
export type ProcessedFolderMode = "intake" | "another";

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

export interface IntakeSettings {
	intakeFolder: string;
	processedFolderMode: ProcessedFolderMode;
	processedFolder: string;
	renameTemplate: string;
}

export const DEFAULT_SETTINGS: IntakeSettings = {
	intakeFolder: "Inbox",
	processedFolderMode: "intake",
	processedFolder: "",
	renameTemplate: "{author} - {title} ({year})",
};

export interface IntakeEntry {
	file: TFile;
	selected: boolean;
	status: IntakeStatus;
	metadata?: BibliographicMetadata;
	manualIdentifier: string;
	finalPath?: string;
	proposedName?: string;
	error?: string;
}
