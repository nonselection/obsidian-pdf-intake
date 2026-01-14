export interface PdfMetadata {
	title?: string;
	author?: string;
	subject?: string;
	keywords?: string[];
	creator?: string;
	producer?: string;
	creationDate?: Date;
	modificationDate?: Date;
	pageCount: number;
	fileSize: number;
	filePath: string;
	contentHash?: string;
}

export type OutputMode = "companion" | "index" | "sidecar";

export interface PdfMetadataSettings {
	scanFolders: string[];
	ignorePatterns: string[];
	outputMode: OutputMode;
	outputFolder: string;
	indexPath: string;
	autoScanOnOpen: boolean;
	watchForNewPdfs: boolean;
	companionTemplate: string;
	overwriteExisting: boolean;
	renameTemplate: string;
	thumbnailFolder: string;
	thumbnailScale: number;
	generateThumbnails: boolean;
}

export const DEFAULT_SETTINGS: PdfMetadataSettings = {
	scanFolders: [],
	ignorePatterns: ["**/node_modules/**", "**/.obsidian/**"],
	outputMode: "companion",
	outputFolder: "PDF Notes",
	indexPath: "PDF Index.md",
	autoScanOnOpen: false,
	watchForNewPdfs: true,
	companionTemplate: "# {{title}}\n\n{{thumbnail}}\n\n{{embed}}\n\n## Notes\n\n",
	overwriteExisting: false,
	renameTemplate: "{author} - {title}",
	thumbnailFolder: "attachments/pdf-thumbnails",
	thumbnailScale: 0.3,
	generateThumbnails: true,
};
