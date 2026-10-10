import { ItemView, WorkspaceLeaf } from "obsidian";
import type PdfIntakePlugin from "./main";
import { deriveAuthorship } from "./authorship";
import { isUsableLegacyTemplate } from "./planning";
import type { IntakeSessionSnapshot, SessionCoordinator, SetupConcern } from "./session";
import type { OutputLocation } from "./types";
import { VaultPdfChooserModal } from "./vault-pdf-chooser";

export const PDF_INTAKE_VIEW_TYPE = "pdf-intake-view";

const CONCERNS: { id: SetupConcern; label: string }[] = [
	{ id: "pdfs", label: "PDFs" },
	{ id: "output", label: "Output" },
	{ id: "metadata-and-naming", label: "Metadata & naming" },
];

type WorkingCardState = "identifying" | "needs-you" | "ready" | "no-change" | "applied";

interface FocusableAction {
	focused?: boolean;
	getAttribute(name: string): string | null;
	focus?: () => void;
}

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
	private session?: IntakeSessionSnapshot;
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
		const focusKey = this.focusedActionKey();
		const { contentEl } = this;
		contentEl.empty();
		if (session.phase === "working") {
			this.renderWorkingSurface(contentEl, session);
			this.restoreActionFocus(focusKey);
			return;
		}
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
		this.restoreActionFocus(focusKey);
	}

	private renderConcernRail(container: HTMLElement, session: IntakeSessionSnapshot): void {
		const rail = container.createDiv({ cls: "pdf-intake-concern-rail" });
		rail.setAttribute("role", "tablist");
		for (const concern of CONCERNS) {
			const button = rail.createEl("button", { text: concern.label });
			button.setAttribute("data-focus-key", `setup-tab-${concern.id}`);
			button.disabled = session.applyState.status === "applying";
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

	private renderPdfs(container: HTMLElement, session: IntakeSessionSnapshot): void {
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
				remove.setAttribute("data-focus-key", `remove-pdf-${item.id}`);
				remove.disabled = session.applyState.status === "applying";
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
		add.setAttribute("data-focus-key", "add-pdfs");
		add.disabled = session.applyState.status === "applying";
		add.addEventListener("click", () => this.openPdfChooser(session.id));
		const review = container.createEl("button", { text: "Begin review" });
		review.setAttribute("data-focus-key", "begin-review");
		review.disabled = session.items.length === 0 || session.applyState.status === "applying";
		review.setAttribute("aria-disabled", String(review.disabled));
		const reviewReason =
			session.items.length === 0 ? "Add at least one PDF before beginning review." : "";
		review.title = reviewReason;
		review.addEventListener("click", () => {
			const result = this.coordinator.beginReview();
			this.statusMessage = result.reason;
			this.render();
		});
		if (reviewReason) container.createEl("p", { text: reviewReason, cls: "pdf-intake-muted" });
	}

	private renderWorkingSurface(container: HTMLElement, session: IntakeSessionSnapshot): void {
		const header = container.createDiv({ cls: "pdf-intake-header" });
		header.createEl("h2", { text: "PDF Intake" });
		header.createEl("p", { text: "Working", cls: "pdf-intake-phase" });

		const states = session.items.map((item) => this.workingCardState(item));
		const countOrder: readonly [WorkingCardState, string][] = [
			["identifying", "Identifying"],
			["needs-you", "Needs you"],
			["ready", "Ready"],
		];
		const context = container.createDiv({ cls: "pdf-intake-working-context" });
		const edit = context.createEl("button", { text: "Edit session" });
		edit.setAttribute("data-focus-key", "edit-session");
		edit.disabled = session.applyState.status === "applying";
		edit.addEventListener("click", () => {
			this.coordinator.returnToSetup(session.id);
		});
		const summary = context.createDiv({ cls: "pdf-intake-working-counts" });
		summary.setAttribute("aria-live", "polite");
		const activeCounts = countOrder
			.map(([state, label]) => {
				const count = states.filter((candidate) => candidate === state).length;
				return count > 0 ? `${label} ${count}` : "";
			})
			.filter(Boolean);
		summary.setText(activeCounts.join(" · "));
		const readyCount = states.filter((state) => state === "ready").length;
		const apply = context.createEl("button", {
			text: readyCount ? `Apply changes (${readyCount})` : "Apply changes",
		});
		apply.setAttribute("data-focus-key", "apply-changes");
		apply.disabled = readyCount === 0 || session.applyState.status === "applying";
		apply.addEventListener("click", () => {
			void this.coordinator.applyReviewedPlan().then((result) => {
				this.statusMessage =
					result.status === "completed" ? "Apply finished." : result.message;
				this.render();
			});
		});
		if (this.statusMessage) {
			container.createEl("p", {
				text: this.statusMessage,
				cls: "pdf-intake-status-message",
			});
		}
		if (session.applyState.status === "applying") {
			container.createEl("p", {
				text: "Applying the reviewed changes…",
				cls: "pdf-intake-muted",
			});
		}
		const cards = container.createDiv({ cls: "pdf-intake-working-cards" });
		cards.setAttribute("aria-label", "PDFs in session order");
		for (let index = 0; index < session.items.length; index++) {
			const item = session.items[index];
			if (item) this.renderWorkingCard(cards, item, states[index] ?? "needs-you");
		}
	}

	private workingCardState(item: IntakeSessionSnapshot["items"][number]): WorkingCardState {
		if (item.sourceHealth && item.sourceHealth !== "current") return "needs-you";
		if (
			item.identification.status === "unattempted" ||
			item.identification.status === "identifying"
		) {
			return "identifying";
		}
		if (item.identification.status === "needs-user") return "needs-you";
		if (item.plan?.status === "eligible") return "ready";
		if (item.plan?.status === "blocked") return "needs-you";
		if (item.plan?.status === "no-change") {
			return item.applyOutcome?.status === "renamed" ? "applied" : "no-change";
		}
		return "needs-you";
	}

	private renderWorkingCard(
		container: HTMLElement,
		item: IntakeSessionSnapshot["items"][number],
		state: WorkingCardState,
	): void {
		const card = container.createDiv({ cls: `pdf-intake-working-card is-${state}` });
		card.setAttribute("data-item-id", item.id);
		const sourceName =
			item.sourceObservation.path.split("/").pop() ?? item.sourceObservation.path;
		card.createEl("h3", { text: sourceName, cls: "pdf-intake-card-source" });
		const label =
			state === "needs-you"
				? "Needs you"
				: state === "ready"
					? "Ready"
					: state === "identifying"
						? "Identifying"
						: state === "applied"
							? "Applied"
							: "No changes needed";
		card.createEl("p", { text: label, cls: "pdf-intake-card-state" });

		if (state === "identifying") return;
		if (state === "ready" && item.identification.status === "resolved") {
			card.createEl("p", {
				text: item.identification.record.title ?? "Untitled work",
				cls: "pdf-intake-card-title",
			});
			const author = deriveAuthorship(item.identification.record.authorship, {
				selection: "first",
				nameStyle: "full",
				etAl: "conditional",
				nameOrder: "family-given",
				separator: ", ",
			});
			const authorYear = [author.value, item.identification.record.year?.toString()]
				.filter((value): value is string => !!value)
				.join(" · ");
			if (authorYear)
				card.createEl("p", { text: authorYear, cls: "pdf-intake-card-metadata" });
			if (item.plan?.status === "eligible") {
				card.createEl("p", {
					text: item.plan.proposedRename.proposedName,
					cls: "pdf-intake-card-proposal",
				});
			}
			if (item.applyOutcome && item.applyOutcome.status !== "renamed") {
				card.createEl("p", {
					text: item.applyOutcome.message,
					cls: "pdf-intake-card-reason",
				});
			}
			return;
		}
		if (state === "needs-you") {
			if (item.identification.status === "resolved" && item.identification.record.title) {
				card.createEl("p", {
					text: item.identification.record.title,
					cls: "pdf-intake-card-title",
				});
			} else if (item.identification.status === "needs-user") {
				const evidenceTitle = item.identification.evidence?.titleCandidates[0];
				if (evidenceTitle) {
					card.createEl("p", { text: evidenceTitle, cls: "pdf-intake-card-title" });
				}
				const identifier = item.identification.evidence?.identifiers.find(
					(candidate) => candidate.valid && candidate.normalizedValue,
				);
				if (identifier?.normalizedValue) {
					card.createEl("p", {
						text: `${identifier.type.toUpperCase()}: ${identifier.normalizedValue}`,
						cls: "pdf-intake-card-metadata",
					});
				}
			}
			const reason =
				item.plan?.status === "blocked"
					? item.plan.message
					: item.identification.status === "needs-user"
						? item.identification.reason
						: (item.sourceIssue ?? "This PDF needs review.");
			card.createEl("p", { text: reason, cls: "pdf-intake-card-reason" });
		}
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
		health: NonNullable<IntakeSessionSnapshot["items"][number]["sourceHealth"]>,
	): string {
		const labels = {
			missing: "Source missing",
			renamed: "Source renamed",
			replaced: "Source replaced",
			changed: "Source changed",
			unverified: "Source not verified",
			"binding-unavailable": "Source unavailable",
			current: "",
		};
		return labels[health];
	}

	private renderOutput(container: HTMLElement, session: IntakeSessionSnapshot): void {
		container.setAttribute("id", "pdf-intake-setup-panel");
		container.setAttribute("role", "tabpanel");
		container.createEl("h3", { text: "Output" });
		const folders = session.outputFolderPaths.filter(Boolean);
		const select = container.createEl("select");
		select.setAttribute("data-focus-key", "output-destination");
		select.disabled = session.applyState.status === "applying";
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
			void this.coordinator.updateOutput(output).then((result) => {
				this.statusMessage = result.message;
				this.render();
			});
		});
		container.createEl("p", {
			text: "The current folders choice keeps each PDF beside its own source file. Folder choices must already exist.",
			cls: "pdf-intake-muted",
		});
	}

	private renderNaming(container: HTMLElement, session: IntakeSessionSnapshot): void {
		container.setAttribute("id", "pdf-intake-setup-panel");
		container.setAttribute("role", "tabpanel");
		container.createEl("h3", { text: "Metadata & naming" });
		container.createEl("p", {
			text: "Illustrative example",
			cls: "pdf-intake-muted",
		});
		container.createEl("p", {
			text: `Example filename: ${session.exampleFilename ?? "Unavailable"}`,
			cls: "pdf-intake-filename-example",
		});
		const format = session.configuration.metadataAndNaming.filenameFormat;
		const editor = container.createEl("input", { type: "text" });
		editor.setAttribute("data-focus-key", "filename-template");
		editor.disabled = session.applyState.status === "applying";
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

	private outputSummary(session: IntakeSessionSnapshot): string {
		const output = session.configuration.output;
		if (output.mode === "current-folders")
			return "Output: each PDF stays in its current folder";
		return `Output: ${output.folderPath || "vault root"}`;
	}

	private focusedActionKey(): string | undefined {
		if (typeof document !== "undefined" && typeof this.contentEl.contains === "function") {
			const active = document.activeElement;
			if (active && this.contentEl.contains(active)) {
				const key = active.getAttribute("data-focus-key");
				if (key) return key;
			}
			return undefined;
		}
		const testRoot = this.contentEl as unknown as {
			find?: (predicate: (element: FocusableAction) => boolean) => FocusableAction[];
		};
		const focused = testRoot.find?.(
			(element) => element.focused === true && !!element.getAttribute("data-focus-key"),
		);
		return focused?.[0]?.getAttribute("data-focus-key") ?? undefined;
	}

	private restoreActionFocus(key: string | undefined): void {
		if (!key) return;
		if (typeof document !== "undefined") {
			const elements = this.contentEl.querySelectorAll<HTMLElement>("[data-focus-key]");
			for (const element of Array.from(elements)) {
				if (element.getAttribute("data-focus-key") === key) {
					element.focus();
					return;
				}
			}
			return;
		}
		const testRoot = this.contentEl as unknown as {
			find?: (predicate: (element: FocusableAction) => boolean) => FocusableAction[];
		};
		const testMatch = testRoot.find?.(
			(element) => element.getAttribute("data-focus-key") === key,
		)[0];
		if (testMatch?.focus) {
			testMatch.focus();
			return;
		}
	}

	private namingSummary(session: IntakeSessionSnapshot): string {
		const format = session.configuration.metadataAndNaming.filenameFormat;
		return format.kind === "legacy-template"
			? `Filename: ${format.template}`
			: "Filename: first author family [et al.] (year). title";
	}
}
