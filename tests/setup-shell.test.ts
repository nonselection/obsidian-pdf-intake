import { describe, expect, it, vi } from "vitest";
import { Modal, requestUrl, TFile, TFolder, TestElement, WorkspaceLeaf } from "./obsidian";
import type PdfIntakePlugin from "../src/main";
import type { PdfIntakeView } from "../src/view";

type TestView = PdfIntakeView & { contentEl: TestElement };
type TestPlugin = PdfIntakePlugin & {
	testLoadedData: unknown;
	registeredViews: Map<string, (leaf: unknown) => unknown>;
	settingTabs: unknown[];
};

async function createShell(raw: unknown = null) {
	const { default: PdfIntakePlugin } = await import("../src/main");
	const getFiles = vi.fn(() => []);
	const readBinary = vi.fn(() => Promise.resolve(new ArrayBuffer(0)));
	const adapterRead = vi.fn(() => Promise.resolve("worker source"));
	const root = new TFolder("/");
	const entries = new Map<string, TFile | TFolder>([["/", root]]);
	const ensureFolder = (path: string): TFolder => {
		const existing = entries.get(path);
		if (existing instanceof TFolder) return existing;
		const slash = path.lastIndexOf("/");
		const parent = slash < 0 ? root : ensureFolder(path.slice(0, slash));
		const folder = new TFolder(path, parent);
		parent.children.push(folder);
		entries.set(path, folder);
		return folder;
	};
	const addFile = (path: string): TFile => {
		const slash = path.lastIndexOf("/");
		const parent = slash < 0 ? root : ensureFolder(path.slice(0, slash));
		const file = new TFile(path, { ctime: 1, mtime: 100, size: 200 }, parent);
		parent.children.push(file);
		entries.set(path, file);
		return file;
	};
	ensureFolder("Sources");
	const vault = {
		configDir: ".obsidian",
		getRoot: vi.fn(() => root),
		getAbstractFileByPath: vi.fn((path: string) => entries.get(path) ?? null),
		getAllFolders: vi.fn(() =>
			[...entries.values()].filter((entry): entry is TFolder => entry instanceof TFolder),
		),
		getFiles: vi.fn(() => {
			getFiles();
			return [...entries.values()].filter((entry): entry is TFile => entry instanceof TFile);
		}),
		getAllLoadedFiles: vi.fn(() => [...entries.values()]),
		rename: vi.fn(),
		create: vi.fn(),
		createFolder: vi.fn(),
		modify: vi.fn(),
		modifyBinary: vi.fn(),
		delete: vi.fn(),
		trash: vi.fn(),
		readBinary,
		adapter: { read: adapterRead },
	};
	const workspace = { detachLeavesOfType: vi.fn() };
	const app = { vault, workspace };
	const plugin = new PdfIntakePlugin(
		app as never,
		{ id: "pdf-intake", dir: "plugins/pdf-intake" } as never,
	) as TestPlugin;
	plugin.testLoadedData = raw;
	await plugin.onload();
	const creator = plugin.registeredViews.get("pdf-intake-view")!;
	const leaf = new WorkspaceLeaf();
	leaf.app = app;
	const view = creator(leaf) as TestView;
	leaf.view = view;
	await view.onOpen();
	return { plugin, view, vault, leaf, getFiles, readBinary, adapterRead, addFile, entries };
}

function textOf(root: TestElement): string {
	return [root.textContent, ...root.children.map(textOf)].filter(Boolean).join(" ");
}

async function tick(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("PDF Intake setup shell", () => {
	it("renders setup concerns with active Add PDFs and disabled Begin review", async () => {
		const workerConstructor = vi.fn(() => {
			throw new Error("PDF extraction must remain lazy");
		});
		vi.stubGlobal("Worker", workerConstructor);
		try {
			const { plugin, view, getFiles, readBinary, adapterRead } = await createShell();
			const tabs = view.contentEl.find(
				(element: TestElement) => element.getAttribute("role") === "tab",
			);
			expect(tabs.map((tab: TestElement) => tab.textContent)).toEqual([
				"PDFs",
				"Output",
				"Metadata & naming",
			]);
			expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
			const add = view.contentEl.find(
				(element: TestElement) =>
					element.tagName === "button" && element.textContent === "Add PDFs",
			)[0];
			const review = view.contentEl.find(
				(element: TestElement) =>
					element.tagName === "button" && element.textContent === "Begin review",
			)[0];
			expect(add?.disabled).toBe(false);
			expect(add?.getAttribute("aria-disabled")).toBeNull();
			expect(review?.disabled).toBe(true);
			expect(textOf(view.contentEl)).toContain("No PDFs in this session yet.");
			expect(textOf(view.contentEl)).not.toContain("PDF selection is not available yet.");
			expect(
				view.contentEl.find((element: TestElement) =>
					/Resolve selected|Process selected|Select all/.test(element.textContent),
				),
			).toEqual([]);
			expect(getFiles).not.toHaveBeenCalled();
			expect(readBinary).not.toHaveBeenCalled();
			expect(adapterRead).not.toHaveBeenCalled();
			expect(workerConstructor).not.toHaveBeenCalled();
			const modalCount = Modal.instances.length;
			add?.trigger("click");
			expect(Modal.instances).toHaveLength(modalCount + 1);
			expect(Modal.instances[Modal.instances.length - 1]?.opened).toBe(true);
			expect(Modal.instances[Modal.instances.length - 1]?.titleEl.textContent).toBe(
				"Add PDFs",
			);
			Modal.instances[Modal.instances.length - 1]?.close();
			const firstTab = view.contentEl.find(
				(element: TestElement) => element.getAttribute("role") === "tab",
			)[0];
			firstTab.trigger("keydown", { key: "ArrowRight" });
			expect(plugin.coordinator.getSnapshot().setupConcern).toBe("output");
			expect(
				view.contentEl.find((element) => element.getAttribute("role") === "tab")[1]
					?.focused,
			).toBe(true);
			await view.onClose();
			plugin.onunload();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("renders a selectable manifest, supports Add more and removes session membership only", async () => {
		const workerConstructor = vi.fn(() => {
			throw new Error("PDF extraction remains outside admission and setup rendering");
		});
		vi.stubGlobal("Worker", workerConstructor);
		requestUrl.mockClear();
		try {
			const { plugin, view, vault, addFile } = await createShell();
			const savesBeforeMembership = (plugin as unknown as { testSavedData: unknown[] })
				.testSavedData.length;
			const first = addFile("Folder/shared.pdf");
			const second = addFile("Other/shared.pdf");
			const sessionId = plugin.coordinator.getSnapshot().id;
			plugin.coordinator.addPdfs([first.path, second.path], sessionId);
			const text = textOf(view.contentEl);
			expect(text).toContain("2 PDFs");
			expect(
				view.contentEl
					.find((element) => element.className === "pdf-intake-pdf-parent-path")
					.map((element) => element.textContent),
			).toEqual(["Folder", "Other"]);
			expect(text).toContain("Add more PDFs");
			expect(text).toContain("Review is not available yet.");
			expect(text).not.toContain("identification is implemented");
			expect(
				view.contentEl
					.find((element) => element.className === "pdf-intake-pdf-filename")
					.map((element) => element.textContent),
			).toEqual(["shared.pdf", "shared.pdf"]);
			expect(
				view.contentEl.find(
					(element) => element.tagName === "input" && element.type === "checkbox",
				),
			).toEqual([]);
			expect(
				view.contentEl.find((element) =>
					/Resolve|Process selected|Select all/.test(element.textContent),
				),
			).toEqual([]);
			const remove = view.contentEl.find(
				(element) =>
					element.tagName === "button" &&
					element.getAttribute("aria-label") === "Remove shared.pdf from Folder",
			)[0];
			remove?.trigger("click");
			expect(
				plugin.coordinator.getSnapshot().items.map((item) => item.sourceObservation.path),
			).toEqual(["Other/shared.pdf"]);
			expect(plugin.coordinator.getSnapshot().revision).toBe(2);
			await view.onClose();
			await view.onOpen();
			expect(plugin.coordinator.getSnapshot().items).toHaveLength(1);
			second.stat.size++;
			plugin.coordinator.refreshSourceHealth(sessionId);
			expect(textOf(view.contentEl)).toContain("Source changed");
			expect(vault.getAbstractFileByPath("Folder/shared.pdf")).toBe(first);
			expect(vault.getAbstractFileByPath("Other/shared.pdf")).toBe(second);
			expect(plugin.store.getDraftNamespace()).toBeNull();
			expect((plugin as unknown as { testSavedData: unknown[] }).testSavedData).toHaveLength(
				savesBeforeMembership,
			);
			expect(vault.readBinary).not.toHaveBeenCalled();
			expect(vault.adapter.read).not.toHaveBeenCalled();
			expect(vault.rename).not.toHaveBeenCalled();
			expect(vault.create).not.toHaveBeenCalled();
			expect(vault.createFolder).not.toHaveBeenCalled();
			expect(vault.modify).not.toHaveBeenCalled();
			expect(vault.modifyBinary).not.toHaveBeenCalled();
			expect(vault.delete).not.toHaveBeenCalled();
			expect(vault.trash).not.toHaveBeenCalled();
			expect(workerConstructor).not.toHaveBeenCalled();
			expect(requestUrl).not.toHaveBeenCalled();
			expect((plugin as unknown as { testSavedData: unknown[] }).testSavedData).toHaveLength(
				savesBeforeMembership,
			);
			const addMore = view.contentEl.find(
				(element) =>
					element.tagName === "button" && element.textContent === "Add more PDFs",
			)[0];
			const modalCount = Modal.instances.length;
			addMore?.trigger("click");
			expect(Modal.instances).toHaveLength(modalCount + 1);
			expect(Modal.instances[Modal.instances.length - 1]?.opened).toBe(true);
			Modal.instances[Modal.instances.length - 1]?.close();
			expect(plugin.coordinator.beginReview()).toEqual({
				allowed: false,
				reason: "Review is not available yet.",
			});
			const remainingRemove = view.contentEl.find(
				(element) =>
					element.tagName === "button" &&
					element.getAttribute("aria-label") === "Remove shared.pdf from Other",
			)[0];
			remainingRemove?.trigger("click");
			expect(plugin.coordinator.getSnapshot().items).toEqual([]);
			expect(plugin.coordinator.getSnapshot().revision).toBe(3);
			expect(textOf(view.contentEl)).toContain("No PDFs in this session yet.");
			expect(plugin.coordinator.beginReview()).toEqual({
				allowed: false,
				reason: "Add at least one PDF before beginning review.",
			});
			await view.onClose();
			plugin.onunload();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("ignores a Remove callback emitted by a previous session render", async () => {
		const { plugin, view, vault, addFile } = await createShell();
		const source = addFile("stale-action.pdf");
		const oldSession = plugin.coordinator.getSnapshot().id;
		plugin.coordinator.addPdfs([source.path], oldSession);
		const staleRemove = view.contentEl.find(
			(element) =>
				element.tagName === "button" &&
				element.getAttribute("aria-label") === "Remove stale-action.pdf from vault root",
		)[0];
		plugin.coordinator.createNewSession();
		const currentSession = plugin.coordinator.getSnapshot();
		staleRemove?.trigger("click");
		expect(plugin.coordinator.getSnapshot()).toMatchObject({
			id: currentSession.id,
			revision: 0,
			items: [],
		});
		expect(vault.getAbstractFileByPath(source.path)).toBe(source);
		await view.onClose();
		plugin.onunload();
	});

	it("edits Output and the illustrative filename through detached session configuration", async () => {
		const { plugin, view } = await createShell();
		const outputTab = view.contentEl.find(
			(element: TestElement) =>
				element.getAttribute("role") === "tab" && element.textContent === "Output",
		)[0];
		outputTab.trigger("click");
		const destination = view.contentEl.find(
			(element: TestElement) => element.getAttribute("aria-label") === "Output destination",
		)[0];
		destination.value = "vault-root";
		destination.trigger("change");
		await tick();
		expect(plugin.coordinator.getSnapshot().configuration.output).toEqual({
			mode: "vault-folder",
			folderPath: "",
		});
		expect(plugin.store.getSettings().defaults.output).toEqual({
			mode: "vault-folder",
			folderPath: "",
		});

		const namingTab = view.contentEl.find(
			(element: TestElement) =>
				element.getAttribute("role") === "tab" &&
				element.textContent === "Metadata & naming",
		)[0];
		namingTab.trigger("click");
		const input = view.contentEl.find(
			(element: TestElement) =>
				element.tagName === "input" &&
				element.getAttribute("aria-label") === "Custom filename template",
		)[0];
		input.value = "{author} - {year} - {title}";
		input.trigger("input");
		input.trigger("blur");
		await tick();
		expect(
			plugin.coordinator.getSnapshot().configuration.metadataAndNaming.filenameFormat,
		).toEqual({
			kind: "legacy-template",
			template: "{author} - {year} - {title}",
		});
		expect(textOf(view.contentEl)).toContain(
			"Example filename: Tesar - 2023 - Example Title.pdf",
		);
		await view.onClose();
		plugin.onunload();
	});

	it("lists policy before defaults and later Settings edits leave an open session unchanged", async () => {
		const { plugin, view } = await createShell();
		const tab = plugin.settingTabs[0] as { display(): void; containerEl: TestElement };
		tab.display();
		const settingNames = tab.containerEl
			.find((element: TestElement) => element.className === "setting-item-name")
			.map((element: TestElement) => element.textContent);
		expect(settingNames.slice(0, 3)).toEqual([
			"Workspace edits",
			"Default output",
			"Default filename convention",
		]);
		expect(textOf(tab.containerEl)).not.toContain("Intake folder");
		const policy = tab.containerEl.find(
			(element: TestElement) => element.tagName === "select",
		)[0];
		policy.value = "session-only";
		policy.trigger("change");
		await tick();
		expect(plugin.store.getSettings().workspaceEditPolicy).toBe("session-only");
		const defaultBefore = JSON.stringify(plugin.store.getSettings().defaults);
		const outputTab = view.contentEl.find(
			(element: TestElement) =>
				element.getAttribute("role") === "tab" && element.textContent === "Output",
		)[0];
		outputTab.trigger("click");
		const destination = view.contentEl.find(
			(element: TestElement) => element.getAttribute("aria-label") === "Output destination",
		)[0];
		destination.value = "folder:Sources";
		destination.trigger("change");
		await tick();
		expect(plugin.coordinator.getSnapshot().configuration.output).toEqual({
			mode: "vault-folder",
			folderPath: "Sources",
		});
		expect(JSON.stringify(plugin.store.getSettings().defaults)).toBe(defaultBefore);
		await view.onClose();
		plugin.onunload();
	});

	it("shows persistence warnings and disables defaults controls for corrupt data", async () => {
		const { plugin, view } = await createShell({
			schemaVersion: 1,
			settings: {},
			unfinishedSessionDraft: null,
		});
		expect(textOf(view.contentEl)).toContain("malformed settings or draft namespace");
		const tab = plugin.settingTabs[0] as { display(): void; containerEl: TestElement };
		tab.display();
		const selects = tab.containerEl.find(
			(element: TestElement) => element.tagName === "select",
		);
		expect(selects.length).toBeGreaterThan(0);
		expect(selects.every((select: TestElement) => select.disabled)).toBe(true);
		await view.onClose();
		plugin.onunload();
	});
});
