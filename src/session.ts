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
import { normalizeDoi, normalizeIsbn } from "./lookup";
import type {
	CanonicalBibliographicRecord,
	CandidateReference,
	CanonicalAuthorship,
	CanonicalAuthor,
	IdentificationRunSummary,
	MetadataAndNaming,
	OutputLocation,
	PendingInspectorForm,
	PersistedApplySummary,
	RepairEvidence,
	SessionConfiguration,
	UserRecordDecision,
	WorkspaceEditPolicy,
} from "./types";
import {
	decodeSessionDraft,
	encodeSessionDraft,
	restoreDraftIdentification,
	type SessionDraftV1,
} from "./session-draft";
import type {
	IdentificationResult,
	ManualIdentifierLookupResult,
	ManualIdentifierType,
} from "./resolver";
import { manualTitleConflict } from "./resolver";

export type SetupConcern = "pdfs" | "output" | "metadata-and-naming";
export type SessionPhase = "setup" | "working";
export const WORKING_STATUS_ORDER = ["identifying", "needs-you", "ready"] as const;

export interface SessionPdf {
	id: string;
	readonly admissionObservation: Readonly<SourceObservation>;
	sourceObservation: SourceObservation;
	identification: IdentificationState;
	acceptedMachineRecord?: CanonicalBibliographicRecord;
	recordDecision?: UserRecordDecision;
	disposition?: "left-unresolved";
	repairActivity?: "idle" | "retry-pending" | "manual-lookup-pending";
	repairEvidence?: RepairEvidence[];
	identificationHistory?: IdentificationRunSummary[];
	sourceHealth?: PdfSourceHealth;
	sourceIssue?: string;
	sourceIssueHealth?: PdfSourceHealth;
	plan?: RenamePlanResult;
	applyOutcome?: RenameApplyOutcome;
	applyOutcomeRevision?: number;
	lastApplySummary?: PersistedApplySummary;
}

export interface SessionPdfSnapshot extends SessionPdf {
	effectiveRecord?: CanonicalBibliographicRecord;
	recordAuthority?: "automatic" | "user-selected" | "user-edited";
	currentStatus:
		"identifying" | "needs-you" | "ready" | "no-change" | "applied" | "left-unresolved";
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
	pendingInspectorForm?: PendingInspectorForm;
}

export interface IntakeSessionSnapshot extends Omit<IntakeSession, "items"> {
	items: SessionPdfSnapshot[];
	outputFolderPaths: string[];
	exampleFilename: string | null;
	draftBacked: boolean;
	recoveryGate: "none" | "supported" | "unavailable";
	recoveryUnavailableReason?: "malformed" | "unsupported-future";
	persistenceWarning: boolean;
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
	manualIdentifierLookupRunner?: ManualIdentifierLookupRunner;
	planningEnvironment?: PlanningEnvironmentProvider;
	initialDraft?: JsonValue;
}

export type ManualIdentifierLookupRunner = (
	type: ManualIdentifierType,
	value: string,
) => Promise<ManualIdentifierLookupResult>;

export interface ManualRecordDraft {
	title?: string;
	authorship: CanonicalAuthorship;
	year?: number;
	doi?: string;
	isbns: readonly string[];
	journal?: string;
	publisher?: string;
}

export type ManualRecordSaveResult =
	| { saved: true; authority: "user-edited" }
	| { saved: false; fieldErrors: Record<string, string> };

export type ManualLookupCommandResult =
	| { status: "started" }
	| { status: "invalid"; message: string }
	| { status: "rejected"; message: string };

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
	kind: "initial" | "retry";
	replaceUserDecision: boolean;
}

interface ManualLookupToken {
	requestId: number;
	sessionId: string;
	itemId: string;
	sourceObservation: SourceObservation;
	generation: number;
	inspectorGeneration: number;
}

interface DraftSnapshotRequest {
	generation: number;
	value: JsonValue;
	waiters: Array<(success: boolean) => void>;
}

interface EffectiveRecordProjection {
	record: CanonicalBibliographicRecord;
	authority: "automatic" | "user-selected" | "user-edited";
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string");
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
	private readonly manualIdentifierLookupRunner?: ManualIdentifierLookupRunner;
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
	private inspectorItemId?: string;
	private inspectorGeneration = 0;
	private manualLookupCounter = 0;
	private readonly manualLookupGeneration = new Map<string, number>();
	private readonly manualLookupByItem = new Map<string, ManualLookupToken>();
	private draftBacked = false;
	private draftId?: string;
	private recoveryDraft?: SessionDraftV1;
	private recoveryGate: "none" | "supported" | "unavailable" = "none";
	private recoveryUnavailableReason?: "malformed" | "unsupported-future";
	private persistenceWarning = false;
	private persistenceGeneration = 0;
	private draftInFlight?: Promise<boolean>;
	private draftPending?: DraftSnapshotRequest;
	private terminalSettling = false;
	private applyCheckpointPending = false;
	private disposed = false;

	constructor(store: PluginDataStore, options: SessionCoordinatorOptions = {}) {
		this.store = store;
		this.applyService = options.applyService;
		this.vault = options.vault;
		this.identificationRunner = options.identificationRunner;
		this.manualIdentifierLookupRunner = options.manualIdentifierLookupRunner;
		this.planningEnvironment = options.planningEnvironment;
		this.session = createFreshSession(store.getSettings().defaults, this.nextSessionId());
		const decoded = decodeSessionDraft(options.initialDraft);
		if (decoded.status === "supported") {
			this.recoveryGate = "supported";
			this.recoveryDraft = decoded.draft;
		} else if (decoded.status === "unavailable") {
			this.recoveryGate = "unavailable";
			this.recoveryUnavailableReason = decoded.reason;
		}
	}

	getSnapshot(): IntakeSessionSnapshot {
		const snapshot = clone(this.session);
		const items: SessionPdfSnapshot[] = snapshot.items.map((item) => {
			const sourceHealth = this.getSourceHealth(item);
			const effective = this.effectiveRecord(item);
			return {
				...item,
				sourceHealth,
				currentStatus: this.currentStatus(item, sourceHealth),
				...(effective
					? {
							effectiveRecord: clone(effective.record),
							recordAuthority: effective.authority,
						}
					: {}),
			};
		});
		return {
			...snapshot,
			items,
			draftBacked: this.draftBacked,
			recoveryGate: this.recoveryGate,
			...(this.recoveryUnavailableReason
				? { recoveryUnavailableReason: this.recoveryUnavailableReason }
				: {}),
			persistenceWarning: this.persistenceWarning,
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
		if (!this.ordinaryMutationsAllowed() || this.session.id !== expectedSessionId) return false;
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
			void this.requestDraftSave();
		} else {
			this.emit();
		}
		return true;
	}

	/** Resolves chooser paths again at confirmation; accepted membership stays coordinator-owned. */
	addPdfs(paths: readonly string[], expectedSessionId: string): PdfAdmissionResult {
		const result: PdfAdmissionResult = {
			staleSession:
				!this.ordinaryMutationsAllowed() ||
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
			if (!this.draftBacked) {
				this.draftBacked = true;
				this.draftId = `draft-${this.nextSessionId()}`;
				this.persistenceGeneration++;
			}
			void this.requestDraftSave();
		}
		this.emit();
		return clone(result);
	}

	/** Removes only session membership; stale callbacks from another session are ignored. */
	removePdf(itemId: string, expectedSessionId: string): boolean {
		if (
			!this.ordinaryMutationsAllowed() ||
			this.session.id !== expectedSessionId ||
			this.session.phase !== "setup"
		)
			return false;
		const index = this.session.items.findIndex((item) => item.id === itemId);
		if (index < 0) return false;
		this.session.items.splice(index, 1);
		this.cancelAttemptForItem(itemId);
		this.cancelManualLookupForItem(itemId);
		this.sourceBindings.delete(itemId);
		this.session.revision++;
		this.invalidatePlanning();
		void this.requestDraftSave();
		this.emit();
		return true;
	}

	openInspector(itemId: string, expectedSessionId: string): boolean {
		if (
			this.recoveryGate !== "none" ||
			this.terminalSettling ||
			this.session.id !== expectedSessionId ||
			!this.getItem(itemId)
		)
			return false;
		if (this.inspectorItemId !== itemId) {
			if (this.inspectorItemId) this.cancelManualLookupForItem(this.inspectorItemId);
			this.inspectorItemId = itemId;
			this.inspectorGeneration++;
		}
		this.emit();
		return true;
	}

	closeInspector(itemId: string, expectedSessionId: string): boolean {
		if (
			this.recoveryGate !== "none" ||
			this.session.id !== expectedSessionId ||
			this.inspectorItemId !== itemId
		)
			return false;
		this.inspectorGeneration++;
		this.cancelManualLookupForItem(itemId);
		this.inspectorItemId = undefined;
		this.emit();
		return true;
	}

	/** Explicit direct identifier lookup. The coordinator validates before invoking the runner. */
	async lookupManualIdentifier(
		itemId: string,
		type: ManualIdentifierType,
		value: string,
		expectedSessionId: string,
	): Promise<ManualLookupCommandResult> {
		const normalized = type === "doi" ? normalizeDoi(value) : normalizeIsbn(value);
		if (!normalized) {
			return {
				status: "invalid",
				message:
					type === "doi" ? "Enter a valid DOI." : "Enter a valid ISBN-10 or ISBN-13.",
			};
		}
		const item = this.getRepairableItem(itemId, expectedSessionId);
		if (!item || this.inspectorItemId !== itemId || !this.manualIdentifierLookupRunner) {
			return { status: "rejected", message: "Manual lookup is unavailable for this PDF." };
		}
		this.cancelAttemptForItem(itemId);
		this.cancelManualLookupForItem(itemId);
		const generation = (this.manualLookupGeneration.get(itemId) ?? 0) + 1;
		this.manualLookupGeneration.set(itemId, generation);
		const token: ManualLookupToken = {
			requestId: ++this.manualLookupCounter,
			sessionId: this.session.id,
			itemId,
			sourceObservation: clone(item.sourceObservation),
			generation,
			inspectorGeneration: this.inspectorGeneration,
		};
		this.manualLookupByItem.set(itemId, token);
		item.repairActivity = "manual-lookup-pending";
		this.emit();
		let result: ManualIdentifierLookupResult;
		try {
			result = await this.manualIdentifierLookupRunner(type, normalized);
		} catch {
			result = {
				status: "request-failed",
				candidate: {
					provider: type === "doi" ? "crossref" : "openlibrary",
					route: type,
					lookupValue: normalized,
				},
			};
		}
		if (!this.isManualLookupCurrent(token)) {
			if (this.manualLookupByItem.get(itemId) === token) {
				this.manualLookupByItem.delete(itemId);
				item.repairActivity = "idle";
				this.emit();
			}
			return { status: "rejected", message: "The lookup result is no longer current." };
		}
		this.manualLookupByItem.delete(itemId);
		item.repairActivity = "idle";
		if (result.status !== "invalid") {
			const conflict =
				result.status === "candidate"
					? manualTitleConflict(result.record.title, this.machineTitleCandidates(item))
					: undefined;
			const evidence: RepairEvidence = {
				type,
				identifier: normalized,
				provider: result.candidate.provider,
				route: result.candidate.route,
				outcome: result.status,
				...(result.status === "candidate" ? { candidateRecord: clone(result.record) } : {}),
				...(conflict ? { conflictingTitle: conflict } : {}),
			};
			item.repairEvidence = [...(item.repairEvidence ?? []).slice(-2), evidence].slice(-3);
		}
		this.session.revision++;
		this.invalidatePlanning();
		this.replanCurrentSession();
		void this.requestDraftSave();
		return { status: "started" };
	}

	acceptManualCandidate(
		itemId: string,
		expectedSessionId: string,
		useAnyway = false,
	): { accepted: boolean; requiresUseAnyway?: true; conflictingTitle?: string } {
		const item = this.getRepairableItem(itemId, expectedSessionId);
		const latest = item?.repairEvidence?.at(-1);
		if (
			!item ||
			this.inspectorItemId !== itemId ||
			latest?.outcome !== "candidate" ||
			!latest.candidateRecord
		)
			return { accepted: false };
		if (latest.conflictingTitle && !useAnyway) {
			return {
				accepted: false,
				requiresUseAnyway: true,
				conflictingTitle: latest.conflictingTitle,
			};
		}
		latest.decision = "accepted";
		item.recordDecision = {
			kind: "selected-candidate",
			record: clone(latest.candidateRecord),
			candidate: {
				provider: latest.provider,
				route: latest.route,
				lookupValue: latest.identifier,
			},
		};
		this.commitEffectiveRecordChange(item);
		return { accepted: true };
	}

	rejectManualCandidate(itemId: string, expectedSessionId: string): boolean {
		const item = this.getRepairableItem(itemId, expectedSessionId);
		const latest = item?.repairEvidence?.at(-1);
		if (!item || this.inspectorItemId !== itemId || latest?.outcome !== "candidate")
			return false;
		latest.decision = "rejected";
		this.session.revision++;
		void this.requestDraftSave();
		this.emit();
		return true;
	}

	selectMachineCandidate(
		itemId: string,
		expectedSessionId: string,
		candidate: CandidateReference,
		useAnyway = false,
	): { accepted: boolean; requiresUseAnyway?: true; conflictingTitle?: string } {
		const item = this.getRepairableItem(itemId, expectedSessionId);
		if (!item || this.inspectorItemId !== itemId) return { accepted: false };
		const attempts =
			(item.identification.status === "resolved" ||
			item.identification.status === "needs-user"
				? item.identification.evidence?.attempts
				: undefined) ?? [];
		const attempt = attempts.find(
			(entry) =>
				entry.provider === candidate.provider &&
				entry.route === candidate.route &&
				entry.lookupValue === candidate.lookupValue &&
				entry.candidateRecord,
		);
		if (!attempt?.candidateRecord) return { accepted: false };
		const conflict = manualTitleConflict(
			attempt.candidateRecord.title,
			this.machineTitleCandidates(item),
		);
		if (conflict && !useAnyway)
			return { accepted: false, requiresUseAnyway: true, conflictingTitle: conflict };
		const { provider, diagnostics: _diagnostics, ...fields } = clone(attempt.candidateRecord);
		item.recordDecision = {
			kind: "selected-candidate",
			record: {
				...fields,
				provenance: { provider, route: candidate.route, identifier: candidate.lookupValue },
			},
			candidate: clone(candidate),
		};
		this.commitEffectiveRecordChange(item);
		return { accepted: true };
	}

	saveManualRecord(
		itemId: string,
		draft: ManualRecordDraft,
		expectedSessionId: string,
		basedOn?: CandidateReference,
	): ManualRecordSaveResult {
		const item = this.getRepairableItem(itemId, expectedSessionId);
		if (!item || this.inspectorItemId !== itemId)
			return { saved: false, fieldErrors: { form: "This PDF is no longer editable." } };
		const fieldErrors: Record<string, string> = {};
		const doiText = draft.doi?.trim() ?? "";
		const normalizedDoi = doiText ? normalizeDoi(doiText) : undefined;
		if (doiText && !normalizedDoi) fieldErrors.doi = "Enter a valid DOI.";
		const normalizedIsbns: string[] = [];
		for (const raw of draft.isbns) {
			if (!raw.trim()) continue;
			const normalized = normalizeIsbn(raw);
			if (!normalized) {
				fieldErrors.isbns = "Enter valid ISBN-10 or ISBN-13 values.";
				break;
			}
			if (!normalizedIsbns.includes(normalized)) normalizedIsbns.push(normalized);
		}
		if (
			draft.year !== undefined &&
			(!Number.isInteger(draft.year) || draft.year < 1 || draft.year > 9999)
		)
			fieldErrors.year = "Enter a four-digit publication year.";
		const authors = this.sanitizeAuthorship(draft.authorship, fieldErrors);
		if (Object.keys(fieldErrors).length) return { saved: false, fieldErrors };
		const record: CanonicalBibliographicRecord = {
			...(draft.title?.trim() ? { title: draft.title.trim().slice(0, 500) } : {}),
			authorship: authors,
			...(draft.year !== undefined ? { year: draft.year } : {}),
			...(normalizedDoi ? { doi: normalizedDoi } : {}),
			isbns: normalizedIsbns,
			...(draft.journal?.trim() ? { journal: draft.journal.trim().slice(0, 300) } : {}),
			...(draft.publisher?.trim() ? { publisher: draft.publisher.trim().slice(0, 300) } : {}),
			provenance: { kind: "user-edited", ...(basedOn ? { basedOn: clone(basedOn) } : {}) },
		};
		item.recordDecision = {
			kind: "user-edited-record",
			record,
			...(basedOn ? { basedOn: clone(basedOn) } : {}),
		};
		if (this.session.pendingInspectorForm?.itemId === itemId)
			this.session.pendingInspectorForm = undefined;
		this.commitEffectiveRecordChange(item);
		return { saved: true, authority: "user-edited" };
	}

	leaveUnresolved(itemId: string, expectedSessionId: string): boolean {
		const item = this.getRepairableItem(itemId, expectedSessionId);
		if (!item || item.disposition || this.currentStatus(item) !== "needs-you") return false;
		this.cancelManualLookupForItem(itemId);
		this.cancelAttemptForItem(itemId);
		item.disposition = "left-unresolved";
		this.session.revision++;
		this.invalidatePlanning();
		this.replanCurrentSession();
		void this.requestDraftSave();
		return true;
	}

	resumeRepair(itemId: string, expectedSessionId: string): boolean {
		const item = this.getRepairableItem(itemId, expectedSessionId, true);
		if (!item || item.disposition !== "left-unresolved") return false;
		item.disposition = undefined;
		this.session.revision++;
		this.invalidatePlanning();
		this.replanCurrentSession();
		void this.requestDraftSave();
		return true;
	}

	retryIdentification(
		itemId: string,
		expectedSessionId: string,
		replaceUserDecision = false,
	): { started: boolean; confirmationRequired?: true; message?: string } {
		const item = this.getRepairableItem(itemId, expectedSessionId);
		if (!item || this.session.phase !== "working" || !this.identificationRunner)
			return { started: false, message: "Retry is unavailable for this PDF." };
		if (item.recordDecision && !replaceUserDecision)
			return { started: false, confirmationRequired: true };
		const health = this.getSourceHealth(item);
		const binding = this.sourceBindings.get(item.id);
		if (health !== "current" || !binding)
			return { started: false, message: this.sourceHealthReason(health) };
		this.cancelManualLookupForItem(itemId);
		this.cancelAttemptForItem(itemId);
		const token: IdentificationAttemptToken = {
			attemptId: `attempt-${++this.attemptCounter}`,
			sessionId: this.session.id,
			itemId,
			sourceObservation: clone(item.sourceObservation),
			binding,
			cancelled: false,
			kind: "retry",
			replaceUserDecision,
		};
		item.repairActivity = "retry-pending";
		this.attemptByItem.set(itemId, token);
		this.queuedAttempts.push(token);
		this.emit();
		this.pumpIdentificationQueue();
		return { started: true };
	}

	subscribe(listener: (snapshot: IntakeSessionSnapshot) => void): () => void {
		if (this.disposed) return () => undefined;
		this.listeners.add(listener);
		listener(this.getSnapshot());
		return () => this.listeners.delete(listener);
	}

	setSetupConcern(concern: SetupConcern): void {
		if (!this.ordinaryMutationsAllowed() || this.session.phase !== "setup") return;
		if (this.session.setupConcern === concern) return;
		this.session.setupConcern = concern;
		void this.requestDraftSave();
		this.emit();
	}

	openSetup(): void {
		if (!this.ordinaryMutationsAllowed()) return;
		this.session.setupOpen = true;
		void this.requestDraftSave();
		this.emit();
	}

	closeSetup(): void {
		if (!this.ordinaryMutationsAllowed()) return;
		this.session.setupOpen = false;
		void this.requestDraftSave();
		this.emit();
	}

	/** Starts read-only identification automatically for current admitted sources. */
	beginReview(): { allowed: boolean; reason?: string } {
		const blocked = this.ordinaryMutationBlockReason();
		if (blocked) return { allowed: false, reason: blocked };
		if (this.session.items.length === 0) {
			return { allowed: false, reason: "Add at least one PDF before beginning review." };
		}
		if (this.session.phase === "working") {
			return { allowed: false, reason: "Review is already in progress." };
		}
		this.session.phase = "working";
		this.session.setupOpen = false;
		void this.requestDraftSave();
		this.enqueueUnattemptedItems();
		this.emit();
		return { allowed: true };
	}

	returnToSetup(expectedSessionId: string): boolean {
		if (
			!this.ordinaryMutationsAllowed() ||
			this.session.id !== expectedSessionId ||
			this.session.phase !== "working"
		) {
			return false;
		}
		this.cancelIdentificationAttempts();
		this.cancelAllManualLookups();
		this.inspectorItemId = undefined;
		this.inspectorGeneration++;
		this.session.phase = "setup";
		this.session.setupOpen = true;
		void this.requestDraftSave();
		this.replanCurrentSession();
		return true;
	}

	createNewSession(): IntakeSession {
		if (!this.ordinaryMutationsAllowed() || this.draftBacked) return this.getSnapshot();
		this.installFreshSession();
		return this.getSnapshot();
	}

	async startNewSession(confirmed: boolean): Promise<boolean> {
		if (
			!confirmed ||
			this.activeInvocationId ||
			this.applyCheckpointPending ||
			this.terminalSettling
		)
			return false;
		if (this.recoveryGate === "none" && !this.draftBacked) {
			this.installFreshSession();
			return true;
		}
		if (!(await this.clearDraftTerminal())) return false;
		this.installFreshSession();
		return true;
	}

	async finishSession(confirmEmpty = false): Promise<boolean> {
		if (!this.draftBacked || !this.ordinaryMutationsAllowed()) return false;
		if (this.session.items.length === 0) {
			if (!confirmEmpty) return false;
		} else if (
			this.session.items.some((item) => {
				const status = this.currentStatus(item);
				return (
					status !== "applied" && status !== "no-change" && status !== "left-unresolved"
				);
			})
		)
			return false;
		if (!(await this.clearDraftTerminal())) return false;
		this.installFreshSession();
		return true;
	}

	resumeUnfinishedSession(): { resumed: boolean; message?: string } {
		if (
			this.recoveryGate !== "supported" ||
			!this.recoveryDraft ||
			this.terminalSettling ||
			this.activeInvocationId
		) {
			return {
				resumed: false,
				message: "There is no supported unfinished session to resume.",
			};
		}
		const draft = this.recoveryDraft;
		let recovered: IntakeSession;
		let bindings: Map<string, TFile>;
		let recoveryAttempts: IdentificationAttemptToken[];
		let planningBasis: PlanningInput;
		let planningSnapshot: PlanningSnapshot;
		try {
			recovered = createFreshSession(draft.configuration, this.nextSessionId());
			recovered.phase = draft.phase;
			recovered.setupOpen = draft.setupOpen;
			recovered.setupConcern = draft.setupConcern;
			recovered.pendingInspectorForm = draft.pendingInspectorForm
				? clone(draft.pendingInspectorForm)
				: undefined;
			bindings = new Map<string, TFile>();
			for (const saved of draft.items) {
				const restored: SessionPdf = {
					id: saved.id,
					admissionObservation: clone(saved.admissionObservation),
					sourceObservation: clone(saved.sourceObservation),
					identification: restoreDraftIdentification(saved.identification),
					...(saved.acceptedMachineRecord
						? { acceptedMachineRecord: clone(saved.acceptedMachineRecord) }
						: {}),
					...(saved.recordDecision
						? { recordDecision: clone(saved.recordDecision) }
						: {}),
					...(saved.disposition ? { disposition: saved.disposition } : {}),
					...(saved.repairEvidence
						? { repairEvidence: clone(saved.repairEvidence) }
						: {}),
					...(saved.identificationHistory
						? { identificationHistory: clone(saved.identificationHistory) }
						: {}),
					...(saved.lastApplySummary
						? { lastApplySummary: clone(saved.lastApplySummary) }
						: {}),
				};
				const file = this.currentPdfAtPath(saved.sourceObservation.path);
				if (
					file &&
					file.path === saved.sourceObservation.path &&
					file.extension.toLowerCase() === "pdf" &&
					Number.isFinite(saved.sourceObservation.mtime) &&
					Number.isFinite(saved.sourceObservation.size) &&
					file.stat.mtime === saved.sourceObservation.mtime &&
					file.stat.size === saved.sourceObservation.size
				) {
					bindings.set(restored.id, file);
				} else {
					restored.sourceIssue =
						"This PDF no longer matches the saved path and file details.";
					restored.sourceIssueHealth = "binding-unavailable";
				}
				recovered.items.push(restored);
			}
			recoveryAttempts = [];
			if (recovered.phase === "working") {
				let recoveryStateChanged = false;
				for (const item of recovered.items) {
					if (item.identification.status !== "unattempted") continue;
					const binding = bindings.get(item.id);
					if (!binding) {
						const reason =
							item.sourceIssue ?? "The admitted PDF is no longer available.";
						item.identification = { status: "needs-user", reason };
						recoveryStateChanged = true;
						continue;
					}
					item.identification = { status: "identifying" };
					recoveryStateChanged = true;
					recoveryAttempts.push({
						attemptId: `attempt-${this.attemptCounter + recoveryAttempts.length + 1}`,
						sessionId: recovered.id,
						itemId: item.id,
						sourceObservation: clone(item.sourceObservation),
						binding,
						cancelled: false,
						kind: "initial",
						replaceUserDecision: false,
					});
				}
				if (recoveryStateChanged) recovered.revision++;
			}
			const environment = this.getStrictPlanningEnvironment();
			planningBasis = this.createPlanningInput(
				environment.filePaths,
				environment.folderPaths,
				recovered,
				new Map(
					recovered.items.map((item) => [
						item.id,
						bindings.has(item.id)
							? "current"
							: (item.sourceIssueHealth ?? "binding-unavailable"),
					]),
				),
			);
			planningSnapshot = planRenames(planningBasis);
			recovered.planningSnapshot = clone(planningSnapshot);
			const resultsById = new Map(
				planningSnapshot.results.map((result) => [result.itemId, result]),
			);
			recovered.items = recovered.items.map((item) => {
				const plan = resultsById.get(item.id);
				return { ...item, plan: plan === undefined ? undefined : clone(plan) };
			});
		} catch {
			return {
				resumed: false,
				message:
					"The saved session could not be resumed because current vault planning is unavailable.",
			};
		}
		// Install only after source reconstruction and strict recovery planning succeed.
		this.cancelIdentificationAttempts();
		this.cancelAllManualLookups();
		this.inspectorItemId = undefined;
		this.inspectorGeneration++;
		this.session = recovered;
		this.sourceBindings.clear();
		for (const [itemId, binding] of bindings) this.sourceBindings.set(itemId, binding);
		this.planningBasis = clone(planningBasis);
		this.activeInvocationId = undefined;
		this.draftBacked = true;
		this.draftId = draft.draftId;
		this.recoveryDraft = undefined;
		this.recoveryGate = "none";
		this.recoveryUnavailableReason = undefined;
		this.attemptCounter += recoveryAttempts.length;
		for (const token of recoveryAttempts) {
			this.attemptByItem.set(token.itemId, token);
			this.queuedAttempts.push(token);
		}
		void this.requestDraftSave();
		this.emit();
		this.pumpIdentificationQueue();
		return { resumed: true };
	}

	preservePendingInspectorForm(form: PendingInspectorForm, expectedSessionId: string): boolean {
		if (
			!this.ordinaryMutationsAllowed() ||
			this.session.id !== expectedSessionId ||
			!this.getItem(form.itemId)
		)
			return false;
		this.session.pendingInspectorForm = { ...clone(form), unsaved: true };
		void this.requestDraftSave();
		return true;
	}

	discardPendingInspectorForm(itemId: string, expectedSessionId: string): boolean {
		if (
			!this.ordinaryMutationsAllowed() ||
			this.session.id !== expectedSessionId ||
			this.session.pendingInspectorForm?.itemId !== itemId
		)
			return false;
		this.session.pendingInspectorForm = undefined;
		void this.requestDraftSave();
		this.emit();
		return true;
	}

	private installFreshSession(): void {
		this.cancelIdentificationAttempts();
		this.cancelAllManualLookups();
		this.inspectorItemId = undefined;
		this.inspectorGeneration++;
		this.session = createFreshSession(this.store.getSettings().defaults, this.nextSessionId());
		this.sourceBindings.clear();
		this.planningBasis = null;
		this.activeInvocationId = undefined;
		this.draftBacked = false;
		this.draftId = undefined;
		this.emit();
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
		if (
			this.activeInvocationId ||
			this.applyCheckpointPending ||
			this.terminalSettling ||
			this.recoveryGate !== "none"
		)
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
		if (this.draftBacked) {
			this.applyCheckpointPending = true;
			this.emit();
			const checkpointSaved = await this.requestDraftSave();
			this.applyCheckpointPending = false;
			if (!checkpointSaved) this.persistenceWarning = true;
			this.emit();
			if (
				this.session.id !== invocation.sessionId ||
				this.session.revision !== invocation.sessionRevision ||
				this.invalidateStaleSourcesForApply()
			) {
				this.replanCurrentSession();
				return {
					status: "rejected",
					message: "The reviewed plan changed while its recovery checkpoint settled.",
				};
			}
			const refreshedEnvironment = this.getPlanningEnvironment();
			const refreshedBasis = this.createPlanningInput(
				refreshedEnvironment.filePaths,
				refreshedEnvironment.folderPaths,
			);
			if (!same(refreshedBasis, basis) || !same(planRenames(refreshedBasis), snapshot)) {
				this.replanCurrentSession();
				return {
					status: "rejected",
					message: "The reviewed plan no longer matches current session values.",
				};
			}
		}
		this.activeInvocationId = invocation.invocationId;
		this.cancelAllManualLookups();
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
		this.cancelAllManualLookups();
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
				kind: "initial",
				replaceUserDecision: false,
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
		if (token.kind === "retry") this.archiveCurrentIdentification(item);
		const priorEffective = this.effectiveRecord(item);
		if (token.kind === "retry" && priorEffective?.authority === "automatic") {
			item.acceptedMachineRecord = clone(priorEffective.record);
		}
		item.sourceIssue = undefined;
		item.identification =
			result.status === "accepted"
				? {
						status: "resolved",
						record: clone(result.record),
						evidence: clone(result.evidence),
					}
				: { status: "needs-user", reason: result.reason, evidence: clone(result.evidence) };
		if (result.status === "accepted") {
			item.acceptedMachineRecord = clone(result.record);
			if (token.replaceUserDecision) item.recordDecision = undefined;
		}
		item.repairActivity = "idle";
		this.session.revision++;
		this.invalidatePlanning();
		this.replanCurrentSession();
		void this.requestDraftSave();
	}

	private acceptIdentificationFailure(token: IdentificationAttemptToken): void {
		const item = this.getItem(token.itemId);
		if (!item) return;
		if (token.kind === "retry") {
			this.archiveCurrentIdentification(item);
			const priorEffective = this.effectiveRecord(item);
			if (priorEffective?.authority === "automatic")
				item.acceptedMachineRecord = clone(priorEffective.record);
		}
		item.identification = {
			status: "needs-user",
			reason: "Identification could not complete.",
		};
		item.repairActivity = "idle";
		this.session.revision++;
		this.invalidatePlanning();
		this.replanCurrentSession();
		void this.requestDraftSave();
	}

	private acceptStaleSourceResult(token: IdentificationAttemptToken): void {
		const item = this.getItem(token.itemId);
		if (!item) return;
		item.repairActivity = "idle";
		const health = this.getSourceHealth(item);
		this.markSourceNeedsYou(item, this.sourceHealthReason(health));
		this.session.revision++;
		this.invalidatePlanning();
		this.replanCurrentSession();
		void this.requestDraftSave();
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
		const item = this.getItem(itemId);
		if (item?.repairActivity === "retry-pending") item.repairActivity = "idle";
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
			if (item.repairActivity === "retry-pending") item.repairActivity = "idle";
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

	private getStrictPlanningEnvironment(): PlanningEnvironmentSnapshot {
		if (!this.planningEnvironment) throw new Error("Planning environment is unavailable");
		const snapshot: unknown = this.planningEnvironment.getSnapshot();
		if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
			throw new Error("Planning environment snapshot is invalid");
		const value = snapshot as Record<string, unknown>;
		if (!isStringArray(value.filePaths) || !isStringArray(value.folderPaths))
			throw new Error("Planning environment snapshot is invalid");
		return clone({
			filePaths: [...value.filePaths],
			folderPaths: [...value.folderPaths],
		});
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

	private planningIdentification(
		item: SessionPdf,
		sourceHealth = this.getSourceHealth(item),
	): IdentificationState {
		if (item.disposition === "left-unresolved") {
			return {
				status: "needs-user",
				reason: "This PDF was left unresolved for now.",
				...("evidence" in item.identification && item.identification.evidence
					? { evidence: clone(item.identification.evidence) }
					: {}),
			};
		}
		if (item.sourceIssue) {
			return {
				status: "needs-user",
				reason: item.sourceIssue,
				...("evidence" in item.identification && item.identification.evidence
					? { evidence: clone(item.identification.evidence) }
					: {}),
			};
		}
		if (sourceHealth !== "current") {
			return {
				status: "needs-user",
				reason: this.sourceHealthReason(sourceHealth),
				...("evidence" in item.identification && item.identification.evidence
					? { evidence: clone(item.identification.evidence) }
					: {}),
			};
		}
		const effective = this.effectiveRecord(item);
		if (effective) {
			return {
				status: "resolved",
				record: clone(effective.record),
				...("evidence" in item.identification && item.identification.evidence
					? { evidence: clone(item.identification.evidence) }
					: {}),
			};
		}
		return item.identification;
	}

	private effectiveRecord(item: SessionPdf): EffectiveRecordProjection | undefined {
		if (item.recordDecision) {
			return {
				record: item.recordDecision.record,
				authority:
					item.recordDecision.kind === "selected-candidate"
						? "user-selected"
						: "user-edited",
			};
		}
		const machineRecord =
			item.acceptedMachineRecord ??
			(item.identification.status === "resolved" ? item.identification.record : undefined);
		if (machineRecord) {
			return { record: machineRecord, authority: "automatic" };
		}
		return undefined;
	}

	private currentStatus(
		item: SessionPdf,
		sourceHealth = this.getSourceHealth(item),
	): SessionPdfSnapshot["currentStatus"] {
		if (item.disposition === "left-unresolved") return "left-unresolved";
		if (sourceHealth !== "current") return "needs-you";
		if (
			(item.identification.status === "unattempted" ||
				item.identification.status === "identifying") &&
			!this.effectiveRecord(item)
		)
			return "identifying";
		if (!this.effectiveRecord(item)) return "needs-you";
		if (item.plan?.status === "eligible") return "ready";
		if (item.plan?.status === "blocked") return "needs-you";
		if (item.plan?.status === "no-change") {
			return item.applyOutcome?.status === "renamed" &&
				item.applyOutcomeRevision === this.session.revision
				? "applied"
				: "no-change";
		}
		return "needs-you";
	}

	private getRepairableItem(
		itemId: string,
		expectedSessionId: string,
		allowLeftUnresolved = false,
	): SessionPdf | undefined {
		if (
			this.disposed ||
			!this.ordinaryMutationsAllowed() ||
			this.session.id !== expectedSessionId ||
			this.session.phase !== "working"
		)
			return undefined;
		const item = this.getItem(itemId);
		if (
			!item ||
			item.identification.status === "identifying" ||
			this.currentStatus(item) === "identifying" ||
			(!allowLeftUnresolved && item.disposition === "left-unresolved")
		)
			return undefined;
		if (this.getSourceHealth(item) !== "current" || !this.sourceBindings.has(itemId))
			return undefined;
		return item;
	}

	private machineTitleCandidates(item: SessionPdf): readonly string[] {
		return "evidence" in item.identification
			? (item.identification.evidence?.titleCandidates ?? [])
			: [];
	}

	private commitEffectiveRecordChange(item: SessionPdf): void {
		this.cancelAttemptForItem(item.id);
		this.cancelManualLookupForItem(item.id);
		this.session.revision++;
		this.invalidatePlanning();
		this.replanCurrentSession();
		void this.requestDraftSave();
	}

	private isManualLookupCurrent(token: ManualLookupToken): boolean {
		return (
			!this.disposed &&
			this.ordinaryMutationsAllowed() &&
			this.session.id === token.sessionId &&
			this.inspectorItemId === token.itemId &&
			this.inspectorGeneration === token.inspectorGeneration &&
			this.manualLookupByItem.get(token.itemId) === token &&
			this.manualLookupGeneration.get(token.itemId) === token.generation &&
			same(this.getItem(token.itemId)?.sourceObservation, token.sourceObservation) &&
			this.getSourceHealth(this.getItem(token.itemId)!) === "current"
		);
	}

	private cancelManualLookupForItem(itemId: string): void {
		this.manualLookupGeneration.set(itemId, (this.manualLookupGeneration.get(itemId) ?? 0) + 1);
		this.manualLookupByItem.delete(itemId);
		const item = this.getItem(itemId);
		if (item?.repairActivity === "manual-lookup-pending") item.repairActivity = "idle";
	}

	private cancelAllManualLookups(): void {
		for (const itemId of this.manualLookupByItem.keys()) this.cancelManualLookupForItem(itemId);
	}

	private sanitizeAuthorship(
		authorship: CanonicalAuthorship,
		fieldErrors: Record<string, string>,
	): CanonicalAuthorship {
		if (
			!authorship ||
			!(["complete", "partial", "unknown"] as const).includes(authorship.completeness) ||
			typeof authorship.totalCountKnown !== "boolean"
		) {
			fieldErrors.authorship = "Choose valid authorship details.";
			return { authors: [], completeness: "unknown", totalCountKnown: false };
		}
		const authors: CanonicalAuthor[] = [];
		for (const [position, author] of authorship.authors.entries()) {
			if (!author || typeof author !== "object") {
				fieldErrors.authorship = "Choose a type for every author position.";
				continue;
			}
			if (author.kind === "person") {
				const given = author.given?.trim();
				const family = author.family?.trim();
				const literal = author.literal?.trim();
				authors.push({
					kind: "person",
					...(given ? { given: given.slice(0, 200) } : {}),
					...(family ? { family: family.slice(0, 200) } : {}),
					...(literal ? { literal: literal.slice(0, 300) } : {}),
				});
			} else if (author.kind === "organization" || author.kind === "literal") {
				const literal = typeof author.literal === "string" ? author.literal.trim() : "";
				if (!literal)
					fieldErrors.authorship = "Enter the supplied organization or literal name.";
				authors.push({ kind: author.kind, literal: literal.slice(0, 300) });
			} else if (author.kind === "unresolved") {
				authors.push({
					kind: "unresolved",
					position,
					...(author.reference ? { reference: author.reference.slice(0, 200) } : {}),
				});
			} else {
				fieldErrors.authorship = "Choose a supported author type.";
			}
		}
		const hasUnresolved = authors.some((author) => author.kind === "unresolved");
		let completeness = authorship.completeness;
		if (hasUnresolved && completeness === "complete") completeness = "partial";
		if (!authorship.totalCountKnown && completeness === "complete") completeness = "unknown";
		if (authors.length === 0 && completeness === "complete") completeness = "unknown";
		return { authors, completeness, totalCountKnown: authorship.totalCountKnown };
	}

	private archiveCurrentIdentification(item: SessionPdf): void {
		const identification = item.identification;
		if (identification.status !== "resolved" && identification.status !== "needs-user") return;
		const summary: IdentificationRunSummary = {
			status: identification.status === "resolved" ? "accepted" : "needs-you",
			...(identification.status === "needs-user" ? { reason: identification.reason } : {}),
			...(identification.evidence?.titleCandidates.length
				? {
						titleCandidates: identification.evidence.titleCandidates
							.slice(0, 3)
							.map((title) => title.slice(0, 200)),
					}
				: {}),
			attempts: (identification.evidence?.attempts ?? []).slice(0, 12).map((attempt) => ({
				provider: attempt.provider,
				route: attempt.route,
				lookupValue: attempt.lookupValue.slice(0, 200),
				outcome: attempt.outcome,
				...(attempt.providerTitle
					? { providerTitle: attempt.providerTitle.slice(0, 200) }
					: {}),
			})),
		};
		item.identificationHistory = [
			...(item.identificationHistory ?? []).slice(-2),
			summary,
		].slice(-2);
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
		const outcomeItemIds = new Set<string>();
		if (result.status === "completed") {
			const operations = new Map(
				invocation.operations.map((operation) => [operation.itemId, operation]),
			);
			for (const outcome of result.outcomes) {
				const operation = operations.get(outcome.itemId);
				const item = this.getItem(outcome.itemId);
				if (!operation || !item) continue;
				item.applyOutcome = clone(outcome);
				outcomeItemIds.add(item.id);
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
		for (const itemId of outcomeItemIds) {
			const item = this.getItem(itemId);
			if (item) item.applyOutcomeRevision = this.session.revision;
		}
		this.finishApplyAndReplan();
	}

	private finishApplyAndReplan(): void {
		this.invalidatePlanning();
		this.replanCurrentSession();
		this.activeInvocationId = undefined;
		void this.requestDraftSave();
		this.emit();
	}

	private async updateConfiguration(
		patch: Partial<SessionConfiguration>,
	): Promise<SessionEditResult> {
		const blocked = this.ordinaryMutationBlockReason();
		if (blocked || this.session.phase !== "setup") {
			return {
				updated: false,
				savedForFutureSessions: false,
				message: blocked ?? "Return to setup before editing this session.",
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
		void this.requestDraftSave();
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

	private requestDraftSave(): Promise<boolean> {
		if (
			!this.draftBacked ||
			!this.draftId ||
			this.recoveryGate !== "none" ||
			this.terminalSettling
		)
			return Promise.resolve(true);
		let value: JsonValue;
		try {
			value = JSON.parse(
				JSON.stringify(encodeSessionDraft(this.session, this.draftId)),
			) as JsonValue;
		} catch {
			this.persistenceWarning = true;
			this.emit();
			return Promise.resolve(false);
		}
		return this.enqueueDraftValue(value, this.persistenceGeneration);
	}

	private enqueueDraftValue(value: JsonValue, generation: number): Promise<boolean> {
		return new Promise((resolve) => {
			const request: DraftSnapshotRequest = {
				generation,
				value: clone(value),
				waiters: [resolve],
			};
			if (this.draftInFlight) {
				if (this.draftPending) request.waiters.unshift(...this.draftPending.waiters);
				this.draftPending = request;
				return;
			}
			this.dispatchDraftValue(request);
		});
	}

	private dispatchDraftValue(request: DraftSnapshotRequest): void {
		let success = false;
		const tracked = this.store
			.updateDraftNamespace(request.value)
			.then(
				() => {
					success = true;
					return true;
				},
				() => false,
			)
			.then((saved) => {
				if (request.generation === this.persistenceGeneration && !this.terminalSettling) {
					this.persistenceWarning = !saved;
					this.emit();
				}
				return saved;
			})
			.finally(() => {
				if (this.draftInFlight === tracked) this.draftInFlight = undefined;
				for (const waiter of request.waiters) waiter(success);
				const pending = this.draftPending;
				this.draftPending = undefined;
				if (!pending) return;
				if (pending.generation === this.persistenceGeneration && !this.terminalSettling) {
					this.dispatchDraftValue(pending);
				} else {
					for (const waiter of pending.waiters) waiter(false);
				}
			});
		this.draftInFlight = tracked;
	}

	private async clearDraftTerminal(): Promise<boolean> {
		if (this.terminalSettling || this.activeInvocationId || this.applyCheckpointPending)
			return false;
		this.terminalSettling = true;
		this.persistenceGeneration++;
		const pending = this.draftPending;
		this.draftPending = undefined;
		if (pending) for (const waiter of pending.waiters) waiter(false);
		this.emit();
		const inFlight = this.draftInFlight;
		if (inFlight) await inFlight;
		try {
			await this.store.updateDraftNamespace(null);
		} catch {
			this.terminalSettling = false;
			this.persistenceGeneration++;
			this.persistenceWarning = true;
			this.emit();
			return false;
		}
		this.draftBacked = false;
		this.draftId = undefined;
		this.recoveryDraft = undefined;
		this.recoveryGate = "none";
		this.recoveryUnavailableReason = undefined;
		this.persistenceWarning = false;
		this.terminalSettling = false;
		this.emit();
		return true;
	}

	private ordinaryMutationBlockReason(): string | undefined {
		if (this.recoveryGate !== "none")
			return "Decide how to handle the saved session before starting new work.";
		if (this.terminalSettling) return "The saved session decision is still being written.";
		if (this.applyCheckpointPending) return "The pre-Apply recovery checkpoint is being saved.";
		if (this.activeInvocationId) return "Apply is in progress.";
		return undefined;
	}

	private ordinaryMutationsAllowed(): boolean {
		return this.ordinaryMutationBlockReason() === undefined;
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
		session: IntakeSession = this.session,
		sourceHealthByItem?: ReadonlyMap<string, PdfSourceHealth>,
	): PlanningInput {
		return clone({
			sessionId: session.id,
			sessionRevision: session.revision,
			configuration: session.configuration,
			items: session.items.map((item) => ({
				itemId: item.id,
				sourceObservation: item.sourceObservation,
				identification: this.planningIdentification(
					item,
					sourceHealthByItem?.get(item.id) ?? this.getSourceHealth(item),
				),
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
