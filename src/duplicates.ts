import { TFile, Vault } from "obsidian";
import { PdfMetadata } from "./types";
import { computeContentHash } from "./extractor";

export interface DuplicateGroup {
	hash: string;
	files: TFile[];
	metadata?: PdfMetadata;
	totalSize: number;
}

export async function findDuplicates(
	files: TFile[],
	vault: Vault,
	onProgress?: (current: number, total: number) => void
): Promise<DuplicateGroup[]> {
	const hashMap = new Map<string, TFile[]>();

	for (let i = 0; i < files.length; i++) {
		const file = files[i];

		if (onProgress) {
			onProgress(i + 1, files.length);
		}

		try {
			const hash = await computeContentHash(file, vault);

			const existing = hashMap.get(hash) || [];
			existing.push(file);
			hashMap.set(hash, existing);
		} catch (error) {
			console.error(`Failed to hash ${file.path}:`, error);
		}
	}

	// Filter to only groups with duplicates (more than 1 file)
	const duplicates: DuplicateGroup[] = [];

	for (const [hash, groupFiles] of hashMap) {
		if (groupFiles.length > 1) {
			const totalSize = groupFiles.reduce((sum, f) => sum + f.stat.size, 0);

			duplicates.push({
				hash,
				files: groupFiles,
				totalSize,
			});
		}
	}

	// Sort by number of duplicates (most first)
	duplicates.sort((a, b) => b.files.length - a.files.length);

	return duplicates;
}

export function formatDuplicateStats(groups: DuplicateGroup[]): string {
	const totalGroups = groups.length;
	const totalDuplicates = groups.reduce((sum, g) => sum + g.files.length - 1, 0);
	const totalWastedSize = groups.reduce(
		(sum, g) => sum + g.files[0].stat.size * (g.files.length - 1),
		0
	);

	return `${totalGroups} duplicate group(s), ${totalDuplicates} duplicate file(s), ${formatSize(totalWastedSize)} wasted`;
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export type KeepStrategy = "oldest" | "newest" | "shortest-path" | "longest-path";

/**
 * Get the file to keep based on strategy
 */
export function getFileToKeep(files: TFile[], strategy: KeepStrategy): TFile {
	const sorted = [...files];

	switch (strategy) {
		case "oldest":
			sorted.sort((a, b) => a.stat.ctime - b.stat.ctime);
			return sorted[0];
		case "newest":
			sorted.sort((a, b) => b.stat.ctime - a.stat.ctime);
			return sorted[0];
		case "shortest-path":
			sorted.sort((a, b) => a.path.length - b.path.length);
			return sorted[0];
		case "longest-path":
			sorted.sort((a, b) => b.path.length - a.path.length);
			return sorted[0];
		default:
			return sorted[0];
	}
}

/**
 * Get files to delete based on strategy (all except the one to keep)
 */
export function getFilesToDelete(files: TFile[], strategy: KeepStrategy): TFile[] {
	const keep = getFileToKeep(files, strategy);
	return files.filter((f) => f.path !== keep.path);
}

/**
 * Delete duplicates in a group, keeping one based on strategy
 */
export async function deleteDuplicatesInGroup(
	group: DuplicateGroup,
	vault: Vault,
	strategy: KeepStrategy,
	useTrash: boolean = true
): Promise<number> {
	const toDelete = getFilesToDelete(group.files, strategy);
	let deleted = 0;

	for (const file of toDelete) {
		try {
			await vault.trash(file, useTrash);
			deleted++;
		} catch (error) {
			console.error(`Failed to delete ${file.path}:`, error);
		}
	}

	return deleted;
}

/**
 * Delete duplicates across all groups
 */
export async function deleteAllDuplicates(
	groups: DuplicateGroup[],
	vault: Vault,
	strategy: KeepStrategy,
	useTrash: boolean = true,
	onProgress?: (current: number, total: number) => void
): Promise<number> {
	let totalDeleted = 0;
	const totalGroups = groups.length;

	for (let i = 0; i < groups.length; i++) {
		const group = groups[i];

		if (onProgress) {
			onProgress(i + 1, totalGroups);
		}

		const deleted = await deleteDuplicatesInGroup(group, vault, strategy, useTrash);
		totalDeleted += deleted;
	}

	return totalDeleted;
}

/**
 * Move duplicates to a folder, keeping one based on strategy
 */
export async function moveDuplicatesToFolder(
	group: DuplicateGroup,
	vault: Vault,
	targetFolder: string,
	strategy: KeepStrategy
): Promise<number> {
	const toMove = getFilesToDelete(group.files, strategy);
	let moved = 0;

	// Ensure folder exists
	const folder = vault.getAbstractFileByPath(targetFolder);
	if (!folder) {
		await vault.createFolder(targetFolder);
	}

	for (const file of toMove) {
		try {
			const fileName = file.name;
			let newPath = `${targetFolder}/${fileName}`;

			// Handle name conflicts
			let counter = 1;
			while (vault.getAbstractFileByPath(newPath)) {
				const baseName = fileName.replace(/\.pdf$/i, "");
				newPath = `${targetFolder}/${baseName} (${counter}).pdf`;
				counter++;
			}

			await vault.rename(file, newPath);
			moved++;
		} catch (error) {
			console.error(`Failed to move ${file.path}:`, error);
		}
	}

	return moved;
}

/**
 * Move all duplicates across all groups to a folder
 */
export async function moveAllDuplicatesToFolder(
	groups: DuplicateGroup[],
	vault: Vault,
	targetFolder: string,
	strategy: KeepStrategy,
	onProgress?: (current: number, total: number) => void
): Promise<number> {
	let totalMoved = 0;
	const totalGroups = groups.length;

	for (let i = 0; i < groups.length; i++) {
		const group = groups[i];

		if (onProgress) {
			onProgress(i + 1, totalGroups);
		}

		const moved = await moveDuplicatesToFolder(group, vault, targetFolder, strategy);
		totalMoved += moved;
	}

	return totalMoved;
}

/**
 * Get strategy display name
 */
export function getStrategyName(strategy: KeepStrategy): string {
	const names: Record<KeepStrategy, string> = {
		oldest: "Keep oldest",
		newest: "Keep newest",
		"shortest-path": "Keep shortest path",
		"longest-path": "Keep longest path",
	};
	return names[strategy];
}
