import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type PdfIntakePlugin from "./main";
import { isUsableLegacyTemplate } from "./filename-template";
import type { OutputLocation } from "./types";

function outputChoice(output: OutputLocation): string {
	if (output.mode === "current-folders") return "current-folders";
	return output.folderPath ? `folder:${output.folderPath}` : "vault-root";
}

function outputFromChoice(value: string): OutputLocation | null {
	if (value === "current-folders") return { mode: "current-folders" };
	if (value === "vault-root") return { mode: "vault-folder", folderPath: "" };
	if (value.startsWith("folder:")) return { mode: "vault-folder", folderPath: value.slice(7) };
	return null;
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
		containerEl.createEl("h3", { text: "Defaults" });
		const stored = this.plugin.store.getSettings();
		const writable = this.plugin.store.getStatus().writable;
		const diagnostics = this.plugin.store.getDiagnostics();
		for (const diagnostic of diagnostics) {
			containerEl.createEl("p", {
				text: diagnostic.message,
				cls: "pdf-intake-persistence-warning",
			});
		}

		let policyPending = false;
		new Setting(containerEl)
			.setName("Workspace edits")
			.setDesc("Choose whether setup changes also become defaults for future sessions.")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("future-sessions", "Keep them for future sessions")
					.addOption("session-only", "Use them only for the current session")
					.setValue(stored.workspaceEditPolicy)
					.setDisabled(!writable || policyPending)
					.onChange(async (value) => {
						if (value !== "future-sessions" && value !== "session-only") return;
						policyPending = true;
						dropdown.setDisabled(true);
						try {
							await this.plugin.store.updateSettings({
								workspaceEditPolicy: value,
							});
						} catch (error) {
							new Notice(`Could not save workspace edit policy: ${errorText(error)}`);
						} finally {
							policyPending = false;
							this.display();
						}
					});
			});

		const folders = this.app.vault
			.getAllFolders()
			.map((folder) => folder.path)
			.filter(Boolean);
		const currentChoice = outputChoice(stored.defaults.output);
		const missingFolderPath =
			stored.defaults.output.mode === "vault-folder" &&
			stored.defaults.output.folderPath &&
			!folders.includes(stored.defaults.output.folderPath)
				? stored.defaults.output.folderPath
				: undefined;
		new Setting(containerEl)
			.setName("Default output")
			.setDesc(this.outputDescription(stored.defaults.output, folders))
			.addDropdown((dropdown) => {
				dropdown
					.addOption("current-folders", "Keep each PDF in its current folder")
					.addOption("vault-root", "Vault root")
					.addOptions(
						Object.fromEntries(folders.map((folder) => [`folder:${folder}`, folder])),
					);
				if (missingFolderPath)
					dropdown.addOption(currentChoice, `Unavailable: ${missingFolderPath}`);
				dropdown
					.setValue(currentChoice)
					.setDisabled(!writable)
					.onChange(async (value) => {
						const output = outputFromChoice(value);
						if (!output) return;
						try {
							await this.plugin.store.updateSettings({ defaults: { output } });
							this.display();
						} catch (error) {
							new Notice(`Could not save default output: ${errorText(error)}`);
							this.display();
						}
					});
			});

		if (
			currentChoice.startsWith("folder:") &&
			!folders.includes(
				stored.defaults.output.mode === "vault-folder"
					? stored.defaults.output.folderPath
					: "",
			)
		) {
			const path =
				stored.defaults.output.mode === "vault-folder"
					? stored.defaults.output.folderPath
					: "";
			new Setting(containerEl)
				.setName("Unavailable default folder")
				.setDesc(
					`${path || "Vault root"} is no longer an available folder. Choose another existing destination.`,
				);
		}

		const naming = stored.defaults.metadataAndNaming.filenameFormat;
		const factoryDescription = "First author family [et al.] (year). title";
		new Setting(containerEl)
			.setName("Default filename convention")
			.setDesc(
				naming.kind === "legacy-template"
					? "A valid migrated or user-authored template is kept exactly."
					: `Factory format: ${factoryDescription}. Enter a valid custom template to replace it.`,
			)
			.addText((text) => {
				text.setPlaceholder("{author} - {year} - {title}")
					.setValue(naming.kind === "legacy-template" ? naming.template : "")
					.setDisabled(!writable);
				const commit = async (): Promise<void> => {
					const value = text.inputEl.value;
					if (
						!isUsableLegacyTemplate(value) ||
						(naming.kind === "legacy-template" && value === naming.template)
					)
						return;
					try {
						await this.plugin.store.updateSettings({
							defaults: {
								metadataAndNaming: {
									filenameFormat: { kind: "legacy-template", template: value },
								},
							},
						});
					} catch (error) {
						new Notice(
							`Could not save default filename convention: ${errorText(error)}`,
						);
					}
				};
				text.inputEl.addEventListener("blur", () => void commit());
				text.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
					if (event.key === "Enter") {
						event.preventDefault();
						void commit();
					}
				});
				return text;
			});

		if (this.plugin.store.getDraftNamespace() !== null) {
			containerEl.createEl("p", {
				text: "Saved PDF Intake session data needs a decision in PDF Intake.",
			});
		}
	}

	private outputDescription(output: OutputLocation, folders: readonly string[]): string {
		if (output.mode === "current-folders")
			return "Each PDF stays beside its current source file.";
		if (output.folderPath === "") return "Future sessions will place PDFs at the vault root.";
		return folders.includes(output.folderPath)
			? `Future sessions will use ${output.folderPath}.`
			: `The saved folder ${output.folderPath} is unavailable; choose an existing folder.`;
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
