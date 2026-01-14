import { TFile, Vault } from "obsidian";
import { PdfMetadata } from "./types";

export interface RenamePreview {
	file: TFile;
	oldName: string;
	newName: string;
	newPath: string;
	conflict: boolean;
	skip: boolean;
	skipReason?: string;
}

export function applyRenameTemplate(
	template: string,
	metadata: PdfMetadata
): string | null {
	// Check if we have enough metadata to apply the template
	const hasRequiredFields = template.includes("{title}")
		? metadata.title
		: true;

	if (!hasRequiredFields && !metadata.title && !metadata.author) {
		return null;
	}

	const year = metadata.creationDate?.getFullYear()?.toString() || "";
	const keywords = metadata.keywords?.join(", ") || "";

	let result = template
		.replace(/{title}/g, metadata.title || "Untitled")
		.replace(/{author}/g, metadata.author || "Unknown")
		.replace(/{subject}/g, metadata.subject || "")
		.replace(/{year}/g, year)
		.replace(/{keywords}/g, keywords)
		.replace(/{pages}/g, metadata.pageCount.toString())
		.replace(/{creator}/g, metadata.creator || "");

	// Clean up multiple spaces and trim
	result = result.replace(/\s+/g, " ").trim();

	// Remove leading/trailing dashes and clean up
	result = result.replace(/^[\s-]+|[\s-]+$/g, "").trim();

	return result || null;
}

export function sanitizeFilename(name: string): string {
	// Remove or replace characters not allowed in filenames
	return name
		.replace(/[<>:"/\\|?*]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 200); // Limit length
}

export function generateRenamePreview(
	files: TFile[],
	metadataMap: Map<string, PdfMetadata>,
	template: string,
	vault: Vault
): RenamePreview[] {
	const previews: RenamePreview[] = [];
	const usedNames = new Set<string>();

	// First pass: collect existing file names
	for (const file of vault.getFiles()) {
		usedNames.add(file.path.toLowerCase());
	}

	for (const file of files) {
		const metadata = metadataMap.get(file.path);
		const oldName = file.name;
		const folder = file.parent?.path || "";

		if (!metadata) {
			previews.push({
				file,
				oldName,
				newName: oldName,
				newPath: file.path,
				conflict: false,
				skip: true,
				skipReason: "No metadata available",
			});
			continue;
		}

		const newBaseName = applyRenameTemplate(template, metadata);

		if (!newBaseName) {
			previews.push({
				file,
				oldName,
				newName: oldName,
				newPath: file.path,
				conflict: false,
				skip: true,
				skipReason: "Insufficient metadata for template",
			});
			continue;
		}

		const sanitized = sanitizeFilename(newBaseName);
		const newName = `${sanitized}.pdf`;
		const newPath = folder ? `${folder}/${newName}` : newName;

		// Check if name actually changes
		if (newName === oldName) {
			previews.push({
				file,
				oldName,
				newName,
				newPath,
				conflict: false,
				skip: true,
				skipReason: "Name unchanged",
			});
			continue;
		}

		// Check for conflicts
		const conflict =
			usedNames.has(newPath.toLowerCase()) &&
			newPath.toLowerCase() !== file.path.toLowerCase();

		previews.push({
			file,
			oldName,
			newName,
			newPath,
			conflict,
			skip: false,
		});

		// Track this new name for subsequent conflict detection
		usedNames.add(newPath.toLowerCase());
	}

	return previews;
}

export async function executeRename(
	preview: RenamePreview,
	vault: Vault
): Promise<boolean> {
	if (preview.skip || preview.conflict) {
		return false;
	}

	try {
		await vault.rename(preview.file, preview.newPath);
		return true;
	} catch (error) {
		console.error(`Failed to rename ${preview.oldName}:`, error);
		return false;
	}
}
