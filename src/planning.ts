import { deriveAuthorship, type AuthorshipDiagnostic } from "./authorship";
import {
	formatLegacyTemplate,
	sanitizePdfFilename,
	type FilenameFormatResult,
} from "./filename-template";
import type {
	CanonicalBibliographicRecord,
	FilenameFormat,
	IdentificationEvidence,
	SessionConfiguration,
} from "./types";

export interface SourceObservation {
	path: string;
	mtime: number;
	size: number;
}

export type IdentificationState =
	| { status: "unattempted" }
	| { status: "identifying" }
	| {
			status: "resolved";
			record: CanonicalBibliographicRecord;
			evidence?: IdentificationEvidence;
	  }
	| { status: "needs-user"; reason: string; evidence?: IdentificationEvidence };

export type PlanBlockedReason =
	| "identification-pending"
	| "identification-required"
	| "missing-title"
	| "missing-authorship"
	| "invalid-output"
	| "destination-conflict"
	| "planned-collision"
	| "source-observation-invalid";

export interface PlanningItem {
	itemId: string;
	sourceObservation: SourceObservation;
	identification: IdentificationState;
}

export interface PlanningInput {
	sessionId: string;
	sessionRevision: number;
	configuration: SessionConfiguration;
	items: readonly PlanningItem[];
	vaultFilePaths: readonly string[];
	vaultFolderPaths: readonly string[];
}

export interface ProposedRename {
	itemId: string;
	sourceObservation: SourceObservation;
	destinationPath: string;
	proposedName: string;
	effects: { path: true; pdfBytes: false };
}

export type RenamePlanResult =
	| { itemId: string; status: "eligible"; proposedRename: ProposedRename; diagnostics: string[] }
	| { itemId: string; status: "no-change"; currentPath: string; diagnostics: string[] }
	| {
			itemId: string;
			status: "blocked";
			reason: PlanBlockedReason;
			message: string;
			diagnostics: string[];
	  };

export interface PlanningSnapshot {
	sessionId: string;
	sessionRevision: number;
	results: readonly RenamePlanResult[];
}

export interface ApplyOperation {
	itemId: string;
	sourcePath: string;
	sourceMtime: number;
	sourceSize: number;
	destinationPath: string;
	proposedName: string;
	effects: { path: true; pdfBytes: false };
}

export interface ApplyInvocation {
	invocationId: string;
	sessionId: string;
	sessionRevision: number;
	operations: readonly ApplyOperation[];
}

export type CreateApplyInvocationResult =
	| { ok: true; invocation: ApplyInvocation }
	| { ok: false; reason: "stale-revision"; message: string };

function record<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	}
	return value;
}

function diagnosticsText(diagnostics: AuthorshipDiagnostic[]): string[] {
	return diagnostics.map((diagnostic) => diagnostic.message);
}

function formatComponents(
	recordValue: CanonicalBibliographicRecord,
	components: readonly import("./types").FilenameComponent[],
): FilenameFormatResult {
	if (!recordValue.title?.trim()) {
		return {
			filename: null,
			diagnostics: ["A title is required for the current rename preview"],
			blockedReason: "missing-title",
		};
	}
	let text = "";
	const diagnostics: string[] = [];
	for (const component of components) {
		if (component.kind === "literal") {
			text += component.text;
		} else if (component.kind === "field") {
			const value =
				component.field === "year"
					? recordValue.year?.toString()
					: recordValue[component.field];
			if (value !== undefined && value !== "") {
				text += `${component.prefix ?? ""}${value}${component.suffix ?? ""}`;
			} else if (component.field === "title") {
				return {
					filename: null,
					diagnostics: ["A title is required for the current rename preview"],
					blockedReason: "missing-title",
				};
			} else if (component.field === "year") {
				diagnostics.push(
					"Publication year is unavailable; the parenthesized year is omitted",
				);
			}
		} else {
			const derived = deriveAuthorship(recordValue.authorship, component.presentation);
			diagnostics.push(...diagnosticsText(derived.diagnostics));
			if (!derived.value) {
				return {
					filename: null,
					diagnostics,
					blockedReason: "missing-authorship",
				};
			}
			text += derived.value;
		}
	}
	const filename = sanitizePdfFilename(text);
	return {
		filename,
		diagnostics: filename
			? diagnostics
			: [...diagnostics, "Filename components produce an empty filename"],
		...(filename ? {} : { blockedReason: "missing-title" as const }),
	};
}

export function formatFilename(
	recordValue: CanonicalBibliographicRecord,
	format: FilenameFormat,
): FilenameFormatResult {
	return format.kind === "legacy-template"
		? formatLegacyTemplate(recordValue, format.template)
		: formatComponents(recordValue, format.components);
}

function canonicalPath(path: string): boolean {
	return (
		!path.startsWith("/") &&
		!path.includes("\\") &&
		!/^\w[\w+.-]*:/.test(path) &&
		(path === "" ||
			path.split("/").every((part) => part !== "" && part !== "." && part !== ".."))
	);
}

export function isCanonicalVaultFolderPath(path: string): boolean {
	return canonicalPath(path);
}

function sourceFolder(path: string): string {
	const index = path.lastIndexOf("/");
	return index < 0 ? "" : path.slice(0, index);
}

export function normalizePathConflictKey(path: string): string {
	return path.normalize("NFC").toLowerCase();
}

function destinationFor(
	path: string,
	name: string,
	configuration: SessionConfiguration,
): { destinationPath: string; valid: boolean } {
	let folder: string;
	if (configuration.output.mode === "current-folders") folder = sourceFolder(path);
	else {
		folder = configuration.output.folderPath;
		if (!canonicalPath(folder)) return { destinationPath: "", valid: false };
	}
	return { destinationPath: folder ? `${folder}/${name}` : name, valid: true };
}

function blocked(itemId: string, reason: PlanBlockedReason, message: string): RenamePlanResult {
	return { itemId, status: "blocked", reason, message, diagnostics: [] };
}

interface Candidate {
	item: PlanningItem;
	name: string;
	destination: string;
	diagnostics: string[];
}

/** Pure planning over detached session/configuration and a read-only vault snapshot. */
export function planRenames(input: PlanningInput): PlanningSnapshot {
	const configuration = record(input.configuration);
	const items = record(input.items) as PlanningItem[];
	const filePaths = [...input.vaultFilePaths];
	const folderPaths = [...input.vaultFolderPaths];
	const preliminary = new Map<string, RenamePlanResult>();
	const candidates: Candidate[] = [];

	for (const item of items) {
		if (
			!item.itemId ||
			!canonicalPath(item.sourceObservation.path) ||
			!Number.isFinite(item.sourceObservation.mtime) ||
			!Number.isFinite(item.sourceObservation.size) ||
			item.sourceObservation.size < 0
		) {
			preliminary.set(
				item.itemId,
				blocked(
					item.itemId,
					"source-observation-invalid",
					"The source observation is incomplete",
				),
			);
			continue;
		}
		if (
			item.identification.status === "unattempted" ||
			item.identification.status === "identifying"
		) {
			preliminary.set(
				item.itemId,
				blocked(
					item.itemId,
					"identification-pending",
					"Bibliographic identification has not finished",
				),
			);
			continue;
		}
		if (item.identification.status === "needs-user") {
			preliminary.set(
				item.itemId,
				blocked(item.itemId, "identification-required", item.identification.reason),
			);
			continue;
		}
		const formatted = formatFilename(
			item.identification.record,
			configuration.metadataAndNaming.filenameFormat,
		);
		if (!formatted.filename) {
			const reason = formatted.blockedReason ?? "missing-title";
			preliminary.set(
				item.itemId,
				blocked(
					item.itemId,
					reason,
					reason === "missing-authorship"
						? "Required authorship is not available in the supplied record"
						: "Required title or a usable filename is not available",
				),
			);
			continue;
		}
		const target = destinationFor(
			item.sourceObservation.path,
			formatted.filename,
			configuration,
		);
		const diagnostics = [...formatted.diagnostics];
		if (!target.valid) {
			preliminary.set(
				item.itemId,
				blocked(
					item.itemId,
					"invalid-output",
					"The selected output folder path is invalid",
				),
			);
			continue;
		}
		if (target.destinationPath === item.sourceObservation.path) {
			preliminary.set(item.itemId, {
				itemId: item.itemId,
				status: "no-change",
				currentPath: item.sourceObservation.path,
				diagnostics,
			});
			continue;
		}
		preliminary.set(
			item.itemId,
			blocked(item.itemId, "invalid-output", "Planning is incomplete"),
		);
		candidates.push({
			item,
			name: formatted.filename,
			destination: target.destinationPath,
			diagnostics,
		});
	}

	const candidateTargets = new Map<string, Candidate[]>();
	for (const candidate of candidates) {
		const key = normalizePathConflictKey(candidate.destination);
		candidateTargets.set(key, [...(candidateTargets.get(key) ?? []), candidate]);
	}
	for (const candidate of candidates) {
		const key = normalizePathConflictKey(candidate.destination);
		const competitors = candidateTargets.get(key) ?? [];
		if (competitors.length > 1) {
			preliminary.set(
				candidate.item.itemId,
				blocked(
					candidate.item.itemId,
					"planned-collision",
					"More than one session item proposes this destination",
				),
			);
			continue;
		}
		const sourcePath = candidate.item.sourceObservation.path;
		const occupiedByOtherFile = filePaths.some(
			(path) => path !== sourcePath && normalizePathConflictKey(path) === key,
		);
		const occupiedByFolder = folderPaths.some((path) => normalizePathConflictKey(path) === key);
		const occupiedByOther = occupiedByOtherFile || occupiedByFolder;
		if (occupiedByOther) {
			preliminary.set(
				candidate.item.itemId,
				blocked(
					candidate.item.itemId,
					"destination-conflict",
					"A file or folder already occupies this destination",
				),
			);
			continue;
		}
		if (configuration.output.mode === "vault-folder") {
			const parent = configuration.output.folderPath;
			if (parent && !folderPaths.includes(parent)) {
				preliminary.set(
					candidate.item.itemId,
					blocked(
						candidate.item.itemId,
						"invalid-output",
						"The selected output folder is unavailable",
					),
				);
				continue;
			}
		}
		preliminary.set(candidate.item.itemId, {
			itemId: candidate.item.itemId,
			status: "eligible",
			proposedRename: {
				itemId: candidate.item.itemId,
				sourceObservation: record(candidate.item.sourceObservation),
				destinationPath: candidate.destination,
				proposedName: candidate.name,
				effects: { path: true, pdfBytes: false },
			},
			diagnostics: candidate.diagnostics,
		});
	}

	const results = items.map(
		(item) =>
			preliminary.get(item.itemId) ??
			blocked(item.itemId, "invalid-output", "No plan was produced"),
	);
	return deepFreeze({
		sessionId: input.sessionId,
		sessionRevision: input.sessionRevision,
		results,
	});
}

export function createApplyInvocation(
	reviewedPlanningSnapshot: PlanningSnapshot,
	expectedSessionRevision: number,
	invocationId: string,
): CreateApplyInvocationResult {
	if (reviewedPlanningSnapshot.sessionRevision !== expectedSessionRevision) {
		return {
			ok: false,
			reason: "stale-revision",
			message: "The reviewed plan is stale; preview the current session again",
		};
	}
	const operations: ApplyOperation[] = [];
	for (const result of reviewedPlanningSnapshot.results) {
		if (result.status !== "eligible") continue;
		operations.push({
			itemId: result.proposedRename.itemId,
			sourcePath: result.proposedRename.sourceObservation.path,
			sourceMtime: result.proposedRename.sourceObservation.mtime,
			sourceSize: result.proposedRename.sourceObservation.size,
			destinationPath: result.proposedRename.destinationPath,
			proposedName: result.proposedRename.proposedName,
			effects: { path: true, pdfBytes: false },
		});
	}
	const invocation: ApplyInvocation = {
		invocationId,
		sessionId: reviewedPlanningSnapshot.sessionId,
		sessionRevision: reviewedPlanningSnapshot.sessionRevision,
		operations,
	};
	return { ok: true, invocation: deepFreeze(record(invocation)) };
}
