import { describe, expect, it, vi } from "vitest";
import { TestElement, WorkspaceLeaf } from "./obsidian";
import type PdfIntakePlugin from "../src/main";
import type { PdfIntakeView } from "../src/view";

type TestView = PdfIntakeView & { contentEl: TestElement };
type TestPlugin = PdfIntakePlugin & {
	testLoadedData: unknown;
	registeredViews: Map<string, (leaf: unknown) => unknown>;
	settingTabs: unknown[];
};

async function createShell(raw: unknown = null) {
	vi.resetModules();
	const { default: PdfIntakePlugin } = await import("../src/main");
	const getFiles = vi.fn(() => []);
	const readBinary = vi.fn(() => Promise.resolve(new ArrayBuffer(0)));
	const adapterRead = vi.fn(() => Promise.resolve("worker source"));
	const vault = {
		configDir: ".obsidian",
		getAllFolders: vi.fn(() => [{ path: "Sources", type: "folder" }]),
		getFiles,
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
	return { plugin, view, vault, leaf, getFiles, readBinary, adapterRead };
}

function textOf(root: TestElement): string {
	return [root.textContent, ...root.children.map(textOf)].filter(Boolean).join(" ");
}

async function tick(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("empty setup shell", () => {
	it("renders all setup concerns immediately with honest disabled PDF/review actions", async () => {
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
			expect(add?.disabled).toBe(true);
			expect(add?.getAttribute("aria-disabled")).toBe("true");
			expect(review?.disabled).toBe(true);
			expect(textOf(view.contentEl)).toContain("No PDFs in this session yet.");
			expect(textOf(view.contentEl)).toContain("PDF selection is not available yet.");
			expect(
				view.contentEl.find((element: TestElement) =>
					/Resolve selected|Process selected|Select all/.test(element.textContent),
				),
			).toEqual([]);
			expect(getFiles).not.toHaveBeenCalled();
			expect(readBinary).not.toHaveBeenCalled();
			expect(adapterRead).not.toHaveBeenCalled();
			expect(workerConstructor).not.toHaveBeenCalled();
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
