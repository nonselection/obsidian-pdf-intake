import { createFactoryConfiguration } from "./types";
import type {
	FilenameComponent,
	MetadataAndNaming,
	OutputLocation,
	SessionConfiguration,
	WorkspaceEditPolicy,
} from "./types";
import { isUsableLegacyTemplate } from "./filename-template";

export type JsonValue =
	null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface PersistedSettings {
	workspaceEditPolicy: WorkspaceEditPolicy;
	defaults: SessionConfiguration;
}

export interface PluginDataEnvelope {
	schemaVersion: 1;
	settings: PersistedSettings;
	unfinishedSessionDraft: JsonValue;
	[key: string]: unknown;
}

export interface PersistenceDiagnostic {
	code: string;
	message: string;
	severity: "info" | "warning" | "error";
}

export type DecodeStatus =
	"absent" | "migrated-legacy" | "supported-v1" | "unsupported" | "unreadable-corrupt";

export interface DecodeResult {
	status: DecodeStatus;
	settings: PersistedSettings;
	draftNamespace: JsonValue;
	envelope: PluginDataEnvelope;
	diagnostics: PersistenceDiagnostic[];
	writable: boolean;
	migrationNeeded: boolean;
}

export interface SettingsPatch {
	workspaceEditPolicy?: WorkspaceEditPolicy;
	defaults?: {
		output?: OutputLocation;
		metadataAndNaming?: Partial<MetadataAndNaming>;
	};
}

export class PersistenceReadonlyError extends Error {
	constructor(
		message = "Plugin data is read-only because its stored format is not safely writable",
	) {
		super(message);
		this.name = "PersistenceReadonlyError";
	}
}

type PlainRecord = Record<string, unknown>;

function isRecord(value: unknown): value is PlainRecord {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Reflect.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (!isRecord(value)) return false;
	return Object.values(value).every(isJsonValue);
}

function cloneJson<T>(value: T): T {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) throw new TypeError("Value is not JSON serializable");
	return JSON.parse(serialized) as T;
}

function cloneConfiguration(value: SessionConfiguration): SessionConfiguration {
	return cloneJson(value);
}

function factorySettings(): PersistedSettings {
	return {
		workspaceEditPolicy: "future-sessions",
		defaults: createFactoryConfiguration(),
	};
}

function factoryEnvelope(): PluginDataEnvelope {
	return {
		schemaVersion: 1,
		settings: factorySettings(),
		unfinishedSessionDraft: null,
	};
}

function isCanonicalVaultPath(path: unknown): path is string {
	if (typeof path !== "string" || path.startsWith("/") || path.includes("\\")) return false;
	if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return false;
	if (path.split("/").some((segment) => segment === "." || segment === ".." || !segment))
		return path === "";
	return true;
}

function isOutputLocation(value: unknown): value is OutputLocation {
	if (!isRecord(value)) return false;
	if (value.mode === "current-folders") return Object.keys(value).length >= 1;
	return value.mode === "vault-folder" && isCanonicalVaultPath(value.folderPath);
}

function isComponent(value: unknown): value is FilenameComponent {
	if (!isRecord(value) || typeof value.kind !== "string") return false;
	if (value.kind === "literal") return typeof value.text === "string";
	if (value.kind === "field") {
		return (
			(value.field === "title" ||
				value.field === "year" ||
				value.field === "journal" ||
				value.field === "publisher") &&
			(value.prefix === undefined || typeof value.prefix === "string") &&
			(value.suffix === undefined || typeof value.suffix === "string")
		);
	}
	if (value.kind !== "authorship" || !isRecord(value.presentation)) return false;
	const p = value.presentation;
	return (
		(p.selection === "first" || p.selection === "all") &&
		(p.nameStyle === "family" ||
			p.nameStyle === "abbreviated-given" ||
			p.nameStyle === "full") &&
		(p.etAl === "never" || p.etAl === "conditional") &&
		(p.nameOrder === "given-family" || p.nameOrder === "family-given") &&
		typeof p.separator === "string"
	);
}

function isMetadataAndNaming(value: unknown): value is MetadataAndNaming {
	if (!isRecord(value) || !isRecord(value.filenameFormat)) return false;
	const format = value.filenameFormat;
	const validFormat =
		(format.kind === "legacy-template" &&
			typeof format.template === "string" &&
			isUsableLegacyTemplate(format.template)) ||
		(format.kind === "components" &&
			Array.isArray(format.components) &&
			format.components.every(isComponent));
	return (
		validFormat &&
		(value.embeddedPdfMetadata === undefined ||
			(isRecord(value.embeddedPdfMetadata) &&
				typeof value.embeddedPdfMetadata.requested === "boolean"))
	);
}

function isSessionConfiguration(value: unknown): value is SessionConfiguration {
	return (
		isRecord(value) &&
		isOutputLocation(value.output) &&
		isMetadataAndNaming(value.metadataAndNaming)
	);
}

function validV1Settings(value: unknown): value is PersistedSettings {
	return (
		isRecord(value) &&
		(value.workspaceEditPolicy === "future-sessions" ||
			value.workspaceEditPolicy === "session-only") &&
		isSessionConfiguration(value.defaults)
	);
}

function warning(code: string, message: string): PersistenceDiagnostic {
	return { code, message, severity: "warning" };
}

function readonlyResult(
	status: "unsupported" | "unreadable-corrupt",
	message: string,
	settings = factorySettings(),
): DecodeResult {
	const envelope = factoryEnvelope();
	envelope.settings = cloneJson(settings);
	return {
		status,
		settings,
		draftNamespace: null,
		envelope,
		diagnostics: [{ code: status, message, severity: "error" }],
		writable: false,
		migrationNeeded: false,
	};
}

function legacyOutput(record: PlainRecord, folders: ReadonlySet<string>): OutputLocation {
	if (record.processedFolderMode === "intake") return { mode: "current-folders" };
	if (record.processedFolderMode !== "another" || typeof record.processedFolder !== "string") {
		return { mode: "current-folders" };
	}
	const path = record.processedFolder.trim().replace(/\/+$/g, "");
	if (path && isCanonicalVaultPath(path) && folders.has(path)) {
		return { mode: "vault-folder", folderPath: path };
	}
	return { mode: "current-folders" };
}

const LEGACY_KEYS = new Set([
	"intakeFolder",
	"intakeFolders",
	"processedFolderMode",
	"processedFolder",
	"renameTemplate",
]);

function isLegacyRecord(record: PlainRecord): boolean {
	return Object.keys(record).some((key) => LEGACY_KEYS.has(key));
}

function legacySettings(record: PlainRecord, folders: ReadonlySet<string>): PersistedSettings {
	const defaults = createFactoryConfiguration();
	defaults.output = legacyOutput(record, folders);
	if (
		typeof record.renameTemplate === "string" &&
		isUsableLegacyTemplate(record.renameTemplate)
	) {
		defaults.metadataAndNaming.filenameFormat = {
			kind: "legacy-template",
			template: record.renameTemplate,
		};
	}
	return { workspaceEditPolicy: "future-sessions", defaults };
}

export function decodePluginData(raw: unknown, folderPaths: readonly string[]): DecodeResult {
	const folders = new Set(folderPaths);
	if (raw === null || raw === undefined || (isRecord(raw) && Object.keys(raw).length === 0)) {
		return {
			status: "absent",
			settings: factorySettings(),
			draftNamespace: null,
			envelope: factoryEnvelope(),
			diagnostics: [],
			writable: true,
			migrationNeeded: true,
		};
	}
	if (!isRecord(raw) || !isJsonValue(raw)) {
		return readonlyResult(
			"unreadable-corrupt",
			"Stored plugin data is not a plain JSON object",
		);
	}

	if (Object.prototype.hasOwnProperty.call(raw, "schemaVersion")) {
		if (raw.schemaVersion !== 1) {
			let recognizable = factorySettings();
			if (isLegacyRecord(raw)) recognizable = legacySettings(raw, folders);
			if (isRecord(raw.settings) && isRecord(raw.settings.defaults)) {
				const maybeDefaults = raw.settings.defaults;
				if (isSessionConfiguration(maybeDefaults))
					recognizable.defaults = cloneConfiguration(maybeDefaults);
				if (
					raw.settings.workspaceEditPolicy === "future-sessions" ||
					raw.settings.workspaceEditPolicy === "session-only"
				)
					recognizable.workspaceEditPolicy = raw.settings.workspaceEditPolicy;
			}
			return readonlyResult(
				"unsupported",
				"Stored plugin data uses an unsupported schema version; it was not rewritten",
				recognizable,
			);
		}
		if (
			!validV1Settings(raw.settings) ||
			!Object.prototype.hasOwnProperty.call(raw, "unfinishedSessionDraft")
		) {
			return readonlyResult(
				"unreadable-corrupt",
				"Stored version 1 plugin data has malformed settings or draft namespace",
			);
		}
		const draft = raw.unfinishedSessionDraft;
		if (!isJsonValue(draft)) {
			return readonlyResult("unreadable-corrupt", "Stored draft namespace is not JSON-safe");
		}
		const envelope = cloneJson(raw) as unknown as PluginDataEnvelope;
		return {
			status: "supported-v1",
			settings: cloneJson(raw.settings),
			draftNamespace: cloneJson(draft),
			envelope,
			diagnostics: [],
			writable: true,
			migrationNeeded: false,
		};
	}

	if (
		Object.prototype.hasOwnProperty.call(raw, "settings") ||
		Object.prototype.hasOwnProperty.call(raw, "unfinishedSessionDraft")
	) {
		return readonlyResult(
			"unsupported",
			"Stored plugin data resembles a versioned envelope but has no recognized schema version; it was not rewritten",
		);
	}

	if (isLegacyRecord(raw)) {
		const settings = legacySettings(raw, folders);
		const unknownLegacyKeys = Object.keys(raw).filter((key) => !LEGACY_KEYS.has(key));
		if (unknownLegacyKeys.length) {
			return readonlyResult(
				"unsupported",
				"Legacy data contains unrecognized fields and was preserved without rewriting",
				settings,
			);
		}
		const diagnostics: PersistenceDiagnostic[] = [];
		if (
			raw.processedFolderMode === "another" &&
			settings.defaults.output.mode === "current-folders"
		) {
			diagnostics.push(
				warning(
					"legacy-destination-repaired",
					"The legacy destination was empty or invalid; each PDF will stay in its current folder.",
				),
			);
		}
		if (
			raw.renameTemplate !== undefined &&
			(typeof raw.renameTemplate !== "string" || !isUsableLegacyTemplate(raw.renameTemplate))
		) {
			diagnostics.push(
				warning(
					"legacy-template-repaired",
					"The legacy filename template was invalid; the citation-style factory format is active.",
				),
			);
		}
		return {
			status: "migrated-legacy",
			settings,
			draftNamespace: null,
			envelope: {
				schemaVersion: 1,
				settings: cloneJson(settings),
				unfinishedSessionDraft: null,
			},
			diagnostics,
			writable: true,
			migrationNeeded: true,
		};
	}
	return readonlyResult("unsupported", "Stored plugin data is not a recognized legacy record");
}

function mergeSettings(base: PersistedSettings, patch: SettingsPatch): PersistedSettings {
	const result = cloneJson(base) as PersistedSettings & PlainRecord;
	if (patch.workspaceEditPolicy) result.workspaceEditPolicy = patch.workspaceEditPolicy;
	if (patch.defaults?.output) result.defaults.output = cloneJson(patch.defaults.output);
	if (patch.defaults?.metadataAndNaming) {
		result.defaults.metadataAndNaming = {
			...result.defaults.metadataAndNaming,
			...cloneJson(patch.defaults.metadataAndNaming),
		};
	}
	return result;
}

/** The single serialized owner for plugin-data load/save and namespace updates. */
export class PluginDataStore {
	private readonly loadData: () => Promise<unknown>;
	private readonly saveData: (data: unknown) => Promise<void>;
	private folderPaths: readonly string[];
	private result?: DecodeResult;
	private committedEnvelope?: PluginDataEnvelope;
	private queueTail: Promise<void> = Promise.resolve();
	private diagnostics: PersistenceDiagnostic[] = [];

	constructor(options: {
		loadData: () => Promise<unknown>;
		saveData: (data: unknown) => Promise<void>;
		folderPaths?: readonly string[];
	}) {
		this.loadData = options.loadData;
		this.saveData = options.saveData;
		this.folderPaths = [...(options.folderPaths ?? [])];
	}

	async load(folderPaths: readonly string[] = this.folderPaths): Promise<DecodeResult> {
		this.folderPaths = [...folderPaths];
		let raw: unknown;
		try {
			raw = await this.loadData();
		} catch (error) {
			this.result = readonlyResult(
				"unreadable-corrupt",
				`Plugin data could not be read and will not be overwritten: ${errorText(error)}`,
			);
			this.diagnostics = [...this.result.diagnostics];
			return this.getDecodeResult();
		}
		this.result = decodePluginData(raw, this.folderPaths);
		this.diagnostics = [...this.result.diagnostics];
		if (this.result.status === "supported-v1")
			this.committedEnvelope = cloneJson(this.result.envelope);
		if (this.result.migrationNeeded && this.result.writable) {
			try {
				await this.enqueue(async () => {
					const initial = cloneJson(this.result!.envelope);
					await this.saveData(initial);
					this.committedEnvelope = cloneJson(initial);
					this.result = { ...this.result!, migrationNeeded: false };
				});
			} catch (error) {
				this.diagnostics = [
					...this.diagnostics.filter((item) => item.code !== "initial-save-failed"),
					warning(
						"initial-save-failed",
						`Settings are available for this session but were not saved: ${errorText(error)}`,
					),
				];
			}
		}
		return this.getDecodeResult();
	}

	getSettings(): PersistedSettings {
		return cloneJson(this.currentEnvelope().settings);
	}

	getDraftNamespace(): JsonValue {
		return cloneJson(this.currentEnvelope().unfinishedSessionDraft);
	}

	getStatus(): DecodeResult {
		return this.getDecodeResult();
	}

	getDiagnostics(): PersistenceDiagnostic[] {
		return cloneJson(this.diagnostics);
	}

	async updateSettings(patch: SettingsPatch): Promise<PersistedSettings> {
		const captured = cloneJson(patch);
		return this.enqueue(async () => {
			this.assertWritable();
			const base = this.currentEnvelope();
			const settings = mergeSettings(base.settings, captured);
			const candidate = cloneJson(base) as PluginDataEnvelope & PlainRecord;
			candidate.schemaVersion = 1;
			const priorSettings = (candidate.settings as unknown as PlainRecord | undefined) ?? {};
			candidate.settings = {
				...priorSettings,
				...settings,
				defaults: {
					...(priorSettings.defaults as PlainRecord | undefined),
					...settings.defaults,
				},
			};
			await this.saveData(candidate);
			this.commit(candidate);
			return this.getSettings();
		});
	}

	async updateDraftNamespace(value: JsonValue): Promise<void> {
		const captured = cloneJson(value);
		if (!isJsonValue(captured))
			throw new TypeError("Draft namespace must contain JSON values only");
		return this.enqueue(async () => {
			this.assertWritable();
			const candidate = cloneJson(this.currentEnvelope());
			candidate.unfinishedSessionDraft = captured;
			await this.saveData(candidate);
			this.commit(candidate);
		});
	}

	private currentEnvelope(): PluginDataEnvelope {
		return cloneJson(this.committedEnvelope ?? this.result?.envelope ?? factoryEnvelope());
	}

	private assertWritable(): void {
		if (!this.result) throw new Error("Plugin data has not been loaded");
		if (!this.result.writable) throw new PersistenceReadonlyError();
	}

	private commit(envelope: PluginDataEnvelope): void {
		this.committedEnvelope = cloneJson(envelope);
		if (this.result) {
			this.result = {
				...this.result,
				status: "supported-v1",
				settings: cloneJson(envelope.settings),
				draftNamespace: cloneJson(envelope.unfinishedSessionDraft),
				envelope: cloneJson(envelope),
				migrationNeeded: false,
				writable: true,
			};
		}
		this.diagnostics = this.diagnostics.filter(
			(item) => item.code !== "initial-save-failed" && item.code !== "save-failed",
		);
	}

	private getDecodeResult(): DecodeResult {
		const result = this.result ?? decodePluginData(null, this.folderPaths);
		return {
			...result,
			settings: cloneJson(this.currentEnvelope().settings),
			draftNamespace: cloneJson(this.currentEnvelope().unfinishedSessionDraft),
			envelope: this.currentEnvelope(),
			diagnostics: this.getDiagnostics(),
		};
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const next = this.queueTail.then(task, task);
		this.queueTail = next.then(
			() => undefined,
			(error: unknown) => {
				if (this.result?.writable) {
					this.diagnostics = [
						...this.diagnostics.filter((item) => item.code !== "save-failed"),
						warning("save-failed", `Plugin data was not saved: ${errorText(error)}`),
					];
				}
				return undefined;
			},
		);
		return next;
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
