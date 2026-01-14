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
