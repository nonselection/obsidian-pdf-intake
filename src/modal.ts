import { App, Modal, TFile, Vault, Notice } from "obsidian";
import { PdfMetadata, PdfAnnotation, AnnotationType } from "./types";
import { RenamePreview, executeRename } from "./renamer";
import { DuplicateGroup, formatSize, formatDuplicateStats } from "./duplicates";
import { writeMetadataToPdf } from "./writeback";
import { getAnnotationStats } from "./annotations";

export class PdfMetadataModal extends Modal {
	metadata: PdfMetadata;
	pdfFile: TFile | null;
	vault: Vault;

	constructor(app: App, metadata: PdfMetadata, pdfFile?: TFile) {
		super(app);
		this.metadata = metadata;
		this.pdfFile = pdfFile || null;
		this.vault = app.vault;
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

export class RenamePreviewModal extends Modal {
	previews: RenamePreview[];
	vault: Vault;
	onComplete: (renamed: number) => void;

	constructor(
		app: App,
		previews: RenamePreview[],
		vault: Vault,
		onComplete: (renamed: number) => void
	) {
		super(app);
		this.previews = previews;
		this.vault = vault;
		this.onComplete = onComplete;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("pdf-metadata-modal");

		contentEl.createEl("h2", { text: "Batch Rename Preview" });

		const validCount = this.previews.filter((p) => !p.skip && !p.conflict).length;
		const skipCount = this.previews.filter((p) => p.skip).length;
		const conflictCount = this.previews.filter((p) => p.conflict).length;

		contentEl.createEl("p", {
			text: `${validCount} file(s) to rename, ${skipCount} skipped, ${conflictCount} conflict(s)`,
			cls: "pdf-rename-summary",
		});

		const table = contentEl.createEl("table", { cls: "pdf-rename-table" });
		const header = table.createEl("tr");
		header.createEl("th", { text: "Current Name" });
		header.createEl("th", { text: "New Name" });
		header.createEl("th", { text: "Status" });

		for (const preview of this.previews) {
			const row = table.createEl("tr");

			row.createEl("td", { text: preview.oldName, cls: "pdf-rename-old" });
			row.createEl("td", { text: preview.newName, cls: "pdf-rename-new" });

			let status = "✓";
			let statusCls = "pdf-rename-ok";

			if (preview.skip) {
				status = `⏭ ${preview.skipReason || "Skipped"}`;
				statusCls = "pdf-rename-skip";
			} else if (preview.conflict) {
				status = "⚠ Conflict";
				statusCls = "pdf-rename-conflict";
			}

			row.createEl("td", { text: status, cls: statusCls });
		}

		const buttonContainer = contentEl.createDiv({ cls: "pdf-rename-buttons" });

		const renameBtn = buttonContainer.createEl("button", {
			text: `Rename ${validCount} file(s)`,
			cls: "mod-cta",
		});
		renameBtn.disabled = validCount === 0;
		renameBtn.addEventListener("click", () => this.executeRenames());

		const cancelBtn = buttonContainer.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());
	}

	private async executeRenames(): Promise<void> {
		let renamed = 0;

		for (const preview of this.previews) {
			if (await executeRename(preview, this.vault)) {
				renamed++;
			}
		}

		this.onComplete(renamed);
		this.close();
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}

export class DuplicatesModal extends Modal {
	groups: DuplicateGroup[];
	vault: Vault;

	constructor(app: App, groups: DuplicateGroup[], vault: Vault) {
		super(app);
		this.groups = groups;
		this.vault = vault;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("pdf-metadata-modal", "pdf-duplicates-modal");

		contentEl.createEl("h2", { text: "Duplicate PDFs" });

		if (this.groups.length === 0) {
			contentEl.createEl("p", { text: "No duplicates found." });
			return;
		}

		contentEl.createEl("p", {
			text: formatDuplicateStats(this.groups),
			cls: "pdf-duplicates-summary",
		});

		for (const group of this.groups) {
			const groupEl = contentEl.createDiv({ cls: "pdf-duplicate-group" });

			groupEl.createEl("h3", {
				text: `${group.files.length} identical files (${formatSize(group.files[0].stat.size)} each)`,
			});

			const list = groupEl.createEl("ul", { cls: "pdf-duplicate-list" });

			for (const file of group.files) {
				const item = list.createEl("li");
				item.createEl("span", { text: file.path, cls: "pdf-duplicate-path" });

				const actions = item.createDiv({ cls: "pdf-duplicate-actions" });

				const openBtn = actions.createEl("button", { text: "Open" });
				openBtn.addEventListener("click", () => {
					this.app.workspace.openLinkText(file.path, "");
				});

				const deleteBtn = actions.createEl("button", {
					text: "Delete",
					cls: "mod-warning",
				});
				deleteBtn.addEventListener("click", async () => {
					await this.vault.trash(file, true);
					item.remove();
				});
			}
		}
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}

export class WritebackModal extends Modal {
	pdfFile: TFile;
	metadata: Partial<PdfMetadata>;
	vault: Vault;
	onComplete: () => void;

	constructor(
		app: App,
		pdfFile: TFile,
		metadata: Partial<PdfMetadata>,
		onComplete: () => void
	) {
		super(app);
		this.pdfFile = pdfFile;
		this.metadata = metadata;
		this.vault = app.vault;
		this.onComplete = onComplete;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("pdf-metadata-modal");

		contentEl.createEl("h2", { text: "Write Metadata to PDF" });

		contentEl.createEl("p", {
			text: `This will write the following metadata to "${this.pdfFile.name}":`,
		});

		const list = contentEl.createEl("ul", { cls: "pdf-writeback-list" });

		if (this.metadata.title) {
			list.createEl("li", { text: `Title: ${this.metadata.title}` });
		}
		if (this.metadata.author) {
			list.createEl("li", { text: `Author: ${this.metadata.author}` });
		}
		if (this.metadata.subject) {
			list.createEl("li", { text: `Subject: ${this.metadata.subject}` });
		}
		if (this.metadata.keywords?.length) {
			list.createEl("li", { text: `Keywords: ${this.metadata.keywords.join(", ")}` });
		}

		contentEl.createEl("p", {
			text: "This action will modify the PDF file. Continue?",
			cls: "pdf-writeback-warning",
		});

		const buttonContainer = contentEl.createDiv({ cls: "pdf-rename-buttons" });

		const writeBtn = buttonContainer.createEl("button", {
			text: "Write to PDF",
			cls: "mod-cta",
		});
		writeBtn.addEventListener("click", () => this.executeWriteback());

		const cancelBtn = buttonContainer.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());
	}

	private async executeWriteback(): Promise<void> {
		try {
			await writeMetadataToPdf(this.pdfFile, this.metadata, this.vault);
			new Notice(`Metadata written to ${this.pdfFile.name}`);
			this.onComplete();
		} catch (error) {
			new Notice(`Failed to write metadata: ${error}`);
		}
		this.close();
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}

export class PdfAnnotationsModal extends Modal {
	annotations: PdfAnnotation[];
	pdfFile: TFile;

	constructor(app: App, annotations: PdfAnnotation[], pdfFile: TFile) {
		super(app);
		this.annotations = annotations;
		this.pdfFile = pdfFile;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("pdf-metadata-modal", "pdf-annotations-modal");

		contentEl.createEl("h2", { text: `Annotations: ${this.pdfFile.name}` });

		if (this.annotations.length === 0) {
			contentEl.createEl("p", {
				text: "No annotations found in this PDF.",
				cls: "pdf-annotations-empty",
			});
			return;
		}

		// Stats summary
		const stats = getAnnotationStats(this.annotations);
		const statParts: string[] = [];
		for (const [type, count] of Object.entries(stats)) {
			if (count > 0) {
				statParts.push(`${count} ${this.getTypeName(type as AnnotationType)}`);
			}
		}
		contentEl.createEl("p", {
			text: statParts.join(", "),
			cls: "pdf-annotations-summary",
		});

		// Group by type
		const groups = new Map<AnnotationType, PdfAnnotation[]>();
		for (const annot of this.annotations) {
			const group = groups.get(annot.type) || [];
			group.push(annot);
			groups.set(annot.type, group);
		}

		const typeOrder: AnnotationType[] = [
			"Highlight",
			"Underline",
			"StrikeOut",
			"Squiggly",
			"Text",
			"FreeText",
			"Ink",
		];

		for (const type of typeOrder) {
			const group = groups.get(type);
			if (!group || group.length === 0) continue;

			const section = contentEl.createDiv({ cls: "pdf-annotation-section" });
			section.createEl("h3", { text: this.getTypeName(type) });

			const list = section.createEl("ul", { cls: "pdf-annotation-list" });

			for (const annot of group) {
				const item = list.createEl("li", { cls: "pdf-annotation-item" });

				// Color badge
				if (annot.color) {
					const colorBadge = item.createSpan({ cls: "pdf-annotation-color" });
					colorBadge.style.backgroundColor = this.rgbToHex(annot.color);
				}

				// Content
				const content = item.createSpan({ cls: "pdf-annotation-content" });
				if (annot.extractedText) {
					content.createEl("q", { text: annot.extractedText });
				} else if (annot.contents) {
					content.setText(annot.contents);
				} else {
					content.setText("(No text content)");
					content.addClass("pdf-annotation-empty");
				}

				// Page reference
				item.createSpan({
					text: `p. ${annot.pageNumber}`,
					cls: "pdf-annotation-page",
				});

				// Copy button
				const copyBtn = item.createEl("button", {
					text: "Copy",
					cls: "pdf-annotation-copy",
				});
				copyBtn.addEventListener("click", () => {
					const text = annot.extractedText || annot.contents || "";
					navigator.clipboard.writeText(text);
					new Notice("Copied to clipboard");
				});
			}
		}
	}

	private getTypeName(type: AnnotationType): string {
		const names: Record<AnnotationType, string> = {
			Highlight: "Highlights",
			Underline: "Underlines",
			StrikeOut: "Strikethroughs",
			Squiggly: "Squiggly Underlines",
			FreeText: "Free Text",
			Text: "Comments",
			Ink: "Drawings",
		};
		return names[type] || type;
	}

	private rgbToHex(color: number[]): string {
		if (color.length < 3) return "#ffff00";
		const normalize = (v: number) => (v <= 1 ? Math.round(v * 255) : Math.round(v));
		const r = normalize(color[0]);
		const g = normalize(color[1]);
		const b = normalize(color[2]);
		return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}
