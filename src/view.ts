import { ItemView, WorkspaceLeaf } from "obsidian";
import type PdfIntakePlugin from "./main";
import { deriveAuthorship } from "./authorship";
import { isUsableLegacyTemplate } from "./filename-template";
import type {
	IntakeSessionSnapshot,
	ManualRecordDraft,
	SessionCoordinator,
	SetupConcern,
} from "./session";
import type {
	CanonicalAuthor,
	CanonicalBibliographicRecord,
	CandidateReference,
	OutputLocation,
	PendingInspectorForm,
	ProviderBibliographicRecord,
} from "./types";
import { VaultPdfChooserModal } from "./vault-pdf-chooser";

export const PDF_INTAKE_VIEW_TYPE = "pdf-intake-view";

const CONCERNS: { id: SetupConcern; label: string }[] = [
	{ id: "pdfs", label: "PDFs" },
	{ id: "output", label: "Output" },
	{ id: "metadata-and-naming", label: "Metadata & naming" },
];

type WorkingCardState =
	"identifying" | "needs-you" | "ready" | "no-change" | "applied" | "left-unresolved";

interface InspectorFormState {
	itemId: string;
	title: string;
	year: string;
	doi: string;
	isbns: string;
	journal: string;
	publisher: string;
	authors: CanonicalAuthor[];
	authorshipCompleteness: "complete" | "partial" | "unknown";
	totalCountKnown: boolean;
}

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
	private inspectedItemId?: string;
	private inspectorOriginFocusKey?: string;
	private pendingFocusKey?: string;
	private inspectorForm?: InspectorFormState;
	private inspectorFormDirty = false;
	private inspectorErrors: Record<string, string> = {};
	private pendingInspectorAction?: { kind: "close" } | { kind: "switch"; itemId: string };
	private candidateConfirmation?: { kind: "machine" | "manual"; candidate?: CandidateReference };
	private retryReplacementConfirmation = false;
	private recoveryDiscardConfirmation = false;
	private newSessionConfirmation = false;
	private finishEmptyConfirmation = false;
	private manualIdentifierType: "doi" | "isbn" = "doi";
	private manualIdentifierValue = "";
	private manualLookupFeedback = "";
	private manualFormVisible = false;
	private escapeHandler?: (event: KeyboardEvent) => void;

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
		this.escapeHandler = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.isComposing || !this.inspectedItemId) return;
			event.preventDefault();
			this.requestInspectorClose();
		};
		this.contentEl.addEventListener("keydown", this.escapeHandler);
		this.unsubscribe = this.coordinator.subscribe((snapshot) => {
			this.session = snapshot;
			this.render();
		});
		return Promise.resolve();
	}

	onClose(): Promise<void> {
		this.chooser?.close();
		this.chooser = undefined;
		if (this.inspectorFormDirty && this.inspectorForm && this.session) {
			this.coordinator.preservePendingInspectorForm(
				this.toPendingForm(this.inspectorForm),
				this.session.id,
			);
		}
		if (this.inspectedItemId && this.session)
			this.coordinator.closeInspector(this.inspectedItemId, this.session.id);
		this.inspectedItemId = undefined;
		this.inspectorForm = undefined;
		this.inspectorFormDirty = false;
		if (this.escapeHandler) this.contentEl.removeEventListener("keydown", this.escapeHandler);
		this.escapeHandler = undefined;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.containerEl.removeClass("pdf-intake-view");
		return Promise.resolve();
	}

	private render(): void {
		const session = this.session;
		if (!session) return;
		const focusKey = this.pendingFocusKey ?? this.focusedActionKey();
		this.pendingFocusKey = undefined;
		const { contentEl } = this;
		contentEl.empty();
		if (session.recoveryGate !== "none") {
			this.renderRecoveryGate(contentEl, session);
			this.restoreActionFocus(focusKey);
			return;
		}
		if (session.persistenceWarning) {
			contentEl.createEl("p", {
				text: "The unfinished session could not be saved. It is still available while PDF Intake remains open.",
				cls: "pdf-intake-persistence-warning",
			});
		}
		const diagnostics = this.plugin.store.getDiagnostics();
		for (const diagnostic of diagnostics.filter(
			(entry) => entry.code !== "save-failed" && entry.code !== "initial-save-failed",
		)) {
			contentEl.createEl("p", {
				text: diagnostic.message,
				cls: "pdf-intake-persistence-warning",
			});
		}
		if (
			diagnostics.some(
				(entry) => entry.code === "save-failed" || entry.code === "initial-save-failed",
			) &&
			!session.persistenceWarning
		) {
			contentEl.createEl("p", {
				text: "PDF Intake could not save the latest plugin data. It remains available while the app is open.",
				cls: "pdf-intake-persistence-warning",
			});
		}
		if (session.phase === "working") {
			this.renderWorkingSurface(contentEl, session);
			this.restoreActionFocus(focusKey);
			return;
		}
		const header = contentEl.createDiv({ cls: "pdf-intake-header" });
		header.createEl("h2", { text: "PDF Intake" });
		header.createEl("p", { text: "Setup", cls: "pdf-intake-phase" });
		this.renderLifecycleControls(header, session);
		this.renderConcernRail(contentEl, session);
		const currentSummary = contentEl.createDiv({ cls: "pdf-intake-current-values" });
		currentSummary.createEl("p", { text: this.outputSummary(session) });
		currentSummary.createEl("p", { text: this.namingSummary(session) });
		if (this.statusMessage) {
			contentEl.createEl("p", { text: this.statusMessage, cls: "pdf-intake-status-message" });
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

	private renderLifecycleControls(container: HTMLElement, session: IntakeSessionSnapshot): void {
		if (!session.draftBacked) return;
		const controls = container.createDiv({ cls: "pdf-intake-lifecycle-controls" });
		const terminal = session.items.every(
			(item) =>
				item.currentStatus === "applied" ||
				item.currentStatus === "no-change" ||
				item.currentStatus === "left-unresolved",
		);
		if (this.newSessionConfirmation) {
			controls.createEl("span", { text: "Discard this unfinished session and start fresh?" });
			const confirm = controls.createEl("button", { text: "Confirm start new session" });
			confirm.setAttribute("data-focus-key", "confirm-new-session");
			confirm.addEventListener("click", () => {
				void this.coordinator.startNewSession(true).then((started) => {
					this.newSessionConfirmation = false;
					this.statusMessage = started
						? undefined
						: "The saved draft was not cleared; the current session remains open.";
					this.inspectedItemId = undefined;
					this.inspectorForm = undefined;
					this.inspectorFormDirty = false;
					this.render();
				});
			});
			const cancel = controls.createEl("button", { text: "Cancel" });
			cancel.addEventListener("click", () => {
				this.newSessionConfirmation = false;
				this.render();
			});
		} else {
			const fresh = controls.createEl("button", { text: "Start new session" });
			fresh.setAttribute("data-focus-key", "start-new-session");
			fresh.disabled = session.applyState.status === "applying";
			fresh.addEventListener("click", () => {
				this.newSessionConfirmation = true;
				this.render();
			});
		}
		if (session.items.length === 0 && !this.finishEmptyConfirmation) {
			const finish = controls.createEl("button", { text: "Finish empty session" });
			finish.disabled = session.applyState.status === "applying";
			finish.addEventListener("click", () => {
				this.finishEmptyConfirmation = true;
				this.render();
			});
		} else if (session.items.length === 0 && this.finishEmptyConfirmation) {
			controls.createEl("span", { text: "Confirm that this empty session is finished." });
			const finish = controls.createEl("button", { text: "Confirm finish" });
			finish.addEventListener("click", () => {
				void this.coordinator.finishSession(true).then((finished) => {
					this.finishEmptyConfirmation = false;
					this.statusMessage = finished
						? undefined
						: "The saved draft was not cleared; the session remains open.";
					this.render();
				});
			});
			const cancel = controls.createEl("button", { text: "Cancel" });
			cancel.addEventListener("click", () => {
				this.finishEmptyConfirmation = false;
				this.render();
			});
		} else {
			const finish = controls.createEl("button", { text: "Finish session" });
			finish.disabled = !terminal || session.applyState.status === "applying";
			finish.title = terminal
				? "Clear the saved session and return to setup."
				: "Finish is available when every PDF is Applied, needs no changes, or is left unresolved.";
			finish.addEventListener("click", () => {
				void this.coordinator.finishSession().then((finished) => {
					this.statusMessage = finished
						? undefined
						: "The session is not complete or its saved draft could not be cleared.";
					this.render();
				});
			});
		}
	}

	private requestInspect(itemId: string, sessionId: string): void {
		if (this.inspectedItemId === itemId) {
			this.requestInspectorClose();
			return;
		}
		if (this.inspectedItemId && this.inspectorFormDirty) {
			this.pendingInspectorAction = { kind: "switch", itemId };
			this.render();
			return;
		}
		this.performInspectorAction({ kind: "switch", itemId }, sessionId);
	}

	private requestInspectorClose(): void {
		if (!this.inspectedItemId || !this.session) return;
		if (this.inspectorFormDirty) {
			this.pendingInspectorAction = { kind: "close" };
			this.render();
			return;
		}
		this.performInspectorAction({ kind: "close" }, this.session.id);
	}

	private performInspectorAction(
		action: { kind: "close" } | { kind: "switch"; itemId: string },
		sessionId: string,
	): void {
		const priorItemId = this.inspectedItemId;
		if (priorItemId) this.coordinator.closeInspector(priorItemId, sessionId);
		this.pendingInspectorAction = undefined;
		this.inspectorFormDirty = false;
		this.inspectorForm = undefined;
		this.inspectorErrors = {};
		this.candidateConfirmation = undefined;
		this.retryReplacementConfirmation = false;
		this.manualLookupFeedback = "";
		if (action.kind === "close") {
			this.inspectedItemId = undefined;
			this.pendingFocusKey =
				this.inspectorOriginFocusKey ??
				(priorItemId ? `inspect-${priorItemId}` : undefined);
			this.inspectorOriginFocusKey = undefined;
		} else {
			if (!this.coordinator.openInspector(action.itemId, sessionId)) return;
			this.inspectedItemId = action.itemId;
			this.inspectorOriginFocusKey = `inspect-${action.itemId}`;
			const target = this.session?.items.find((item) => item.id === action.itemId);
			const pending =
				this.session?.pendingInspectorForm?.itemId === action.itemId
					? this.session.pendingInspectorForm
					: undefined;
			this.inspectorForm = target ? this.makeInspectorForm(target, pending) : undefined;
			this.inspectorFormDirty = !!pending;
			this.manualFormVisible = !!pending;
			this.pendingFocusKey = "inspector-close";
		}
		this.render();
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
		this.renderLifecycleControls(header, session);

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
			if (!item) continue;
			this.renderWorkingCard(cards, item, states[index] ?? "needs-you", session);
			if (item.id === this.inspectedItemId) this.renderInspector(cards, item, session);
		}
	}

	private workingCardState(item: IntakeSessionSnapshot["items"][number]): WorkingCardState {
		return item.currentStatus;
	}

	private renderWorkingCard(
		container: HTMLElement,
		item: IntakeSessionSnapshot["items"][number],
		state: WorkingCardState,
		session: IntakeSessionSnapshot,
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
							: state === "left-unresolved"
								? "Left unresolved"
								: "No changes needed";
		card.createEl("p", { text: label, cls: "pdf-intake-card-state" });
		const inspect = card.createEl("button", {
			text: this.inspectedItemId === item.id ? "Inspected" : "Inspect",
		});
		inspect.setAttribute("data-focus-key", `inspect-${item.id}`);
		inspect.setAttribute("aria-label", `Inspect ${sourceName}`);
		inspect.setAttribute("aria-expanded", String(this.inspectedItemId === item.id));
		inspect.addEventListener("click", () => this.requestInspect(item.id, session.id));
		if (item.effectiveRecord) {
			card.createEl("p", {
				text: item.effectiveRecord.title ?? "Untitled work",
				cls: "pdf-intake-card-title",
			});
			const author = deriveAuthorship(item.effectiveRecord.authorship, {
				selection: "first",
				nameStyle: "full",
				etAl: "conditional",
				nameOrder: "family-given",
				separator: ", ",
			});
			const authorYear = [author.value, item.effectiveRecord.year?.toString()]
				.filter((value): value is string => !!value)
				.join(" · ");
			if (authorYear)
				card.createEl("p", { text: authorYear, cls: "pdf-intake-card-metadata" });
			if (item.plan?.status === "eligible" && state === "ready") {
				card.createEl("p", {
					text: item.plan.proposedRename.proposedName,
					cls: "pdf-intake-card-proposal",
				});
			}
			if (
				item.plan?.status === "blocked" ||
				item.applyOutcome?.status === "blocked" ||
				item.applyOutcome?.status === "failed"
			) {
				card.createEl("p", {
					text:
						item.plan?.status === "blocked"
							? item.plan.message
							: item.applyOutcome?.status === "blocked"
								? item.applyOutcome.message
								: item.applyOutcome?.status === "failed"
									? item.applyOutcome.message
									: "",
					cls: "pdf-intake-card-reason",
				});
			}
		}
		if (state === "identifying" && item.repairActivity !== "retry-pending") return;
		if (item.currentStatus === "needs-you" || item.currentStatus === "left-unresolved") {
			const reason =
				item.sourceIssue ??
				(item.plan?.status === "blocked"
					? item.plan.message
					: item.identification.status === "needs-user"
						? item.identification.reason
						: "This PDF needs review.");
			card.createEl("p", { text: reason, cls: "pdf-intake-card-reason" });
		}
		if (item.repairActivity === "retry-pending")
			card.createEl("p", { text: "Retrying identification…", cls: "pdf-intake-muted" });
		if (item.repairActivity === "manual-lookup-pending")
			card.createEl("p", { text: "Looking up identifier…", cls: "pdf-intake-muted" });
	}

	private renderRecoveryGate(container: HTMLElement, session: IntakeSessionSnapshot): void {
		const header = container.createDiv({ cls: "pdf-intake-header" });
		header.createEl("h2", { text: "PDF Intake" });
		header.createEl("p", { text: "Unfinished session", cls: "pdf-intake-phase" });
		const panel = container.createDiv({ cls: "pdf-intake-recovery-gate" });
		panel.createEl("h3", { text: "A saved session needs your decision" });
		if (session.recoveryGate === "supported") {
			panel.createEl("p", {
				text: "Resume the saved PDFs and their session configuration, or discard this saved session before starting fresh.",
			});
			const resume = panel.createEl("button", { text: "Resume unfinished session" });
			resume.setAttribute("data-focus-key", "resume-session");
			resume.addEventListener("click", () => {
				const result = this.coordinator.resumeUnfinishedSession();
				this.statusMessage = result.message;
				if (result.resumed) {
					this.inspectedItemId = undefined;
					this.inspectorForm = undefined;
					this.inspectorFormDirty = false;
				}
				this.render();
			});
		} else {
			panel.createEl("p", {
				text: "This saved session cannot be read safely. Its contents remain untouched until you confirm discard.",
			});
		}
		if (this.recoveryDiscardConfirmation) {
			const confirm = panel.createEl("button", {
				text: "Confirm discard and start new session",
			});
			confirm.setAttribute("data-focus-key", "confirm-discard-session");
			confirm.addEventListener("click", () => {
				void this.coordinator.startNewSession(true).then((started) => {
					this.recoveryDiscardConfirmation = false;
					this.statusMessage = started
						? undefined
						: "The saved draft was not cleared; the recovery decision is still required.";
					this.render();
				});
			});
			const cancel = panel.createEl("button", { text: "Cancel" });
			cancel.addEventListener("click", () => {
				this.recoveryDiscardConfirmation = false;
				this.render();
			});
		} else {
			const discard = panel.createEl("button", {
				text:
					session.recoveryGate === "supported"
						? "Start new session"
						: "Discard saved draft",
			});
			discard.setAttribute("data-focus-key", "discard-session");
			discard.addEventListener("click", () => {
				this.recoveryDiscardConfirmation = true;
				this.render();
			});
		}
		if (session.persistenceWarning)
			container.createEl("p", {
				text: "The saved session could not be cleared. It remains available for another decision.",
				cls: "pdf-intake-persistence-warning",
			});
		if (this.statusMessage)
			container.createEl("p", { text: this.statusMessage, cls: "pdf-intake-status-message" });
	}

	private renderInspector(
		container: HTMLElement,
		item: IntakeSessionSnapshot["items"][number],
		session: IntakeSessionSnapshot,
	): void {
		const inspector = container.createDiv({ cls: "pdf-intake-inspector" });
		inspector.setAttribute("data-inspector-item", item.id);
		inspector.setAttribute("aria-label", "PDF inspector");
		const heading = inspector.createDiv({ cls: "pdf-intake-inspector-heading" });
		heading.createEl("h3", {
			text: item.sourceObservation.path.split("/").pop() ?? item.sourceObservation.path,
		});
		const close = heading.createEl("button", { text: "Close" });
		close.setAttribute("data-focus-key", "inspector-close");
		close.addEventListener("click", () => this.requestInspectorClose());
		inspector.createEl("p", {
			text: item.sourceObservation.path,
			cls: "pdf-intake-inspector-path",
		});
		const statusReason =
			item.sourceIssue ?? (item.plan?.status === "blocked" ? item.plan.message : undefined);
		inspector.createEl("p", {
			text: `Status: ${this.statusLabel(item.currentStatus)}${statusReason ? ` · ${statusReason}` : ""}`,
			cls: item.sourceHealth === "current" ? "pdf-intake-muted" : "pdf-intake-card-reason",
		});
		if (item.repairActivity === "retry-pending")
			inspector.createEl("p", {
				text: "Automatic identification retry is in progress.",
				cls: "pdf-intake-muted",
			});
		if (item.repairActivity === "manual-lookup-pending")
			inspector.createEl("p", {
				text: "Direct identifier lookup is in progress.",
				cls: "pdf-intake-muted",
			});

		const evidence =
			item.identification.status === "resolved" || item.identification.status === "needs-user"
				? item.identification.evidence
				: undefined;
		if (evidence) {
			if (evidence.identifiers.length) {
				const identifiers = inspector.createDiv({ cls: "pdf-intake-inspector-evidence" });
				identifiers.createEl("h4", { text: "Identifiers found in the PDF" });
				for (const identifier of evidence.identifiers.slice(0, 12)) {
					identifiers.createEl("p", {
						text: `${identifier.type.toUpperCase()}: ${identifier.normalizedValue ?? (identifier.rawText || "Unrecognized identifier")}${identifier.valid ? "" : " (invalid)"}`,
					});
				}
			}
			if (evidence.titleCandidates.length) {
				const titles = inspector.createDiv({ cls: "pdf-intake-inspector-evidence" });
				titles.createEl("h4", { text: "Title evidence" });
				for (const title of evidence.titleCandidates.slice(0, 5))
					titles.createEl("p", { text: title });
			}
			if (evidence.attempts.length) {
				const attempts = inspector.createDiv({ cls: "pdf-intake-inspector-evidence" });
				attempts.createEl("h4", { text: "Provider attempts" });
				for (const attempt of evidence.attempts.slice(0, 12)) {
					const row = attempts.createDiv({ cls: "pdf-intake-evidence-attempt" });
					row.createEl("p", {
						text: `${this.providerLabel(attempt.provider)} · ${this.routeLabel(attempt.route)} · ${this.outcomeLabel(attempt.outcome)}`,
					});
					if (attempt.outcome === "title-mismatch")
						row.createEl("p", {
							text: "This provider title differed from the PDF title evidence. Choosing it requires a separate confirmation.",
							cls: "pdf-intake-card-reason",
						});
					if (attempt.providerTitle)
						row.createEl("p", { text: `Provider title: ${attempt.providerTitle}` });
					if (attempt.candidateRecord) {
						this.renderCandidateSummary(row, attempt.candidateRecord, attempt.provider);
						const candidate: CandidateReference = {
							provider: attempt.provider,
							route: attempt.route,
							lookupValue: attempt.lookupValue,
						};
						const isConfirming =
							this.candidateConfirmation?.kind === "machine" &&
							this.sameCandidate(this.candidateConfirmation.candidate, candidate);
						const choose = row.createEl("button", {
							text: isConfirming ? "Use anyway" : "Use this record",
						});
						choose.disabled =
							!this.canRepairItem(item, session) ||
							item.identification.status === "identifying";
						choose.addEventListener("click", () => {
							const result = this.coordinator.selectMachineCandidate(
								item.id,
								session.id,
								candidate,
								isConfirming,
							);
							if (result.requiresUseAnyway) {
								this.candidateConfirmation = { kind: "machine", candidate };
								this.statusMessage = `The candidate title differs from the PDF title evidence “${result.conflictingTitle ?? ""}”. Confirm Use anyway to select it.`;
							} else if (result.accepted) {
								this.candidateConfirmation = undefined;
								this.statusMessage =
									"The provider candidate is now the selected record.";
								this.inspectorForm = undefined;
								this.inspectorFormDirty = false;
							} else this.statusMessage = "This candidate is no longer available.";
							this.render();
						});
					}
				}
			}
		}

		if (item.effectiveRecord) {
			const record = inspector.createDiv({ cls: "pdf-intake-inspector-record" });
			record.createEl("h4", {
				text: `Current record · ${this.authorityLabel(item.recordAuthority)}`,
			});
			this.renderRecordFields(record, item.effectiveRecord);
		}
		if (item.identificationHistory?.length) {
			const priorRuns = inspector.createDiv({ cls: "pdf-intake-inspector-evidence" });
			priorRuns.createEl("h4", { text: "Previous identification runs" });
			for (const summary of item.identificationHistory.slice(-2)) {
				const row = priorRuns.createDiv({ cls: "pdf-intake-evidence-attempt" });
				row.createEl("p", {
					text: `${summary.status === "accepted" ? "Accepted" : "Needs you"}${summary.reason ? ` · ${summary.reason}` : ""}`,
				});
				for (const title of (summary.titleCandidates ?? []).slice(0, 3))
					row.createEl("p", { text: `PDF title evidence: ${title}` });
				for (const attempt of summary.attempts.slice(0, 12))
					row.createEl("p", {
						text: `${this.providerLabel(attempt.provider)} · ${this.routeLabel(attempt.route)} · ${this.outcomeLabel(attempt.outcome)}${attempt.providerTitle ? ` · ${attempt.providerTitle}` : ""}`,
					});
			}
		}
		if (item.plan?.status === "eligible")
			inspector.createEl("p", {
				text: `Current filename proposal: ${item.plan.proposedRename.proposedName}`,
				cls: "pdf-intake-card-proposal",
			});
		else if (item.plan?.status === "blocked")
			inspector.createEl("p", {
				text: `Current planner blocker: ${item.plan.message}`,
				cls: "pdf-intake-card-reason",
			});
		else if (item.plan?.status === "no-change")
			inspector.createEl("p", {
				text: "The current configuration produces no filename change.",
				cls: "pdf-intake-muted",
			});

		for (const repair of (item.repairEvidence ?? []).slice(-3)) {
			const panel = inspector.createDiv({ cls: "pdf-intake-inspector-evidence" });
			panel.createEl("h4", { text: `Manual ${repair.type.toUpperCase()} lookup` });
			panel.createEl("p", {
				text: `${repair.identifier} · ${this.providerLabel(repair.provider)} · ${repair.outcome === "candidate" ? "candidate found" : repair.outcome === "no-record" ? "no record found" : "request failed"}`,
			});
			if (repair.conflictingTitle)
				panel.createEl("p", {
					text: `This title differs from the PDF title evidence “${repair.conflictingTitle}”. Choose Use anyway to accept it.`,
					cls: "pdf-intake-card-reason",
				});
			if (repair.candidateRecord) {
				this.renderCandidateSummary(panel, repair.candidateRecord, repair.provider);
				if (!repair.decision) {
					const reference: CandidateReference = {
						provider: repair.provider,
						route: repair.route,
						lookupValue: repair.identifier,
					};
					const confirming =
						this.candidateConfirmation?.kind === "manual" &&
						this.sameCandidate(this.candidateConfirmation.candidate, reference);
					const choose = panel.createEl("button", {
						text: confirming
							? "Use anyway"
							: repair.conflictingTitle
								? "Review title difference"
								: "Use this record",
					});
					choose.disabled = !this.canRepairItem(item, session);
					choose.addEventListener("click", () => {
						const result = this.coordinator.acceptManualCandidate(
							item.id,
							session.id,
							confirming || !repair.conflictingTitle,
						);
						if (result.requiresUseAnyway)
							this.candidateConfirmation = { kind: "manual", candidate: reference };
						else if (result.accepted) {
							this.candidateConfirmation = undefined;
							this.statusMessage = "The manual candidate is now the selected record.";
						}
						this.render();
					});
					const reject = panel.createEl("button", { text: "Reject candidate" });
					reject.disabled = !this.canRepairItem(item, session);
					reject.addEventListener("click", () => {
						this.coordinator.rejectManualCandidate(item.id, session.id);
						this.render();
					});
				}
			}
		}

		if (this.pendingInspectorAction) {
			const decision = inspector.createDiv({ cls: "pdf-intake-dirty-decision" });
			decision.createEl("p", {
				text: "This form has unsaved edits. Save, discard, or stay here.",
			});
			for (const [field, message] of Object.entries(this.inspectorErrors))
				decision.createEl("p", {
					text: `${field}: ${message}`,
					cls: "pdf-intake-validation-message",
				});
			const save = decision.createEl("button", { text: "Save" });
			save.addEventListener("click", () => void this.saveInspectorForm(true, session));
			const discard = decision.createEl("button", { text: "Discard" });
			discard.addEventListener("click", () => {
				if (this.inspectedItemId)
					this.coordinator.discardPendingInspectorForm(this.inspectedItemId, session.id);
				const next = this.pendingInspectorAction;
				if (next) this.performInspectorAction(next, session.id);
			});
			const stay = decision.createEl("button", { text: "Stay" });
			stay.addEventListener("click", () => {
				this.pendingInspectorAction = undefined;
				this.render();
			});
			return;
		}

		if (item.currentStatus === "left-unresolved") {
			const resume = inspector.createEl("button", { text: "Resume repair" });
			resume.disabled = !this.canRepairItem(item, session);
			resume.addEventListener("click", () =>
				this.coordinator.resumeRepair(item.id, session.id),
			);
		} else if (
			(item.currentStatus === "needs-you" || !!item.recordDecision) &&
			this.canRepairItem(item, session)
		) {
			const retry = inspector.createEl("button", {
				text: this.retryReplacementConfirmation
					? "Replace my saved choice and retry"
					: "Retry identification",
			});
			retry.addEventListener("click", () => {
				const result = this.coordinator.retryIdentification(
					item.id,
					session.id,
					this.retryReplacementConfirmation,
				);
				if (result.confirmationRequired) this.retryReplacementConfirmation = true;
				else {
					this.retryReplacementConfirmation = false;
					this.statusMessage = result.message;
				}
				this.render();
			});
			if (this.retryReplacementConfirmation) {
				const cancel = inspector.createEl("button", { text: "Cancel retry" });
				cancel.addEventListener("click", () => {
					this.retryReplacementConfirmation = false;
					this.render();
				});
			}
			const leave = inspector.createEl("button", { text: "Leave unresolved for now" });
			leave.addEventListener("click", () => {
				this.coordinator.leaveUnresolved(item.id, session.id);
				this.render();
			});
		}

		const readOnly =
			item.identification.status === "identifying" ||
			!this.canRepairItem(item, session) ||
			item.currentStatus === "left-unresolved";
		if (readOnly) {
			inspector.createEl("p", {
				text:
					item.identification.status === "identifying"
						? "Identification is still running. This evidence is read-only until it settles."
						: item.sourceHealth !== "current"
							? "This source is stale. Evidence remains available, but repair and planning require a current source."
							: "Repair controls are unavailable while Apply is active.",
				cls: "pdf-intake-muted",
			});
			return;
		}
		this.renderManualLookup(inspector, item, session);
		if (!this.manualFormVisible) {
			const edit = inspector.createEl("button", { text: "Edit bibliographic record" });
			edit.addEventListener("click", () => {
				this.manualFormVisible = true;
				this.inspectorForm ??= this.makeInspectorForm(item);
				this.render();
			});
		} else if (this.inspectorForm) this.renderManualRecordForm(inspector, item, session);
	}

	private renderManualLookup(
		container: HTMLElement,
		item: IntakeSessionSnapshot["items"][number],
		session: IntakeSessionSnapshot,
	): void {
		const lookup = container.createDiv({ cls: "pdf-intake-manual-lookup" });
		lookup.createEl("h4", { text: "Look up a DOI or ISBN" });
		const type = lookup.createEl("select");
		type.setAttribute("aria-label", "Identifier type");
		for (const option of [
			{ value: "doi", label: "DOI" },
			{ value: "isbn", label: "ISBN" },
		])
			type.createEl("option", { value: option.value, text: option.label });
		type.value = this.manualIdentifierType;
		type.addEventListener("change", () => {
			this.manualIdentifierType = type.value === "isbn" ? "isbn" : "doi";
		});
		const value = lookup.createEl("input", { type: "text", value: this.manualIdentifierValue });
		value.setAttribute("aria-label", this.manualIdentifierType.toUpperCase());
		value.placeholder =
			this.manualIdentifierType === "doi" ? "10.xxxx/..." : "ISBN-10 or ISBN-13";
		value.addEventListener("input", () => {
			this.manualIdentifierValue = value.value;
			this.manualLookupFeedback = "";
		});
		const submit = lookup.createEl("button", { text: "Look up" });
		submit.disabled = !this.canRepairItem(item, session);
		submit.addEventListener("click", () => {
			void this.coordinator
				.lookupManualIdentifier(
					item.id,
					this.manualIdentifierType,
					this.manualIdentifierValue,
					session.id,
				)
				.then((result) => {
					this.manualLookupFeedback =
						result.status === "invalid" || result.status === "rejected"
							? result.message
							: "Lookup complete. Review the result before selecting it.";
					this.render();
				});
		});
		if (this.manualLookupFeedback)
			lookup.createEl("p", {
				text: this.manualLookupFeedback,
				cls: "pdf-intake-validation-message",
			});
	}

	private renderManualRecordForm(
		container: HTMLElement,
		item: IntakeSessionSnapshot["items"][number],
		session: IntakeSessionSnapshot,
	): void {
		const form = container.createDiv({ cls: "pdf-intake-manual-record-form" });
		form.createEl("h4", {
			text: this.inspectorFormDirty ? "Edit record · Unsaved" : "Edit bibliographic record",
		});
		const current = this.inspectorForm!;
		this.renderTextField(form, "Title", current.title, (value) => {
			current.title = value;
		});
		this.renderTextField(form, "Publication year", current.year, (value) => {
			current.year = value;
		});
		this.renderTextField(form, "DOI", current.doi, (value) => {
			current.doi = value;
		});
		this.renderTextField(
			form,
			"ISBNs (one per line)",
			current.isbns,
			(value) => {
				current.isbns = value;
			},
			true,
		);
		this.renderTextField(form, "Journal or container", current.journal, (value) => {
			current.journal = value;
		});
		this.renderTextField(form, "Publisher", current.publisher, (value) => {
			current.publisher = value;
		});
		this.renderAuthorshipEditor(form, current);
		for (const [field, message] of Object.entries(this.inspectorErrors))
			form.createEl("p", {
				text: `${field}: ${message}`,
				cls: "pdf-intake-validation-message",
			});
		const save = form.createEl("button", { text: "Save record" });
		save.addEventListener("click", () => void this.saveInspectorForm(false, session));
		const cancel = form.createEl("button", { text: "Cancel edits" });
		cancel.addEventListener("click", () => {
			this.inspectorFormDirty = false;
			this.inspectorErrors = {};
			this.coordinator.discardPendingInspectorForm(item.id, session.id);
			this.inspectorForm = this.makeInspectorForm(item);
			this.render();
		});
	}

	private renderTextField(
		container: HTMLElement,
		label: string,
		value: string,
		update: (value: string) => void,
		multiline = false,
	): void {
		const wrapper = container.createDiv({ cls: "pdf-intake-form-field" });
		wrapper.createEl("label", { text: label });
		const input = wrapper.createEl(
			multiline ? "textarea" : "input",
			multiline ? {} : { type: "text" },
		);
		input.value = value;
		input.setAttribute("aria-label", label);
		input.addEventListener("input", () => {
			update(input.value);
			this.inspectorFormDirty = true;
			this.inspectorErrors = {};
		});
	}

	private renderAuthorshipEditor(container: HTMLElement, form: InspectorFormState): void {
		const section = container.createDiv({ cls: "pdf-intake-authorship-editor" });
		section.createEl("h4", { text: "Ordered authorship" });
		const completeness = section.createEl("select");
		completeness.setAttribute("aria-label", "Authorship completeness");
		for (const option of ["complete", "partial", "unknown"] as const)
			completeness.createEl("option", {
				value: option,
				text: option[0].toUpperCase() + option.slice(1),
			});
		completeness.value = form.authorshipCompleteness;
		completeness.addEventListener("change", () => {
			form.authorshipCompleteness =
				completeness.value as InspectorFormState["authorshipCompleteness"];
			this.inspectorFormDirty = true;
		});
		const total = section.createEl("input", { type: "checkbox" });
		total.checked = form.totalCountKnown;
		total.setAttribute("aria-label", "Total author count is known");
		total.addEventListener("change", () => {
			form.totalCountKnown = total.checked;
			this.inspectorFormDirty = true;
		});
		section.createEl("label", { text: "Total author count is known" });
		form.authors.forEach((author, index) => {
			const row = section.createDiv({ cls: "pdf-intake-author-row" });
			row.createEl("span", { text: `Position ${index + 1}` });
			const kind = row.createEl("select");
			kind.setAttribute("aria-label", `Author ${index + 1} type`);
			for (const option of ["person", "organization", "literal", "unresolved"])
				kind.createEl("option", {
					value: option,
					text: option[0].toUpperCase() + option.slice(1),
				});
			kind.value = author.kind;
			kind.addEventListener("change", () => {
				const value = kind.value;
				form.authors[index] =
					value === "person"
						? { kind: "person" }
						: value === "organization"
							? { kind: "organization", literal: "" }
							: value === "unresolved"
								? { kind: "unresolved", position: index }
								: { kind: "literal", literal: "" };
				this.inspectorFormDirty = true;
				this.render();
			});
			if (author.kind === "person") {
				this.renderAuthorField(
					row,
					`Author ${index + 1} given name`,
					author.given ?? "",
					(given) => {
						form.authors[index] = { ...author, given };
					},
				);
				this.renderAuthorField(
					row,
					`Author ${index + 1} family name`,
					author.family ?? "",
					(family) => {
						form.authors[index] = { ...author, family };
					},
				);
			} else if (author.kind === "organization" || author.kind === "literal") {
				this.renderAuthorField(
					row,
					`Author ${index + 1} literal`,
					author.literal,
					(literal) => {
						form.authors[index] = { ...author, literal };
					},
				);
			} else if (author.kind === "unresolved") {
				this.renderAuthorField(
					row,
					`Author ${index + 1} note`,
					author.reference ?? "",
					(reference) => {
						form.authors[index] = { ...author, position: index, reference };
					},
				);
			}
			const up = row.createEl("button", { text: "Move up" });
			up.disabled = index === 0;
			up.addEventListener("click", () => this.moveAuthor(form, index, -1));
			const down = row.createEl("button", { text: "Move down" });
			down.disabled = index === form.authors.length - 1;
			down.addEventListener("click", () => this.moveAuthor(form, index, 1));
			const remove = row.createEl("button", { text: "Remove position" });
			remove.addEventListener("click", () => {
				form.authors.splice(index, 1);
				this.inspectorFormDirty = true;
				this.render();
			});
		});
		const add = section.createEl("button", { text: "Add author position" });
		add.addEventListener("click", () => {
			form.authors.push({ kind: "literal", literal: "" });
			this.inspectorFormDirty = true;
			this.render();
		});
	}

	private renderAuthorField(
		container: HTMLElement,
		label: string,
		value: string,
		update: (value: string) => void,
	): void {
		const input = container.createEl("input", { type: "text", value });
		input.setAttribute("aria-label", label);
		input.addEventListener("input", () => {
			update(input.value);
			this.inspectorFormDirty = true;
		});
	}

	private moveAuthor(form: InspectorFormState, index: number, delta: -1 | 1): void {
		const target = index + delta;
		if (target < 0 || target >= form.authors.length) return;
		[form.authors[index], form.authors[target]] = [form.authors[target], form.authors[index]];
		form.authors = form.authors.map((author, position) =>
			author.kind === "unresolved" ? { ...author, position } : author,
		);
		this.inspectorFormDirty = true;
		this.render();
	}

	private saveInspectorForm(continueAction: boolean, session: IntakeSessionSnapshot): void {
		const form = this.inspectorForm;
		if (!form) return;
		const yearText = form.year.trim();
		const year = yearText
			? /^\d{1,4}$/.test(yearText)
				? Number(yearText)
				: Number.NaN
			: undefined;
		const authors = form.authors.map((author, position) =>
			author.kind === "unresolved" ? { ...author, position } : author,
		);
		const draft: ManualRecordDraft = {
			title: form.title,
			year,
			doi: form.doi,
			isbns: form.isbns.split(/[\n,]+/),
			journal: form.journal,
			publisher: form.publisher,
			authorship: {
				authors,
				completeness: form.authorshipCompleteness,
				totalCountKnown: form.totalCountKnown,
			},
		};
		const item = session.items.find((entry) => entry.id === form.itemId);
		const result = this.coordinator.saveManualRecord(
			form.itemId,
			draft,
			session.id,
			item ? this.recordBasedOn(item) : undefined,
		);
		if (!result.saved) {
			this.inspectorErrors = result.fieldErrors;
			this.render();
			return;
		}
		this.inspectorFormDirty = false;
		this.inspectorErrors = {};
		this.manualFormVisible = true;
		const updated = this.session?.items.find((entry) => entry.id === form.itemId);
		if (updated) this.inspectorForm = this.makeInspectorForm(updated);
		if (continueAction && this.pendingInspectorAction) {
			const action = this.pendingInspectorAction;
			this.performInspectorAction(action, session.id);
		} else {
			this.pendingInspectorAction = undefined;
			this.render();
		}
	}

	private makeInspectorForm(
		item: IntakeSessionSnapshot["items"][number],
		pending?: PendingInspectorForm,
	): InspectorFormState {
		if (pending)
			return {
				itemId: pending.itemId,
				title: pending.values.title,
				year: pending.values.year,
				doi: pending.values.doi,
				isbns: pending.values.isbns.join("\n"),
				journal: pending.values.journal,
				publisher: pending.values.publisher,
				authors: JSON.parse(JSON.stringify(pending.values.authors)) as CanonicalAuthor[],
				authorshipCompleteness: pending.values.authorshipCompleteness,
				totalCountKnown: pending.values.totalCountKnown,
			};
		const record = item.effectiveRecord;
		return {
			itemId: item.id,
			title: record?.title ?? "",
			year: record?.year?.toString() ?? "",
			doi: record?.doi ?? "",
			isbns: record?.isbns.join("\n") ?? "",
			journal: record?.journal ?? "",
			publisher: record?.publisher ?? "",
			authors: record
				? (JSON.parse(JSON.stringify(record.authorship.authors)) as CanonicalAuthor[])
				: [],
			authorshipCompleteness: record?.authorship.completeness ?? "unknown",
			totalCountKnown: record?.authorship.totalCountKnown ?? false,
		};
	}

	private toPendingForm(form: InspectorFormState): PendingInspectorForm {
		return {
			itemId: form.itemId,
			unsaved: true,
			values: {
				title: form.title,
				year: form.year,
				doi: form.doi,
				isbns: form.isbns.split(/[\n,]+/),
				journal: form.journal,
				publisher: form.publisher,
				authors: JSON.parse(JSON.stringify(form.authors)) as CanonicalAuthor[],
				authorshipCompleteness: form.authorshipCompleteness,
				totalCountKnown: form.totalCountKnown,
			},
		};
	}

	private canRepairItem(
		item: IntakeSessionSnapshot["items"][number],
		session: IntakeSessionSnapshot,
	): boolean {
		return (
			session.recoveryGate === "none" &&
			session.applyState.status !== "applying" &&
			item.sourceHealth === "current" &&
			item.currentStatus !== "identifying" &&
			item.identification.status !== "identifying"
		);
	}

	private sameCandidate(
		left: CandidateReference | undefined,
		right: CandidateReference,
	): boolean {
		return (
			!!left &&
			left.provider === right.provider &&
			left.route === right.route &&
			left.lookupValue === right.lookupValue
		);
	}

	private statusLabel(status: WorkingCardState): string {
		return status === "needs-you"
			? "Needs you"
			: status === "no-change"
				? "No changes needed"
				: status === "left-unresolved"
					? "Left unresolved"
					: status[0].toUpperCase() + status.slice(1);
	}

	private providerLabel(provider: "crossref" | "openlibrary"): string {
		return provider === "crossref" ? "Crossref" : "Open Library";
	}

	private routeLabel(
		route: "doi" | "isbn" | "bibliographic-query" | "openlibrary-search",
	): string {
		return route === "doi"
			? "DOI"
			: route === "isbn"
				? "ISBN"
				: route === "bibliographic-query"
					? "Bibliographic search"
					: "Open Library search";
	}

	private outcomeLabel(outcome: string): string {
		return outcome === "no-record"
			? "no record"
			: outcome === "request-failed"
				? "request failed"
				: outcome === "title-mismatch"
					? "title differs"
					: outcome === "ambiguous"
						? "ambiguous"
						: "matched";
	}

	private authorityLabel(
		authority: IntakeSessionSnapshot["items"][number]["recordAuthority"],
	): string {
		return authority === "automatic"
			? "automatic identification"
			: authority === "user-selected"
				? "user-selected candidate"
				: authority === "user-edited"
					? "user-edited record"
					: "no accepted record";
	}

	private renderCandidateSummary(
		container: HTMLElement,
		record: CanonicalBibliographicRecord | ProviderBibliographicRecord,
		provider: "crossref" | "openlibrary",
	): void {
		container.createEl("p", {
			text: `${this.providerLabel(provider)} candidate: ${record.title ?? "Untitled work"}`,
		});
		const authors = deriveAuthorship(record.authorship, {
			selection: "all",
			nameStyle: "full",
			etAl: "never",
			nameOrder: "given-family",
			separator: "; ",
		});
		const context = [authors.value, record.year?.toString()].filter(Boolean).join(" · ");
		if (context) container.createEl("p", { text: context });
	}

	private renderRecordFields(container: HTMLElement, record: CanonicalBibliographicRecord): void {
		const authors = deriveAuthorship(record.authorship, {
			selection: "all",
			nameStyle: "full",
			etAl: "never",
			nameOrder: "given-family",
			separator: "; ",
		});
		const fields = [
			record.title ? `Title: ${record.title}` : "Title: (empty)",
			`Authorship: ${authors.value || "(empty)"} · ${record.authorship.completeness}${record.authorship.totalCountKnown ? " · total count known" : ""}`,
			record.year ? `Year: ${record.year}` : "Year: (empty)",
			record.doi ? `DOI: ${record.doi}` : "",
			record.isbns.length ? `ISBN: ${record.isbns.join(", ")}` : "",
			record.journal ? `Journal/container: ${record.journal}` : "",
			record.publisher ? `Publisher: ${record.publisher}` : "",
		].filter(Boolean);
		for (const field of fields) container.createEl("p", { text: field });
	}

	private recordBasedOn(
		item: IntakeSessionSnapshot["items"][number],
	): CandidateReference | undefined {
		if (item.recordDecision?.kind === "selected-candidate")
			return item.recordDecision.candidate;
		if (item.recordDecision?.kind === "user-edited-record") return item.recordDecision.basedOn;
		const provenance = item.effectiveRecord?.provenance;
		if (!provenance || "kind" in provenance || !provenance.identifier) return undefined;
		return {
			provider: provenance.provider,
			route: provenance.route,
			lookupValue: provenance.identifier,
		};
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
