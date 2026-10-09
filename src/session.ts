import { TFile, type Vault } from "obsidian";
import type {
	ApplyChangesService,
	ApplyInvocationResult,
	RenameApplyOutcome,
} from "./apply-changes";
import type { JsonValue, PluginDataStore, SettingsPatch } from "./persistence";
import {
	createApplyInvocation,
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

export type SetupConcern = "pdfs" | "output" | "metadata-and-naming";
export type SessionPhase = "setup" | "working";
export const WORKING_STATUS_ORDER = ["identifying", "needs-you", "ready"] as const;

export interface SessionPdf {
	id: string;
	sourceObservation: SourceObservation;
	identification: IdentificationState;
	sourceHealth?: PdfSourceHealth;
	plan?: RenamePlanResult;
	applyOutcome?: RenameApplyOutcome;
}

export type PdfSourceHealth =
	"current" | "missing" | "renamed" | "replaced" | "changed" | "binding-unavailable";

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

export interface SessionEditResult {
	updated: boolean;
	savedForFutureSessions: boolean;
	message?: string;
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
	private session: IntakeSession;
	private readonly sourceBindings = new Map<string, TFile>();
	private readonly listeners = new Set<(snapshot: IntakeSession) => void>();
	private planningBasis: PlanningInput | null = null;
	private invocationCounter = 0;
	private activeInvocationId?: string;
	private disposed = false;

	constructor(store: PluginDataStore, applyService?: ApplyChangesService, vault?: Vault) {
		this.store = store;
		this.applyService = applyService;
		this.vault = vault;
		this.session = createFreshSession(store.getSettings().defaults, this.nextSessionId());
	}

	getSnapshot(): IntakeSession {
		const snapshot = clone(this.session);
		snapshot.items = snapshot.items.map((item) => ({
			...item,
			sourceHealth: this.getSourceHealth(item),
		}));
		return snapshot;
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
		this.emit();
		return true;
	}

	/** Resolves chooser paths again at confirmation; accepted membership stays coordinator-owned. */
	addPdfs(paths: readonly string[], expectedSessionId: string): PdfAdmissionResult {
		const result: PdfAdmissionResult = {
			staleSession: this.session.id !== expectedSessionId,
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
			this.session.items.push({
				id,
				sourceObservation: {
					path: file.path,
					mtime: file.stat.mtime,
					size: file.stat.size,
				},
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
		if (this.session.id !== expectedSessionId) return false;
		const index = this.session.items.findIndex((item) => item.id === itemId);
		if (index < 0) return false;
		this.session.items.splice(index, 1);
		this.sourceBindings.delete(itemId);
		this.session.revision++;
		this.invalidatePlanning();
		this.emit();
		return true;
	}

	subscribe(listener: (snapshot: IntakeSession) => void): () => void {
		if (this.disposed) return () => undefined;
		this.listeners.add(listener);
		listener(this.getSnapshot());
		return () => this.listeners.delete(listener);
	}

	setSetupConcern(concern: SetupConcern): void {
		this.session.setupConcern = concern;
		this.emit();
	}

	openSetup(): void {
		this.session.setupOpen = true;
		this.emit();
	}

	closeSetup(): void {
		this.session.setupOpen = false;
		this.emit();
	}

	/** Zero-item review stays unavailable until the later identification slice. */
	beginReview(): { allowed: boolean; reason?: string } {
		if (this.session.items.length === 0) {
			return { allowed: false, reason: "Add at least one PDF before beginning review." };
		}
		return { allowed: false, reason: "Review is not available yet." };
	}

	createNewSession(): IntakeSession {
		this.session = createFreshSession(this.store.getSettings().defaults, this.nextSessionId());
		this.sourceBindings.clear();
		this.planningBasis = null;
		this.activeInvocationId = undefined;
		this.emit();
		return this.getSnapshot();
	}

	async updateOutput(
		output: OutputLocation,
		existingFolders: readonly string[],
	): Promise<SessionEditResult> {
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

	planCurrentSession(
		vaultFilePaths: readonly string[],
		vaultFolderPaths: readonly string[],
	): PlanningSnapshot {
		const input = this.createPlanningInput(vaultFilePaths, vaultFolderPaths);
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
		if (!this.applyService)
			return { status: "rejected", message: "Apply service is unavailable" };
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
		const currentBasis = this.createPlanningInput(basis.vaultFilePaths, basis.vaultFolderPaths);
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
		if (this.activeInvocationId)
			return { status: "busy", message: "This session already has an Apply invocation" };
		this.activeInvocationId = created.invocation.invocationId;
		this.session.applyState = { status: "applying", invocationId: this.activeInvocationId };
		this.emit();
		const bindings = new Map<string, TFile>();
		for (const operation of created.invocation.operations) {
			const binding = this.sourceBindings.get(operation.itemId);
			if (binding) bindings.set(operation.itemId, binding);
		}
		try {
			const result = await this.applyService.apply(created.invocation, bindings);
			if (
				this.session.id === created.invocation.sessionId &&
				this.activeInvocationId === created.invocation.invocationId
			) {
				if (result.status === "completed") {
					for (const outcome of result.outcomes) {
						const item = this.session.items.find(
							(entry) => entry.id === outcome.itemId,
						);
						if (item) item.applyOutcome = clone(outcome);
					}
					this.session.applyState = {
						status: "completed",
						invocationId: result.invocationId,
					};
				} else {
					this.session.applyState = {
						status: "rejected",
						invocationId: created.invocation.invocationId,
					};
				}
				this.activeInvocationId = undefined;
				this.emit();
			}
			return result;
		} catch (error) {
			if (
				this.session.id === created.invocation.sessionId &&
				this.activeInvocationId === created.invocation.invocationId
			) {
				this.session.applyState = {
					status: "rejected",
					invocationId: created.invocation.invocationId,
				};
				this.activeInvocationId = undefined;
				this.emit();
			}
			return { status: "rejected", message: errorText(error) };
		}
	}

	dispose(): void {
		this.disposed = true;
		this.listeners.clear();
		this.sourceBindings.clear();
		this.activeInvocationId = undefined;
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

	private async updateConfiguration(
		patch: Partial<SessionConfiguration>,
	): Promise<SessionEditResult> {
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
		this.emit();
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
				identification: item.identification,
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
