import { Notice, Plugin, TFile } from "obsidian";
import { PdfMetadataSettings, DEFAULT_SETTINGS, PdfMetadata } from "./types";
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
import { PdfMetadataSettingTab } from "./settings";
import { PdfMetadataModal, RenamePreviewModal, DuplicatesModal } from "./modal";

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
					await this.writeCompanionNote(metadata);
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
		new PdfMetadataModal(this.app, metadata).open();
	}

	async generateCompanion(file: TFile): Promise<void> {
		const metadata = await extractMetadata(file, this.app.vault);
		await this.writeCompanionNote(metadata);
		new Notice(`Created companion note for ${file.name}`);
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

	private async writeCompanionNote(metadata: PdfMetadata): Promise<void> {
		const notePath = getCompanionNotePath(
			metadata.filePath,
			this.settings.outputFolder
		);

		const content = generateCompanionNote(
			metadata,
			this.settings.companionTemplate
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
}
