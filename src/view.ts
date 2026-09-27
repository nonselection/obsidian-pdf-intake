import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import type PdfIntakePlugin from "./main";
import { resolveBibliographicMetadata } from "./resolver";
import {
	filesInIntakeFolder,
	planEntries,
	processEntry,
	validateIntakeFolder,
	validateProcessedFolder,
} from "./intake";
import type { BibliographicMetadata, IntakeEntry, IntakeStatus } from "./types";

export const PDF_INTAKE_VIEW_TYPE = "pdf-intake-view";

export class PdfIntakeView extends ItemView {
	private plugin: PdfIntakePlugin;
	private entries: IntakeEntry[] = [];
	private folderError?: string;
	private processedFolderError?: string;
	private working = false;

	constructor(leaf: WorkspaceLeaf, plugin: PdfIntakePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return PDF_INTAKE_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "PDF Intake";
	}

	getIcon(): string {
		return "inbox";
	}

	async onOpen(): Promise<void> {
		this.containerEl.addClass("pdf-intake-view");
		await this.refresh();
	}

	onClose(): Promise<void> {
		this.containerEl.removeClass("pdf-intake-view");
		return Promise.resolve();
	}

	refresh(): Promise<void> {
		const settings = this.plugin.settings;
		const folders = this.app.vault.getAllFolders().map((folder) => folder.path);
		const intakeValidation = validateIntakeFolder(settings.intakeFolder, folders);
		const processedValidation = validateProcessedFolder(
			settings.processedFolderMode,
			settings.processedFolder,
			folders,
		);
		const scan = filesInIntakeFolder(
			this.app.vault.getFiles(),
			settings.intakeFolder,
			folders,
			settings.processedFolderMode,
			settings.processedFolder,
		);
		this.folderError = intakeValidation.error ?? scan.error;
		this.processedFolderError = processedValidation.error;
		if (!intakeValidation.valid || !scan.valid) {
			this.entries = [];
			this.render();
			return Promise.resolve();
		}

		const prior = new Map(this.entries.map((entry) => [entry.file.path, entry]));
		this.entries = scan.files.map((file) => {
			const existing = prior.get(file.path);
			return (
				existing ?? {
					file,
					selected: false,
					status: "unprocessed",
					manualIdentifier: "",
				}
			);
		});
		this.replan();
		this.render();
		return Promise.resolve();
	}

	private replan(): void {
		planEntries(
			this.entries,
			this.plugin.settings,
			this.app.vault.getFiles().map((file) => file.path),
			this.app.vault.getAllFolders().map((folder) => folder.path),
		);
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		const header = contentEl.createDiv({ cls: "pdf-intake-header" });
		header.createEl("h2", { text: "PDF Intake" });
		const actions = header.createDiv({ cls: "pdf-intake-actions" });
		this.addButton(actions, "Select all", () => {
			for (const entry of this.entries) entry.selected = true;
			this.render();
		});
		this.addButton(actions, "Select none", () => {
			for (const entry of this.entries) entry.selected = false;
			this.render();
		});
		this.addButton(actions, "Resolve selected", () => void this.resolveSelected());
		const processButton = this.addButton(
			actions,
			"Process selected ready files",
			() => void this.processSelected(),
		);
		processButton.disabled = this.working || !!this.processedFolderError;
		this.addButton(actions, "Refresh", () => void this.refresh());

		if (this.folderError) {
			contentEl.createEl("p", { text: this.folderError, cls: "pdf-intake-error" });
			contentEl.createEl("p", {
				text: "Choose an existing vault folder in PDF Intake settings. No files were scanned.",
			});
			return;
		}
		if (this.processedFolderError) {
			contentEl.createEl("p", { text: this.processedFolderError, cls: "pdf-intake-error" });
			contentEl.createEl("p", {
				text: "Processing is blocked until you choose an existing processed folder. Resolution and preview remain available.",
			});
		}
		if (this.entries.length === 0) {
			contentEl.createEl("p", {
				text: `No PDFs found in ${this.plugin.settings.intakeFolder}.`,
			});
			return;
		}
		const list = contentEl.createDiv({ cls: "pdf-intake-list" });
		for (const entry of this.entries) this.renderEntry(list, entry);
	}

	private renderEntry(list: HTMLElement, entry: IntakeEntry): void {
		const card = list.createDiv({ cls: `pdf-intake-card is-${entry.status}` });
		const top = card.createDiv({ cls: "pdf-intake-card-top" });
		const selectLabel = top.createEl("label", { cls: "pdf-intake-selection" });
		const checkbox = selectLabel.createEl("input", { type: "checkbox" });
		checkbox.checked = entry.selected;
		checkbox.disabled = this.working || entry.status === "processed";
		checkbox.addEventListener("change", () => {
			entry.selected = checkbox.checked;
			this.render();
		});
		top.createEl("span", { text: entry.file.name, cls: "pdf-intake-file-name" });
		top.createEl("span", { text: this.statusLabel(entry.status), cls: "pdf-intake-status" });

		const paths = card.createDiv({ cls: "pdf-intake-paths" });
		this.addDetail(paths, "Current", entry.file.path);
		if (entry.finalPath) this.addDetail(paths, "Will become", entry.finalPath);

		if (entry.metadata) this.renderMetadata(card, entry.metadata);
		if (entry.error) card.createEl("p", { text: entry.error, cls: "pdf-intake-error" });
		if (entry.status === "unresolved" || entry.status === "error")
			this.renderManualResolution(card, entry);
	}

	private renderMetadata(card: HTMLElement, metadata: BibliographicMetadata): void {
		const details = card.createDiv({ cls: "pdf-intake-metadata" });
		this.addDetail(details, "Identifier", metadata.doi ?? metadata.isbn ?? "Not detected");
		this.addDetail(details, "Provider", metadata.source ?? "—");
		this.addDetail(details, "Title", metadata.title ?? "—");
		this.addDetail(details, "First author", metadata.firstAuthor ?? "—");
		this.addDetail(details, "Year", metadata.year?.toString() ?? "—");
	}

	private renderManualResolution(card: HTMLElement, entry: IntakeEntry): void {
		const form = card.createDiv({ cls: "pdf-intake-manual" });
		const input = form.createEl("input", {
			type: "text",
			placeholder: "DOI or ISBN",
			value: entry.manualIdentifier,
		});
		input.setAttribute("aria-label", `Manual DOI or ISBN for ${entry.file.name}`);
		input.disabled = this.working;
		const resolve = form.createEl("button", { text: "Resolve" });
		resolve.disabled = this.working || !entry.manualIdentifier.trim();
		input.addEventListener("input", () => {
			entry.manualIdentifier = input.value;
			resolve.disabled = this.working || !entry.manualIdentifier.trim();
		});
		resolve.addEventListener(
			"click",
			() => void this.resolveEntry(entry, entry.manualIdentifier),
		);
	}

	private addDetail(container: HTMLElement, label: string, value: string): void {
		const detail = container.createDiv({ cls: "pdf-intake-detail" });
		detail.createEl("span", { text: label, cls: "pdf-intake-detail-label" });
		detail.createEl("span", { text: value, cls: "pdf-intake-detail-value" });
	}

	private addButton(
		container: HTMLElement,
		label: string,
		action: () => void,
	): HTMLButtonElement {
		const button = container.createEl("button", { text: label });
		button.disabled = this.working;
		button.addEventListener("click", action);
		return button;
	}

	private async resolveSelected(): Promise<void> {
		for (const entry of this.entries) {
			if (!entry.selected || entry.status === "processed" || entry.status === "resolving")
				continue;
			await this.resolveEntry(
				entry,
				entry.manualIdentifier.trim() ? entry.manualIdentifier : undefined,
			);
		}
	}

	private async resolveEntry(entry: IntakeEntry, manualIdentifier?: string): Promise<void> {
		if (this.working) return;
		this.working = true;
		entry.status = "resolving";
		entry.error = undefined;
		this.render();
		try {
			entry.metadata = await resolveBibliographicMetadata(
				entry.file,
				this.app.vault,
				manualIdentifier,
			);
			entry.status = entry.metadata.status === "resolved" ? "ready" : entry.metadata.status;
			if (entry.metadata.status === "resolved") entry.manualIdentifier = "";
			this.replan();
		} catch (error) {
			entry.status = "error";
			entry.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.working = false;
			this.render();
		}
	}

	private async processSelected(): Promise<void> {
		if (this.working) return;
		const folders = this.app.vault.getAllFolders().map((folder) => folder.path);
		const intakeValidation = validateIntakeFolder(this.plugin.settings.intakeFolder, folders);
		const processedValidation = validateProcessedFolder(
			this.plugin.settings.processedFolderMode,
			this.plugin.settings.processedFolder,
			folders,
		);
		this.folderError = intakeValidation.error;
		this.processedFolderError = processedValidation.error;
		if (!intakeValidation.valid || !processedValidation.valid) {
			new Notice(
				intakeValidation.error ??
					processedValidation.error ??
					"Configure valid intake and processed folders first.",
			);
			this.render();
			return;
		}

		this.replan();
		const selected = this.entries.filter((entry) => entry.selected && entry.status === "ready");
		if (!selected.length) {
			new Notice("Select at least one ready PDF to process.");
			this.render();
			return;
		}

		this.working = true;
		this.render();
		let processed = 0;
		for (const entry of selected) {
			if (await processEntry(entry, this.app.vault)) processed++;
			this.replan();
			this.render();
		}
		this.working = false;
		this.render();
		new Notice(`Processed ${processed} of ${selected.length} selected PDF(s).`);
	}

	private statusLabel(status: IntakeStatus): string {
		const labels: Record<IntakeStatus, string> = {
			unprocessed: "Unprocessed",
			resolving: "Resolving…",
			ready: "Ready to process",
			unresolved: "Unresolved",
			conflict: "Conflict",
			error: "Error",
			processed: "Processed",
			unchanged: "Already at destination",
		};
		return labels[status];
	}
}
