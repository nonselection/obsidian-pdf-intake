import { TFile, Vault } from "obsidian";
import { PdfMetadataSettings } from "./types";

export function scanVault(
	vault: Vault,
	settings: PdfMetadataSettings
): TFile[] {
	const pdfs: TFile[] = [];

	for (const file of vault.getFiles()) {
		if (file.extension !== "pdf") continue;
		if (shouldIgnore(file.path, settings.ignorePatterns)) continue;
		if (!isInScanFolders(file.path, settings.scanFolders)) continue;

		pdfs.push(file);
	}

	return pdfs;
}

export function shouldIgnore(path: string, patterns: string[]): boolean {
	return patterns.some((pattern) => matchGlob(pattern, path));
}

export function isInScanFolders(path: string, folders: string[]): boolean {
	// Empty folders array means scan all
	if (folders.length === 0) return true;

	return folders.some((folder) => {
		const normalizedFolder = folder.endsWith("/") ? folder : folder + "/";
		const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
		return normalizedPath.startsWith(normalizedFolder) || normalizedPath === folder;
	});
}

function matchGlob(pattern: string, path: string): boolean {
	// Convert glob pattern to regex
	const regexPattern = pattern
		.replace(/\*\*/g, "{{DOUBLE_STAR}}")
		.replace(/\*/g, "[^/]*")
		.replace(/\{\{DOUBLE_STAR\}\}/g, ".*")
		.replace(/\?/g, ".");

	const regex = new RegExp(`^${regexPattern}$`);
	return regex.test(path);
}
