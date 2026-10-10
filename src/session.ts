import { TFile, type Vault } from "obsidian";
import type {
	ApplyChangesService,
	ApplyInvocationResult,
	RenameApplyOutcome,
} from "./apply-changes";
import type { JsonValue, PluginDataStore, SettingsPatch } from "./persistence";
import {
	createApplyInvocation,
	formatFilename,
	isCanonicalVaultFolderPath,
	planRenames,
	type IdentificationState,
	type PlanningInput,
	type PlanningSnapshot,
	type RenamePlanResult,
	type SourceObservation,
} from "./planning";
import type {
	MetadataAndNaming,
	OutputLocation,
	SessionConfiguration,
	WorkspaceEditPolicy,
} from "./types";
import type { IdentificationResult } from "./resolver";

export type SetupConcern = "pdfs" | "output" | "metadata-and-naming";
export type SessionPhase = "setup" | "working";
export const WORKING_STATUS_ORDER = ["identifying", "needs-you", "ready"] as const;

export interface SessionPdf {
	id: string;
	readonly admissionObservation: Readonly<SourceObservation>;
	sourceObservation: SourceObservation;
	identification: IdentificationState;
	sourceHealth?: PdfSourceHealth;
	sourceIssue?: string;
	sourceIssueHealth?: PdfSourceHealth;
	plan?: RenamePlanResult;
	applyOutcome?: RenameApplyOutcome;
}

export type PdfSourceHealth =
	| "current"
	| "missing"
	| "renamed"
	| "replaced"
	| "changed"
	| "unverified"
	| "binding-unavailable";

export type PdfPathClassification =
	"selectable" | "already-represented" | "unavailable" | "stale-session";

export interface PdfAdmissionResult {
	staleSession: boolean;
	addedItemIds: string[];
	duplicates: string[];
	rejected: { path: string; reason: string }[];
}

export interface IntakeSession {
	id: string;
	revision: number;
	phase: SessionPhase;
	setupOpen: boolean;
	setupConcern: SetupConcern;
	configuration: SessionConfiguration;
	items: SessionPdf[];
	planningSnapshot: PlanningSnapshot | null;
	applyState: { status: "idle" | "applying" | "completed" | "rejected"; invocationId?: string };
}

export interface IntakeSessionSnapshot extends IntakeSession {
	outputFolderPaths: string[];
	exampleFilename: string | null;
}

const NAMING_EXAMPLE_RECORD = {
	title: "Example Title",
	authorship: {
		authors: [
			{ kind: "person" as const, family: "Tesar" },
			{ kind: "person" as const, family: "Chilisa" },
		],
		completeness: "complete" as const,
		totalCountKnown: true,
	},
	year: 2023,
	isbns: [],
	provenance: {
		provider: "crossref" as const,
		route: "doi" as const,
		identifier: "10.1234/example",
	},
};

export interface IdentificationRunContext {
	sourceObservation: SourceObservation;
	shouldCancel: () => boolean;
}

export type IdentificationRunner = (
	file: TFile,
	context: IdentificationRunContext,
) => Promise<IdentificationResult>;

export interface SessionCoordinatorOptions {
	applyService?: ApplyChangesService;
	vault?: Vault;
	identificationRunner?: IdentificationRunner;
	planningEnvironment?: PlanningEnvironmentProvider;
}

export interface PlanningEnvironmentSnapshot {
	filePaths: readonly string[];
	folderPaths: readonly string[];
}

export interface PlanningEnvironmentProvider {
	getSnapshot(): PlanningEnvironmentSnapshot;
	getOutputFolderPaths?(): readonly string[];
}

export interface SessionEditResult {
	updated: boolean;
	savedForFutureSessions: boolean;
	message?: string;
}

interface IdentificationAttemptToken {
	attemptId: string;
	sessionId: string;
	itemId: string;
	sourceObservation: SourceObservation;
	binding: TFile;
	cancelled: boolean;
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function same(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function isVaultRelativePath(path: string): boolean {
	if (!path || path.startsWith("/") || path.includes("\\")) return false;
	const parts = path.split("/");
	return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

export function createFreshSession(configuration: SessionConfiguration, id: string): IntakeSession {
	return {
		id,
		revision: 0,
		phase: "setup",
		setupOpen: true,
		setupConcern: "pdfs",
		configuration: clone(configuration),
		items: [],
		planningSnapshot: null,
		applyState: { status: "idle" },
	};
}

/** Owns one plugin-lifetime session independently from any ItemView instance. */
export class SessionCoordinator {
	private readonly store: PluginDataStore;
	private readonly applyService?: ApplyChangesService;
	private readonly vault?: Vault;
	private readonly identificationRunner?: IdentificationRunner;
	private readonly planningEnvironment?: PlanningEnvironmentProvider;
	private session: IntakeSession;
	private readonly sourceBindings = new Map<string, TFile>();
	private readonly listeners = new Set<(snapshot: IntakeSessionSnapshot) => void>();
	private planningBasis: PlanningInput | null = null;
	private invocationCounter = 0;
	private attemptCounter = 0;
	private readonly queuedAttempts: IdentificationAttemptToken[] = [];
	private readonly activeAttempts = new Map<string, IdentificationAttemptToken>();
	private readonly attemptByItem = new Map<string, IdentificationAttemptToken>();
	private readonly maxUnsettledJobs = 2;
	private activeInvocationId?: string;
	private disposed = false;

	constructor(store: PluginDataStore, options: SessionCoordinatorOptions = {}) {
		this.store = store;
		this.applyService = options.applyService;
		this.vault = options.vault;
		this.identificationRunner = options.identificationRunner;
		this.planningEnvironment = options.planningEnvironment;
		this.session = createFreshSession(store.getSettings().defaults, this.nextSessionId());
	}

	getSnapshot(): IntakeSessionSnapshot {
		const snapshot = clone(this.session);
		snapshot.items = snapshot.items.map((item) => ({
			...item,
			sourceHealth: this.getSourceHealth(item),
		}));
		return {
			...snapshot,
			outputFolderPaths: [...this.getOutputFolderPaths()],
			exampleFilename: formatFilename(
				NAMING_EXAMPLE_RECORD,
				snapshot.configuration.metadataAndNaming.filenameFormat,
			).filename,
		};
	}

	/** Classifies one currently visible vault path without exposing its live TFile binding. */
	classifyPdfPath(path: string, expectedSessionId: string): PdfPathClassification {
		if (this.session.id !== expectedSessionId) return "stale-session";
		const file = this.currentPdfAtPath(path);
		if (!file) return "unavailable";
		return this.isAlreadyRepresented(path, file) ? "already-represented" : "selectable";
	}

	/** Refreshes derived source-health values without changing session revision or membership. */
	refreshSourceHealth(expectedSessionId: string): boolean {
		if (this.session.id !== expectedSessionId) return false;
		let changed = false;
		for (const item of this.session.items) {
			const health = this.getSourceHealth(item);
			if (health === "current") continue;
			const reason = this.sourceHealthReason(health);
			if (
				item.sourceIssue !== reason ||
				item.sourceIssueHealth !== health ||
				item.identification.status !== "needs-user" ||
				item.identification.reason !== reason
			) {
				this.cancelAttemptForItem(item.id);
				this.markSourceNeedsYou(item, reason);
				item.sourceIssueHealth = health;
				changed = true;
			}
		}
		if (changed) {
			this.session.revision++;
			this.invalidatePlanning();
			this.replanCurrentSession();
		} else {
			this.emit();
		}
		return true;
	}

	/** Resolves chooser paths again at confirmation; accepted membership stays coordinator-owned. */
	addPdfs(paths: readonly string[], expectedSessionId: string): PdfAdmissionResult {
		const result: PdfAdmissionResult = {
			staleSession:
				this.activeInvocationId !== undefined ||
				this.session.id !== expectedSessionId ||
				this.session.phase !== "setup",
			addedItemIds: [],
			duplicates: [],
			rejected: [],
		};
		if (result.staleSession) return result;

		for (const path of paths) {
			const file = this.currentPdfAtPath(path);
			if (!file) {
				result.rejected.push({
					path,
					reason: "Missing, folder, non-PDF, or invalid source",
				});
				continue;
			}
			if (this.isAlreadyRepresented(path, file)) {
				result.duplicates.push(path);
				continue;
			}

			const id = globalThis.crypto.randomUUID();
			const observation = {
				path: file.path,
				mtime: file.stat.mtime,
				size: file.stat.size,
			};
			this.session.items.push({
				id,
				admissionObservation: clone(observation),
				sourceObservation: clone(observation),
				identification: { status: "unattempted" },
			});
			this.sourceBindings.set(id, file);
			result.addedItemIds.push(id);
		}

		if (result.addedItemIds.length > 0) {
			this.session.revision++;
			this.invalidatePlanning();
		}
		this.emit();
		return clone(result);
	}

	/** Removes only session membership; stale callbacks from another session are ignored. */
	removePdf(itemId: string, expectedSessionId: string): boolean {
		if (
			this.activeInvocationId ||
			this.session.id !== expectedSessionId ||
			this.session.phase !== "setup"
		)
			return false;
		const index = this.session.items.findIndex((item) => item.id === itemId);
		if (index < 0) return false;
		this.session.items.splice(index, 1);
		this.cancelAttemptForItem(itemId);
		this.sourceBindings.delete(itemId);
		this.session.revision++;
		this.invalidatePlanning();
		this.emit();
		return true;
	}

	subscribe(listener: (snapshot: IntakeSessionSnapshot) => void): () => void {
		if (this.disposed) return () => undefined;
		this.listeners.add(listener);
		listener(this.getSnapshot());
		return () => this.listeners.delete(listener);
	}

	setSetupConcern(concern: SetupConcern): void {
		if (this.activeInvocationId || this.session.phase !== "setup") return;
		this.session.setupConcern = concern;
		this.emit();
	}

	openSetup(): void {
		if (this.activeInvocationId) return;
		this.session.setupOpen = true;
		this.emit();
	}

	closeSetup(): void {
		if (this.activeInvocationId) return;
		this.session.setupOpen = false;
		this.emit();
	}

	/** Starts read-only identification automatically for current admitted sources. */
	beginReview(): { allowed: boolean; reason?: string } {
		if (this.activeInvocationId) {
			return { allowed: false, reason: "Apply is in progress." };
		}
		if (this.session.items.length === 0) {
			return { allowed: false, reason: "Add at least one PDF before beginning review." };
		}
		if (this.session.phase === "working") {
			return { allowed: false, reason: "Review is already in progress." };
		}
		this.session.phase = "working";
		this.session.setupOpen = false;
		this.enqueueUnattemptedItems();
		this.emit();
		return { allowed: true };
	}

	returnToSetup(expectedSessionId: string): boolean {
		if (
			this.activeInvocationId ||
			this.session.id !== expectedSessionId ||
			this.session.phase !== "working"
		) {
			return false;
		}
		this.cancelIdentificationAttempts();
		this.session.phase = "setup";
		this.session.setupOpen = true;
		this.replanCurrentSession();
		return true;
	}

	createNewSession(): IntakeSession {
		if (this.activeInvocationId) return this.getSnapshot();
		this.cancelIdentificationAttempts();
		this.session = createFreshSession(this.store.getSettings().defaults, this.nextSessionId());
		this.sourceBindings.clear();
		this.planningBasis = null;
		this.activeInvocationId = undefined;
		this.emit();
		return this.getSnapshot();
	}

	async updateOutput(output: OutputLocation): Promise<SessionEditResult> {
		const existingFolders = this.getOutputFolderPaths();
		if (
			output.mode === "vault-folder" &&
			(!isCanonicalVaultFolderPath(output.folderPath) ||
				(output.folderPath !== "" && !existingFolders.includes(output.folderPath)))
		) {
			return {
				updated: false,
				savedForFutureSessions: false,
				message: "Choose an existing vault folder.",
			};
		}
		return this.updateConfiguration({ output: clone(output) });
	}

	async updateMetadataAndNaming(patch: Partial<MetadataAndNaming>): Promise<SessionEditResult> {
		return this.updateConfiguration({
			metadataAndNaming: {
				...clone(this.session.configuration.metadataAndNaming),
				...clone(patch),
			},
		});
	}

	/** Replans detached coordinator state using fresh read-only vault path snapshots. */
	replanCurrentSession(): PlanningSnapshot {
		const environment = this.getPlanningEnvironment();
		const input = this.createPlanningInput(environment.filePaths, environment.folderPaths);
		const snapshot = planRenames(input);
		this.planningBasis = clone(input);
		this.session.planningSnapshot = clone(snapshot);
		const resultsById = new Map(snapshot.results.map((result) => [result.itemId, result]));
		this.session.items = this.session.items.map((item) => {
			const plan = resultsById.get(item.id);
			return { ...item, plan: plan === undefined ? undefined : clone(plan) };
		});
		this.emit();
		return clone(snapshot);
	}

	async applyReviewedPlan(): Promise<ApplyInvocationResult> {
		if (this.activeInvocationId)
			return { status: "busy", message: "This session already has an Apply invocation" };
		if (!this.applyService)
			return { status: "rejected", message: "Apply service is unavailable" };
		if (this.invalidateStaleSourcesForApply()) {
			this.replanCurrentSession();
			return { status: "rejected", message: "A reviewed source is no longer current" };
		}
		const snapshot = this.session.planningSnapshot;
		const basis = this.planningBasis;
		if (
			snapshot === null ||
			basis === null ||
			snapshot.sessionId !== this.session.id ||
			snapshot.sessionRevision !== this.session.revision
		) {
			return {
				status: "rejected",
				message: "There is no current coordinator-owned plan for this session",
			};
		}
		const environment = this.getPlanningEnvironment();
		const currentBasis = this.createPlanningInput(
			environment.filePaths,
			environment.folderPaths,
		);
		if (!same(currentBasis, basis) || !same(planRenames(currentBasis), snapshot)) {
			return {
				status: "rejected",
				message: "The reviewed plan no longer matches current session values",
			};
		}
		const created = createApplyInvocation(
			snapshot,
			this.session.revision,
			this.nextInvocationId(),
		);
		if (!created.ok) return { status: "rejected", message: created.message };
		const itemIds = new Set(this.session.items.map((item) => item.id));
		if (created.invocation.operations.some((operation) => !itemIds.has(operation.itemId))) {
			return {
				status: "rejected",
				message: "The reviewed plan includes an item outside this session",
			};
		}
		const invocation = created.invocation;
		this.activeInvocationId = invocation.invocationId;
		this.session.applyState = { status: "applying", invocationId: this.activeInvocationId };
		this.emit();
		const bindings = new Map<string, TFile>();
		for (const operation of invocation.operations) {
			const binding = this.sourceBindings.get(operation.itemId);
			if (binding) bindings.set(operation.itemId, binding);
		}
		try {
			const result = await this.applyService.apply(invocation, bindings);
			this.reconcileApplyResult(invocation, result, bindings);
			return result;
		} catch (error) {
			this.session.applyState = { status: "rejected", invocationId: invocation.invocationId };
			this.finishApplyAndReplan();
			return { status: "rejected", message: errorText(error) };
		}
	}

	dispose(): void {
		this.disposed = true;
		this.cancelIdentificationAttempts();
		this.listeners.clear();
		this.sourceBindings.clear();
	}

	getWorkspaceEditPolicy(): WorkspaceEditPolicy {
		return this.store.getSettings().workspaceEditPolicy;
	}

	getPersistenceDiagnostics(): string[] {
		return this.store.getDiagnostics().map((diagnostic) => diagnostic.message);
	}

	getDraftNamespace(): JsonValue {
		return this.store.getDraftNamespace();
	}

	private enqueueUnattemptedItems(): void {
		let changed = false;
		for (const item of this.session.items) {
			if (item.identification.status !== "unattempted") {
				if (this.getSourceHealth(item) !== "current") {
					const health = this.getSourceHealth(item);
					const reason = this.sourceHealthReason(health);
					if (
						item.sourceIssue !== reason ||
						item.sourceIssueHealth !== health ||
						item.identification.status !== "needs-user" ||
						item.identification.reason !== reason
					) {
						this.markSourceNeedsYou(item, reason);
						item.sourceIssueHealth = health;
						changed = true;
					}
				}
				continue;
			}
			const health = this.getSourceHealth(item);
			if (health !== "current") {
				this.markSourceNeedsYou(item, this.sourceHealthReason(health));
				changed = true;
				continue;
			}
			const binding = this.sourceBindings.get(item.id);
			if (!binding) {
				this.markSourceNeedsYou(item, "The admitted PDF is no longer available.");
				changed = true;
				continue;
			}
			const token: IdentificationAttemptToken = {
				attemptId: `attempt-${++this.attemptCounter}`,
				sessionId: this.session.id,
				itemId: item.id,
				sourceObservation: clone(item.sourceObservation),
				binding,
				cancelled: false,
			};
			item.identification = { status: "identifying" };
			this.attemptByItem.set(item.id, token);
			this.queuedAttempts.push(token);
			changed = true;
		}
		if (changed) {
			this.session.revision++;
			this.invalidatePlanning();
		}
		this.replanCurrentSession();
		this.pumpIdentificationQueue();
	}

	private pumpIdentificationQueue(): void {
		while (
			!this.disposed &&
			this.activeAttempts.size < this.maxUnsettledJobs &&
			this.queuedAttempts.length > 0
		) {
			const token = this.queuedAttempts.shift();
			if (!token) continue;
			this.activeAttempts.set(token.attemptId, token);
			if (!this.isTokenCurrent(token)) {
				if (this.isTokenCurrentIgnoringSource(token)) this.acceptStaleSourceResult(token);
				this.activeAttempts.delete(token.attemptId);
				if (this.attemptByItem.get(token.itemId) === token) {
					this.attemptByItem.delete(token.itemId);
				}
				continue;
			}
			void this.runIdentificationAttempt(token);
		}
	}

	private async runIdentificationAttempt(token: IdentificationAttemptToken): Promise<void> {
		try {
			const result = this.identificationRunner
				? await this.identificationRunner(token.binding, {
						sourceObservation: clone(token.sourceObservation),
						shouldCancel: () => !this.isTokenCurrent(token),
					})
				: undefined;
			if (result && this.isTokenCurrent(token)) {
				this.acceptIdentification(token, result);
			} else if (!token.cancelled && this.isTokenCurrentIgnoringSource(token)) {
				if (this.getSourceHealth(this.getItem(token.itemId)!) !== "current") {
					this.acceptStaleSourceResult(token);
				} else if (!result) {
					this.acceptIdentificationFailure(token);
				}
			}
		} catch {
			if (this.isTokenCurrent(token)) this.acceptIdentificationFailure(token);
			else if (!token.cancelled && this.isTokenCurrentIgnoringSource(token)) {
				this.acceptStaleSourceResult(token);
			}
		} finally {
			this.activeAttempts.delete(token.attemptId);
			if (this.attemptByItem.get(token.itemId) === token) {
				this.attemptByItem.delete(token.itemId);
			}
			this.pumpIdentificationQueue();
		}
	}

	private acceptIdentification(
		token: IdentificationAttemptToken,
		result: IdentificationResult,
	): void {
		const item = this.getItem(token.itemId);
		if (!item) return;
		item.sourceIssue = undefined;
		item.identification =
			result.status === "accepted"
				? {
						status: "resolved",
						record: clone(result.record),
						evidence: clone(result.evidence),
					}
				: { status: "needs-user", reason: result.reason, evidence: clone(result.evidence) };
		this.session.revision++;
		this.invalidatePlanning();
		this.replanCurrentSession();
	}

	private acceptIdentificationFailure(token: IdentificationAttemptToken): void {
		const item = this.getItem(token.itemId);
		if (!item) return;
		item.identification = {
			status: "needs-user",
			reason: "Identification could not complete.",
		};
		this.session.revision++;
		this.invalidatePlanning();
		this.replanCurrentSession();
	}

	private acceptStaleSourceResult(token: IdentificationAttemptToken): void {
		const item = this.getItem(token.itemId);
		if (!item) return;
		const health = this.getSourceHealth(item);
		this.markSourceNeedsYou(item, this.sourceHealthReason(health));
		this.session.revision++;
		this.invalidatePlanning();
		this.replanCurrentSession();
	}

	private isTokenCurrent(token: IdentificationAttemptToken): boolean {
		return (
			this.isTokenCurrentIgnoringSource(token) &&
			this.getSourceHealthForToken(token) === "current"
		);
	}

	private isTokenCurrentIgnoringSource(token: IdentificationAttemptToken): boolean {
		return (
			!this.disposed &&
			!token.cancelled &&
			this.session.phase === "working" &&
			this.session.id === token.sessionId &&
			this.activeAttempts.get(token.attemptId) === token &&
			this.attemptByItem.get(token.itemId) === token &&
			this.sourceBindings.get(token.itemId) === token.binding &&
			same(this.getItem(token.itemId)?.sourceObservation, token.sourceObservation)
		);
	}

	private getSourceHealthForToken(token: IdentificationAttemptToken): PdfSourceHealth {
		const item = this.getItem(token.itemId);
		return item ? this.getSourceHealth(item) : "missing";
	}

	private cancelAttemptForItem(itemId: string): void {
		const token = this.attemptByItem.get(itemId);
		if (!token) return;
		token.cancelled = true;
		this.attemptByItem.delete(itemId);
		this.queuedAttempts.splice(
			0,
			this.queuedAttempts.length,
			...this.queuedAttempts.filter((entry) => entry !== token),
		);
	}

	private cancelIdentificationAttempts(): void {
		for (const token of this.attemptByItem.values()) token.cancelled = true;
		this.attemptByItem.clear();
		this.queuedAttempts.length = 0;
		let changed = false;
		for (const item of this.session.items) {
			if (item.identification.status === "identifying") {
				item.identification = { status: "unattempted" };
				changed = true;
			}
		}
		if (changed) {
			this.session.revision++;
			this.invalidatePlanning();
		}
	}

	private markSourceNeedsYou(item: SessionPdf, reason: string): void {
		item.sourceIssue = reason;
		item.sourceIssueHealth = this.getSourceHealth(item);
		const evidence =
			"evidence" in item.identification ? item.identification.evidence : undefined;
		item.identification = {
			status: "needs-user",
			reason,
			...(evidence ? { evidence: clone(evidence) } : {}),
		};
	}

	private sourceHealthReason(health: PdfSourceHealth): string {
		switch (health) {
			case "missing":
				return "The admitted PDF is no longer available.";
			case "renamed":
				return "The admitted PDF has moved since it was added.";
			case "replaced":
				return "A different file now occupies the admitted PDF path.";
			case "changed":
				return "The admitted PDF changed since it was added.";
			case "unverified":
				return "The renamed PDF could not be verified at its destination.";
			default:
				return "The admitted PDF binding is unavailable.";
		}
	}

	private getItem(itemId: string): SessionPdf | undefined {
		return this.session.items.find((item) => item.id === itemId);
	}

	private getPlanningEnvironment(): PlanningEnvironmentSnapshot {
		if (!this.planningEnvironment) return { filePaths: [], folderPaths: [] };
		try {
			const snapshot = this.planningEnvironment.getSnapshot();
			return clone({
				filePaths: [...snapshot.filePaths],
				folderPaths: [...snapshot.folderPaths],
			});
		} catch {
			return { filePaths: [], folderPaths: [] };
		}
	}

	private getOutputFolderPaths(): readonly string[] {
		if (!this.planningEnvironment) return [];
		try {
			return [
				...(this.planningEnvironment.getOutputFolderPaths?.() ??
					this.planningEnvironment.getSnapshot().folderPaths),
			];
		} catch {
			return [];
		}
	}

	private planningIdentification(item: SessionPdf): IdentificationState {
		if (item.sourceIssue) {
			return {
				status: "needs-user",
				reason: item.sourceIssue,
				...("evidence" in item.identification && item.identification.evidence
					? { evidence: clone(item.identification.evidence) }
					: {}),
			};
		}
		const health = this.getSourceHealth(item);
		if (health !== "current") {
			return {
				status: "needs-user",
				reason: this.sourceHealthReason(health),
				...("evidence" in item.identification && item.identification.evidence
					? { evidence: clone(item.identification.evidence) }
					: {}),
			};
		}
		return item.identification;
	}

	private invalidateStaleSourcesForApply(): boolean {
		const operations =
			this.session.planningSnapshot?.results.filter(
				(result): result is Extract<RenamePlanResult, { status: "eligible" }> =>
					result.status === "eligible",
			) ?? [];
		let stale = false;
		for (const operation of operations) {
			const item = this.getItem(operation.itemId);
			if (!item) {
				stale = true;
				continue;
			}
			const health = this.getSourceHealth(item);
			if (health !== "current") {
				this.markSourceNeedsYou(item, this.sourceHealthReason(health));
				stale = true;
			}
		}
		if (stale) {
			this.session.revision++;
			this.invalidatePlanning();
		}
		return stale;
	}

	private reconcileApplyResult(
		invocation: import("./planning").ApplyInvocation,
		result: ApplyInvocationResult,
		bindings: ReadonlyMap<string, TFile>,
	): void {
		if (this.session.id !== invocation.sessionId) {
			this.finishApplyAndReplan();
			return;
		}
		let reconciliationChanged = false;
		if (result.status === "completed") {
			const operations = new Map(
				invocation.operations.map((operation) => [operation.itemId, operation]),
			);
			for (const outcome of result.outcomes) {
				const operation = operations.get(outcome.itemId);
				const item = this.getItem(outcome.itemId);
				if (!operation || !item) continue;
				item.applyOutcome = clone(outcome);
				if (outcome.status === "renamed") {
					const binding = bindings.get(item.id);
					const current = this.vault?.getAbstractFileByPath(operation.destinationPath);
					const outcomeMatchesInvocation =
						outcome.sourcePath === operation.sourcePath &&
						outcome.destinationPath === operation.destinationPath &&
						outcome.effects.path === true &&
						outcome.effects.pdfBytes === false;
					const valid =
						outcomeMatchesInvocation &&
						!!binding &&
						this.sourceBindings.get(item.id) === binding &&
						current === binding &&
						binding.path === operation.destinationPath &&
						binding.extension.toLowerCase() === "pdf" &&
						Number.isFinite(binding.stat?.mtime) &&
						Number.isFinite(binding.stat?.size) &&
						binding.stat.size >= 0;
					if (valid && binding) {
						const nextObservation = {
							path: binding.path,
							mtime: binding.stat.mtime,
							size: binding.stat.size,
						};
						if (!same(item.sourceObservation, nextObservation))
							reconciliationChanged = true;
						item.sourceObservation = clone(nextObservation);
						item.sourceIssue = undefined;
						item.sourceIssueHealth = undefined;
					} else {
						this.markSourceNeedsYou(
							item,
							"The renamed PDF could not be verified at its destination.",
						);
						item.sourceIssueHealth = "unverified";
						reconciliationChanged = true;
					}
				} else if (outcome.status === "blocked" && outcome.reason === "source-changed") {
					const health = this.getSourceHealth(item);
					this.markSourceNeedsYou(item, this.sourceHealthReason(health));
					reconciliationChanged = true;
				}
			}
			this.session.applyState = {
				status: "completed",
				invocationId: result.invocationId,
			};
		} else {
			this.session.applyState = { status: "rejected", invocationId: invocation.invocationId };
		}
		if (reconciliationChanged) this.session.revision++;
		this.finishApplyAndReplan();
	}

	private finishApplyAndReplan(): void {
		this.invalidatePlanning();
		this.replanCurrentSession();
		this.activeInvocationId = undefined;
		this.emit();
	}

	private async updateConfiguration(
		patch: Partial<SessionConfiguration>,
	): Promise<SessionEditResult> {
		if (this.activeInvocationId || this.session.phase !== "setup") {
			return {
				updated: false,
				savedForFutureSessions: false,
				message: this.activeInvocationId
					? "Session edits are unavailable while Apply is in progress."
					: "Return to setup before editing this session.",
			};
		}
		const policy = this.store.getSettings().workspaceEditPolicy;
		const next: SessionConfiguration = {
			...this.session.configuration,
			...clone(patch),
		};
		if (same(next, this.session.configuration)) {
			return { updated: false, savedForFutureSessions: false };
		}
		this.session.configuration = clone(next);
		this.session.revision++;
		this.invalidatePlanning();
		this.replanCurrentSession();
		if (policy === "session-only") return { updated: true, savedForFutureSessions: false };
		const settingsPatch: SettingsPatch = { defaults: clone(patch) };
		try {
			await this.store.updateSettings(settingsPatch);
			return { updated: true, savedForFutureSessions: true };
		} catch (error) {
			return {
				updated: true,
				savedForFutureSessions: false,
				message: `This session changed, but the future default was not saved: ${errorText(error)}`,
			};
		}
	}

	private emit(): void {
		if (this.disposed) return;
		const snapshot = this.getSnapshot();
		for (const listener of this.listeners) listener(clone(snapshot));
	}

	private invalidatePlanning(): void {
		this.session.planningSnapshot = null;
		this.planningBasis = null;
		this.session.items = this.session.items.map((item) => ({ ...item, plan: undefined }));
	}

	private currentPdfAtPath(path: string): TFile | undefined {
		if (!this.vault || !isVaultRelativePath(path)) return undefined;
		const current = this.vault.getAbstractFileByPath(path);
		if (!(current instanceof TFile)) return undefined;
		if (current.path !== path || current.extension.toLowerCase() !== "pdf") return undefined;
		if (
			!Number.isFinite(current.stat?.mtime) ||
			!Number.isFinite(current.stat?.size) ||
			current.stat.size < 0
		)
			return undefined;
		return current;
	}

	private isAlreadyRepresented(path: string, file: TFile): boolean {
		return this.session.items.some(
			(item) =>
				item.sourceObservation.path === path || this.sourceBindings.get(item.id) === file,
		);
	}

	private getSourceHealth(item: SessionPdf): PdfSourceHealth {
		if (item.sourceIssueHealth) return item.sourceIssueHealth;
		const binding = this.sourceBindings.get(item.id);
		if (!binding || !this.vault) return "binding-unavailable";
		const currentAtOriginalPath = this.vault.getAbstractFileByPath(item.sourceObservation.path);
		if (currentAtOriginalPath && currentAtOriginalPath !== binding) return "replaced";
		const currentAtBoundPath = this.vault.getAbstractFileByPath(binding.path);
		if (currentAtBoundPath !== binding) return currentAtBoundPath ? "replaced" : "missing";
		if (binding.extension.toLowerCase() !== "pdf") return "changed";
		if (
			binding.stat.mtime !== item.sourceObservation.mtime ||
			binding.stat.size !== item.sourceObservation.size
		)
			return "changed";
		if (binding.path !== item.sourceObservation.path) return "renamed";
		if (currentAtOriginalPath !== binding) return "missing";
		return "current";
	}

	private createPlanningInput(
		vaultFilePaths: readonly string[],
		vaultFolderPaths: readonly string[],
	): PlanningInput {
		return clone({
			sessionId: this.session.id,
			sessionRevision: this.session.revision,
			configuration: this.session.configuration,
			items: this.session.items.map((item) => ({
				itemId: item.id,
				sourceObservation: item.sourceObservation,
				identification: this.planningIdentification(item),
			})),
			vaultFilePaths: [...vaultFilePaths],
			vaultFolderPaths: [...vaultFolderPaths],
		});
	}

	private nextSessionId(): string {
		return globalThis.crypto.randomUUID();
	}

	private nextInvocationId(): string {
		this.invocationCounter++;
		return `invocation-${this.invocationCounter}`;
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
