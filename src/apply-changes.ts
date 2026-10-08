import type { TFile, Vault } from "obsidian";
import { normalizePathConflictKey, type ApplyInvocation, type ApplyOperation } from "./planning";

export type RenameApplyOutcome =
	| {
			itemId: string;
			status: "renamed";
			sourcePath: string;
			destinationPath: string;
			effects: { path: true; pdfBytes: false };
	  }
	| {
			itemId: string;
			status: "blocked";
			reason:
				| "missing-binding"
				| "source-changed"
				| "source-unavailable"
				| "invalid-destination"
				| "destination-conflict";
			message: string;
	  }
	| { itemId: string; status: "failed"; message: string };

export type ApplyInvocationResult =
	| { status: "completed"; invocationId: string; outcomes: RenameApplyOutcome[] }
	| { status: "busy"; message: string }
	| { status: "rejected"; message: string };

function safeVaultPath(path: unknown): path is string {
	if (typeof path !== "string" || path.startsWith("/") || path.includes("\\")) return false;
	if (/^\w[\w+.-]*:/.test(path)) return false;
	return (
		path.length > 0 &&
		path.split("/").every((segment) => !!segment && segment !== "." && segment !== "..")
	);
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	return (
		actual.length === expected.length &&
		actual.every((key, index) => key === [...expected].sort()[index])
	);
}

function isPdf(file: TFile): boolean {
	return file.extension.toLowerCase() === "pdf";
}

function validOperation(value: unknown): value is ApplyOperation {
	if (!value || typeof value !== "object") return false;
	const operation = value as Partial<ApplyOperation>;
	return (
		hasExactKeys(value, [
			"itemId",
			"sourcePath",
			"sourceMtime",
			"sourceSize",
			"destinationPath",
			"proposedName",
			"effects",
		]) &&
		typeof operation.itemId === "string" &&
		operation.itemId.length > 0 &&
		safeVaultPath(operation.sourcePath) &&
		Number.isFinite(operation.sourceMtime) &&
		Number.isFinite(operation.sourceSize) &&
		(operation.sourceSize ?? -1) >= 0 &&
		safeVaultPath(operation.destinationPath) &&
		operation.destinationPath !== operation.sourcePath &&
		operation.destinationPath.toLowerCase().endsWith(".pdf") &&
		typeof operation.proposedName === "string" &&
		operation.proposedName ===
			operation.destinationPath.slice(operation.destinationPath.lastIndexOf("/") + 1) &&
		!!operation.effects &&
		operation.effects.path === true &&
		operation.effects.pdfBytes === false &&
		Object.keys(operation.effects).length === 2
	);
}

function validateInvocation(
	value: unknown,
): { valid: true; invocation: ApplyInvocation } | { valid: false } {
	if (!value || typeof value !== "object") return { valid: false };
	const invocation = value as Partial<ApplyInvocation>;
	if (
		!hasExactKeys(value, ["invocationId", "sessionId", "sessionRevision", "operations"]) ||
		typeof invocation.invocationId !== "string" ||
		!invocation.invocationId ||
		typeof invocation.sessionId !== "string" ||
		!invocation.sessionId ||
		!Number.isInteger(invocation.sessionRevision) ||
		!Array.isArray(invocation.operations)
	)
		return { valid: false };
	const operations = invocation.operations as ApplyOperation[];
	const itemIds = new Set<string>();
	const sourcePaths = new Set<string>();
	const destinations = new Set<string>();
	for (const operation of operations) {
		if (!validOperation(operation)) return { valid: false };
		const source = normalizePathConflictKey(operation.sourcePath);
		const destination = normalizePathConflictKey(operation.destinationPath);
		if (
			itemIds.has(operation.itemId) ||
			sourcePaths.has(source) ||
			destinations.has(destination)
		)
			return { valid: false };
		itemIds.add(operation.itemId);
		sourcePaths.add(source);
		destinations.add(destination);
	}
	for (const operation of operations) {
		const source = normalizePathConflictKey(operation.sourcePath);
		const destination = normalizePathConflictKey(operation.destinationPath);
		if (destination !== source && sourcePaths.has(destination)) return { valid: false };
	}
	return { valid: true, invocation: invocation as ApplyInvocation };
}

/** Executes only the exact detached rename operations in a reviewed invocation. */
export class ApplyChangesService {
	private active = false;
	private readonly vault: Vault;

	constructor(vault: Vault) {
		this.vault = vault;
	}

	async apply(
		invocationValue: ApplyInvocation,
		sourceBindings: ReadonlyMap<string, TFile>,
	): Promise<ApplyInvocationResult> {
		if (this.active)
			return { status: "busy", message: "Another Apply invocation is already running" };
		const checked = validateInvocation(invocationValue);
		if (!checked.valid)
			return { status: "rejected", message: "The reviewed invocation is malformed" };
		this.active = true;
		try {
			const invocation = JSON.parse(JSON.stringify(checked.invocation)) as ApplyInvocation;
			const bindings = new Map(sourceBindings);
			const outcomes: RenameApplyOutcome[] = [];
			for (const operation of invocation.operations) {
				outcomes.push(await this.applyOne(operation, bindings));
			}
			return { status: "completed", invocationId: invocation.invocationId, outcomes };
		} catch (error) {
			return {
				status: "rejected",
				message: `The reviewed invocation could not be captured: ${error instanceof Error ? error.message : String(error)}`,
			};
		} finally {
			this.active = false;
		}
	}

	private async applyOne(
		operation: ApplyOperation,
		bindings: ReadonlyMap<string, TFile>,
	): Promise<RenameApplyOutcome> {
		try {
			const bound = bindings.get(operation.itemId);
			if (!bound) {
				return {
					itemId: operation.itemId,
					status: "blocked",
					reason: "missing-binding",
					message: "The reviewed source binding is unavailable",
				};
			}
			const current = this.vault.getAbstractFileByPath(operation.sourcePath);
			if (current !== bound || bound.path !== operation.sourcePath || !isPdf(bound)) {
				return {
					itemId: operation.itemId,
					status: "blocked",
					reason: "source-changed",
					message:
						"The reviewed source is missing, replaced, renamed or is no longer a PDF",
				};
			}
			if (
				bound.stat.mtime !== operation.sourceMtime ||
				bound.stat.size !== operation.sourceSize
			) {
				return {
					itemId: operation.itemId,
					status: "blocked",
					reason: "source-changed",
					message: "The reviewed source changed after preview",
				};
			}

			const parentPath = operation.destinationPath.includes("/")
				? operation.destinationPath.slice(0, operation.destinationPath.lastIndexOf("/"))
				: "";
			const parent = parentPath
				? this.vault.getAbstractFileByPath(parentPath)
				: this.vault.getRoot();
			const parentIsFolder = parentPath
				? !!parent &&
					parent.path === parentPath &&
					this.vault.getAllFolders().some((folder) => folder.path === parentPath) &&
					!this.vault.getFiles().some((file) => file.path === parentPath)
				: parent === this.vault.getRoot();
			if (!parent || !parentIsFolder) {
				return {
					itemId: operation.itemId,
					status: "blocked",
					reason: "invalid-destination",
					message: "The reviewed destination folder is no longer available",
				};
			}
			const destinationKey = normalizePathConflictKey(operation.destinationPath);
			const occupiedByFile = this.vault
				.getFiles()
				.some(
					(file) =>
						file !== bound && normalizePathConflictKey(file.path) === destinationKey,
				);
			const occupiedByFolder = this.vault
				.getAllFolders()
				.some((folder) => normalizePathConflictKey(folder.path) === destinationKey);
			if (occupiedByFile || occupiedByFolder) {
				return {
					itemId: operation.itemId,
					status: "blocked",
					reason: "destination-conflict",
					message: "A file or folder now occupies the reviewed destination",
				};
			}
			await this.vault.rename(bound, operation.destinationPath);
			return {
				itemId: operation.itemId,
				status: "renamed",
				sourcePath: operation.sourcePath,
				destinationPath: operation.destinationPath,
				effects: { path: true, pdfBytes: false },
			};
		} catch (error) {
			return {
				itemId: operation.itemId,
				status: "failed",
				message: error instanceof Error ? error.message : String(error),
			};
		}
	}
}
