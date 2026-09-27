import { AbstractInputSuggest, App, Notice, PluginSettingTab, Setting, TFolder } from "obsidian";
import type PdfIntakePlugin from "./main";

class VaultFolderSuggest extends AbstractInputSuggest<TFolder> {
	private onPicked: (folder: TFolder) => void;

	constructor(app: App, input: HTMLInputElement, onPicked: (folder: TFolder) => void) {
		super(app, input);
		this.onPicked = onPicked;
	}

	protected getSuggestions(query: string): TFolder[] {
		const folders = this.app.vault.getAllFolders();
		const normalized = query.trim().toLocaleLowerCase();
		return normalized
			? folders.filter((folder) => folder.path.toLocaleLowerCase().includes(normalized))
			: folders;
	}

	renderSuggestion(folder: TFolder, element: HTMLElement): void {
		element.setText(folder.path);
	}

	selectSuggestion(folder: TFolder): void {
		this.setValue(folder.path);
		this.onPicked(folder);
		this.close();
	}
}

export class IntakeSettingTab extends PluginSettingTab {
	plugin: PdfIntakePlugin;
	constructor(app: App, plugin: PdfIntakePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "PDF Intake" });
		const settings = this.plugin.settings;

		const intakeSetting = new Setting(containerEl)
			.setName("Intake folder")
			.setDesc(this.folderDescription(settings.intakeFolder, "PDFs eligible for intake"));
		intakeSetting.addText((text) => {
			text.setPlaceholder("Inbox")
				.setValue(settings.intakeFolder)
				.onChange(async (value) => {
					settings.intakeFolder = value.trim().replace(/^\/+|\/+$/g, "");
					intakeSetting.setDesc(
						this.folderDescription(settings.intakeFolder, "PDFs eligible for intake"),
					);
					await this.plugin.saveSettings();
				});
			new VaultFolderSuggest(this.app, text.inputEl, (folder) => {
				text.setValue(folder.path);
				settings.intakeFolder = folder.path;
				intakeSetting.setDesc(
					this.folderDescription(settings.intakeFolder, "PDFs eligible for intake"),
				);
				void this.plugin
					.saveSettings()
					.catch(
						(error: unknown) => new Notice(`Failed to save settings: ${String(error)}`),
					);
			});
			return text;
		});

		new Setting(containerEl)
			.setName("Processed files")
			.setDesc(
				"Keep renamed PDFs in the intake folder or move them to another existing folder.",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("intake", "Keep in intake folder")
					.addOption("another", "Move to another folder")
					.setValue(settings.processedFolderMode)
					.onChange(async (value) => {
						settings.processedFolderMode = value as typeof settings.processedFolderMode;
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		if (settings.processedFolderMode === "another") {
			const processedSetting = new Setting(containerEl)
				.setName("Processed folder")
				.setDesc(this.folderDescription(settings.processedFolder, "processed PDFs"));
			processedSetting.addText((text) => {
				text.setPlaceholder("Sources/Processed")
					.setValue(settings.processedFolder)
					.onChange(async (value) => {
						settings.processedFolder = value.trim().replace(/^\/+|\/+$/g, "");
						processedSetting.setDesc(
							this.folderDescription(settings.processedFolder, "processed PDFs"),
						);
						await this.plugin.saveSettings();
					});
				new VaultFolderSuggest(this.app, text.inputEl, (folder) => {
					text.setValue(folder.path);
					settings.processedFolder = folder.path;
					processedSetting.setDesc(
						this.folderDescription(settings.processedFolder, "processed PDFs"),
					);
					void this.plugin
						.saveSettings()
						.catch(
							(error: unknown) =>
								new Notice(`Failed to save settings: ${String(error)}`),
						);
				});
				return text;
			});
		}

		new Setting(containerEl)
			.setName("Filename template")
			.setDesc("Placeholders: {title}, {author}, {authors}, {year}, {journal}, {publisher}")
			.addText((text) =>
				text
					.setPlaceholder("{author} - {title} ({year})")
					.setValue(settings.renameTemplate)
					.onChange(async (value) => {
						settings.renameTemplate = value;
						await this.plugin.saveSettings();
					}),
			);
	}

	private folderDescription(path: string, purpose: string): string {
		if (!path || !this.app.vault.getAllFolders().some((folder) => folder.path === path)) {
			return `Vault-relative folder for ${purpose}. Folder does not exist; processing is blocked until you choose an existing folder.`;
		}
		return `Existing vault folder for ${purpose}. Type to search existing folders.`;
	}
}
