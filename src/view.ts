import { ItemView, WorkspaceLeaf } from "obsidian";
import type PdfIntakePlugin from "./main";
import { formatFilename, isUsableLegacyTemplate } from "./planning";
import type { IntakeSession, SessionCoordinator, SetupConcern } from "./session";
import type { CanonicalBibliographicRecord, OutputLocation } from "./types";
import { VaultPdfChooserModal } from "./vault-pdf-chooser";

export const PDF_INTAKE_VIEW_TYPE = "pdf-intake-view";

const CONCERNS: { id: SetupConcern; label: string }[] = [
	{ id: "pdfs", label: "PDFs" },
	{ id: "output", label: "Output" },
	{ id: "metadata-and-naming", label: "Metadata & naming" },
];

const EXAMPLE_RECORD: CanonicalBibliographicRecord = {
	title: "Example Title",
	authorship: {
		authors: [
			{ kind: "person", family: "Tesar" },
			{ kind: "person", family: "Chilisa" },
		],
		completeness: "complete",
		totalCountKnown: true,
	},
	year: 2023,
};

function outputValue(output: OutputLocation): string {
	if (output.mode === "current-folders") return "current-folders";
	return output.folderPath ? `folder:${output.folderPath}` : "vault-root";
}

function outputFromValue(value: string): OutputLocation | null {
	if (value === "current-folders") return { mode: "current-folders" };
	if (value === "vault-root") return { mode: "vault-folder", folderPath: "" };
	if (value.startsWith("folder:"))
		return { mode: "vault-folder", folderPath: value.slice("folder:".length) };
	return null;
}

export class PdfIntakeView extends ItemView {
	private readonly coordinator: SessionCoordinator;
	private readonly plugin: PdfIntakePlugin;
	private unsubscribe?: () => void;
	private session?: IntakeSession;
	private templateDraft?: string;
	private statusMessage?: string;
	private chooser?: VaultPdfChooserModal;

	constructor(leaf: WorkspaceLeaf, coordinator: SessionCoordinator, plugin: PdfIntakePlugin) {
		super(leaf);
		this.coordinator = coordinator;
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

	onOpen(): Promise<void> {
		this.containerEl.addClass("pdf-intake-view");
		this.unsubscribe?.();
		this.unsubscribe = this.coordinator.subscribe((snapshot) => {
			this.session = snapshot;
			this.render();
		});
		return Promise.resolve();
	}

	onClose(): Promise<void> {
		this.chooser?.close();
		this.chooser = undefined;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.containerEl.removeClass("pdf-intake-view");
		return Promise.resolve();
	}

	private render(): void {
		const session = this.session;
		if (!session) return;
		const { contentEl } = this;
		contentEl.empty();
		const header = contentEl.createDiv({ cls: "pdf-intake-header" });
		header.createEl("h2", { text: "PDF Intake" });
		header.createEl("p", { text: "Setup", cls: "pdf-intake-phase" });
		this.renderConcernRail(contentEl, session);
		const currentSummary = contentEl.createDiv({ cls: "pdf-intake-current-values" });
		currentSummary.createEl("p", { text: this.outputSummary(session) });
		currentSummary.createEl("p", { text: this.namingSummary(session) });
		if (this.statusMessage) {
			contentEl.createEl("p", { text: this.statusMessage, cls: "pdf-intake-status-message" });
		}
		for (const diagnostic of this.plugin.store.getDiagnostics()) {
			contentEl.createEl("p", {
				text: diagnostic.message,
				cls: "pdf-intake-persistence-warning",
			});
		}
		const concern = contentEl.createDiv({ cls: "pdf-intake-concern" });
		if (session.setupConcern === "pdfs") this.renderPdfs(concern, session);
		else if (session.setupConcern === "output") this.renderOutput(concern, session);
		else this.renderNaming(concern, session);
	}

	private renderConcernRail(container: HTMLElement, session: IntakeSession): void {
		const rail = container.createDiv({ cls: "pdf-intake-concern-rail" });
		rail.setAttribute("role", "tablist");
		for (const concern of CONCERNS) {
			const button = rail.createEl("button", { text: concern.label });
			button.setAttribute("role", "tab");
			button.setAttribute("aria-selected", String(session.setupConcern === concern.id));
			button.setAttribute("aria-controls", "pdf-intake-setup-panel");
			button.setAttribute("tabindex", session.setupConcern === concern.id ? "0" : "-1");
			button.addEventListener("click", () => this.coordinator.setSetupConcern(concern.id));
			button.addEventListener("keydown", (event: KeyboardEvent) => {
				const currentIndex = CONCERNS.findIndex((item) => item.id === concern.id);
				const nextIndex =
					event.key === "ArrowRight"
						? (currentIndex + 1) % CONCERNS.length
						: event.key === "ArrowLeft"
							? (currentIndex + CONCERNS.length - 1) % CONCERNS.length
							: event.key === "Home"
								? 0
								: event.key === "End"
									? CONCERNS.length - 1
									: -1;
				if (nextIndex < 0) return;
				event.preventDefault();
				this.coordinator.setSetupConcern(CONCERNS[nextIndex].id);
				const tabs = this.contentEl.querySelectorAll<HTMLButtonElement>('[role="tab"]');
				tabs[nextIndex]?.focus();
			});
		}
	}

	private renderPdfs(container: HTMLElement, session: IntakeSession): void {
		container.setAttribute("id", "pdf-intake-setup-panel");
		container.setAttribute("role", "tabpanel");
		container.createEl("h3", { text: "PDFs" });
		if (session.items.length === 0) {
			container.createEl("p", {
				text: "No PDFs in this session yet.",
				cls: "pdf-intake-muted",
			});
		} else {
			container.createEl("p", {
				text: `${session.items.length} PDF${session.items.length === 1 ? "" : "s"}`,
				cls: "pdf-intake-pdf-count",
			});
			const manifest = container.createDiv({ cls: "pdf-intake-pdf-manifest" });
			for (const item of session.items) {
				const entry = manifest.createDiv({ cls: "pdf-intake-pdf-entry" });
				const details = entry.createDiv({ cls: "pdf-intake-pdf-entry-details" });
				const basename =
					item.sourceObservation.path.split("/").pop() ?? item.sourceObservation.path;
				const slash = item.sourceObservation.path.lastIndexOf("/");
				details.createEl("span", {
					text: basename,
					cls: "pdf-intake-pdf-filename",
				});
				details.createEl("span", {
					text: slash < 0 ? "Vault root" : item.sourceObservation.path.slice(0, slash),
					cls: "pdf-intake-pdf-parent-path",
				});
				if (item.sourceHealth && item.sourceHealth !== "current") {
					details.createEl("span", {
						text: this.sourceHealthLabel(item.sourceHealth),
						cls: "pdf-intake-pdf-source-health",
					});
				}
				const remove = entry.createEl("button", { text: "Remove" });
				const parentPath =
					slash < 0 ? "vault root" : item.sourceObservation.path.slice(0, slash);
				remove.setAttribute("aria-label", `Remove ${basename} from ${parentPath}`);
				remove.addEventListener("click", () => {
					this.coordinator.removePdf(item.id, session.id);
				});
			}
		}
		const add = container.createEl("button", {
			text: session.items.length === 0 ? "Add PDFs" : "Add more PDFs",
		});
		add.addEventListener("click", () => this.openPdfChooser(session.id));
		const review = container.createEl("button", { text: "Begin review" });
		review.disabled = true;
		review.setAttribute("aria-disabled", "true");
		const reviewReason =
			session.items.length === 0
				? "Add at least one PDF before beginning review."
				: "Review is not available yet.";
		review.title = reviewReason;
		container.createEl("p", { text: reviewReason, cls: "pdf-intake-muted" });
	}

	private openPdfChooser(expectedSessionId: string): void {
		if (!this.coordinator.refreshSourceHealth(expectedSessionId)) return;
		const chooser = new VaultPdfChooserModal(
			this.app,
			this.coordinator,
			expectedSessionId,
			() => {
				this.chooser = undefined;
			},
		);
		this.chooser = chooser;
		chooser.open();
	}

	private sourceHealthLabel(
		health: NonNullable<IntakeSession["items"][number]["sourceHealth"]>,
	): string {
		const labels = {
			missing: "Source missing",
			renamed: "Source renamed",
			replaced: "Source replaced",
			changed: "Source changed",
			"binding-unavailable": "Source unavailable",
			current: "",
		};
		return labels[health];
	}

	private renderOutput(container: HTMLElement, session: IntakeSession): void {
		container.setAttribute("id", "pdf-intake-setup-panel");
		container.setAttribute("role", "tabpanel");
		container.createEl("h3", { text: "Output" });
		const folders = this.app.vault
			.getAllFolders()
			.map((folder) => folder.path)
			.filter(Boolean);
		const select = container.createEl("select");
		select.setAttribute("aria-label", "Output destination");
		const choices = [
			{ value: "current-folders", label: "Keep each PDF in its current folder" },
			{ value: "vault-root", label: "Vault root" },
			...folders.map((folder) => ({ value: `folder:${folder}`, label: folder })),
		];
		for (const choice of choices) {
			select.createEl("option", { text: choice.label, value: choice.value });
		}
		const selected = outputValue(session.configuration.output);
		select.value = selected;
		if (
			session.configuration.output.mode === "vault-folder" &&
			session.configuration.output.folderPath &&
			!folders.includes(session.configuration.output.folderPath)
		) {
			select.createEl("option", {
				text: `Unavailable: ${session.configuration.output.folderPath}`,
				value: selected,
			});
			select.value = selected;
			container.createEl("p", {
				text: `The saved destination ${session.configuration.output.folderPath} is unavailable. Choose an existing folder.`,
				cls: "pdf-intake-error",
			});
		}
		select.addEventListener("change", () => {
			const output = outputFromValue(select.value);
			if (!output) return;
			const currentFolders = this.app.vault
				.getAllFolders()
				.map((folder) => folder.path)
				.filter(Boolean);
			void this.coordinator.updateOutput(output, currentFolders).then((result) => {
				this.statusMessage = result.message;
				this.render();
			});
		});
		container.createEl("p", {
			text: "The current folders choice keeps each PDF beside its own source file. Folder choices must already exist.",
			cls: "pdf-intake-muted",
		});
	}

	private renderNaming(container: HTMLElement, session: IntakeSession): void {
		container.setAttribute("id", "pdf-intake-setup-panel");
		container.setAttribute("role", "tabpanel");
		container.createEl("h3", { text: "Metadata & naming" });
		container.createEl("p", {
			text: "Illustrative example",
			cls: "pdf-intake-muted",
		});
		const example = formatFilename(
			EXAMPLE_RECORD,
			session.configuration.metadataAndNaming.filenameFormat,
		);
		container.createEl("p", {
			text: `Example filename: ${example.filename ?? "Unavailable"}`,
			cls: "pdf-intake-filename-example",
		});
		const format = session.configuration.metadataAndNaming.filenameFormat;
		const editor = container.createEl("input", { type: "text" });
		editor.setAttribute("aria-label", "Custom filename template");
		const validation = container.createEl("p", { cls: "pdf-intake-validation-message" });
		if (this.templateDraft === undefined) {
			this.templateDraft = format.kind === "legacy-template" ? format.template : "";
		}
		editor.value = this.templateDraft;
		editor.placeholder =
			format.kind === "components" ? "Use a custom template (optional)" : "Filename template";
		validation.setText(
			this.templateDraft && !isUsableLegacyTemplate(this.templateDraft)
				? "Enter a valid template using supported fields. The current format stays active until this is valid."
				: "",
		);
		editor.addEventListener("input", () => {
			this.templateDraft = editor.value;
			validation.setText(
				this.templateDraft && !isUsableLegacyTemplate(this.templateDraft)
					? "Enter a valid template using supported fields. The current format stays active until this is valid."
					: "",
			);
		});
		const commit = async (): Promise<void> => {
			const value = this.templateDraft ?? "";
			if (!value && format.kind === "components") return;
			if (!isUsableLegacyTemplate(value)) {
				validation.setText("Enter a valid template using supported fields.");
				return;
			}
			const result = await this.coordinator.updateMetadataAndNaming({
				filenameFormat: { kind: "legacy-template", template: value },
			});
			this.statusMessage = result.message;
			if (result.updated) this.templateDraft = value;
			this.render();
		};
		editor.addEventListener("blur", () => void commit());
		editor.addEventListener("keydown", (event: KeyboardEvent) => {
			if (event.key === "Enter") {
				event.preventDefault();
				void commit();
			}
		});
		container.createEl("p", {
			text: "Custom templates support {title}, {author}, {authors}, {year}, {journal}, and {publisher}.",
			cls: "pdf-intake-muted",
		});
	}

	private outputSummary(session: IntakeSession): string {
		const output = session.configuration.output;
		if (output.mode === "current-folders")
			return "Output: each PDF stays in its current folder";
		return `Output: ${output.folderPath || "vault root"}`;
	}

	private namingSummary(session: IntakeSession): string {
		const format = session.configuration.metadataAndNaming.filenameFormat;
		return format.kind === "legacy-template"
			? `Filename: ${format.template}`
			: "Filename: first author family [et al.] (year). title";
	}
}
