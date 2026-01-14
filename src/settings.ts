import { App, PluginSettingTab, Setting } from "obsidian";
import type PdfMetadataPlugin from "./main";
import { OutputMode } from "./types";

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
			.setDesc("Template for companion notes. Use {{title}} and {{embed}} as placeholders.")
			.addTextArea((text) =>
				text
					.setPlaceholder("# {{title}}\n\n{{embed}}\n\n## Notes\n\n")
					.setValue(this.plugin.settings.companionTemplate)
					.onChange(async (value) => {
						this.plugin.settings.companionTemplate = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
