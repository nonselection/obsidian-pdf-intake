import { describe, expect, it, vi } from "vitest";
import type { Vault } from "obsidian";
import { TFile, TFolder, type TAbstractFile } from "./obsidian";
import { PluginDataStore, type PluginDataEnvelope } from "../src/persistence";
import {
	SessionCoordinator,
	type IntakeSession,
	type SessionCoordinatorOptions,
} from "../src/session";
import type { ApplyInvocation } from "../src/planning";
import type { ApplyInvocationResult } from "../src/apply-changes";
import { createFactoryConfiguration } from "../src/types";
import type { IdentificationResult } from "../src/resolver";

function stored(
	policy: "future-sessions" | "session-only" = "future-sessions",
): PluginDataEnvelope {
	return {
		schemaVersion: 1,
		settings: { workspaceEditPolicy: policy, defaults: createFactoryConfiguration() },
		unfinishedSessionDraft: { opaque: "retained" },
	};
}

async function storeWith(
	raw: unknown = stored(),
	saveData = vi.fn(() => Promise.resolve(undefined)),
) {
	const store = new PluginDataStore({ loadData: () => Promise.resolve(raw), saveData });
	await store.load(["Sources"]);
	return { store, saveData };
}

function vaultFixture() {
	const root = new TFolder("/");
	const entries = new Map<string, TAbstractFile>([["/", root]]);
	const folders: TFolder[] = [];
	const ensureFolder = (path: string): TFolder => {
		const existing = entries.get(path);
		if (existing instanceof TFolder) return existing;
		const slash = path.lastIndexOf("/");
		const parent = slash < 0 ? root : ensureFolder(path.slice(0, slash));
		const folder = new TFolder(path, parent);
		parent.children.push(folder);
		entries.set(path, folder);
		folders.push(folder);
		return folder;
	};
	const addFile = (path: string, stat = { ctime: 1, mtime: 100, size: 200 }): TFile => {
		const slash = path.lastIndexOf("/");
		const parent = slash < 0 ? root : ensureFolder(path.slice(0, slash));
		const file = new TFile(path, stat, parent);
		parent.children.push(file);
		entries.set(path, file);
		return file;
	};
	const getAbstractFileByPath = vi.fn((path: string) => entries.get(path) ?? null);
	const mutations = {
		rename: vi.fn(),
		create: vi.fn(),
		createFolder: vi.fn(),
		modify: vi.fn(),
		modifyBinary: vi.fn(),
		delete: vi.fn(),
		trash: vi.fn(),
	};
	const vault = {
		getRoot: () => root,
		getAbstractFileByPath,
		getAllFolders: () => folders,
		getFiles: vi.fn(() =>
			[...entries.values()].filter((entry): entry is TFile => entry instanceof TFile),
		),
		getAllLoadedFiles: vi.fn(() => [...entries.values()]),
		readBinary: vi.fn(),
		...mutations,
	};
	const moveFile = (file: TFile, nextPath: string): void => {
		file.parent?.children.splice(file.parent.children.indexOf(file), 1);
		entries.delete(file.path);
		const slash = nextPath.lastIndexOf("/");
		const parent = slash < 0 ? root : ensureFolder(nextPath.slice(0, slash));
		Object.defineProperty(file, "path", { value: nextPath, configurable: true });
		Object.defineProperty(file, "name", {
			value: nextPath.split("/").pop() ?? "",
			configurable: true,
		});
		file.parent = parent;
		parent.children.push(file);
		entries.set(nextPath, file);
	};
	return {
		vault: vault as unknown as Vault,
		entries,
		root,
		folders,
		addFile,
		moveFile,
		mutations,
	};
}

function seedTestItem(coordinator: SessionCoordinator): void {
	const testSession = coordinator as unknown as {
		session: IntakeSession;
		vault?: Vault;
		sourceBindings: Map<string, TFile>;
	};
	const file = testSession.vault?.getAbstractFileByPath("Inbox/source.pdf");
	testSession.session.items.push({
		id: "item-1",
		admissionObservation: { path: "Inbox/source.pdf", mtime: 100, size: 200 },
		sourceObservation: { path: "Inbox/source.pdf", mtime: 100, size: 200 },
		identification: {
			status: "resolved",
			record: {
				title: "Example",
				authorship: {
					authors: [{ kind: "person", given: "Ada", family: "Lovelace" }],
					completeness: "complete",
					totalCountKnown: true,
				},
				year: 2024,
				isbns: [],
				provenance: { provider: "crossref", route: "doi", identifier: "10.1234/test" },
			},
		},
	});
	if (file instanceof TFile) testSession.sourceBindings.set("item-1", file);
}

function makeCoordinator(
	store: PluginDataStore,
	options: SessionCoordinatorOptions = {},
): SessionCoordinator {
	const vault = options.vault;
	return new SessionCoordinator(store, {
		...options,
		planningEnvironment: options.planningEnvironment ?? {
			getSnapshot: () => ({
				filePaths: vault?.getFiles().map((file) => file.path) ?? ["Inbox/source.pdf"],
				folderPaths: [
					"",
					"Sources",
					"Inbox",
					...(vault?.getAllFolders().map((folder) => folder.path) ?? []),
				],
			}),
		},
	});
}

function recordingApplyService() {
	const apply = vi.fn((invocation: ApplyInvocation): Promise<ApplyInvocationResult> =>
		Promise.resolve({
			status: "completed",
			invocationId: invocation.invocationId,
			outcomes: [],
		}),
	);
	return { apply, service: { apply } };
}

function deferred() {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function deferredValue<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

function acceptedIdentification(title: string): IdentificationResult {
	return {
		status: "accepted",
		record: {
			title,
			authorship: {
				authors: [{ kind: "person", given: "Ada", family: "Lovelace" }],
				completeness: "complete",
				totalCountKnown: true,
			},
			year: 2024,
			isbns: [],
			provenance: { provider: "crossref", route: "doi", identifier: "10.1234/test" },
		},
		evidence: { identifiers: [], attempts: [], titleCandidates: [title], diagnostics: [] },
	};
}

function needsYouIdentification(reason = "No title match."): IdentificationResult {
	return {
		status: "needs-you",
		reason,
		evidence: { identifiers: [], attempts: [], titleCandidates: [], diagnostics: [] },
	};
}

describe("plugin-owned session coordinator", () => {
	it("assigns a fresh identity to each coordinator after plugin reload", async () => {
		const { store } = await storeWith();
		const beforeReload = makeCoordinator(store).getSnapshot();
		const afterReload = makeCoordinator(store).getSnapshot();
		expect(afterReload.id).not.toBe(beforeReload.id);
	});

	it("creates fresh empty setup sessions from detached defaults", async () => {
		const { store } = await storeWith();
		const coordinator = makeCoordinator(store);
		const first = coordinator.getSnapshot();
		expect(first).toMatchObject({
			revision: 0,
			phase: "setup",
			setupOpen: true,
			setupConcern: "pdfs",
			items: [],
		});
		expect(first.configuration.output).toEqual({ mode: "current-folders" });
		const second = coordinator.createNewSession();
		expect(second.id).not.toBe(first.id);
		expect(second.items).toEqual([]);
		expect(second.configuration).not.toBe(first.configuration);
		expect(second.configuration.metadataAndNaming).not.toBe(
			first.configuration.metadataAndNaming,
		);
		first.configuration.output.mode = "vault-folder";
		expect(coordinator.getSnapshot().configuration.output).toEqual({ mode: "current-folders" });
	});

	it("keeps setup concern changes from resetting identity, revision or configuration", async () => {
		const { store } = await storeWith();
		const coordinator = makeCoordinator(store);
		const before = coordinator.getSnapshot();
		coordinator.setSetupConcern("metadata-and-naming");
		const after = coordinator.getSnapshot();
		expect(after.setupConcern).toBe("metadata-and-naming");
		expect(after.id).toBe(before.id);
		expect(after.revision).toBe(before.revision);
		expect(after.configuration).toEqual(before.configuration);
		expect(coordinator.beginReview()).toEqual({
			allowed: false,
			reason: "Add at least one PDF before beginning review.",
		});
	});

	it("updates the current session and future defaults under the committed future-sessions policy", async () => {
		const { store, saveData } = await storeWith();
		const coordinator = makeCoordinator(store);
		const original = coordinator.getSnapshot();
		const edit = await coordinator.updateOutput({
			mode: "vault-folder",
			folderPath: "Sources",
		});
		expect(edit).toMatchObject({ updated: true, savedForFutureSessions: true });
		expect(coordinator.getSnapshot().configuration.output).toEqual({
			mode: "vault-folder",
			folderPath: "Sources",
		});
		expect(store.getSettings().defaults.output).toEqual({
			mode: "vault-folder",
			folderPath: "Sources",
		});
		expect(original.configuration.output).toEqual({ mode: "current-folders" });
		expect(coordinator.createNewSession().configuration.output).toEqual({
			mode: "vault-folder",
			folderPath: "Sources",
		});
		expect(saveData).toHaveBeenCalledTimes(1);
	});

	it("keeps session-only edits out of defaults and draft writes", async () => {
		const { store, saveData } = await storeWith(stored("session-only"));
		const coordinator = makeCoordinator(store);
		const edit = await coordinator.updateOutput({
			mode: "vault-folder",
			folderPath: "Sources",
		});
		expect(edit).toMatchObject({ updated: true, savedForFutureSessions: false });
		expect(store.getSettings().defaults.output).toEqual({ mode: "current-folders" });
		expect(store.getDraftNamespace()).toEqual({ opaque: "retained" });
		expect(saveData).not.toHaveBeenCalled();
		expect(coordinator.createNewSession().configuration.output).toEqual({
			mode: "current-folders",
		});
	});

	it("does not retroactively copy later Settings defaults into an existing session", async () => {
		const { store } = await storeWith();
		const coordinator = makeCoordinator(store);
		const existing = coordinator.getSnapshot();
		await store.updateSettings({
			defaults: { output: { mode: "vault-folder", folderPath: "Sources" } },
		});
		expect(coordinator.getSnapshot().configuration.output).toEqual(
			existing.configuration.output,
		);
		expect(coordinator.createNewSession().configuration.output).toEqual({
			mode: "vault-folder",
			folderPath: "Sources",
		});
	});

	it("updates the session immediately on save failure while keeping committed defaults intact", async () => {
		const gate = deferred();
		const saveData = vi.fn(async () => gate.promise);
		const { store } = await storeWith(stored(), saveData);
		const coordinator = makeCoordinator(store);
		const pending = coordinator.updateOutput({ mode: "vault-folder", folderPath: "Sources" });
		expect(coordinator.getSnapshot().configuration.output).toEqual({
			mode: "vault-folder",
			folderPath: "Sources",
		});
		expect(store.getSettings().defaults.output).toEqual({ mode: "current-folders" });
		gate.reject(new Error("offline"));
		const result = await pending;
		expect(result.updated).toBe(true);
		expect(result.savedForFutureSessions).toBe(false);
		expect(result.message).toContain("not saved");
		expect(store.getSettings().defaults.output).toEqual({ mode: "current-folders" });
		expect(coordinator.getSnapshot().configuration.output).toEqual({
			mode: "vault-folder",
			folderPath: "Sources",
		});
	});

	it("requires existing output folders and accepts an explicit root choice", async () => {
		const { store } = await storeWith();
		const coordinator = makeCoordinator(store);
		await expect(
			coordinator.updateOutput({ mode: "vault-folder", folderPath: "Missing" }),
		).resolves.toMatchObject({
			updated: false,
		});
		await expect(
			coordinator.updateOutput({ mode: "vault-folder", folderPath: "" }),
		).resolves.toMatchObject({
			updated: true,
		});
	});

	it("rejects a fabricated eligible result for an owned item when no coordinator plan exists", async () => {
		const { store } = await storeWith();
		const { apply, service } = recordingApplyService();
		const host = vaultFixture();
		host.addFile("Inbox/source.pdf");
		const coordinator = makeCoordinator(store, {
			applyService: service as never,
			vault: host.vault,
		});
		seedTestItem(coordinator);
		const session = coordinator.getSnapshot();
		const fabricated = {
			sessionId: session.id,
			sessionRevision: session.revision,
			results: [
				{
					itemId: "item-1",
					status: "eligible",
					proposedRename: {
						itemId: "item-1",
						sourceObservation: { path: "Inbox/source.pdf", mtime: 100, size: 200 },
						destinationPath: "Elsewhere/arbitrary.pdf",
						proposedName: "arbitrary.pdf",
						effects: { path: true, pdfBytes: false },
					},
					diagnostics: [],
				},
			],
		};
		const callerView = coordinator.getSnapshot();
		callerView.planningSnapshot = fabricated as never;
		const callerItem = callerView.items[0];
		if (!callerItem) throw new Error("Expected the test item");
		callerItem.plan = fabricated.results[0] as never;

		const result = await coordinator.applyReviewedPlan();

		expect(result.status).toBe("rejected");
		expect(apply).not.toHaveBeenCalled();
		expect(coordinator.getSnapshot().planningSnapshot).toBeNull();
		expect(coordinator.getSnapshot().items[0]?.plan).toBeUndefined();
		expect("setPlanningSnapshot" in coordinator).toBe(false);
		expect(coordinator.beginReview().allowed).toBe(true);
	});

	it("derives and stores detached plans from current coordinator state", async () => {
		const { store } = await storeWith();
		const { apply, service } = recordingApplyService();
		const host = vaultFixture();
		host.addFile("Inbox/source.pdf");
		const coordinator = makeCoordinator(store, {
			applyService: service as never,
			vault: host.vault,
		});
		seedTestItem(coordinator);
		const returnedPlan = coordinator.replanCurrentSession();
		const expectedDestination = "Inbox/Lovelace (2024). Example.pdf";

		expect(returnedPlan.results[0]).toMatchObject({
			status: "eligible",
			proposedRename: { destinationPath: expectedDestination },
		});
		const returnedEligible = returnedPlan.results[0];
		if (returnedEligible.status !== "eligible") throw new Error("Expected an eligible plan");
		returnedEligible.proposedRename.destinationPath = "Elsewhere/hostile.pdf";
		returnedEligible.proposedRename.sourceObservation.path = "Elsewhere/replacement.pdf";

		const stored = coordinator.getSnapshot();
		expect(stored.planningSnapshot?.results[0]).toMatchObject({
			status: "eligible",
			proposedRename: {
				destinationPath: expectedDestination,
				sourceObservation: { path: "Inbox/source.pdf" },
			},
		});
		expect(stored.items[0]?.plan).toEqual(stored.planningSnapshot?.results[0]);
		await expect(coordinator.applyReviewedPlan()).resolves.toMatchObject({
			status: "completed",
		});
		expect(apply.mock.calls[0]?.[0].operations[0]?.destinationPath).toBe(expectedDestination);
	});

	it("replans from fresh coordinator-owned collision snapshots after configuration changes", async () => {
		const { store } = await storeWith();
		const host = vaultFixture();
		host.addFile("Inbox/source.pdf");
		const paths = {
			filePaths: ["Inbox/source.pdf"],
			folderPaths: ["", "Inbox", "Sources"],
		};
		const getSnapshot = vi.fn(() => ({
			filePaths: [...paths.filePaths],
			folderPaths: [...paths.folderPaths],
		}));
		const coordinator = makeCoordinator(store, {
			vault: host.vault,
			planningEnvironment: {
				getSnapshot,
				getOutputFolderPaths: () => [...paths.folderPaths],
			},
		});
		seedTestItem(coordinator);
		expect(coordinator.replanCurrentSession().results[0]?.status).toBe("eligible");
		paths.filePaths.push("Inbox/Lovelace (2024). Example.pdf");
		await coordinator.updateOutput({ mode: "vault-folder", folderPath: "Inbox" });
		expect(getSnapshot).toHaveBeenCalledTimes(2);
		expect(coordinator.getSnapshot().planningSnapshot?.results[0]).toMatchObject({
			status: "blocked",
			reason: "destination-conflict",
		});
		paths.filePaths.pop();
		await coordinator.updateOutput({ mode: "current-folders" });
		expect(getSnapshot).toHaveBeenCalledTimes(3);
		expect(coordinator.getSnapshot().planningSnapshot?.results[0]?.status).toBe("eligible");
	});

	it("rejects plans after session, revision, configuration, evidence or source observations change", async () => {
		{
			const { store } = await storeWith();
			const { apply, service } = recordingApplyService();
			const host = vaultFixture();
			host.addFile("Inbox/source.pdf");
			const coordinator = makeCoordinator(store, {
				applyService: service as never,
				vault: host.vault,
			});
			seedTestItem(coordinator);
			coordinator.replanCurrentSession();
			coordinator.createNewSession();
			expect(await coordinator.applyReviewedPlan()).toMatchObject({
				status: "rejected",
			});
			expect(apply).not.toHaveBeenCalled();
		}
		{
			const { store } = await storeWith();
			const { apply, service } = recordingApplyService();
			const host = vaultFixture();
			host.addFile("Inbox/source.pdf");
			const coordinator = makeCoordinator(store, {
				applyService: service as never,
				vault: host.vault,
			});
			seedTestItem(coordinator);
			const stale = coordinator.replanCurrentSession();
			await coordinator.updateOutput({ mode: "vault-folder", folderPath: "Sources" });
			expect(coordinator.getSnapshot().revision).toBe(stale.sessionRevision + 1);
			expect(coordinator.getSnapshot().planningSnapshot?.results[0]).toMatchObject({
				status: "eligible",
				proposedRename: { destinationPath: "Sources/Lovelace (2024). Example.pdf" },
			});
			expect(await coordinator.applyReviewedPlan()).toMatchObject({ status: "completed" });
			expect(apply.mock.calls[0]?.[0].operations[0]?.destinationPath).toBe(
				"Sources/Lovelace (2024). Example.pdf",
			);
		}
		for (const changedField of ["evidence", "source"] as const) {
			const { store } = await storeWith();
			const { apply, service } = recordingApplyService();
			const host = vaultFixture();
			host.addFile("Inbox/source.pdf");
			const coordinator = makeCoordinator(store, {
				applyService: service as never,
				vault: host.vault,
			});
			seedTestItem(coordinator);
			coordinator.replanCurrentSession();
			const testSession = coordinator as unknown as { session: IntakeSession };
			const item = testSession.session.items[0];
			if (!item) throw new Error("Expected the test item");
			if (changedField === "evidence" && item.identification.status === "resolved") {
				item.identification.record.title = "Changed evidence";
			} else if (changedField === "source") {
				item.sourceObservation.mtime++;
			}
			expect(await coordinator.applyReviewedPlan()).toMatchObject({
				status: "rejected",
			});
			expect(apply).not.toHaveBeenCalled();
		}
	});

	it("notifies attached views and preserves the coordinator across unsubscribe/re-subscribe", async () => {
		const { store } = await storeWith();
		const coordinator = makeCoordinator(store);
		const seen: string[] = [];
		const stop = coordinator.subscribe((snapshot) => seen.push(snapshot.setupConcern));
		coordinator.setSetupConcern("output");
		stop();
		coordinator.setSetupConcern("metadata-and-naming");
		expect(seen).toEqual(["pdfs", "output"]);
		const reopened: string[] = [];
		coordinator.subscribe((snapshot) => reopened.push(snapshot.setupConcern));
		expect(reopened).toEqual(["metadata-and-naming"]);
		coordinator.dispose();
	});
});

describe("coordinator-owned PDF membership", () => {
	it("admits current PDFs in chooser order with detached observations and private bindings", async () => {
		const { store, saveData } = await storeWith();
		const host = vaultFixture();
		const second = host.addFile("B/download.PDF", { ctime: 1, mtime: 22, size: 33 });
		const first = host.addFile("A/theory.pdf", { ctime: 1, mtime: 11, size: 12 });
		const coordinator = makeCoordinator(store, { vault: host.vault });
		const sessionId = coordinator.getSnapshot().id;

		const result = coordinator.addPdfs([second.path, first.path], sessionId);
		const snapshot = coordinator.getSnapshot();

		expect(result.addedItemIds).toHaveLength(2);
		expect(snapshot.revision).toBe(1);
		expect(snapshot.items.map((item) => item.sourceObservation)).toEqual([
			{ path: "B/download.PDF", mtime: 22, size: 33 },
			{ path: "A/theory.pdf", mtime: 11, size: 12 },
		]);
		expect(snapshot.items.map((item) => item.identification)).toEqual([
			{ status: "unattempted" },
			{ status: "unattempted" },
		]);
		expect(snapshot.items.map((item) => item.sourceHealth)).toEqual(["current", "current"]);
		expect(Object.values(snapshot.items[0] ?? {})).not.toContain(first);
		expect(snapshot).not.toHaveProperty("sourceBindings");
		snapshot.items[0].sourceObservation.path = "Changed by caller.pdf";
		snapshot.items.pop();
		expect(coordinator.getSnapshot().items.map((item) => item.sourceObservation.path)).toEqual([
			"B/download.PDF",
			"A/theory.pdf",
		]);
		expect(JSON.stringify(coordinator.getSnapshot())).not.toContain('"sourceBindings"');
		expect(makeCoordinator(store, { vault: host.vault }).getSnapshot().items).toEqual([]);
		expect(saveData).not.toHaveBeenCalled();
		expect(store.getDraftNamespace()).toEqual({ opaque: "retained" });
		expect(host.mutations.rename).not.toHaveBeenCalled();
		expect(host.mutations.create).not.toHaveBeenCalled();
		expect(host.mutations.createFolder).not.toHaveBeenCalled();
		expect(host.mutations.modifyBinary).not.toHaveBeenCalled();
		expect(host.mutations.delete).not.toHaveBeenCalled();
	});

	it("deduplicates exact paths and retained bindings but keeps equal basenames at different paths", async () => {
		const { store } = await storeWith();
		const host = vaultFixture();
		const original = host.addFile("A/shared.pdf");
		const originalPath = original.path;
		const other = host.addFile("B/shared.pdf");
		const coordinator = makeCoordinator(store, { vault: host.vault });
		const sessionId = coordinator.getSnapshot().id;

		expect(coordinator.addPdfs([original.path], sessionId).addedItemIds).toHaveLength(1);
		expect(coordinator.classifyPdfPath(original.path, sessionId)).toBe("already-represented");
		expect(coordinator.addPdfs([original.path], sessionId).duplicates).toEqual([original.path]);
		host.moveFile(original, "Renamed/shared.pdf");
		expect(coordinator.classifyPdfPath(originalPath, sessionId)).toBe("unavailable");
		expect(coordinator.classifyPdfPath("Renamed/shared.pdf", sessionId)).toBe(
			"already-represented",
		);
		const renamedDuplicate = coordinator.addPdfs(["Renamed/shared.pdf"], sessionId);
		expect(renamedDuplicate.duplicates).toEqual(["Renamed/shared.pdf"]);
		const distinct = coordinator.addPdfs([other.path], sessionId);
		expect(distinct.addedItemIds).toHaveLength(1);
		expect(coordinator.getSnapshot().items.map((item) => item.sourceObservation.path)).toEqual([
			"A/shared.pdf",
			"B/shared.pdf",
		]);
		expect(coordinator.getSnapshot().revision).toBe(2);
	});

	it("rejects missing, folder, non-PDF, invalid-stat, and non-vault-relative paths without revision changes", async () => {
		const { store } = await storeWith();
		const host = vaultFixture();
		host.addFile("plain.txt");
		host.addFile("broken.pdf", { ctime: 1, mtime: Number.NaN, size: 4 });
		host.addFile("negative.pdf", { ctime: 1, mtime: 1, size: -2 });
		host.addFile("Folder/child.pdf");
		host.addFile("valid.pdf");
		const coordinator = makeCoordinator(store, { vault: host.vault });
		const sessionId = coordinator.getSnapshot().id;

		const result = coordinator.addPdfs(
			[
				"missing.pdf",
				"Folder",
				"plain.txt",
				"broken.pdf",
				"negative.pdf",
				"../valid.pdf",
				"valid.pdf",
			],
			sessionId,
		);
		expect(result.addedItemIds).toHaveLength(1);
		expect(result.rejected.map((entry) => entry.path)).toEqual([
			"missing.pdf",
			"Folder",
			"plain.txt",
			"broken.pdf",
			"negative.pdf",
			"../valid.pdf",
		]);
		expect(coordinator.getSnapshot().revision).toBe(1);
		const rejectedOnly = coordinator.addPdfs(["missing.pdf", "plain.txt"], sessionId);
		expect(rejectedOnly.addedItemIds).toEqual([]);
		expect(coordinator.getSnapshot().revision).toBe(1);
	});

	it("guards stale session actions and increments revision only for real membership changes", async () => {
		const { store } = await storeWith();
		const host = vaultFixture();
		host.addFile("A/one.pdf");
		host.addFile("B/two.pdf");
		const coordinator = makeCoordinator(store, { vault: host.vault });
		const oldSessionId = coordinator.getSnapshot().id;
		const added = coordinator.addPdfs(["A/one.pdf", "B/two.pdf"], oldSessionId);
		const firstId = added.addedItemIds[0];
		coordinator.replanCurrentSession();
		const revision = coordinator.getSnapshot().revision;
		expect(coordinator.removePdf(firstId, "another-session")).toBe(false);
		expect(coordinator.getSnapshot().revision).toBe(revision);
		expect(coordinator.getSnapshot().planningSnapshot).not.toBeNull();
		expect(coordinator.removePdf(firstId, oldSessionId)).toBe(true);
		expect(coordinator.getSnapshot().revision).toBe(revision + 1);
		expect(coordinator.getSnapshot().items.map((item) => item.sourceObservation.path)).toEqual([
			"B/two.pdf",
		]);
		expect(coordinator.getSnapshot().planningSnapshot).toBeNull();
		expect(coordinator.classifyPdfPath("A/one.pdf", oldSessionId)).toBe("selectable");
		expect(coordinator.removePdf(firstId, oldSessionId)).toBe(false);
		expect(coordinator.getSnapshot().revision).toBe(revision + 1);
		const newSession = coordinator.createNewSession();
		expect(coordinator.classifyPdfPath("B/two.pdf", oldSessionId)).toBe("stale-session");
		expect(coordinator.addPdfs(["A/one.pdf"], oldSessionId).staleSession).toBe(true);
		expect(coordinator.removePdf(added.addedItemIds[1], oldSessionId)).toBe(false);
		expect(coordinator.getSnapshot().id).toBe(newSession.id);
		expect(coordinator.getSnapshot().items).toEqual([]);
		expect(coordinator.getSnapshot().revision).toBe(0);
	});

	it("derives missing, renamed, replaced, changed, and unavailable source health", async () => {
		const { store } = await storeWith();
		const host = vaultFixture();
		const file = host.addFile("Sources/item.pdf");
		const coordinator = makeCoordinator(store, { vault: host.vault });
		const sessionId = coordinator.getSnapshot().id;
		const add = coordinator.addPdfs([file.path], sessionId);
		const itemId = add.addedItemIds[0];
		const health = (): string | undefined =>
			coordinator.getSnapshot().items.find((item) => item.id === itemId)?.sourceHealth;
		expect(health()).toBe("current");

		file.stat.mtime++;
		expect(health()).toBe("changed");
		file.stat.mtime--;
		file.stat.size++;
		expect(health()).toBe("changed");
		file.stat.size--;
		const replacement = new TFile(
			"Sources/item.pdf",
			{ ctime: 1, mtime: 100, size: 200 },
			file.parent,
		);
		host.entries.set(replacement.path, replacement);
		expect(health()).toBe("replaced");
		host.entries.delete(replacement.path);
		expect(health()).toBe("missing");
		host.moveFile(file, "Elsewhere/item.pdf");
		expect(health()).toBe("renamed");
		host.entries.delete(file.path);
		expect(health()).toBe("missing");

		const seeded = makeCoordinator(store, { vault: host.vault });
		seedTestItem(seeded);
		expect(seeded.getSnapshot().items[0]?.sourceHealth).toBe("binding-unavailable");
	});

	it("replans once when explicit source refresh discovers a changed binding", async () => {
		const { store } = await storeWith();
		const host = vaultFixture();
		const file = host.addFile("current.pdf");
		const coordinator = makeCoordinator(store, { vault: host.vault });
		const sessionId = coordinator.getSnapshot().id;
		coordinator.addPdfs([file.path], sessionId);
		const revision = coordinator.getSnapshot().revision;
		const observed: string[] = [];
		coordinator.subscribe((snapshot) => {
			const health = snapshot.items[0]?.sourceHealth;
			if (health) observed.push(health);
		});
		file.stat.mtime++;
		expect(coordinator.refreshSourceHealth(sessionId)).toBe(true);
		expect(observed[observed.length - 1]).toBe("changed");
		expect(coordinator.getSnapshot().revision).toBe(revision + 1);
		expect(coordinator.getSnapshot().items[0]?.identification.status).toBe("needs-user");
		expect(coordinator.getSnapshot().planningSnapshot).not.toBeNull();
		const beforeStale = observed.length;
		expect(coordinator.refreshSourceHealth("old-session")).toBe(false);
		expect(observed).toHaveLength(beforeStale);
	});

	it("begins review for populated membership and queues identification automatically", async () => {
		const { store } = await storeWith();
		const host = vaultFixture();
		const file = host.addFile("item.pdf");
		const runner = vi.fn(() =>
			Promise.resolve({
				status: "needs-you" as const,
				reason: "No title match.",
				evidence: { identifiers: [], attempts: [], titleCandidates: [], diagnostics: [] },
			}),
		);
		const coordinator = makeCoordinator(store, {
			vault: host.vault,
			identificationRunner: runner,
		});
		const sessionId = coordinator.getSnapshot().id;
		coordinator.addPdfs([file.path], sessionId);
		const before = coordinator.getSnapshot();
		expect(coordinator.beginReview()).toEqual({ allowed: true });
		expect(coordinator.getSnapshot()).toMatchObject({
			id: before.id,
			phase: "working",
			setupOpen: false,
		});
		await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
		await vi.waitFor(() =>
			expect(coordinator.getSnapshot().items[0]?.identification.status).toBe("needs-user"),
		);
	});

	it("keeps at most two unsettled PDF jobs and starts queued work in membership order", async () => {
		const { store } = await storeWith();
		const host = vaultFixture();
		for (const path of ["A/one.pdf", "B/two.pdf", "C/three.pdf"]) host.addFile(path);
		const work = [
			deferredValue<IdentificationResult>(),
			deferredValue<IdentificationResult>(),
			deferredValue<IdentificationResult>(),
		];
		const started: string[] = [];
		const runner = vi.fn((file: TFile) => {
			started.push(file.path);
			return work[started.length - 1].promise;
		});
		const coordinator = makeCoordinator(store, {
			vault: host.vault,
			identificationRunner: runner,
		});
		const sessionId = coordinator.getSnapshot().id;
		coordinator.addPdfs(["A/one.pdf", "B/two.pdf", "C/three.pdf"], sessionId);

		expect(coordinator.beginReview()).toEqual({ allowed: true });
		expect(started).toEqual(["A/one.pdf", "B/two.pdf"]);
		work[1].resolve(needsYouIdentification("second finished"));
		await vi.waitFor(() => expect(started).toEqual(["A/one.pdf", "B/two.pdf", "C/three.pdf"]));
		work[0].resolve(needsYouIdentification("first finished"));
		work[2].resolve(needsYouIdentification("third finished"));
		await vi.waitFor(() =>
			expect(
				coordinator
					.getSnapshot()
					.items.every((item) => item.identification.status === "needs-user"),
			).toBe(true),
		);
		expect(runner).toHaveBeenCalledTimes(3);
	});

	it("keeps canceled unsettled jobs in scheduler slots until each promise settles", async () => {
		const { store } = await storeWith();
		const host = vaultFixture();
		const files = [
			host.addFile("A/one.pdf"),
			host.addFile("B/two.pdf"),
			host.addFile("C/three.pdf"),
		];
		const work = new Map(
			files.map((file) => [file.path, deferredValue<IdentificationResult>()]),
		);
		const started: string[] = [];
		const runner = vi.fn((file: TFile) => {
			started.push(file.path);
			return work.get(file.path)!.promise;
		});
		const coordinator = makeCoordinator(store, {
			vault: host.vault,
			identificationRunner: runner,
		});
		const sessionId = coordinator.getSnapshot().id;
		const admission = coordinator.addPdfs(
			files.map((file) => file.path),
			sessionId,
		);

		expect(coordinator.beginReview()).toEqual({ allowed: true });
		expect(started).toEqual(["A/one.pdf", "B/two.pdf"]);
		expect(runner).toHaveBeenCalledTimes(2);

		expect(coordinator.returnToSetup(sessionId)).toBe(true);
		expect(coordinator.removePdf(admission.addedItemIds[0], sessionId)).toBe(true);
		expect(coordinator.removePdf(admission.addedItemIds[1], sessionId)).toBe(true);
		expect(coordinator.beginReview()).toEqual({ allowed: true });
		expect(started).toEqual(["A/one.pdf", "B/two.pdf"]);
		expect(runner).toHaveBeenCalledTimes(2);

		work.get("A/one.pdf")?.resolve(needsYouIdentification("Canceled A settled"));
		await vi.waitFor(() => expect(started).toEqual(["A/one.pdf", "B/two.pdf", "C/three.pdf"]));
		expect(runner).toHaveBeenCalledTimes(3);
		expect(coordinator.getSnapshot().items[0]?.identification.status).toBe("identifying");

		work.get("B/two.pdf")?.resolve(needsYouIdentification("Canceled B settled"));
		work.get("C/three.pdf")?.resolve(needsYouIdentification("Current C result"));
		await vi.waitFor(() =>
			expect(coordinator.getSnapshot().items[0]?.identification.status).toBe("needs-user"),
		);
		expect(started).toEqual(["A/one.pdf", "B/two.pdf", "C/three.pdf"]);
	});

	it("discards a deferred identification result after legitimate session replacement", async () => {
		const { store } = await storeWith();
		const host = vaultFixture();
		const file = host.addFile("old-session.pdf");
		const pending = deferredValue<IdentificationResult>();
		const runner = vi.fn(() => pending.promise);
		const coordinator = makeCoordinator(store, {
			vault: host.vault,
			identificationRunner: runner,
		});
		const oldSessionId = coordinator.getSnapshot().id;
		coordinator.addPdfs([file.path], oldSessionId);
		coordinator.beginReview();
		await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
		const newSession = coordinator.createNewSession();
		const newSessionBeforeLateResult = coordinator.getSnapshot();
		expect(newSession.id).not.toBe(oldSessionId);
		expect(newSessionBeforeLateResult.items).toEqual([]);
		expect(newSessionBeforeLateResult.planningSnapshot).toBeNull();

		pending.resolve(acceptedIdentification("Old session result"));
		await Promise.resolve();
		await Promise.resolve();

		expect(coordinator.getSnapshot()).toEqual(newSessionBeforeLateResult);
	});

	it("discards a deferred result after setup-mediated removal without changing survivors", async () => {
		const { store } = await storeWith();
		const host = vaultFixture();
		const removed = host.addFile("removed.pdf");
		const remaining = host.addFile("remaining.pdf");
		const removedResult = deferredValue<IdentificationResult>();
		const remainingResult = deferredValue<IdentificationResult>();
		const runner = vi.fn((file: TFile) =>
			file.path === removed.path ? removedResult.promise : remainingResult.promise,
		);
		const coordinator = makeCoordinator(store, {
			vault: host.vault,
			identificationRunner: runner,
		});
		const sessionId = coordinator.getSnapshot().id;
		const admission = coordinator.addPdfs([removed.path, remaining.path], sessionId);
		coordinator.beginReview();
		await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2));
		expect(coordinator.returnToSetup(sessionId)).toBe(true);
		expect(coordinator.removePdf(admission.addedItemIds[0], sessionId)).toBe(true);
		const survivorSnapshot = coordinator.getSnapshot();
		expect(survivorSnapshot.items.map((item) => item.id)).toEqual([admission.addedItemIds[1]]);

		removedResult.resolve(acceptedIdentification("Removed late result"));
		remainingResult.resolve(acceptedIdentification("Canceled survivor result"));
		await Promise.all([removedResult.promise, remainingResult.promise]);
		await Promise.resolve();
		await Promise.resolve();

		expect(coordinator.getSnapshot()).toEqual(survivorSnapshot);
		expect(coordinator.getSnapshot().items).toHaveLength(1);
		expect(coordinator.getSnapshot().items[0]?.identification.status).toBe("unattempted");
	});

	it("ignores canceled older attempts after setup re-entry while accepting the newer attempt", async () => {
		const { store } = await storeWith();
		const host = vaultFixture();
		const file = host.addFile("current.pdf");
		const first = deferredValue<IdentificationResult>();
		const second = deferredValue<IdentificationResult>();
		const contexts: { shouldCancel: () => boolean }[] = [];
		const runner = vi.fn((_file: TFile, context: { shouldCancel: () => boolean }) => {
			contexts.push(context);
			return contexts.length === 1 ? first.promise : second.promise;
		});
		const coordinator = makeCoordinator(store, {
			vault: host.vault,
			identificationRunner: runner,
		});
		const sessionId = coordinator.getSnapshot().id;
		coordinator.addPdfs([file.path], sessionId);
		coordinator.beginReview();
		expect(coordinator.returnToSetup(sessionId)).toBe(true);
		expect(coordinator.getSnapshot().items[0]?.identification.status).toBe("unattempted");
		expect(contexts[0]?.shouldCancel()).toBe(true);
		coordinator.beginReview();
		await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2));
		first.resolve(acceptedIdentification("Older result"));
		await Promise.resolve();
		expect(coordinator.getSnapshot().items[0]?.identification.status).toBe("identifying");
		second.resolve(acceptedIdentification("Current result"));
		await vi.waitFor(() => {
			const state = coordinator.getSnapshot().items[0]?.identification;
			expect(state?.status).toBe("resolved");
			if (state?.status === "resolved") expect(state.record.title).toBe("Current result");
		});
	});

	it("does not accept a result after the admitted source changes", async () => {
		const { store } = await storeWith();
		const host = vaultFixture();
		const file = host.addFile("current.pdf");
		const pending = deferredValue<IdentificationResult>();
		const coordinator = makeCoordinator(store, {
			vault: host.vault,
			identificationRunner: () => pending.promise,
		});
		const sessionId = coordinator.getSnapshot().id;
		coordinator.addPdfs([file.path], sessionId);
		coordinator.beginReview();
		file.stat.mtime++;
		pending.resolve(acceptedIdentification("Should not be trusted"));
		await vi.waitFor(() =>
			expect(coordinator.getSnapshot().items[0]?.identification.status).toBe("needs-user"),
		);
		expect(coordinator.getSnapshot().items[0]?.sourceHealth).toBe("changed");
		expect(coordinator.getSnapshot().items[0]?.identification).toMatchObject({
			status: "needs-user",
			reason: "The admitted PDF changed since it was added.",
		});
	});

	it("invalidates active identification on coordinator disposal", async () => {
		const { store } = await storeWith();
		const host = vaultFixture();
		const file = host.addFile("current.pdf");
		const pending = deferredValue<IdentificationResult>();
		let context: { shouldCancel: () => boolean } | undefined;
		const runner = vi.fn((_file: TFile, value: { shouldCancel: () => boolean }) => {
			context = value;
			return pending.promise;
		});
		const coordinator = makeCoordinator(store, {
			vault: host.vault,
			identificationRunner: runner,
		});
		const sessionId = coordinator.getSnapshot().id;
		coordinator.addPdfs([file.path], sessionId);
		coordinator.beginReview();
		await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
		coordinator.dispose();
		expect(context?.shouldCancel()).toBe(true);
		pending.resolve(acceptedIdentification("Late after unload"));
		await Promise.resolve();
		await Promise.resolve();
		expect(coordinator.getSnapshot().items[0]?.identification.status).toBe("unattempted");
	});

	it("does not retry completed Needs you outcomes on review re-entry", async () => {
		const { store } = await storeWith();
		const host = vaultFixture();
		const file = host.addFile("current.pdf");
		const runner = vi.fn(() => Promise.resolve(needsYouIdentification()));
		const coordinator = makeCoordinator(store, {
			vault: host.vault,
			identificationRunner: runner,
		});
		const sessionId = coordinator.getSnapshot().id;
		coordinator.addPdfs([file.path], sessionId);
		coordinator.beginReview();
		await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
		await vi.waitFor(() =>
			expect(coordinator.getSnapshot().items[0]?.identification.status).toBe("needs-user"),
		);
		coordinator.returnToSetup(sessionId);
		coordinator.beginReview();
		await Promise.resolve();
		expect(runner).toHaveBeenCalledTimes(1);
		expect(coordinator.getSnapshot().items[0]?.identification.status).toBe("needs-user");
	});

	it("guards all session edits while an Apply invocation is active", async () => {
		const { store } = await storeWith();
		const host = vaultFixture();
		host.addFile("Inbox/source.pdf");
		host.addFile("later.pdf");
		let finish!: (result: ApplyInvocationResult) => void;
		const apply = vi.fn(
			(_invocation: ApplyInvocation) =>
				new Promise<ApplyInvocationResult>((resolve) => (finish = resolve)),
		);
		const coordinator = makeCoordinator(store, {
			vault: host.vault,
			applyService: { apply } as never,
		});
		seedTestItem(coordinator);
		coordinator.replanCurrentSession();
		const applyPending = coordinator.applyReviewedPlan();
		await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
		const invocation = apply.mock.calls[0]?.[0];
		expect(coordinator.getSnapshot().applyState.status).toBe("applying");
		expect(Object.isFrozen(invocation)).toBe(true);
		expect(Object.isFrozen(invocation?.operations)).toBe(true);
		expect(coordinator.removePdf("item-1", coordinator.getSnapshot().id)).toBe(false);
		expect(coordinator.addPdfs(["later.pdf"], coordinator.getSnapshot().id).staleSession).toBe(
			true,
		);
		expect(
			await coordinator.updateOutput({ mode: "vault-folder", folderPath: "Sources" }),
		).toMatchObject({
			updated: false,
		});
		expect(
			await coordinator.updateMetadataAndNaming({ embeddedPdfMetadata: { requested: true } }),
		).toMatchObject({
			updated: false,
		});
		expect(coordinator.createNewSession().id).toBe(invocation?.sessionId);
		expect((await coordinator.applyReviewedPlan()).status).toBe("busy");
		expect(apply.mock.calls[0]?.[0]).toBe(invocation);
		finish({ status: "completed", invocationId: invocation?.invocationId ?? "", outcomes: [] });
		await expect(applyPending).resolves.toMatchObject({ status: "completed" });
		expect(coordinator.getSnapshot().items).toHaveLength(1);
	});

	it("keeps a frozen Ready subset while accepting a guarded identification during Apply", async () => {
		const { store } = await storeWith();
		const host = vaultFixture();
		const source = host.addFile("Inbox/source.pdf");
		const other = host.addFile("Inbox/other.pdf");
		const identify = deferredValue<IdentificationResult>();
		const runner = vi.fn(() => identify.promise);
		let finish!: (result: ApplyInvocationResult) => void;
		const apply = vi.fn(
			(_invocation: ApplyInvocation) =>
				new Promise<ApplyInvocationResult>((resolve) => (finish = resolve)),
		);
		const coordinator = makeCoordinator(store, {
			vault: host.vault,
			identificationRunner: runner,
			applyService: { apply } as never,
		});
		seedTestItem(coordinator);
		const sessionId = coordinator.getSnapshot().id;
		coordinator.addPdfs([other.path], sessionId);
		coordinator.beginReview();
		await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
		const pendingApply = coordinator.applyReviewedPlan();
		await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
		const frozen = apply.mock.calls[0]?.[0];
		expect(frozen?.operations.map((operation) => operation.itemId)).toEqual(["item-1"]);
		expect(coordinator.returnToSetup(sessionId)).toBe(false);
		identify.resolve(acceptedIdentification("Later Ready work"));
		await vi.waitFor(() =>
			expect(coordinator.getSnapshot().items[1]?.identification.status).toBe("resolved"),
		);
		expect(apply.mock.calls[0]?.[0]).toEqual(frozen);
		const operation = frozen?.operations[0];
		if (!operation) throw new Error("Expected one frozen operation");
		host.moveFile(source, operation.destinationPath);
		finish({
			status: "completed",
			invocationId: frozen.invocationId,
			outcomes: [
				{
					itemId: operation.itemId,
					status: "renamed",
					sourcePath: operation.sourcePath,
					destinationPath: operation.destinationPath,
					effects: { path: true, pdfBytes: false },
				},
			],
		});
		await pendingApply;
		const snapshot = coordinator.getSnapshot();
		expect(snapshot.items[0]?.admissionObservation.path).toBe("Inbox/source.pdf");
		expect(snapshot.items[0]?.sourceObservation.path).toBe(operation.destinationPath);
		expect(snapshot.items[0]?.sourceHealth).toBe("current");
		expect(snapshot.items[0]?.plan?.status).toBe("no-change");
		expect(snapshot.items[1]?.plan?.status).toBe("eligible");
	});

	it("marks a renamed outcome Needs you when same-binding verification fails", async () => {
		const { store } = await storeWith();
		const host = vaultFixture();
		host.addFile("Inbox/source.pdf");
		const apply = vi.fn((invocation: ApplyInvocation): Promise<ApplyInvocationResult> =>
			Promise.resolve({
				status: "completed",
				invocationId: invocation.invocationId,
				outcomes: invocation.operations.map((operation) => ({
					itemId: operation.itemId,
					status: "renamed" as const,
					sourcePath: operation.sourcePath,
					destinationPath: operation.destinationPath,
					effects: { path: true as const, pdfBytes: false as const },
				})),
			}),
		);
		const coordinator = makeCoordinator(store, {
			vault: host.vault,
			applyService: { apply } as never,
		});
		seedTestItem(coordinator);
		coordinator.replanCurrentSession();
		await coordinator.applyReviewedPlan();
		const item = coordinator.getSnapshot().items[0];
		expect(item?.identification.status).toBe("needs-user");
		expect(item?.sourceHealth).toBe("unverified");
		expect(item?.sourceObservation.path).toBe("Inbox/source.pdf");
		expect(item?.admissionObservation.path).toBe("Inbox/source.pdf");
		expect(item?.plan?.status).toBe("blocked");
	});

	it("reconciles all successful renames in one revision and replans from their new paths", async () => {
		const { store } = await storeWith();
		const host = vaultFixture();
		const first = host.addFile("Inbox/first.pdf");
		const second = host.addFile("Inbox/second.pdf");
		const apply = vi.fn(
			(
				invocation: ApplyInvocation,
				bindings: ReadonlyMap<string, TFile>,
			): Promise<ApplyInvocationResult> =>
				Promise.resolve().then(() => {
					const outcomes = [];
					for (const operation of invocation.operations) {
						const binding = bindings.get(operation.itemId);
						if (!binding) throw new Error("missing fixture binding");
						host.moveFile(binding, operation.destinationPath);
						outcomes.push({
							itemId: operation.itemId,
							status: "renamed" as const,
							sourcePath: operation.sourcePath,
							destinationPath: operation.destinationPath,
							effects: { path: true as const, pdfBytes: false as const },
						});
					}
					return { status: "completed", invocationId: invocation.invocationId, outcomes };
				}),
		);
		const coordinator = makeCoordinator(store, {
			vault: host.vault,
			applyService: { apply } as never,
		});
		const sessionId = coordinator.getSnapshot().id;
		coordinator.addPdfs([first.path, second.path], sessionId);
		const internal = coordinator as unknown as { session: IntakeSession };
		for (const [index, item] of internal.session.items.entries()) {
			item.identification = {
				status: "resolved",
				record: {
					title: `Work ${index + 1}`,
					authorship: {
						authors: [{ kind: "person", given: "Ada", family: "Lovelace" }],
						completeness: "complete",
						totalCountKnown: true,
					},
					year: 2024,
					isbns: [],
					provenance: { provider: "crossref", route: "doi", identifier: "10.1234/work" },
				},
			};
		}
		const revisionBeforeApply = coordinator.getSnapshot().revision;
		coordinator.replanCurrentSession();
		expect(
			coordinator
				.getSnapshot()
				.planningSnapshot?.results.every((result) => result.status === "eligible"),
		).toBe(true);
		await coordinator.applyReviewedPlan();
		const snapshot = coordinator.getSnapshot();
		expect(snapshot.revision).toBe(revisionBeforeApply + 1);
		expect(snapshot.items.map((item) => item.admissionObservation.path)).toEqual([
			"Inbox/first.pdf",
			"Inbox/second.pdf",
		]);
		expect(snapshot.items.map((item) => item.sourceObservation.path)).toEqual([
			"Inbox/Lovelace (2024). Work 1.pdf",
			"Inbox/Lovelace (2024). Work 2.pdf",
		]);
		expect(snapshot.items.map((item) => item.plan?.status)).toEqual(["no-change", "no-change"]);
		expect(snapshot.planningSnapshot?.sessionRevision).toBe(snapshot.revision);
		expect(apply).toHaveBeenCalledTimes(1);
	});

	it("reconciles mixed Apply outcomes only for the verified renamed binding", async () => {
		const { store } = await storeWith();
		const host = vaultFixture();
		const files = [
			host.addFile("Inbox/first.pdf"),
			host.addFile("Inbox/second.pdf"),
			host.addFile("Inbox/third.pdf"),
		];
		const pending = deferredValue<ApplyInvocationResult>();
		const apply = vi.fn(
			(_invocation: ApplyInvocation, _bindings: ReadonlyMap<string, TFile>) =>
				pending.promise,
		);
		const planningSnapshots: { filePaths: string[]; folderPaths: string[] }[] = [];
		const planningEnvironment = {
			getSnapshot: vi.fn(() => {
				const snapshot = {
					filePaths: host.vault.getFiles().map((file) => file.path),
					folderPaths: [
						"",
						"Inbox",
						"Sources",
						...host.vault.getAllFolders().map((folder) => folder.path),
					],
				};
				planningSnapshots.push(snapshot);
				return snapshot;
			}),
		};
		const coordinator = makeCoordinator(store, {
			vault: host.vault,
			applyService: { apply } as never,
			planningEnvironment,
		});
		const sessionId = coordinator.getSnapshot().id;
		const admission = coordinator.addPdfs(
			files.map((file) => file.path),
			sessionId,
		);
		const internal = coordinator as unknown as { session: IntakeSession };
		for (const [index, item] of internal.session.items.entries()) {
			const identification = acceptedIdentification(`Mixed outcome work ${index + 1}`);
			if (identification.status !== "accepted")
				throw new Error("Expected a canonical fixture for the Apply test");
			item.identification = {
				status: "resolved",
				record: identification.record,
				evidence: identification.evidence,
			};
		}
		const admissionObservations = coordinator
			.getSnapshot()
			.items.map((item) => ({ ...item.admissionObservation }));
		coordinator.replanCurrentSession();
		const beforeApply = coordinator.getSnapshot();
		expect(beforeApply.planningSnapshot?.results.map((result) => result.status)).toEqual([
			"eligible",
			"eligible",
			"eligible",
		]);
		const environmentCallsBeforeApply = planningEnvironment.getSnapshot.mock.calls.length;
		const invalidatePlanning = vi.spyOn(
			coordinator as unknown as { invalidatePlanning: () => void },
			"invalidatePlanning",
		);

		const applyPending = coordinator.applyReviewedPlan();
		await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
		const invocation = apply.mock.calls[0]?.[0];
		if (!invocation) throw new Error("Expected a frozen coordinator Apply invocation");
		expect(invocation.operations).toHaveLength(3);
		const firstOperation = invocation.operations[0];
		const secondOperation = invocation.operations[1];
		const thirdOperation = invocation.operations[2];
		if (!firstOperation || !secondOperation || !thirdOperation)
			throw new Error("Expected three operations in the reviewed Apply invocation");

		host.moveFile(files[0], firstOperation.destinationPath);
		files[1].stat.mtime++;
		files[2].stat.mtime++;
		const mixedResult: ApplyInvocationResult = {
			status: "completed",
			invocationId: invocation.invocationId,
			outcomes: [
				{
					itemId: firstOperation.itemId,
					status: "renamed",
					sourcePath: firstOperation.sourcePath,
					destinationPath: firstOperation.destinationPath,
					effects: { path: true, pdfBytes: false },
				},
				{
					itemId: secondOperation.itemId,
					status: "blocked",
					reason: "source-changed",
					message: "The source changed before Apply.",
				},
				{
					itemId: thirdOperation.itemId,
					status: "failed",
					message: "The rename failed.",
				},
			],
		};
		pending.resolve(mixedResult);
		expect(await applyPending).toEqual(mixedResult);

		const after = coordinator.getSnapshot();
		const itemsById = new Map(after.items.map((item) => [item.id, item]));
		const renamed = itemsById.get(firstOperation.itemId);
		const blocked = itemsById.get(secondOperation.itemId);
		const failed = itemsById.get(thirdOperation.itemId);
		expect(after.revision).toBe(beforeApply.revision + 1);
		expect(after.items.map((item) => item.admissionObservation)).toEqual(admissionObservations);
		expect(renamed).toMatchObject({
			sourceObservation: {
				path: firstOperation.destinationPath,
				mtime: files[0]?.stat.mtime,
				size: files[0]?.stat.size,
			},
			sourceHealth: "current",
			applyOutcome: { status: "renamed" },
		});
		expect(blocked).toMatchObject({
			sourceObservation: { path: secondOperation.sourcePath, mtime: 100, size: 200 },
			sourceHealth: "changed",
			identification: { status: "needs-user" },
			applyOutcome: { status: "blocked", reason: "source-changed" },
		});
		expect(failed).toMatchObject({
			sourceObservation: { path: thirdOperation.sourcePath, mtime: 100, size: 200 },
			sourceHealth: "changed",
			applyOutcome: { status: "failed" },
		});
		expect(after.planningSnapshot?.sessionRevision).toBe(after.revision);
		expect(invalidatePlanning).toHaveBeenCalled();
		expect(
			after.planningSnapshot?.results.find((result) => result.itemId === renamed?.id),
		).toMatchObject({
			status: "no-change",
			currentPath: firstOperation.destinationPath,
		});
		expect(planningEnvironment.getSnapshot.mock.calls.length).toBeGreaterThan(
			environmentCallsBeforeApply + 1,
		);
		expect(planningSnapshots.at(-1)?.filePaths).toContain(firstOperation.destinationPath);
		expect(planningSnapshots.at(-1)?.filePaths).not.toContain(firstOperation.sourcePath);
		expect(admission.addedItemIds).toEqual(
			invocation.operations.map((operation) => operation.itemId),
		);
	});
});
