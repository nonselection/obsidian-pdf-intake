import { describe, expect, it, vi } from "vitest";
import { decodePluginData, PluginDataStore, type PluginDataEnvelope } from "../src/persistence";
import { createFactoryConfiguration } from "../src/types";

function envelope(overrides: Partial<PluginDataEnvelope> = {}): PluginDataEnvelope {
	return {
		schemaVersion: 1,
		settings: {
			workspaceEditPolicy: "future-sessions",
			defaults: createFactoryConfiguration(),
		},
		unfinishedSessionDraft: null,
		...overrides,
	};
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

describe("plugin data decoding and migration", () => {
	it("creates detached factory settings with no session membership", () => {
		const decoded = decodePluginData(null, []);
		expect(decoded.status).toBe("absent");
		expect(decoded.settings.workspaceEditPolicy).toBe("future-sessions");
		expect(decoded.settings.defaults.output).toEqual({ mode: "current-folders" });
		expect(decoded.settings.defaults.metadataAndNaming.filenameFormat.kind).toBe("components");
		expect(decoded.draftNamespace).toBeNull();
		const second = decodePluginData(null, []);
		(second.settings.defaults.output as { mode: string }).mode = "vault-folder";
		expect(decoded.settings.defaults.output).toEqual({ mode: "current-folders" });
	});

	it("migrates the current malformed destination without importing folders and preserves its exact template", () => {
		const decoded = decodePluginData(
			{
				intakeFolder: "Inbox",
				intakeFolders: ["Other"],
				processedFolderMode: "another",
				processedFolder: "",
				renameTemplate: "{author} - {year} - {title}",
			},
			["Inbox", "Other"],
		);
		expect(decoded.status).toBe("migrated-legacy");
		expect(decoded.settings.defaults.output).toEqual({ mode: "current-folders" });
		expect(decoded.settings.defaults.metadataAndNaming.filenameFormat).toEqual({
			kind: "legacy-template",
			template: "{author} - {year} - {title}",
		});
		expect(JSON.stringify(decoded)).not.toContain("Inbox");
		expect(JSON.stringify(decoded)).not.toContain("Other");
		expect(decoded.draftNamespace).toBeNull();
	});

	it("keeps only a valid unambiguous legacy destination and distinguishes chosen root from empty legacy state", () => {
		const nested = decodePluginData(
			{ processedFolderMode: "another", processedFolder: "Sources/Processed/" },
			["Sources", "Sources/Processed"],
		);
		expect(nested.settings.defaults.output).toEqual({
			mode: "vault-folder",
			folderPath: "Sources/Processed",
		});
		const oldEmpty = decodePluginData({ processedFolderMode: "another", processedFolder: "" }, [
			"",
		]);
		expect(oldEmpty.settings.defaults.output).toEqual({ mode: "current-folders" });
		const newRoot = envelope();
		newRoot.settings.defaults.output = { mode: "vault-folder", folderPath: "" };
		expect(decodePluginData(newRoot, []).settings.defaults.output).toEqual({
			mode: "vault-folder",
			folderPath: "",
		});
	});

	it("repairs malformed legacy destinations to current folders without guessing", () => {
		const bad = [
			"",
			12,
			"Missing",
			"../Sources",
			"/Sources",
			"https://example.com",
			"Sources\\x",
		];
		for (const processedFolder of bad) {
			const decoded = decodePluginData({ processedFolderMode: "another", processedFolder }, [
				"Sources",
				"Sources/child",
			]);
			expect(decoded.settings.defaults.output).toEqual({ mode: "current-folders" });
			expect(
				decoded.diagnostics.some((item) => item.code === "legacy-destination-repaired"),
			).toBe(true);
		}
		const missingPath = decodePluginData({ processedFolderMode: "another" }, ["Sources"]);
		expect(missingPath.settings.defaults.output).toEqual({ mode: "current-folders" });
		expect(
			decodePluginData({ processedFolder: "Sources" }, ["Sources"]).settings.defaults.output,
		).toEqual({ mode: "current-folders" });
	});

	it("preserves valid legacy filename preferences and replaces invalid templates with a warning", () => {
		for (const template of [
			"{author} {year} {title}",
			"{title} - {title}",
			"A literal title",
		]) {
			const decoded = decodePluginData({ renameTemplate: template }, []);
			expect(decoded.settings.defaults.metadataAndNaming.filenameFormat).toEqual({
				kind: "legacy-template",
				template,
			});
		}
		for (const template of ["", "{unknown}", "{title", 42]) {
			const decoded = decodePluginData({ renameTemplate: template }, []);
			expect(decoded.settings.defaults.metadataAndNaming.filenameFormat.kind).toBe(
				"components",
			);
			expect(
				decoded.diagnostics.some((item) => item.code === "legacy-template-repaired"),
			).toBe(true);
		}
	});

	it("reads v1 without rewriting and retains an opaque draft and unknown JSON keys", () => {
		const raw = {
			...envelope({ unfinishedSessionDraft: { schemaVersion: 7, opaque: ["keep"] } }),
			otherNamespace: { retain: true },
		};
		expect(decodePluginData(raw, []).status).toBe("supported-v1");
		const saveData = vi.fn((_data: unknown) => Promise.resolve(undefined));
		const store = new PluginDataStore({ loadData: () => Promise.resolve(raw), saveData });
		return store.load([]).then(async () => {
			expect(saveData).not.toHaveBeenCalled();
			expect(store.getDraftNamespace()).toEqual({ schemaVersion: 7, opaque: ["keep"] });
			await store.updateSettings({ workspaceEditPolicy: "session-only" });
			expect(saveData.mock.calls[0]?.[0]).toMatchObject({
				otherNamespace: { retain: true },
				unfinishedSessionDraft: { schemaVersion: 7, opaque: ["keep"] },
			});
		});
	});

	it("keeps unavailable v1 folder intent visible rather than applying the legacy fallback", () => {
		const raw = envelope();
		raw.settings.defaults.output = { mode: "vault-folder", folderPath: "Deleted" };
		expect(decodePluginData(raw, ["Other"]).settings.defaults.output).toEqual({
			mode: "vault-folder",
			folderPath: "Deleted",
		});
	});

	it("does not overwrite corrupt, ambiguous or future data", async () => {
		const future = decodePluginData(
			{ schemaVersion: 9, settings: { workspaceEditPolicy: "future-sessions" } },
			[],
		);
		expect(future.writable).toBe(false);
		const corrupt = decodePluginData(
			{ schemaVersion: 1, settings: {}, unfinishedSessionDraft: null },
			[],
		);
		expect(corrupt.writable).toBe(false);
		const ambiguous = decodePluginData({ renameTemplate: "{author}", extra: true }, []);
		expect(ambiguous.writable).toBe(false);
		const saveData = vi.fn(() => Promise.resolve(undefined));
		const store = new PluginDataStore({
			loadData: () => Promise.resolve({ schemaVersion: 8 }),
			saveData,
		});
		await store.load([]);
		await expect(
			store.updateSettings({ workspaceEditPolicy: "session-only" }),
		).rejects.toThrow();
		await expect(store.updateDraftNamespace({ keep: true })).rejects.toThrow();
		expect(saveData).not.toHaveBeenCalled();
	});

	it("exposes independently valid legacy preferences from a future envelope without making it writable", () => {
		const future = decodePluginData(
			{
				schemaVersion: 7,
				processedFolderMode: "another",
				processedFolder: "Sources",
				renameTemplate: "{title}",
			},
			["Sources"],
		);
		expect(future.writable).toBe(false);
		expect(future.settings.defaults.output).toEqual({
			mode: "vault-folder",
			folderPath: "Sources",
		});
		expect(future.settings.defaults.metadataAndNaming.filenameFormat).toEqual({
			kind: "legacy-template",
			template: "{title}",
		});
	});

	it("preserves unknown settings/default keys while applying a known field patch", async () => {
		const raw = envelope() as PluginDataEnvelope & Record<string, unknown>;
		(raw.settings as unknown as Record<string, unknown>).futureSetting = { keep: true };
		(raw.settings.defaults as unknown as Record<string, unknown>).futureDefault = ["keep"];
		const saveData = vi.fn((_data: unknown) => Promise.resolve(undefined));
		const store = new PluginDataStore({ loadData: () => Promise.resolve(raw), saveData });
		await store.load([]);
		await store.updateSettings({
			defaults: { output: { mode: "vault-folder", folderPath: "Sources" } },
		});
		expect(saveData.mock.calls[0]?.[0]).toMatchObject({
			settings: {
				futureSetting: { keep: true },
				defaults: {
					futureDefault: ["keep"],
					output: { mode: "vault-folder", folderPath: "Sources" },
				},
			},
		});
	});

	it("keeps unreadable load data readonly and never attempts a replacement write", async () => {
		const saveData = vi.fn((_data: unknown) => Promise.resolve(undefined));
		const store = new PluginDataStore({
			loadData: () => Promise.reject(new Error("parse failed")),
			saveData,
		});
		expect((await store.load([])).writable).toBe(false);
		await expect(store.updateDraftNamespace({ any: "value" })).rejects.toThrow();
		expect(saveData).not.toHaveBeenCalled();
	});
});

describe("serialized partial plugin-data updates", () => {
	it("composes alternating settings and draft patches after the prior successful save", async () => {
		const gate = deferred();
		const writes: unknown[] = [];
		const saveData = vi.fn(async (data: unknown) => {
			writes.push(JSON.parse(JSON.stringify(data)));
			if (writes.length === 1) await gate.promise;
		});
		const store = new PluginDataStore({
			loadData: () => Promise.resolve(envelope()),
			saveData,
		});
		await store.load([]);
		const first = store.updateSettings({
			defaults: { output: { mode: "vault-folder", folderPath: "Sources" } },
		});
		const draft = { schemaVersion: 3, values: [1] };
		const second = store.updateDraftNamespace(draft);
		const third = store.updateSettings({ workspaceEditPolicy: "session-only" });
		const metadata = {
			filenameFormat: { kind: "legacy-template" as const, template: "{title}" },
		};
		const fourth = store.updateSettings({ defaults: { metadataAndNaming: metadata } });
		draft.values[0] = 99;
		await Promise.resolve();
		expect(writes).toHaveLength(1);
		gate.resolve();
		await Promise.all([first, second, third, fourth]);
		expect(writes).toHaveLength(4);
		expect(writes[1]).toMatchObject({
			unfinishedSessionDraft: { schemaVersion: 3, values: [1] },
			settings: { defaults: { output: { mode: "vault-folder", folderPath: "Sources" } } },
		});
		expect(writes[2]).toMatchObject({
			unfinishedSessionDraft: { schemaVersion: 3, values: [1] },
			settings: { workspaceEditPolicy: "session-only" },
		});
		expect(store.getDraftNamespace()).toEqual({ schemaVersion: 3, values: [1] });
		expect(store.getSettings().defaults.metadataAndNaming.filenameFormat).toEqual({
			kind: "legacy-template",
			template: "{title}",
		});
	});

	it("does not publish failed patches and lets later queued updates succeed", async () => {
		const writes: unknown[] = [];
		const saveData = vi.fn((data: unknown) => {
			writes.push(JSON.parse(JSON.stringify(data)));
			if (writes.length === 1) return Promise.reject(new Error("write failed"));
			return Promise.resolve();
		});
		const store = new PluginDataStore({
			loadData: () => Promise.resolve(envelope()),
			saveData,
		});
		await store.load([]);
		const failed = store.updateSettings({ workspaceEditPolicy: "session-only" });
		const later = store.updateDraftNamespace({ preserved: true });
		await expect(failed).rejects.toThrow("write failed");
		await later;
		expect(store.getSettings().workspaceEditPolicy).toBe("future-sessions");
		expect(store.getDraftNamespace()).toEqual({ preserved: true });
		expect(writes[1]).toMatchObject({
			settings: { workspaceEditPolicy: "future-sessions" },
			unfinishedSessionDraft: { preserved: true },
		});
		expect(store.getDiagnostics().some((item) => item.code === "save-failed")).toBe(false);
	});

	it("keeps failed initial migration unsaved and retries from a coherent envelope on an explicit save", async () => {
		const writes: unknown[] = [];
		const saveData = vi.fn((data: unknown) => {
			writes.push(JSON.parse(JSON.stringify(data)));
			if (writes.length === 1) return Promise.reject(new Error("offline"));
			return Promise.resolve();
		});
		const store = new PluginDataStore({
			loadData: () =>
				Promise.resolve({
					processedFolderMode: "another",
					processedFolder: "",
					renameTemplate: "{title}",
				}),
			saveData,
		});
		const loaded = await store.load([]);
		expect(loaded.migrationNeeded).toBe(true);
		expect(store.getDiagnostics().some((item) => item.code === "initial-save-failed")).toBe(
			true,
		);
		await store.updateSettings({ workspaceEditPolicy: "session-only" });
		expect(writes[1]).toMatchObject({
			schemaVersion: 1,
			settings: {
				workspaceEditPolicy: "session-only",
				defaults: { output: { mode: "current-folders" } },
			},
		});
		expect(store.getStatus().migrationNeeded).toBe(false);
	});
});
