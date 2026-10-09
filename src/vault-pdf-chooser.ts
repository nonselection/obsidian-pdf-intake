import { Modal, Notice, TFile, TFolder, type App } from "obsidian";
import type { PdfAdmissionResult, SessionCoordinator } from "./session";

function isDirectVaultChild(parent: TFolder, path: string): boolean {
	if (!path || path.startsWith("/") || path.includes("\\")) return false;
	const parts = path.split("/");
	if (parts.some((part) => !part || part === "." || part === "..")) return false;
	const prefix = parent.isRoot() ? "" : `${parent.path}/`;
	if (!path.startsWith(prefix)) return false;
	return !path.slice(prefix.length).includes("/");
}

/** A one-invocation vault browser. It owns paths only, never accepted membership. */
export class VaultPdfChooserModal extends Modal {
	private readonly coordinator: SessionCoordinator;
	private readonly expectedSessionId: string;
	private readonly onDismiss: () => void;
	private currentFolder!: TFolder;
	private selectedPaths = new Set<string>();
	private selectionCountElement?: HTMLElement;
	private confirmButton?: HTMLButtonElement;
	private dismissed = false;

	constructor(
		app: App,
		coordinator: SessionCoordinator,
		expectedSessionId: string,
		onDismiss: () => void = () => undefined,
	) {
		super(app);
		this.coordinator = coordinator;
		this.expectedSessionId = expectedSessionId;
		this.onDismiss = onDismiss;
	}

	override onOpen(): void {
		this.currentFolder = this.app.vault.getRoot();
		this.selectedPaths = new Set<string>();
		this.dismissed = false;
		this.setTitle("Add PDFs");
		this.render();
	}

	override onClose(): void {
		this.selectedPaths.clear();
		this.currentFolder = this.app.vault.getRoot();
		this.contentEl.empty();
		this.selectionCountElement = undefined;
		this.confirmButton = undefined;
		if (!this.dismissed) {
			this.dismissed = true;
			this.onDismiss();
		}
	}

	private render(): void {
		this.contentEl.empty();
		this.contentEl.addClass("pdf-intake-pdf-chooser");
		const activeFolder = this.resolveCurrentFolder();
		this.currentFolder = activeFolder;
		this.renderBreadcrumbs();

		const list = this.contentEl.createDiv({ cls: "pdf-intake-chooser-list" });
		const folders = activeFolder.children.filter(
			(child): child is TFolder =>
				child instanceof TFolder &&
				child.parent === activeFolder &&
				isDirectVaultChild(activeFolder, child.path) &&
				this.app.vault.getAbstractFileByPath(child.path) === child,
		);
		const pdfs = activeFolder.children.filter(
			(child): child is TFile =>
				child instanceof TFile &&
				child.parent === activeFolder &&
				isDirectVaultChild(activeFolder, child.path) &&
				child.extension.toLowerCase() === "pdf" &&
				this.app.vault.getAbstractFileByPath(child.path) === child,
		);

		for (const folder of folders) {
			const button = list.createEl("button", {
				text: folder.name,
				cls: "pdf-intake-chooser-folder",
			});
			button.setAttribute("aria-label", `Open folder ${folder.path}`);
			button.addEventListener("click", () => {
				if (
					folder.parent !== this.currentFolder ||
					!this.currentFolder.children.includes(folder) ||
					!isDirectVaultChild(this.currentFolder, folder.path) ||
					this.app.vault.getAbstractFileByPath(folder.path) !== folder
				)
					return;
				this.currentFolder = folder;
				this.render();
			});
		}

		for (const file of pdfs) this.renderPdfChoice(list, file);
		if (pdfs.length === 0) {
			list.createEl("p", {
				text: "No PDFs in this folder.",
				cls: "pdf-intake-muted pdf-intake-chooser-empty",
			});
		}

		const footer = this.contentEl.createDiv({ cls: "pdf-intake-chooser-actions" });
		this.selectionCountElement = footer.createEl("p", {
			text: `${this.selectedPaths.size} selected`,
			cls: "pdf-intake-muted pdf-intake-chooser-selection-count",
		});
		const cancel = footer.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.close());
		this.confirmButton = footer.createEl("button", {
			text: "Add selected PDFs",
			cls: "mod-cta",
		});
		this.confirmButton.disabled = this.selectedPaths.size === 0;
		this.confirmButton.setAttribute("aria-disabled", String(this.confirmButton.disabled));
		this.confirmButton.addEventListener("click", () => this.confirmSelection());
	}

	private renderBreadcrumbs(): void {
		const nav = this.contentEl.createEl("nav", { cls: "pdf-intake-chooser-breadcrumbs" });
		nav.setAttribute("aria-label", "Vault folder path");
		const root = this.app.vault.getRoot();
		const rootButton = nav.createEl("button", { text: "Vault root" });
		rootButton.disabled = this.currentFolder === root;
		rootButton.addEventListener("click", () => {
			this.currentFolder = root;
			this.render();
		});
		const breadcrumbFolders = [
			...this.ancestorsOf(this.currentFolder),
			...(this.currentFolder.isRoot() ? [] : [this.currentFolder]),
		];
		for (const folder of breadcrumbFolders) {
			const crumb = nav.createEl("button", { text: folder.name });
			crumb.disabled = folder === this.currentFolder;
			crumb.setAttribute("aria-label", `Open folder ${folder.path}`);
			crumb.addEventListener("click", () => {
				if (this.isAncestor(folder, this.currentFolder)) {
					this.currentFolder = folder;
					this.render();
				}
			});
		}
	}

	private renderPdfChoice(list: HTMLElement, file: TFile): void {
		const path = file.path;
		const filename = file.name;
		const parentPath = !file.parent || file.parent.isRoot() ? "Vault root" : file.parent.path;
		const row = list.createEl("label", { cls: "pdf-intake-chooser-pdf" });
		const checkbox = row.createEl("input", { type: "checkbox" });
		const classification = this.coordinator.classifyPdfPath(path, this.expectedSessionId);
		const alreadyRepresented = classification === "already-represented";
		checkbox.checked = this.selectedPaths.has(path);
		checkbox.disabled = alreadyRepresented || classification !== "selectable";
		checkbox.setAttribute(
			"aria-label",
			`${alreadyRepresented ? "Already added" : "Select"} ${filename}, ${path}`,
		);
		checkbox.addEventListener("change", () => {
			if (checkbox.disabled) return;
			if (checkbox.checked) this.selectedPaths.add(path);
			else this.selectedPaths.delete(path);
			this.updateSelectionControls();
		});
		row.createEl("span", { text: filename, cls: "pdf-intake-chooser-filename" });
		row.createEl("span", {
			text: parentPath,
			cls: "pdf-intake-chooser-path",
		});
		if (alreadyRepresented) {
			row.createEl("span", { text: "Already added", cls: "pdf-intake-muted" });
		}
	}

	private updateSelectionControls(): void {
		if (this.selectionCountElement)
			this.selectionCountElement.textContent = `${this.selectedPaths.size} selected`;
		if (this.confirmButton) {
			this.confirmButton.disabled = this.selectedPaths.size === 0;
			this.confirmButton.setAttribute("aria-disabled", String(this.confirmButton.disabled));
		}
	}

	private confirmSelection(): void {
		const paths = [...this.selectedPaths];
		const result = this.coordinator.addPdfs(paths, this.expectedSessionId);
		if (result.staleSession) {
			new Notice("This PDF Intake session has changed. Open Add PDFs again.");
		} else if (result.rejected.length > 0) {
			new Notice(this.admissionMessage(result));
		}
		this.close();
	}

	private admissionMessage(result: PdfAdmissionResult): string {
		const added = result.addedItemIds.length;
		const rejectedPaths = result.rejected.map(({ path }) => path);
		const rejectionMessage = `Could not add: ${rejectedPaths.join("; ")}`;
		if (added > 0) return `${added} PDF${added === 1 ? "" : "s"} added. ${rejectionMessage}`;
		return rejectionMessage;
	}

	private resolveCurrentFolder(): TFolder {
		const root = this.app.vault.getRoot();
		if (this.currentFolder?.isRoot()) return root;
		const current = this.app.vault.getAbstractFileByPath(this.currentFolder?.path ?? "");
		return current === this.currentFolder && current instanceof TFolder ? current : root;
	}

	private ancestorsOf(folder: TFolder): TFolder[] {
		const ancestors: TFolder[] = [];
		let current = folder.parent;
		const root = this.app.vault.getRoot();
		while (current && current !== root) {
			ancestors.unshift(current);
			current = current.parent;
		}
		return ancestors;
	}

	private isAncestor(candidate: TFolder, folder: TFolder): boolean {
		let current = folder.parent;
		while (current) {
			if (current === candidate) return true;
			current = current.parent;
		}
		return false;
	}
}
