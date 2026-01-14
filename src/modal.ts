import { App, Modal } from "obsidian";
import { PdfMetadata } from "./types";

export class PdfMetadataModal extends Modal {
	metadata: PdfMetadata;

	constructor(app: App, metadata: PdfMetadata) {
		super(app);
		this.metadata = metadata;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("pdf-metadata-modal");

		const title = this.metadata.title || this.getFileName();
		contentEl.createEl("h2", { text: title });

		const table = contentEl.createEl("table", { cls: "pdf-metadata-table" });

		this.addRow(table, "File", this.metadata.filePath);
		this.addRow(table, "Title", this.metadata.title);
		this.addRow(table, "Author", this.metadata.author);
		this.addRow(table, "Subject", this.metadata.subject);
		this.addRow(table, "Keywords", this.metadata.keywords?.join(", "));
		this.addRow(table, "Creator", this.metadata.creator);
		this.addRow(table, "Producer", this.metadata.producer);
		this.addRow(table, "Created", this.formatDate(this.metadata.creationDate));
		this.addRow(table, "Modified", this.formatDate(this.metadata.modificationDate));
		this.addRow(table, "Pages", this.metadata.pageCount > 0 ? this.metadata.pageCount.toString() : undefined);
		this.addRow(table, "File size", this.formatFileSize(this.metadata.fileSize));
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}

	private addRow(table: HTMLTableElement, label: string, value?: string): void {
		if (!value) return;

		const row = table.createEl("tr");
		row.createEl("td", { text: label, cls: "pdf-metadata-label" });
		row.createEl("td", { text: value, cls: "pdf-metadata-value" });
	}

	private getFileName(): string {
		const parts = this.metadata.filePath.split("/");
		return parts[parts.length - 1];
	}

	private formatDate(date?: Date): string | undefined {
		if (!date) return undefined;
		return date.toLocaleDateString() + " " + date.toLocaleTimeString();
	}

	private formatFileSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}
}
