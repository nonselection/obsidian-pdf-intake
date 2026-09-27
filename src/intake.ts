import type { TFile, Vault } from "obsidian";
import type { BibliographicMetadata, IntakeEntry, IntakeSettings } from "./types";

export interface FolderValidation {
	valid: boolean;
	error?: string;
}

export function validateIntakeFolder(
	intakeFolder: string,
	availableFolders: readonly string[],
): FolderValidation {
	return intakeFolder.trim() && availableFolders.includes(intakeFolder)
		? { valid: true }
		: { valid: false, error: `Intake folder does not exist: ${intakeFolder || "(empty)"}` };
}

export function validateProcessedFolder(
	processedFolderMode: IntakeSettings["processedFolderMode"],
	processedFolder: string,
	availableFolders: readonly string[],
): FolderValidation {
	if (processedFolderMode === "intake") return { valid: true };
	return processedFolder.trim() && availableFolders.includes(processedFolder)
		? { valid: true }
		: {
				valid: false,
				error: `Processed folder does not exist: ${processedFolder || "(empty)"}`,
			};
}

export function validateFolders(
	intakeFolder: string,
	processedFolderMode: IntakeSettings["processedFolderMode"],
	processedFolder: string,
	availableFolders: readonly string[],
): FolderValidation {
	const intake = validateIntakeFolder(intakeFolder, availableFolders);
	if (!intake.valid) return intake;
	return validateProcessedFolder(processedFolderMode, processedFolder, availableFolders);
}

export function filesInIntakeFolder(
	files: readonly TFile[],
	intakeFolder: string,
	availableFolders: readonly string[],
	processedFolderMode: IntakeSettings["processedFolderMode"] = "intake",
	processedFolder = "",
): { valid: boolean; error?: string; files: TFile[] } {
	if (!intakeFolder || !availableFolders.includes(intakeFolder)) {
		return {
			valid: false,
			error: `Intake folder does not exist: ${intakeFolder || "(empty)"}`,
			files: [],
		};
	}
	const processedFolderIsValid = validateProcessedFolder(
		processedFolderMode,
		processedFolder,
		availableFolders,
	).valid;
	const excludedSubtree =
		processedFolderMode === "another" &&
		processedFolderIsValid &&
		processedFolder.startsWith(`${intakeFolder}/`);
	return {
		valid: true,
		files: files.filter(
			(file) =>
				file.extension.toLowerCase() === "pdf" &&
				(file.parent?.path === intakeFolder || file.path.startsWith(`${intakeFolder}/`)) &&
				(!excludedSubtree || !file.path.startsWith(`${processedFolder}/`)),
		),
	};
}

export function generateFilename(metadata: BibliographicMetadata, template: string): string | null {
	if (metadata.status !== "resolved" || !metadata.title) return null;
	if (/\{authors?\}/.test(template) && !metadata.firstAuthor) return null;
	const values: Record<string, string> = {
		title: metadata.title,
		author: metadata.firstAuthor ?? "",
		authors: metadata.authors.join(", "),
		year: metadata.year?.toString() ?? "",
		journal: metadata.journal ?? "",
		publisher: metadata.publisher ?? "",
	};
	const base = template
		.replace(
			/\{(title|author|authors|year|journal|publisher)\}/g,
			(_, key: string) => values[key],
		)
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

export function finalDestinationPath(
	filePath: string,
	filename: string,
	processedFolderMode: IntakeSettings["processedFolderMode"],
	processedFolder: string,
): string {
	const parent = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
	const folder = processedFolderMode === "another" ? processedFolder : parent;
	return folder ? `${folder}/${filename}` : filename;
}

export function updateEntryPlan(
	entry: IntakeEntry,
	settings: IntakeSettings,
	vaultPaths: readonly string[],
	plannedPaths: Set<string> = new Set(),
): void {
	if (!entry.metadata || entry.status === "processed" || entry.status === "resolving") return;
	const { metadata } = entry;
	entry.error = metadata.error;
	entry.finalPath = undefined;
	entry.proposedName = undefined;
	if (metadata.status === "error") {
		entry.status = "error";
		entry.error = metadata.error ?? "Metadata resolution failed";
		return;
	}
	if (metadata.status !== "resolved") {
		entry.status = "unresolved";
		entry.error = metadata.error ?? "Bibliographic metadata was not resolved";
		return;
	}
	const filename = generateFilename(metadata, settings.renameTemplate);
	if (!filename) {
		entry.status = "unresolved";
		entry.error = "Required title or author unavailable for this filename template";
		return;
	}
	const finalPath = finalDestinationPath(
		entry.file.path,
		filename,
		settings.processedFolderMode,
		settings.processedFolder,
	);
	entry.proposedName = filename;
	entry.finalPath = finalPath;
	if (finalPath === entry.file.path) {
		entry.status = "unchanged";
		entry.error = "The file already has its final name and location";
		return;
	}
	const key = finalPath.toLocaleLowerCase();
	const sourceKey = entry.file.path.toLocaleLowerCase();
	if (
		(vaultPaths.some((path) => path.toLocaleLowerCase() === key) && key !== sourceKey) ||
		plannedPaths.has(key)
	) {
		entry.status = "conflict";
		entry.error = "The final destination already exists or is planned for another PDF";
		return;
	}
	plannedPaths.add(key);
	entry.status = "ready";
	entry.error = undefined;
}

export function planEntries(
	entries: IntakeEntry[],
	settings: IntakeSettings,
	vaultPaths: readonly string[],
	availableFolders?: readonly string[],
): void {
	if (availableFolders) {
		const validation = validateFolders(
			settings.intakeFolder,
			settings.processedFolderMode,
			settings.processedFolder,
			availableFolders,
		);
		if (!validation.valid) {
			for (const entry of entries) {
				if (entry.status === "processed" || entry.status === "resolving") continue;
				entry.status = "error";
				entry.error = validation.error;
				entry.finalPath = undefined;
				entry.proposedName = undefined;
			}
			return;
		}
	}
	const plannedPaths = new Set<string>();
	for (const entry of entries) updateEntryPlan(entry, settings, vaultPaths, plannedPaths);
}

export async function processEntry(entry: IntakeEntry, vault: Vault): Promise<boolean> {
	if (entry.status !== "ready" || !entry.finalPath || entry.finalPath === entry.file.path)
		return false;
	const destinationKey = entry.finalPath.toLocaleLowerCase();
	const exists = vault
		.getFiles()
		.some(
			(file) =>
				file.path.toLocaleLowerCase() === destinationKey && file.path !== entry.file.path,
		);
	if (exists) {
		entry.status = "conflict";
		entry.error = "The final destination now exists";
		return false;
	}
	try {
		await vault.rename(entry.file, entry.finalPath);
		entry.status = "processed";
		entry.error = undefined;
		return true;
	} catch (error) {
		entry.status = "error";
		entry.error = error instanceof Error ? error.message : String(error);
		return false;
	}
}
