import { describe, expect, it, vi } from "vitest";
import { TFile, TFolder, type TAbstractFile } from "./obsidian";
import { PluginDataStore, type JsonValue, type PluginDataEnvelope } from "../src/persistence";
import {
	SessionCoordinator,
	createFreshSession,
	type SessionCoordinatorOptions,
	type SessionPdf,
} from "../src/session";
import { createFactoryConfiguration } from "../src/types";
import {
	decodeSessionDraft,
	encodeSessionDraft,
	restoreDraftIdentification,
} from "../src/session-draft";
import type { IdentificationResult } from "../src/resolver";
import type { ApplyInvocation } from "../src/planning";
import type { ApplyInvocationResult } from "../src/apply-changes";
import type { IdentificationState } from "../src/planning";

function host() {
	const root = new TFolder("/");
	const entries = new Map<string, TAbstractFile>([["/", root]]);
	const folders = new Map<string, TFolder>();
	const ensureFolder = (path: string): TFolder => {
		const current = entries.get(path);
		if (current instanceof TFolder) return current;
		const parentPath = path.slice(0, path.lastIndexOf("/"));
		const parent = parentPath ? ensureFolder(parentPath) : root;
		const folder = new TFolder(path, parent);
		parent.children.push(folder);
		entries.set(path, folder);
		folders.set(path, folder);
		return folder;
	};
	const addFile = (path: string, stat = { ctime: 1, mtime: 100, size: 200 }): TFile => {
		const parentPath = path.slice(0, path.lastIndexOf("/"));
		const parent = parentPath ? ensureFolder(parentPath) : root;
		const file = new TFile(path, stat, parent);
		parent.children.push(file);
		entries.set(path, file);
		return file;
	};
	const moveFile = (file: TFile, nextPath: string): void => {
		file.parent?.children.splice(file.parent.children.indexOf(file), 1);
		entries.delete(file.path);
		const parentPath = nextPath.slice(0, nextPath.lastIndexOf("/"));
		const parent = parentPath ? ensureFolder(parentPath) : root;
		Object.defineProperty(file, "path", { value: nextPath, configurable: true });
		Object.defineProperty(file, "name", {
			value: nextPath.split("/").pop() ?? "",
			configurable: true,
		});
		file.parent = parent;
		parent.children.push(file);
		entries.set(nextPath, file);
	};
	const getAbstractFileByPath = vi.fn((path: string) => entries.get(path) ?? null);
	const vault = {
		getRoot: () => root,
		getAbstractFileByPath,
		getFiles: vi.fn(() =>
			[...entries.values()].filter((entry): entry is TFile => entry instanceof TFile),
		),
		getAllFolders: vi.fn(() => [...folders.values()]),
		getAllLoadedFiles: vi.fn(() => [...entries.values()]),
		readBinary: vi.fn(),
		rename: vi.fn(),
		create: vi.fn(),
		createFolder: vi.fn(),
		modify: vi.fn(),
		modifyBinary: vi.fn(),
		delete: vi.fn(),
		trash: vi.fn(),
	};
	return {
		vault: vault as unknown as SessionCoordinatorOptions["vault"],
		entries,
		addFile,
		moveFile,
		getAbstractFileByPath,
		rawVault: vault,
	};
}

function envelope(draft: JsonValue = null): PluginDataEnvelope {
	return {
		schemaVersion: 1,
		settings: {
			workspaceEditPolicy: "future-sessions",
			defaults: createFactoryConfiguration(),
		},
		unfinishedSessionDraft: draft,
	};
}

async function storeFor(raw: unknown = envelope()) {
	const saveData = vi.fn(() => Promise.resolve(undefined));
	const store = new PluginDataStore({ loadData: () => Promise.resolve(raw), saveData });
	await store.load(["Sources"]);
	return { store, saveData };
}

function accepted(title = "Recovered title"): IdentificationResult {
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
			provenance: { provider: "crossref", route: "doi", identifier: "10.1234/recovered" },
		},
		evidence: { identifiers: [], attempts: [], titleCandidates: [title], diagnostics: [] },
	};
}

function resolvedState(): IdentificationState {
	const result = accepted();
	if (result.status !== "accepted") throw new Error("Fixture must resolve");
	return { status: "resolved", record: result.record, evidence: result.evidence };
}

function savedSession(
	paths: string[],
	status: SessionPdf["identification"] = resolvedState(),
): ReturnType<typeof encodeSessionDraft> {
	const session = createFreshSession(createFactoryConfiguration(), "old-runtime-id");
	session.phase = "working";
	session.setupOpen = false;
	session.configuration.output = { mode: "vault-folder", folderPath: "Saved destination" };
	session.items = paths.map((path, index) => ({
		id: `saved-item-${index + 1}`,
		admissionObservation: { path: `Original/${index + 1}.pdf`, mtime: 90, size: 100 },
		sourceObservation: { path, mtime: 100, size: 200 },
		identification: structuredClone(status),
	}));
	return encodeSessionDraft(session, "stable-draft-id", "2026-10-11T08:00:00.000Z");
}

function coordinator(
	store: PluginDataStore,
	vault: SessionCoordinatorOptions["vault"],
	options: Partial<SessionCoordinatorOptions> = {},
): SessionCoordinator {
	if (!vault) throw new Error("Fixture vault is required");
	return new SessionCoordinator(store, {
		vault,
		planningEnvironment: {
			getSnapshot: () => ({
				filePaths: vault.getFiles().map((file) => file.path),
				folderPaths: ["", "Sources", "Saved destination"],
			}),
		},
		...options,
	});
}

async function tick(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

describe("draft-backed session lifecycle", () => {
	it("does not materialize before first successful admission, then immediately backs the session", async () => {
		const fixture = host();
		const { store } = await storeFor();
		const instance = coordinator(store, fixture.vault);
		const initialId = instance.getSnapshot().id;
		await instance.updateOutput({ mode: "vault-folder", folderPath: "Sources" });
		expect(instance.getSnapshot().draftBacked).toBe(false);
		expect(store.getDraftNamespace()).toBeNull();
		const source = fixture.addFile("Sources/one.pdf");
		const failed = instance.addPdfs(["missing.pdf"], initialId);
		expect(failed.addedItemIds).toEqual([]);
		expect(store.getDraftNamespace()).toBeNull();
		const admitted = instance.addPdfs([source.path], initialId);
		expect(instance.getSnapshot().draftBacked).toBe(true);
		await tick();
		expect(store.getDraftNamespace()).toMatchObject({
			draftVersion: 1,
			configuration: { output: { mode: "vault-folder", folderPath: "Sources" } },
			items: [{ id: admitted.addedItemIds[0], sourceObservation: { path: source.path } }],
		});
		const duplicate = instance.addPdfs([source.path], initialId);
		expect(duplicate.addedItemIds).toEqual([]);
		expect(duplicate.duplicates).toEqual([source.path]);
		instance.removePdf(admitted.addedItemIds[0], initialId);
		await tick();
		expect(store.getDraftNamespace()).toMatchObject({ draftVersion: 1, items: [] });
	});

	it("keeps draft-backed state after initial persistence failure and retries on a later stable change", async () => {
		const fixture = host();
		let shouldFail = true;
		const saveData = vi.fn(() =>
			shouldFail
				? Promise.reject(new Error("private storage detail"))
				: Promise.resolve(undefined),
		);
		const store = new PluginDataStore({
			loadData: () => Promise.resolve(envelope()),
			saveData,
		});
		await store.load([]);
		const instance = coordinator(store, fixture.vault);
		const source = fixture.addFile("Sources/one.pdf");
		const sessionId = instance.getSnapshot().id;
		const admitted = instance.addPdfs([source.path], sessionId);
		expect(instance.getSnapshot().draftBacked).toBe(true);
		await tick();
		expect(instance.getSnapshot().persistenceWarning).toBe(true);
		expect(store.getDraftNamespace()).toBeNull();
		shouldFail = false;
		instance.removePdf(admitted.addedItemIds[0], sessionId);
		await tick();
		expect(instance.getSnapshot().persistenceWarning).toBe(false);
		expect(store.getDraftNamespace()).toMatchObject({ draftVersion: 1, items: [] });
		expect(JSON.stringify(instance.getSnapshot())).not.toContain("private storage detail");
	});

	it("drops the latest pending snapshot and orders terminal clear after the dispatched write", async () => {
		const fixture = host();
		const firstWrite = deferred<void>();
		const saveData = vi
			.fn()
			.mockImplementationOnce(() => firstWrite.promise)
			.mockImplementation(() => Promise.resolve(undefined));
		const store = new PluginDataStore({
			loadData: () => Promise.resolve(envelope()),
			saveData,
		});
		await store.load([]);
		const instance = coordinator(store, fixture.vault);
		const source = fixture.addFile("Sources/one.pdf");
		const sessionId = instance.getSnapshot().id;
		const admission = instance.addPdfs([source.path], sessionId);
		await tick();
		expect(saveData).toHaveBeenCalledTimes(1);
		instance.removePdf(admission.addedItemIds[0], sessionId);
		const start = instance.startNewSession(true);
		expect(saveData).toHaveBeenCalledTimes(1);
		firstWrite.resolve();
		expect(await start).toBe(true);
		await tick();
		expect(saveData).toHaveBeenCalledTimes(2);
		expect(saveData.mock.calls[1]?.[0]).toMatchObject({ unfinishedSessionDraft: null });
		expect(store.getDraftNamespace()).toBeNull();
		expect(instance.getSnapshot()).toMatchObject({ draftBacked: false, items: [] });
	});

	it("drains one in-flight write followed by only the latest pending membership snapshot", async () => {
		const fixture = host();
		const firstWrite = deferred<void>();
		const saveData = vi
			.fn()
			.mockImplementationOnce(() => firstWrite.promise)
			.mockImplementation(() => Promise.resolve(undefined));
		const store = new PluginDataStore({
			loadData: () => Promise.resolve(envelope()),
			saveData,
		});
		await store.load([]);
		const instance = coordinator(store, fixture.vault);
		const first = fixture.addFile("Sources/first.pdf");
		const second = fixture.addFile("Sources/second.pdf");
		const third = fixture.addFile("Sources/third.pdf");
		const sessionId = instance.getSnapshot().id;
		instance.addPdfs([first.path], sessionId);
		await tick();
		instance.addPdfs([second.path], sessionId);
		instance.addPdfs([third.path], sessionId);
		expect(saveData).toHaveBeenCalledTimes(1);
		firstWrite.resolve();
		await tick();
		expect(saveData).toHaveBeenCalledTimes(2);
		expect(saveData.mock.calls[0]?.[0]).toMatchObject({
			unfinishedSessionDraft: { items: [{ sourceObservation: { path: first.path } }] },
		});
		expect(saveData.mock.calls[1]?.[0]).toMatchObject({
			unfinishedSessionDraft: {
				items: [
					{ sourceObservation: { path: first.path } },
					{ sourceObservation: { path: second.path } },
					{ sourceObservation: { path: third.path } },
				],
			},
		});
		expect(store.getDraftNamespace()).toMatchObject({
			items: [
				{ sourceObservation: { path: first.path } },
				{ sourceObservation: { path: second.path } },
				{ sourceObservation: { path: third.path } },
			],
		});
		const recovered = decodeSessionDraft(store.getDraftNamespace());
		expect(recovered.status).toBe("supported");
		if (recovered.status === "supported")
			expect(recovered.draft.items.map((item) => item.sourceObservation.path)).toEqual([
				first.path,
				second.path,
				third.path,
			]);
	});

	it("rejects an old identification callback after terminal clear without restoring its draft", async () => {
		const fixture = host();
		const pendingIdentification = deferred<IdentificationResult>();
		const runner = vi.fn(() => pendingIdentification.promise);
		const { store, saveData } = await storeFor();
		const instance = coordinator(store, fixture.vault, { identificationRunner: runner });
		const source = fixture.addFile("Sources/late-callback.pdf");
		const oldSessionId = instance.getSnapshot().id;
		const admission = instance.addPdfs([source.path], oldSessionId);
		expect(admission.addedItemIds).toHaveLength(1);
		expect(instance.beginReview()).toMatchObject({ allowed: true });
		await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
		await vi.waitFor(() =>
			expect(store.getDraftNamespace()).toMatchObject({
				draftVersion: 1,
				phase: "working",
			}),
		);

		expect(await instance.startNewSession(true)).toBe(true);
		const newSessionId = instance.getSnapshot().id;
		expect(newSessionId).not.toBe(oldSessionId);
		expect(instance.getSnapshot()).toMatchObject({ draftBacked: false, items: [] });
		expect(store.getDraftNamespace()).toBeNull();
		const writesAfterClear = saveData.mock.calls.length;

		pendingIdentification.resolve(accepted("Late old-session result"));
		await tick();
		expect(instance.getSnapshot()).toMatchObject({ id: newSessionId, items: [] });
		expect(store.getDraftNamespace()).toBeNull();
		expect(saveData).toHaveBeenCalledTimes(writesAfterClear);
	});

	it("retains the session and recovery authority when terminal clear fails", async () => {
		const fixture = host();
		let calls = 0;
		const saveData = vi.fn(() =>
			++calls === 1
				? Promise.resolve(undefined)
				: Promise.reject(new Error("storage failure")),
		);
		const store = new PluginDataStore({
			loadData: () => Promise.resolve(envelope()),
			saveData,
		});
		await store.load([]);
		const instance = coordinator(store, fixture.vault);
		const source = fixture.addFile("Sources/one.pdf");
		const sessionId = instance.getSnapshot().id;
		instance.addPdfs([source.path], sessionId);
		await tick();
		expect(store.getDraftNamespace()).not.toBeNull();
		expect(await instance.startNewSession(true)).toBe(false);
		expect(instance.getSnapshot()).toMatchObject({
			id: sessionId,
			draftBacked: true,
			persistenceWarning: true,
			items: [{ sourceObservation: { path: source.path } }],
		});
	});

	it("waits for the pre-Apply draft checkpoint before dispatch and proceeds with a warning if it fails", async () => {
		for (const checkpointFails of [false, true]) {
			const fixture = host();
			const saveData = vi.fn(() => Promise.resolve(undefined));
			const store = new PluginDataStore({
				loadData: () => Promise.resolve(envelope()),
				saveData,
			});
			await store.load([]);
			const source = fixture.addFile("Sources/apply.pdf");
			const apply = vi.fn((invocation: { invocationId: string }) =>
				Promise.resolve({
					status: "completed" as const,
					invocationId: invocation.invocationId,
					outcomes: [],
				}),
			);
			const instance = coordinator(store, fixture.vault, {
				identificationRunner: () => Promise.resolve(accepted()),
				applyService: { apply } as never,
			});
			const sessionId = instance.getSnapshot().id;
			instance.addPdfs([source.path], sessionId);
			instance.beginReview();
			await vi.waitFor(() =>
				expect(instance.getSnapshot().items[0]?.currentStatus).toBe("ready"),
			);
			await vi.waitFor(() =>
				expect(store.getDraftNamespace()).toMatchObject({
					draftVersion: 1,
					phase: "working",
					items: [{ sourceObservation: { path: source.path } }],
				}),
			);
			await tick();
			const callsBeforeCheckpoint = saveData.mock.calls.length;
			const checkpoint = deferred<void>();
			if (checkpointFails)
				saveData.mockImplementationOnce(() =>
					Promise.reject(new Error("private checkpoint failure")),
				);
			else saveData.mockImplementationOnce(() => checkpoint.promise.then(() => undefined));
			const observedWarnings: boolean[] = [];
			instance.subscribe((snapshot) => observedWarnings.push(snapshot.persistenceWarning));
			const applyResult = instance.applyReviewedPlan();
			if (!checkpointFails) {
				await vi.waitFor(() =>
					expect(saveData).toHaveBeenCalledTimes(callsBeforeCheckpoint + 1),
				);
				expect(apply).not.toHaveBeenCalled();
				checkpoint.resolve();
			}
			await expect(applyResult).resolves.toMatchObject({ status: "completed" });
			expect(apply).toHaveBeenCalledTimes(1);
			if (checkpointFails) expect(observedWarnings).toContain(true);
			expect(fixture.rawVault.rename).not.toHaveBeenCalled();
		}
	});
});

describe("recovery decision and exact-source resume", () => {
	it("keeps Resume atomic when strict planning-environment acquisition fails, then retries", async () => {
		const fixture = host();
		fixture.addFile("Sources/recovered.pdf");
		const draft = savedSession(["Sources/recovered.pdf"]);
		const { store, saveData } = await storeFor(envelope(draft as unknown as JsonValue));
		let environmentAvailable = false;
		const planningEnvironment = {
			getSnapshot: vi.fn(() => {
				if (!environmentAvailable) throw new Error("private vault detail");
				return {
					filePaths: fixture.vault!.getFiles().map((file) => file.path),
					folderPaths: ["", "Sources", "Saved destination"],
				};
			}),
		};
		const instance = coordinator(store, fixture.vault, {
			initialDraft: draft as unknown as JsonValue,
			planningEnvironment,
		});
		const before = instance.getSnapshot();
		const savedDraft = store.getDraftNamespace();
		const sourceBindings = (instance as unknown as { sourceBindings: Map<string, TFile> })
			.sourceBindings;
		expect(sourceBindings.size).toBe(0);
		const failed = instance.resumeUnfinishedSession();
		expect(failed).toEqual({
			resumed: false,
			message:
				"The saved session could not be resumed because current vault planning is unavailable.",
		});
		expect(instance.getSnapshot()).toMatchObject({
			id: before.id,
			items: [],
			planningSnapshot: null,
			recoveryGate: "supported",
			draftBacked: false,
		});
		expect(sourceBindings.size).toBe(0);
		expect(instance.openInspector("saved-item-1", before.id)).toBe(false);
		expect(instance.beginReview()).toMatchObject({ allowed: false });
		expect(instance.addPdfs(["Sources/recovered.pdf"], before.id).staleSession).toBe(true);
		expect(store.getDraftNamespace()).toEqual(savedDraft);
		expect(saveData).not.toHaveBeenCalled();

		environmentAvailable = true;
		expect(instance.resumeUnfinishedSession()).toEqual({ resumed: true });
		expect(instance.getSnapshot()).toMatchObject({
			items: [{ id: "saved-item-1", sourceHealth: "current" }],
			recoveryGate: "none",
		});
		expect(sourceBindings.get("saved-item-1")).toBe(
			fixture.entries.get("Sources/recovered.pdf"),
		);
		expect(instance.getSnapshot().id).not.toBe(before.id);
		expect(instance.getSnapshot().planningSnapshot).not.toBeNull();
	});

	it("gates ordinary mutation and resumes with a fresh runtime identity and saved configuration", async () => {
		const fixture = host();
		fixture.addFile("Sources/recovered.pdf");
		const draft = savedSession(["Sources/recovered.pdf"]);
		const { store } = await storeFor(envelope(draft as unknown as JsonValue));
		const instance = coordinator(store, fixture.vault, {
			initialDraft: draft as unknown as JsonValue,
		});
		const placeholderId = instance.getSnapshot().id;
		expect(instance.getSnapshot().recoveryGate).toBe("supported");
		expect(instance.addPdfs(["Sources/recovered.pdf"], placeholderId).staleSession).toBe(true);
		expect(instance.beginReview()).toMatchObject({
			allowed: false,
			reason: "Decide how to handle the saved session before starting new work.",
		});
		expect((await instance.updateOutput({ mode: "current-folders" })).updated).toBe(false);
		expect(instance.createNewSession().id).toBe(placeholderId);
		expect(await instance.finishSession(true)).toBe(false);
		const result = instance.resumeUnfinishedSession();
		expect(result.resumed).toBe(true);
		const snapshot = instance.getSnapshot();
		expect(snapshot.id).not.toBe("old-runtime-id");
		expect(snapshot.id).not.toBe(placeholderId);
		expect(snapshot).toMatchObject({
			recoveryGate: "none",
			draftBacked: true,
			phase: "working",
			setupOpen: false,
		});
		expect(snapshot.configuration.output).toEqual({
			mode: "vault-folder",
			folderPath: "Saved destination",
		});
		expect(snapshot.items[0]).toMatchObject({
			admissionObservation: { path: "Original/1.pdf" },
			sourceHealth: "current",
		});
		expect(snapshot.planningSnapshot).not.toBeNull();
		expect(store.getSettings().defaults.output).toEqual(createFactoryConfiguration().output);
	});

	it("leaves missing, changed-stat, folder, and non-PDF sources stale without following or scanning", async () => {
		for (const kind of [
			"missing",
			"changed-mtime",
			"changed-size",
			"invalid-stat",
			"folder",
			"non-pdf",
		] as const) {
			const fixture = host();
			if (kind === "changed-mtime")
				fixture.addFile("Sources/recovered.pdf", { ctime: 99, mtime: 101, size: 200 });
			if (kind === "changed-size")
				fixture.addFile("Sources/recovered.pdf", { ctime: 99, mtime: 100, size: 201 });
			if (kind === "invalid-stat")
				fixture.addFile("Sources/recovered.pdf", {
					ctime: 99,
					mtime: Number.NaN,
					size: 200,
				});
			if (kind === "folder")
				fixture.entries.set("Sources/recovered.pdf", new TFolder("Sources/recovered.pdf"));
			if (kind === "non-pdf")
				fixture.addFile("Sources/recovered.pdf", { ctime: 1, mtime: 100, size: 200 });
			if (kind === "non-pdf") {
				fixture.entries.delete("Sources/recovered.pdf");
				fixture.addFile("Sources/recovered.txt");
			}
			const draft = savedSession(["Sources/recovered.pdf"]);
			const { store } = await storeFor(envelope(draft as unknown as JsonValue));
			const instance = coordinator(store, fixture.vault, {
				initialDraft: draft as unknown as JsonValue,
			});
			expect(instance.resumeUnfinishedSession()).toEqual({ resumed: true });
			const item = instance.getSnapshot().items[0];
			expect(item.sourceHealth).not.toBe("current");
			expect(item.currentStatus).toBe("needs-you");
			expect(item.plan?.status).toBe("blocked");
			expect(instance.retryIdentification(item.id, instance.getSnapshot().id).started).toBe(
				false,
			);
			expect(
				fixture.getAbstractFileByPath.mock.calls.every(
					([path]) => path === "Sources/recovered.pdf",
				),
			).toBe(true);
			expect(fixture.rawVault.getAllLoadedFiles).not.toHaveBeenCalled();
		}
	});

	it("restores only interrupted work as unattempted and retains completed failures without retry", async () => {
		const fixture = host();
		fixture.addFile("Sources/interrupted.pdf");
		fixture.addFile("Sources/finished.pdf");
		const interruptedDraft = savedSession(["Sources/interrupted.pdf", "Sources/finished.pdf"]);
		interruptedDraft.items[1].identification = {
			status: "needs-user",
			reason: "Completed ambiguity.",
			evidence: { identifiers: [], attempts: [], titleCandidates: [], diagnostics: [] },
		};
		const draft = encodeSessionDraft(
			(() => {
				const session = createFreshSession(interruptedDraft.configuration, "prior");
				session.phase = "working";
				session.setupOpen = false;
				session.items = interruptedDraft.items.map((item) => ({
					...item,
					admissionObservation: { ...item.admissionObservation },
					sourceObservation: { ...item.sourceObservation },
					identification: restoreDraftIdentification(item.identification),
				}));
				session.items[0].identification = { status: "identifying" };
				return session;
			})(),
			"interrupted-draft",
		);
		const { store } = await storeFor(envelope(draft as unknown as JsonValue));
		const runner = vi.fn(() => Promise.resolve(accepted("Recovered after interruption")));
		const instance = coordinator(store, fixture.vault, {
			initialDraft: draft as unknown as JsonValue,
			identificationRunner: runner,
		});
		instance.resumeUnfinishedSession();
		await tick();
		expect(runner).toHaveBeenCalledTimes(1);
		expect(instance.getSnapshot().items[1]?.identification).toMatchObject({
			status: "needs-user",
			reason: "Completed ambiguity.",
		});
		expect(instance.getSnapshot().items[0]?.identification.status).toBe("resolved");
	});

	it("treats restored no-change as current planning and returns to Ready after a saved edit", async () => {
		const fixture = host();
		const sourcePath = "Sources/Lovelace (2024). Recovered title.pdf";
		fixture.addFile(sourcePath);
		const session = createFreshSession(createFactoryConfiguration(), "previous-runtime");
		session.phase = "working";
		session.setupOpen = false;
		session.items.push({
			id: "no-change-item",
			admissionObservation: { path: sourcePath, mtime: 100, size: 200 },
			sourceObservation: { path: sourcePath, mtime: 100, size: 200 },
			identification: resolvedState(),
		});
		const draft = encodeSessionDraft(session, "no-change-draft");
		const { store } = await storeFor(envelope(draft as unknown as JsonValue));
		const instance = coordinator(store, fixture.vault, {
			initialDraft: draft as unknown as JsonValue,
		});
		instance.resumeUnfinishedSession();
		const runtimeId = instance.getSnapshot().id;
		expect(instance.getSnapshot().items[0]?.currentStatus).toBe("no-change");
		instance.openInspector("no-change-item", runtimeId);
		instance.saveManualRecord(
			"no-change-item",
			{
				title: "User correction",
				authorship: {
					authors: [{ kind: "person", given: "Ada", family: "Lovelace" }],
					completeness: "complete",
					totalCountKnown: true,
				},
				year: 2024,
				isbns: [],
			},
			runtimeId,
		);
		expect(instance.getSnapshot().items[0]).toMatchObject({
			currentStatus: "ready",
			effectiveRecord: { title: "User correction" },
		});
	});

	it("requires explicit confirmed discard for malformed and future drafts", async () => {
		const unsupportedDrafts: JsonValue[] = [
			{ draftVersion: 1, nope: true },
			{ draftVersion: 9, keep: "raw" },
		];
		for (const unsupported of unsupportedDrafts) {
			const fixture = host();
			const raw = envelope(unsupported);
			const { store } = await storeFor(raw);
			const instance = coordinator(store, fixture.vault, { initialDraft: unsupported });
			const sessionId = instance.getSnapshot().id;
			expect(instance.getSnapshot().recoveryGate).toBe("unavailable");
			expect(instance.beginReview()).toMatchObject({
				allowed: false,
				reason: "Decide how to handle the saved session before starting new work.",
			});
			expect(instance.addPdfs(["not-a-file.pdf"], sessionId).staleSession).toBe(true);
			expect(store.getDraftNamespace()).toEqual(unsupported);
			expect(await instance.startNewSession(true)).toBe(true);
			expect(store.getDraftNamespace()).toBeNull();
			expect(instance.getSnapshot().recoveryGate).toBe("none");
		}
	});
});

describe("draft finish eligibility", () => {
	function draftFor(path: string, identification: SessionPdf["identification"]) {
		const session = createFreshSession(createFactoryConfiguration(), "old-runtime");
		session.phase = "working";
		session.setupOpen = false;
		session.configuration.output = { mode: "current-folders" };
		session.items.push({
			id: "finish-item",
			admissionObservation: { path, mtime: 100, size: 200 },
			sourceObservation: { path, mtime: 100, size: 200 },
			identification,
		});
		return encodeSessionDraft(session, "finish-draft");
	}

	it("blocks Finish for Ready and clears only after no-change or left-unresolved is terminal", async () => {
		const readyHost = host();
		readyHost.addFile("Sources/not-ready.pdf");
		const readyDraft = draftFor("Sources/not-ready.pdf", resolvedState());
		const readyStore = await storeFor(envelope(readyDraft as unknown as JsonValue));
		const ready = coordinator(readyStore.store, readyHost.vault, {
			initialDraft: readyDraft as unknown as JsonValue,
		});
		ready.resumeUnfinishedSession();
		expect(ready.getSnapshot().items[0]?.currentStatus).toBe("ready");
		expect(await ready.finishSession()).toBe(false);
		expect(readyStore.store.getDraftNamespace()).not.toBeNull();

		for (const terminal of ["no-change", "left-unresolved"] as const) {
			const fixture = host();
			const path =
				terminal === "no-change"
					? "Sources/Lovelace (2024). Recovered title.pdf"
					: "Sources/unresolved.pdf";
			fixture.addFile(path);
			const identification =
				terminal === "no-change"
					? resolvedState()
					: ({
							status: "needs-user" as const,
							reason: "No automatic result.",
							evidence: {
								identifiers: [],
								attempts: [],
								titleCandidates: [],
								diagnostics: [],
							},
						} satisfies SessionPdf["identification"]);
			const draft = draftFor(path, identification);
			const state = await storeFor(envelope(draft as unknown as JsonValue));
			const instance = coordinator(state.store, fixture.vault, {
				initialDraft: draft as unknown as JsonValue,
			});
			instance.resumeUnfinishedSession();
			if (terminal === "left-unresolved") {
				expect(instance.leaveUnresolved("finish-item", instance.getSnapshot().id)).toBe(
					true,
				);
				expect(instance.getSnapshot().items[0]?.currentStatus).toBe("left-unresolved");
			} else {
				expect(instance.getSnapshot().items[0]?.currentStatus).toBe("no-change");
			}
			expect(await instance.finishSession()).toBe(true);
			expect(state.store.getDraftNamespace()).toBeNull();
			expect(instance.getSnapshot()).toMatchObject({ draftBacked: false, items: [] });
		}
	});

	it("allows a verified Applied item to finish and requires confirmation for an empty draft", async () => {
		const fixture = host();
		const sourcePath = "Sources/old-name.pdf";
		fixture.addFile(sourcePath);
		const draft = draftFor(sourcePath, resolvedState());
		const state = await storeFor(envelope(draft as unknown as JsonValue));
		const apply = vi.fn((invocation: ApplyInvocation): Promise<ApplyInvocationResult> => {
			const outcomes = invocation.operations.map((operation) => {
				const binding = fixture.entries.get(operation.sourcePath);
				if (!(binding instanceof TFile)) throw new Error("Expected the bound PDF.");
				fixture.moveFile(binding, operation.destinationPath);
				return {
					itemId: operation.itemId,
					status: "renamed" as const,
					sourcePath: operation.sourcePath,
					destinationPath: operation.destinationPath,
					effects: { path: true as const, pdfBytes: false as const },
				};
			});
			return Promise.resolve({
				status: "completed",
				invocationId: invocation.invocationId,
				outcomes,
			});
		});
		const instance = coordinator(state.store, fixture.vault, {
			initialDraft: draft as unknown as JsonValue,
			applyService: { apply } as never,
		});
		instance.resumeUnfinishedSession();
		expect(await instance.applyReviewedPlan()).toMatchObject({ status: "completed" });
		expect(instance.getSnapshot().items[0]?.currentStatus).toBe("applied");
		const destinationPath = apply.mock.calls[0]?.[0].operations[0]?.destinationPath;
		if (!destinationPath) throw new Error("Expected a reviewed Apply destination.");
		await vi.waitFor(() =>
			expect(state.store.getDraftNamespace()).toMatchObject({
				items: [{ sourceObservation: { path: destinationPath } }],
			}),
		);
		instance.dispose();
		const recovered = coordinator(state.store, fixture.vault, {
			initialDraft: state.store.getDraftNamespace(),
		});
		recovered.resumeUnfinishedSession();
		expect(recovered.getSnapshot().items[0]).toMatchObject({
			admissionObservation: { path: sourcePath },
			sourceObservation: { path: destinationPath },
			sourceHealth: "current",
			currentStatus: "no-change",
		});
		expect(await recovered.finishSession()).toBe(true);
		expect(state.store.getDraftNamespace()).toBeNull();

		const emptySession = createFreshSession(createFactoryConfiguration(), "empty-runtime");
		const emptyDraft = encodeSessionDraft(emptySession, "empty-draft");
		const emptyStore = await storeFor(envelope(emptyDraft as unknown as JsonValue));
		const empty = coordinator(emptyStore.store, host().vault, {
			initialDraft: emptyDraft as unknown as JsonValue,
		});
		empty.resumeUnfinishedSession();
		expect(await empty.finishSession()).toBe(false);
		expect(await empty.finishSession(true)).toBe(true);
		expect(emptyStore.store.getDraftNamespace()).toBeNull();
	});

	it.each(["no-change", "needs-you"] as const)(
		"does not make an unrelated old Apply outcome current after an edit to %s",
		async (editedStatus) => {
			const fixture = host();
			fixture.addFile("Sources/a.pdf");
			fixture.addFile("Sources/b.pdf");
			const draft = savedSession(["Sources/a.pdf", "Sources/b.pdf"]);
			draft.configuration.output = { mode: "current-folders" };
			draft.items[1].identification = {
				status: "needs-user",
				reason: "The second item needs identification.",
				evidence: { identifiers: [], attempts: [], titleCandidates: [], diagnostics: [] },
			};
			const state = await storeFor(envelope(draft as unknown as JsonValue));
			const runner = vi.fn(() => Promise.resolve(accepted("Second recovered title")));
			const apply = vi.fn((invocation: ApplyInvocation): Promise<ApplyInvocationResult> => {
				const outcomes = invocation.operations.map((operation) => {
					const binding = fixture.entries.get(operation.sourcePath);
					if (!(binding instanceof TFile)) throw new Error("Expected the bound PDF.");
					fixture.moveFile(binding, operation.destinationPath);
					return {
						itemId: operation.itemId,
						status: "renamed" as const,
						sourcePath: operation.sourcePath,
						destinationPath: operation.destinationPath,
						effects: { path: true as const, pdfBytes: false as const },
					};
				});
				return Promise.resolve({
					status: "completed",
					invocationId: invocation.invocationId,
					outcomes,
				});
			});
			const instance = coordinator(state.store, fixture.vault, {
				initialDraft: draft as unknown as JsonValue,
				identificationRunner: runner,
				applyService: { apply } as never,
			});
			expect(instance.resumeUnfinishedSession()).toEqual({ resumed: true });
			const sessionId = instance.getSnapshot().id;
			expect(instance.getSnapshot().items[0]?.currentStatus).toBe("ready");
			expect(instance.getSnapshot().items[1]?.currentStatus).toBe("needs-you");
			expect(await instance.applyReviewedPlan()).toMatchObject({ status: "completed" });
			const afterFirstApply = instance.getSnapshot();
			const firstApplyRevision = afterFirstApply.items[0]?.applyOutcomeRevision;
			expect(afterFirstApply.items[0]?.currentStatus).toBe("applied");

			const appliedItem = afterFirstApply.items[0];
			if (!appliedItem?.effectiveRecord) throw new Error("Expected the first item record.");
			expect(instance.openInspector(appliedItem.id, sessionId)).toBe(true);
			const edit =
				editedStatus === "no-change"
					? {
							title: appliedItem.effectiveRecord.title,
							authorship: appliedItem.effectiveRecord.authorship,
							year: appliedItem.effectiveRecord.year,
							isbns: appliedItem.effectiveRecord.isbns,
							publisher: "Edited publisher",
						}
					: {
							authorship: {
								authors: [],
								completeness: "unknown" as const,
								totalCountKnown: false,
							},
							isbns: [],
						};
			expect(instance.saveManualRecord(appliedItem.id, edit, sessionId)).toMatchObject({
				saved: true,
			});
			expect(instance.getSnapshot().items[0]?.currentStatus).toBe(editedStatus);

			expect(instance.retryIdentification("saved-item-2", sessionId)).toMatchObject({
				started: true,
			});
			await vi.waitFor(() =>
				expect(instance.getSnapshot().items[1]?.currentStatus).toBe("ready"),
			);
			expect(await instance.applyReviewedPlan()).toMatchObject({ status: "completed" });
			const afterSecondApply = instance.getSnapshot();
			expect(apply).toHaveBeenCalledTimes(2);
			expect(
				apply.mock.calls[1]?.[0].operations.map((operation) => operation.itemId),
			).toEqual(["saved-item-2"]);
			expect(afterSecondApply.items[1]).toMatchObject({
				currentStatus: "applied",
				applyOutcomeRevision: afterSecondApply.revision,
			});
			expect(afterSecondApply.items[0]).toMatchObject({
				currentStatus: editedStatus,
				applyOutcomeRevision: firstApplyRevision,
			});
			expect(afterSecondApply.items[0]?.applyOutcomeRevision).not.toBe(
				afterSecondApply.revision,
			);
		},
	);
});
