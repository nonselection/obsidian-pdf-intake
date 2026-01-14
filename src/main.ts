import { Notice, Plugin, TFile } from "obsidian";
import { PdfMetadataSettings, DEFAULT_SETTINGS, PdfMetadata, PdfAnnotation } from "./types";
import { extractMetadata, hasMetadata } from "./extractor";
import {
	generateCompanionNote,
	generateIndexNote,
	getCompanionNotePath,
	getSidecarPath,
} from "./generator";
import { scanVault } from "./scanner";
import { generateRenamePreview } from "./renamer";
import { findDuplicates } from "./duplicates";
import {
	generateThumbnail,
	saveThumbnail,
	getThumbnailPath,
	generateMultipleThumbnails,
	saveMultipleThumbnails,
} from "./thumbnail";
import { syncFromCompanion, getCompanionForPdf, parseCompanionFrontmatter } from "./writeback";
import { extractAnnotations, formatAnnotationsForNote, hasAnnotations } from "./annotations";
import { PdfMetadataSettingTab } from "./settings";
import {
	PdfMetadataModal,
	RenamePreviewModal,
	DuplicatesModal,
	WritebackModal,
	PdfAnnotationsModal,
	ThumbnailGalleryModal,
} from "./modal";

export default class PdfMetadataPlugin extends Plugin {
	settings: PdfMetadataSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addSettingTab(new PdfMetadataSettingTab(this.app, this));

		this.addCommand({
			id: "scan-vault-pdfs",
			name: "Scan vault for PDFs",
			callback: () => this.scanAndProcess(),
		});

		this.addCommand({
			id: "extract-current-pdf",
			name: "Extract metadata for current PDF",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (file?.extension !== "pdf") return false;
				if (!checking) this.extractSingle(file);
				return true;
			},
		});

		this.addCommand({
			id: "view-pdf-metadata",
			name: "View PDF metadata",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (file?.extension !== "pdf") return false;
				if (!checking) this.viewMetadata(file);
				return true;
			},
		});

		this.addCommand({
			id: "generate-companion-note",
			name: "Generate companion note for current PDF",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (file?.extension !== "pdf") return false;
				if (!checking) this.generateCompanion(file);
				return true;
			},
		});

		this.addCommand({
			id: "rebuild-pdf-index",
			name: "Rebuild PDF index",
			callback: () => this.rebuildIndex(),
		});

		this.addCommand({
			id: "batch-rename-pdfs",
			name: "Batch rename PDFs",
			callback: () => this.batchRename(),
		});

		this.addCommand({
			id: "find-duplicate-pdfs",
			name: "Find duplicate PDFs",
			callback: () => this.findDuplicatePdfs(),
		});

		this.addCommand({
			id: "generate-thumbnail",
			name: "Generate thumbnail for current PDF",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (file?.extension !== "pdf") return false;
				if (!checking) this.generateThumbnailForFile(file);
				return true;
			},
		});

		this.addCommand({
			id: "sync-metadata-from-companion",
			name: "Sync metadata from companion note to PDF",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;

				// Check if it's a companion note or PDF
				if (file.extension === "pdf") {
					if (!checking) this.syncFromCompanionForPdf(file);
					return true;
				}
				if (file.extension === "md") {
					if (!checking) this.syncFromCompanionNote(file);
					return true;
				}
				return false;
			},
		});

		this.addCommand({
			id: "view-pdf-annotations",
			name: "View PDF annotations",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (file?.extension !== "pdf") return false;
				if (!checking) this.viewAnnotations(file);
				return true;
			},
		});

		this.addCommand({
			id: "extract-pdf-annotations",
			name: "Extract annotations from current PDF",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (file?.extension !== "pdf") return false;
				if (!checking) this.extractAnnotationsToNote(file);
				return true;
			},
		});

		this.addCommand({
			id: "select-thumbnail-page",
			name: "Select thumbnail page from gallery",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (file?.extension !== "pdf") return false;
				if (!checking) this.openThumbnailGallery(file);
				return true;
			},
		});

		if (this.settings.watchForNewPdfs) {
			this.setupFileWatcher();
		}

		if (this.settings.autoScanOnOpen) {
			this.app.workspace.onLayoutReady(() => {
				this.scanAndProcess();
			});
		}
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private setupFileWatcher(): void {
		this.registerEvent(
			this.app.vault.on("create", async (file) => {
				if (!(file instanceof TFile)) return;
				if (file.extension !== "pdf") return;
				if (!this.settings.watchForNewPdfs) return;

				new Notice(`Processing new PDF: ${file.name}`);
				await this.processFile(file);
			})
		);
	}

	async scanAndProcess(): Promise<void> {
		const pdfs = scanVault(this.app.vault, this.settings);
		new Notice(`Found ${pdfs.length} PDF(s). Processing...`);

		let processed = 0;
		const allMetadata: PdfMetadata[] = [];

		for (const file of pdfs) {
			const metadata = await this.processFile(file);
			if (metadata) {
				allMetadata.push(metadata);
				processed++;
			}
		}

		if (this.settings.outputMode === "index") {
			await this.writeIndexNote(allMetadata);
		}

		new Notice(`Processed ${processed} PDF(s).`);
	}

	async processFile(file: TFile): Promise<PdfMetadata | null> {
		try {
			const metadata = await extractMetadata(file, this.app.vault);

			switch (this.settings.outputMode) {
				case "companion":
					await this.writeCompanionNote(metadata, file);
					break;
				case "sidecar":
					await this.writeSidecarNote(metadata);
					break;
				case "index":
					// Index is written after all files are processed
					break;
			}

			return metadata;
		} catch (error) {
			console.error(`Failed to process ${file.path}:`, error);
			return null;
		}
	}

	async extractSingle(file: TFile): Promise<void> {
		new Notice(`Extracting metadata from ${file.name}...`);
		const metadata = await this.processFile(file);

		if (metadata && hasMetadata(metadata)) {
			new Notice(`Extracted metadata for ${file.name}`);
		} else {
			new Notice(`No metadata found in ${file.name}`);
		}
	}

	async viewMetadata(file: TFile): Promise<void> {
		const metadata = await extractMetadata(file, this.app.vault);
		new PdfMetadataModal(this.app, metadata, file).open();
	}

	async generateCompanion(file: TFile): Promise<void> {
		const metadata = await extractMetadata(file, this.app.vault);
		await this.writeCompanionNote(metadata, file);
		new Notice(`Created companion note for ${file.name}`);
	}

	async viewAnnotations(file: TFile): Promise<void> {
		new Notice(`Extracting annotations from ${file.name}...`);

		const annotations = await extractAnnotations(
			file,
			this.app.vault,
			this.settings.annotationTypes
		);

		new PdfAnnotationsModal(this.app, annotations, file).open();
	}

	async extractAnnotationsToNote(file: TFile): Promise<void> {
		new Notice(`Extracting annotations from ${file.name}...`);

		const annotations = await extractAnnotations(
			file,
			this.app.vault,
			this.settings.annotationTypes
		);

		if (!hasAnnotations(annotations)) {
			new Notice(`No annotations found in ${file.name}`);
			return;
		}

		const annotationsContent = formatAnnotationsForNote(
			annotations,
			this.settings.annotationGrouping,
			this.settings.includeAnnotationColors
		);

		// Create or update companion note with annotations
		const metadata = await extractMetadata(file, this.app.vault);
		await this.writeCompanionNote(metadata, file);

		new Notice(`Extracted ${annotations.length} annotation(s) from ${file.name}`);
	}

	async rebuildIndex(): Promise<void> {
		const pdfs = scanVault(this.app.vault, this.settings);
		const allMetadata: PdfMetadata[] = [];

		for (const file of pdfs) {
			const metadata = await extractMetadata(file, this.app.vault);
			allMetadata.push(metadata);
		}

		await this.writeIndexNote(allMetadata);
		new Notice(`Index rebuilt with ${allMetadata.length} PDF(s).`);
	}

	private async writeCompanionNote(metadata: PdfMetadata, file?: TFile): Promise<void> {
		const notePath = getCompanionNotePath(
			metadata.filePath,
			this.settings.outputFolder
		);

		let thumbnailPath: string | undefined;
		let annotationsContent: string | undefined;

		// Generate thumbnail(s) if enabled
		if (this.settings.generateThumbnails && file) {
			try {
				if (this.settings.thumbnailMode === "multiple") {
					// Generate multiple thumbnails
					const thumbnails = await generateMultipleThumbnails(
						file,
						this.app.vault,
						this.settings.thumbnailScale,
						this.settings.thumbnailPageCount
					);
					const paths = await saveMultipleThumbnails(
						file,
						thumbnails,
						this.settings.thumbnailFolder,
						this.app.vault
					);
					// Use first thumbnail for embed, but all are saved
					thumbnailPath = paths[0];
				} else {
					// Single page mode (also used for gallery mode)
					const thumbnailData = await generateThumbnail(
						file,
						this.app.vault,
						this.settings.thumbnailScale,
						this.settings.thumbnailPage
					);
					thumbnailPath = await saveThumbnail(
						file,
						thumbnailData,
						this.settings.thumbnailFolder,
						this.app.vault
					);
				}
			} catch (error) {
				console.error(`Failed to generate thumbnail for ${file.path}:`, error);
			}
		}

		// Extract annotations if enabled
		if (this.settings.extractAnnotations && file) {
			try {
				const annotations = await extractAnnotations(
					file,
					this.app.vault,
					this.settings.annotationTypes
				);

				if (hasAnnotations(annotations)) {
					annotationsContent = formatAnnotationsForNote(
						annotations,
						this.settings.annotationGrouping,
						this.settings.includeAnnotationColors
					);

					if (annotationsContent) {
						annotationsContent = `## Annotations\n\n${annotationsContent}`;
					}
				}
			} catch (error) {
				console.error(`Failed to extract annotations for ${file.path}:`, error);
			}
		}

		const content = generateCompanionNote(
			metadata,
			this.settings.companionTemplate,
			thumbnailPath,
			annotationsContent
		);

		await this.ensureFolderExists(this.settings.outputFolder);
		await this.writeNote(notePath, content);
	}

	private async writeSidecarNote(metadata: PdfMetadata): Promise<void> {
		const notePath = getSidecarPath(metadata.filePath);
		const content = generateCompanionNote(
			metadata,
			this.settings.companionTemplate
		);

		await this.writeNote(notePath, content);
	}

	private async writeIndexNote(allMetadata: PdfMetadata[]): Promise<void> {
		const content = generateIndexNote(allMetadata);
		await this.writeNote(this.settings.indexPath, content);
	}

	private async writeNote(path: string, content: string): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(path);

		if (existing instanceof TFile) {
			if (this.settings.overwriteExisting) {
				await this.app.vault.modify(existing, content);
			}
		} else {
			await this.app.vault.create(path, content);
		}
	}

	private async ensureFolderExists(folderPath: string): Promise<void> {
		const folder = this.app.vault.getAbstractFileByPath(folderPath);
		if (!folder) {
			await this.app.vault.createFolder(folderPath);
		}
	}

	async openThumbnailGallery(file: TFile): Promise<void> {
		new ThumbnailGalleryModal(
			this.app,
			file,
			async (selectedPage) => {
				this.settings.thumbnailPage = selectedPage;
				await this.saveSettings();

				// Regenerate thumbnail with selected page
				const metadata = await extractMetadata(file, this.app.vault);
				await this.writeCompanionNote(metadata, file);
			},
			this.settings.thumbnailPage
		).open();
	}

	async batchRename(): Promise<void> {
		const pdfs = scanVault(this.app.vault, this.settings);

		if (pdfs.length === 0) {
			new Notice("No PDFs found in vault.");
			return;
		}

		new Notice(`Scanning ${pdfs.length} PDF(s) for metadata...`);

		const metadataMap = new Map<string, PdfMetadata>();

		for (const file of pdfs) {
			const metadata = await extractMetadata(file, this.app.vault);
			metadataMap.set(file.path, metadata);
		}

		const previews = generateRenamePreview(
			pdfs,
			metadataMap,
			this.settings.renameTemplate,
			this.app.vault
		);

		new RenamePreviewModal(
			this.app,
			previews,
			this.app.vault,
			(renamed) => {
				new Notice(`Renamed ${renamed} PDF(s).`);
			}
		).open();
	}

	async findDuplicatePdfs(): Promise<void> {
		const pdfs = scanVault(this.app.vault, this.settings);

		if (pdfs.length === 0) {
			new Notice("No PDFs found in vault.");
			return;
		}

		new Notice(`Scanning ${pdfs.length} PDF(s) for duplicates...`);

		const duplicates = await findDuplicates(
			pdfs,
			this.app.vault,
			(current, total) => {
				if (current % 10 === 0 || current === total) {
					new Notice(`Hashing PDF ${current}/${total}...`);
				}
			}
		);

		new DuplicatesModal(this.app, duplicates, this.app.vault).open();
	}

	async generateThumbnailForFile(file: TFile): Promise<void> {
		new Notice(`Generating thumbnail for ${file.name}...`);

		try {
			const thumbnailData = await generateThumbnail(
				file,
				this.app.vault,
				this.settings.thumbnailScale
			);
			const thumbnailPath = await saveThumbnail(
				file,
				thumbnailData,
				this.settings.thumbnailFolder,
				this.app.vault
			);
			new Notice(`Thumbnail saved: ${thumbnailPath}`);
		} catch (error) {
			new Notice(`Failed to generate thumbnail: ${error}`);
			console.error(error);
		}
	}

	async syncFromCompanionForPdf(pdfFile: TFile): Promise<void> {
		const companionFile = getCompanionForPdf(
			pdfFile.path,
			this.settings.outputFolder,
			this.app.vault
		);

		if (!companionFile) {
			new Notice(`No companion note found for ${pdfFile.name}`);
			return;
		}

		const content = await this.app.vault.read(companionFile);
		const metadata = parseCompanionFrontmatter(content);

		if (Object.keys(metadata).length === 0) {
			new Notice("No metadata found in companion note");
			return;
		}

		new WritebackModal(
			this.app,
			pdfFile,
			metadata,
			() => new Notice(`Metadata synced to ${pdfFile.name}`)
		).open();
	}

	async syncFromCompanionNote(companionFile: TFile): Promise<void> {
		const content = await this.app.vault.read(companionFile);
		const metadata = parseCompanionFrontmatter(content);

		// Extract source PDF path from frontmatter
		const sourceMatch = content.match(/^source:\s*"?\[\[([^\]]+)\]\]"?$/m);
		if (!sourceMatch) {
			new Notice("No source PDF found in companion note");
			return;
		}

		const pdfPath = sourceMatch[1];
		const pdfFile = this.app.vault.getAbstractFileByPath(pdfPath);

		if (!(pdfFile instanceof TFile)) {
			new Notice(`PDF not found: ${pdfPath}`);
			return;
		}

		if (Object.keys(metadata).length === 0) {
			new Notice("No metadata found in companion note");
			return;
		}

		new WritebackModal(
			this.app,
			pdfFile,
			metadata,
			() => new Notice(`Metadata synced to ${pdfFile.name}`)
		).open();
	}
}
