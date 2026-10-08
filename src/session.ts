import type { TFile } from "obsidian";
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
	plan?: RenamePlanResult;
	applyOutcome?: RenameApplyOutcome;
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
	private session: IntakeSession;
	private readonly sourceBindings = new Map<string, TFile>();
	private readonly listeners = new Set<(snapshot: IntakeSession) => void>();
	private planningBasis: PlanningInput | null = null;
	private invocationCounter = 0;
	private activeInvocationId?: string;
	private disposed = false;

	constructor(store: PluginDataStore, applyService?: ApplyChangesService) {
		this.store = store;
		this.applyService = applyService;
		this.session = createFreshSession(store.getSettings().defaults, this.nextSessionId());
	}

	getSnapshot(): IntakeSession {
		return clone(this.session);
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
		return { allowed: false, reason: "Review identification is not available in this slice." };
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
		this.session.planningSnapshot = null;
		this.planningBasis = null;
		this.session.items = this.session.items.map((item) => ({ ...item, plan: undefined }));
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
