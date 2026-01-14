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

export type AnnotationType =
	| "Highlight"
	| "Underline"
	| "StrikeOut"
	| "Squiggly"
	| "FreeText"
	| "Text"
	| "Ink";

export type AnnotationGrouping = "type" | "page" | "date" | "flat";

export interface PdfAnnotation {
	id: string;
	type: AnnotationType;
	pageNumber: number;
	rect: [number, number, number, number];
	color?: number[];
	contents?: string;
	extractedText?: string;
	author?: string;
	creationDate?: Date;
	modificationDate?: Date;
}

export type OutputMode = "companion" | "index" | "sidecar";

export type ThumbnailMode = "single" | "multiple" | "gallery";

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
	thumbnailMode: ThumbnailMode;
	thumbnailPage: number;
	thumbnailPageCount: number;
	// Annotation settings
	extractAnnotations: boolean;
	annotationTypes: AnnotationType[];
	annotationGrouping: AnnotationGrouping;
	extractHighlightText: boolean;
	includeAnnotationColors: boolean;
	// Dataview integration settings
	frontmatterTypeField: boolean;
	frontmatterFileSize: boolean;
	frontmatterCreatorProducer: boolean;
	frontmatterKeywordsAsTags: boolean;
}

export const DEFAULT_SETTINGS: PdfMetadataSettings = {
	scanFolders: [],
	ignorePatterns: ["**/node_modules/**", "**/.obsidian/**"],
	outputMode: "companion",
	outputFolder: "PDF Notes",
	indexPath: "PDF Index.md",
	autoScanOnOpen: false,
	watchForNewPdfs: true,
	companionTemplate: "# {{title}}\n\n{{thumbnail}}\n\n{{embed}}\n\n{{annotations}}\n\n## Notes\n\n",
	overwriteExisting: false,
	renameTemplate: "{author} - {title}",
	thumbnailFolder: "attachments/pdf-thumbnails",
	thumbnailScale: 0.3,
	generateThumbnails: true,
	thumbnailMode: "single",
	thumbnailPage: 1,
	thumbnailPageCount: 3,
	// Annotation defaults
	extractAnnotations: true,
	annotationTypes: ["Highlight", "Underline", "StrikeOut", "Squiggly", "FreeText", "Text", "Ink"],
	annotationGrouping: "type",
	extractHighlightText: true,
	includeAnnotationColors: true,
	// Dataview integration defaults
	frontmatterTypeField: true,
	frontmatterFileSize: true,
	frontmatterCreatorProducer: false,
	frontmatterKeywordsAsTags: true,
};
