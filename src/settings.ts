import { App, PluginSettingTab, Setting } from "obsidian";
import type PdfMetadataPlugin from "./main";
import { OutputMode, AnnotationType, AnnotationGrouping, ThumbnailMode } from "./types";

export class PdfMetadataSettingTab extends PluginSettingTab {
	plugin: PdfMetadataPlugin;

	constructor(app: App, plugin: PdfMetadataPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "PDF Metadata Settings" });

		// Scan folders
		new Setting(containerEl)
			.setName("Scan folders")
			.setDesc("Folders to scan for PDFs (comma-separated). Leave empty to scan entire vault.")
			.addText((text) =>
				text
					.setPlaceholder("papers, books, documents")
					.setValue(this.plugin.settings.scanFolders.join(", "))
					.onChange(async (value) => {
						this.plugin.settings.scanFolders = value
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean);
						await this.plugin.saveSettings();
					})
			);

		// Ignore patterns
		new Setting(containerEl)
			.setName("Ignore patterns")
			.setDesc("Glob patterns to ignore (comma-separated).")
			.addText((text) =>
				text
					.setPlaceholder("**/node_modules/**, **/.obsidian/**")
					.setValue(this.plugin.settings.ignorePatterns.join(", "))
					.onChange(async (value) => {
						this.plugin.settings.ignorePatterns = value
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean);
						await this.plugin.saveSettings();
					})
			);

		// Output mode
		new Setting(containerEl)
			.setName("Output mode")
			.setDesc("How to store extracted metadata.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("companion", "Companion notes")
					.addOption("index", "Index note")
					.addOption("sidecar", "Sidecar files")
					.setValue(this.plugin.settings.outputMode)
					.onChange(async (value) => {
						this.plugin.settings.outputMode = value as OutputMode;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		// Output folder (for companion mode)
		if (this.plugin.settings.outputMode === "companion") {
			new Setting(containerEl)
				.setName("Output folder")
				.setDesc("Folder for companion notes.")
				.addText((text) =>
					text
						.setPlaceholder("PDF Notes")
						.setValue(this.plugin.settings.outputFolder)
						.onChange(async (value) => {
							this.plugin.settings.outputFolder = value;
							await this.plugin.saveSettings();
						})
				);
		}

		// Index path (for index mode)
		if (this.plugin.settings.outputMode === "index") {
			new Setting(containerEl)
				.setName("Index file path")
				.setDesc("Path for the index note.")
				.addText((text) =>
					text
						.setPlaceholder("PDF Index.md")
						.setValue(this.plugin.settings.indexPath)
						.onChange(async (value) => {
							this.plugin.settings.indexPath = value;
							await this.plugin.saveSettings();
						})
				);
		}

		// Auto-scan on open
		new Setting(containerEl)
			.setName("Auto-scan on vault open")
			.setDesc("Automatically scan for PDFs when opening the vault.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoScanOnOpen)
					.onChange(async (value) => {
						this.plugin.settings.autoScanOnOpen = value;
						await this.plugin.saveSettings();
					})
			);

		// Watch for new PDFs
		new Setting(containerEl)
			.setName("Watch for new PDFs")
			.setDesc("Automatically process new PDFs added to the vault.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.watchForNewPdfs)
					.onChange(async (value) => {
						this.plugin.settings.watchForNewPdfs = value;
						await this.plugin.saveSettings();
					})
			);

		// Overwrite existing
		new Setting(containerEl)
			.setName("Overwrite existing notes")
			.setDesc("Overwrite existing companion/sidecar notes when re-scanning.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.overwriteExisting)
					.onChange(async (value) => {
						this.plugin.settings.overwriteExisting = value;
						await this.plugin.saveSettings();
					})
			);

		// Companion template
		new Setting(containerEl)
			.setName("Companion note template")
			.setDesc("Template for companion notes. Placeholders: {{title}}, {{embed}}, {{thumbnail}}, {{annotations}}")
			.addTextArea((text) =>
				text
					.setPlaceholder("# {{title}}\n\n{{thumbnail}}\n\n{{embed}}\n\n## Notes\n\n")
					.setValue(this.plugin.settings.companionTemplate)
					.onChange(async (value) => {
						this.plugin.settings.companionTemplate = value;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "Thumbnails" });

		// Generate thumbnails
		new Setting(containerEl)
			.setName("Generate thumbnails")
			.setDesc("Generate thumbnail images from PDF first page.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.generateThumbnails)
					.onChange(async (value) => {
						this.plugin.settings.generateThumbnails = value;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (this.plugin.settings.generateThumbnails) {
			// Thumbnail mode
			new Setting(containerEl)
				.setName("Thumbnail mode")
				.setDesc("How to generate thumbnails.")
				.addDropdown((dropdown) =>
					dropdown
						.addOption("single", "Single page")
						.addOption("multiple", "Multiple pages")
						.addOption("gallery", "Gallery (select via command)")
						.setValue(this.plugin.settings.thumbnailMode)
						.onChange(async (value) => {
							this.plugin.settings.thumbnailMode = value as ThumbnailMode;
							await this.plugin.saveSettings();
							this.display();
						})
				);

			// Page number (for single mode)
			if (this.plugin.settings.thumbnailMode === "single") {
				new Setting(containerEl)
					.setName("Thumbnail page")
					.setDesc("Page number to use (0 = last page).")
					.addText((text) =>
						text
							.setPlaceholder("1")
							.setValue(this.plugin.settings.thumbnailPage.toString())
							.onChange(async (value) => {
								const num = parseInt(value) || 1;
								this.plugin.settings.thumbnailPage = num;
								await this.plugin.saveSettings();
							})
					);
			}

			// Page count (for multiple mode)
			if (this.plugin.settings.thumbnailMode === "multiple") {
				new Setting(containerEl)
					.setName("Pages to generate")
					.setDesc("Number of pages to generate thumbnails for.")
					.addText((text) =>
						text
							.setPlaceholder("3")
							.setValue(this.plugin.settings.thumbnailPageCount.toString())
							.onChange(async (value) => {
								const num = parseInt(value) || 3;
								this.plugin.settings.thumbnailPageCount = Math.max(1, Math.min(num, 20));
								await this.plugin.saveSettings();
							})
					);
			}

			// Thumbnail folder
			new Setting(containerEl)
				.setName("Thumbnail folder")
				.setDesc("Folder to store generated thumbnails.")
				.addText((text) =>
					text
						.setPlaceholder("attachments/pdf-thumbnails")
						.setValue(this.plugin.settings.thumbnailFolder)
						.onChange(async (value) => {
							this.plugin.settings.thumbnailFolder = value;
							await this.plugin.saveSettings();
						})
				);

			// Thumbnail scale
			new Setting(containerEl)
				.setName("Thumbnail scale")
				.setDesc(`Scale factor for thumbnails (${Math.round(this.plugin.settings.thumbnailScale * 100)}%)`)
				.addSlider((slider) =>
					slider
						.setLimits(0.1, 1.0, 0.1)
						.setValue(this.plugin.settings.thumbnailScale)
						.onChange(async (value) => {
							this.plugin.settings.thumbnailScale = value;
							await this.plugin.saveSettings();
							this.display();
						})
				);
		}

		// Rename template
		new Setting(containerEl)
			.setName("Rename template")
			.setDesc("Template for batch rename. Placeholders: {title}, {author}, {subject}, {year}, {keywords}, {pages}, {creator}")
			.addText((text) =>
				text
					.setPlaceholder("{author} - {title}")
					.setValue(this.plugin.settings.renameTemplate)
					.onChange(async (value) => {
						this.plugin.settings.renameTemplate = value;
						await this.plugin.saveSettings();
					})
			);

		// Annotations Section
		containerEl.createEl("h3", { text: "Annotations" });

		// Extract annotations toggle
		new Setting(containerEl)
			.setName("Extract annotations")
			.setDesc("Extract highlights, comments, and other annotations from PDFs.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.extractAnnotations)
					.onChange(async (value) => {
						this.plugin.settings.extractAnnotations = value;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (this.plugin.settings.extractAnnotations) {
			// Annotation types
			const allTypes: { type: AnnotationType; label: string }[] = [
				{ type: "Highlight", label: "Highlights" },
				{ type: "Underline", label: "Underlines" },
				{ type: "StrikeOut", label: "Strikethroughs" },
				{ type: "Squiggly", label: "Squiggly underlines" },
				{ type: "Text", label: "Comments (sticky notes)" },
				{ type: "FreeText", label: "Free text" },
				{ type: "Ink", label: "Ink drawings" },
			];

			new Setting(containerEl)
				.setName("Annotation types")
				.setDesc("Select which annotation types to extract.");

			for (const { type, label } of allTypes) {
				new Setting(containerEl)
					.setName(label)
					.addToggle((toggle) =>
						toggle
							.setValue(this.plugin.settings.annotationTypes.includes(type))
							.onChange(async (value) => {
								if (value) {
									if (!this.plugin.settings.annotationTypes.includes(type)) {
										this.plugin.settings.annotationTypes.push(type);
									}
								} else {
									this.plugin.settings.annotationTypes =
										this.plugin.settings.annotationTypes.filter((t) => t !== type);
								}
								await this.plugin.saveSettings();
							})
					)
					.settingEl.addClass("pdf-metadata-indent");
			}

			// Annotation grouping
			new Setting(containerEl)
				.setName("Group annotations by")
				.setDesc("How to organize annotations in companion notes.")
				.addDropdown((dropdown) =>
					dropdown
						.addOption("type", "Annotation type")
						.addOption("page", "Page number")
						.addOption("date", "Creation date")
						.addOption("flat", "No grouping (flat list)")
						.setValue(this.plugin.settings.annotationGrouping)
						.onChange(async (value) => {
							this.plugin.settings.annotationGrouping = value as AnnotationGrouping;
							await this.plugin.saveSettings();
						})
				);

			// Extract highlight text
			new Setting(containerEl)
				.setName("Extract highlighted text")
				.setDesc("Attempt to extract the text content from highlights.")
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.extractHighlightText)
						.onChange(async (value) => {
							this.plugin.settings.extractHighlightText = value;
							await this.plugin.saveSettings();
						})
				);

			// Include annotation colors
			new Setting(containerEl)
				.setName("Show annotation colors")
				.setDesc("Include color indicators in the output.")
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.includeAnnotationColors)
						.onChange(async (value) => {
							this.plugin.settings.includeAnnotationColors = value;
							await this.plugin.saveSettings();
						})
				);
		}
	}
}
