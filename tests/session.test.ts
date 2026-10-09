import { describe, expect, it, vi } from "vitest";
import type { Vault } from "obsidian";
import { TFile, TFolder, type TAbstractFile } from "./obsidian";
import { PluginDataStore, type PluginDataEnvelope } from "../src/persistence";
import { SessionCoordinator, type IntakeSession } from "../src/session";
import type { ApplyInvocation } from "../src/planning";
import type { ApplyInvocationResult } from "../src/apply-changes";
import { createFactoryConfiguration } from "../src/types";

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
	const testSession = coordinator as unknown as { session: IntakeSession };
	testSession.session.items.push({
		id: "item-1",
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
			},
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

describe("plugin-owned session coordinator", () => {
	it("assigns a fresh identity to each coordinator after plugin reload", async () => {
		const { store } = await storeWith();
		const beforeReload = new SessionCoordinator(store).getSnapshot();
		const afterReload = new SessionCoordinator(store).getSnapshot();
		expect(afterReload.id).not.toBe(beforeReload.id);
	});

	it("creates fresh empty setup sessions from detached defaults", async () => {
		const { store } = await storeWith();
		const coordinator = new SessionCoordinator(store);
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
		const coordinator = new SessionCoordinator(store);
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
		const coordinator = new SessionCoordinator(store);
		const original = coordinator.getSnapshot();
		const edit = await coordinator.updateOutput(
			{ mode: "vault-folder", folderPath: "Sources" },
			["Sources"],
		);
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
		const coordinator = new SessionCoordinator(store);
		const edit = await coordinator.updateOutput(
			{ mode: "vault-folder", folderPath: "Sources" },
			["Sources"],
		);
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
		const coordinator = new SessionCoordinator(store);
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
		const coordinator = new SessionCoordinator(store);
		const pending = coordinator.updateOutput({ mode: "vault-folder", folderPath: "Sources" }, [
			"Sources",
		]);
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
		const coordinator = new SessionCoordinator(store);
		await expect(
			coordinator.updateOutput({ mode: "vault-folder", folderPath: "Missing" }, ["Sources"]),
		).resolves.toMatchObject({
			updated: false,
		});
		await expect(
			coordinator.updateOutput({ mode: "vault-folder", folderPath: "" }, []),
		).resolves.toMatchObject({
			updated: true,
		});
	});

	it("rejects a fabricated eligible result for an owned item when no coordinator plan exists", async () => {
		const { store } = await storeWith();
		const { apply, service } = recordingApplyService();
		const coordinator = new SessionCoordinator(store, service as never);
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
		expect(coordinator.beginReview().allowed).toBe(false);
	});

	it("derives and stores detached plans from current coordinator state", async () => {
		const { store } = await storeWith();
		const { apply, service } = recordingApplyService();
		const coordinator = new SessionCoordinator(store, service as never);
		seedTestItem(coordinator);
		const filePaths = ["Inbox/source.pdf"];
		const folderPaths = ["Inbox"];
		const returnedPlan = coordinator.planCurrentSession(filePaths, folderPaths);
		const expectedDestination = "Inbox/Lovelace (2024). Example.pdf";

		expect(returnedPlan.results[0]).toMatchObject({
			status: "eligible",
			proposedRename: { destinationPath: expectedDestination },
		});
		filePaths[0] = "Elsewhere/replacement.pdf";
		folderPaths[0] = "Elsewhere";
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

	it("rejects plans after session, revision, configuration, evidence or source observations change", async () => {
		{
			const { store } = await storeWith();
			const { apply, service } = recordingApplyService();
			const coordinator = new SessionCoordinator(store, service as never);
			seedTestItem(coordinator);
			coordinator.planCurrentSession(["Inbox/source.pdf"], ["Inbox"]);
			coordinator.createNewSession();
			expect(await coordinator.applyReviewedPlan()).toMatchObject({
				status: "rejected",
			});
			expect(apply).not.toHaveBeenCalled();
		}
		{
			const { store } = await storeWith();
			const { apply, service } = recordingApplyService();
			const coordinator = new SessionCoordinator(store, service as never);
			seedTestItem(coordinator);
			const stale = coordinator.planCurrentSession(["Inbox/source.pdf"], ["Inbox"]);
			await coordinator.updateOutput({ mode: "vault-folder", folderPath: "Sources" }, [
				"Sources",
			]);
			expect(coordinator.getSnapshot().revision).toBe(stale.sessionRevision + 1);
			expect(coordinator.getSnapshot().planningSnapshot).toBeNull();
			expect(await coordinator.applyReviewedPlan()).toMatchObject({
				status: "rejected",
			});
			expect(apply).not.toHaveBeenCalled();
		}
		for (const changedField of ["evidence", "source"] as const) {
			const { store } = await storeWith();
			const { apply, service } = recordingApplyService();
			const coordinator = new SessionCoordinator(store, service as never);
			seedTestItem(coordinator);
			coordinator.planCurrentSession(["Inbox/source.pdf"], ["Inbox"]);
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
		const coordinator = new SessionCoordinator(store);
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
		const coordinator = new SessionCoordinator(store, undefined, host.vault);
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
		expect(new SessionCoordinator(store, undefined, host.vault).getSnapshot().items).toEqual(
			[],
		);
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
		const coordinator = new SessionCoordinator(store, undefined, host.vault);
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
		const coordinator = new SessionCoordinator(store, undefined, host.vault);
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
		const coordinator = new SessionCoordinator(store, undefined, host.vault);
		const oldSessionId = coordinator.getSnapshot().id;
		const added = coordinator.addPdfs(["A/one.pdf", "B/two.pdf"], oldSessionId);
		const firstId = added.addedItemIds[0];
		coordinator.planCurrentSession(["A/one.pdf", "B/two.pdf"], ["A", "B"]);
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
		const coordinator = new SessionCoordinator(store, undefined, host.vault);
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

		const seeded = new SessionCoordinator(store, undefined, host.vault);
		seedTestItem(seeded);
		expect(seeded.getSnapshot().items[0]?.sourceHealth).toBe("binding-unavailable");
	});

	it("refreshes derived source health without revising membership and rejects stale refreshes", async () => {
		const { store } = await storeWith();
		const host = vaultFixture();
		const file = host.addFile("current.pdf");
		const coordinator = new SessionCoordinator(store, undefined, host.vault);
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
		expect(coordinator.getSnapshot().revision).toBe(revision);
		const beforeStale = observed.length;
		expect(coordinator.refreshSourceHealth("old-session")).toBe(false);
		expect(observed).toHaveLength(beforeStale);
	});

	it("keeps Begin review unavailable for populated membership without changing phase", async () => {
		const { store } = await storeWith();
		const host = vaultFixture();
		host.addFile("item.pdf");
		const coordinator = new SessionCoordinator(store, undefined, host.vault);
		const sessionId = coordinator.getSnapshot().id;
		coordinator.addPdfs(["item.pdf"], sessionId);
		const before = coordinator.getSnapshot();
		expect(coordinator.beginReview()).toEqual({
			allowed: false,
			reason: "Review is not available yet.",
		});
		expect(coordinator.getSnapshot()).toMatchObject({
			id: before.id,
			phase: "setup",
			revision: before.revision,
		});
	});
});
