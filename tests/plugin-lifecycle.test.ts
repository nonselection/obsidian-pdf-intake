import { describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import { Modal, TFolder, TestElement, WorkspaceLeaf } from "./obsidian";
import type PdfIntakePlugin from "../src/main";
import type { PdfIntakeView } from "../src/view";

type TestView = PdfIntakeView & { contentEl: TestElement };
type TestPlugin = PdfIntakePlugin & {
	registeredViews: Map<string, (leaf: unknown) => unknown>;
	commands: { id: string; callback: () => void }[];
	ribbons: (() => void)[];
};
type DeferredLeaf = WorkspaceLeaf & {
	app: unknown;
	view?: TestView;
	deferred?: boolean;
	viewType?: string;
	setViewState: (state: { type: string }) => Promise<void>;
	loadIfDeferred: () => Promise<void>;
};

function makeHost() {
	const getFiles = vi.fn(() => []);
	const readBinary = vi.fn(() => Promise.resolve(new ArrayBuffer(0)));
	const adapterRead = vi.fn(() => Promise.resolve("worker source"));
	const folders = [{ path: "Sources", type: "folder" }];
	const leaves: DeferredLeaf[] = [];
	const root = new TFolder("/");
	let creator: ((leaf: unknown) => unknown) | undefined;
	let created = 0;
	const vault = {
		configDir: ".obsidian",
		getRoot: vi.fn(() => root),
		getAbstractFileByPath: vi.fn(() => null),
		getAllFolders: vi.fn(() => folders),
		getFiles,
		readBinary,
		adapter: { read: adapterRead },
	};
	const workspace = {
		getLeavesOfType: vi.fn((type: string) => leaves.filter((leaf) => leaf.viewType === type)),
		getLeaf: vi.fn(() => {
			created++;
			const leaf = new WorkspaceLeaf() as DeferredLeaf;
			leaf.app = app;
			leaf.setViewState = (state: { type: string }) => {
				leaf.deferred = true;
				leaf.viewType = state.type;
				return Promise.resolve();
			};
			leaf.loadIfDeferred = async () => {
				if (leaf.deferred && !leaf.view) {
					leaf.view = creator?.(leaf) as TestView | undefined;
					await leaf.view?.onOpen();
					leaf.deferred = false;
				}
			};
			leaves.push(leaf);
			return leaf;
		}),
		revealLeaf: vi.fn(() => Promise.resolve(undefined)),
		setActiveLeaf: vi.fn(),
		detachLeavesOfType: vi.fn(() => {
			leaves.length = 0;
		}),
	};
	const app = { vault, workspace };
	return {
		app,
		vault,
		workspace,
		leaves,
		get created() {
			return created;
		},
		attachCreator(value: unknown) {
			creator =
				typeof value === "function" ? (value as (leaf: unknown) => unknown) : undefined;
		},
	};
}

async function tick(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("plugin lifecycle", () => {
	it("opens one real empty setup view from command/ribbon without scanning or extracting", async () => {
		const workerConstructor = vi.fn(() => {
			throw new Error("Worker construction should wait for a later identification slice");
		});
		vi.stubGlobal("Worker", workerConstructor);
		try {
			const { default: PdfIntakePlugin } = await import("../src/main");
			const host = makeHost();
			const plugin = new PdfIntakePlugin(
				host.app as never,
				{ id: "pdf-intake", dir: "plugins/pdf-intake" } as never,
			) as TestPlugin;
			await plugin.onload();
			host.attachCreator(plugin.registeredViews.get("pdf-intake-view"));
			const command = plugin.commands.find(
				(item: { id: string }) => item.id === "open-pdf-intake",
			)!;
			command.callback();
			plugin.ribbons[0]();
			await tick();
			expect(host.created).toBe(1);
			expect(host.workspace.revealLeaf).toHaveBeenCalledTimes(1);
			expect(host.workspace.setActiveLeaf).toHaveBeenCalledWith(host.leaves[0], {
				focus: true,
			});
			expect(host.vault.getFiles).not.toHaveBeenCalled();
			expect(host.vault.readBinary).not.toHaveBeenCalled();
			expect(host.vault.adapter.read).not.toHaveBeenCalled();
			expect(workerConstructor).not.toHaveBeenCalled();
			expect(requestUrl).not.toHaveBeenCalled();
			expect(plugin.coordinator.getSnapshot()).toMatchObject({
				phase: "setup",
				setupOpen: true,
				setupConcern: "pdfs",
				items: [],
			});
			expect(host.leaves[0]?.view).toBeTruthy();
			const openedView = host.leaves[0]?.view;
			if (!openedView) throw new Error("PDF Intake view was not created");
			const add = openedView.contentEl.find(
				(element) => element.textContent === "Add PDFs",
			)[0];
			expect(add?.disabled).toBe(false);
			const modalCount = Modal.instances.length;
			add?.trigger("click");
			expect(Modal.instances).toHaveLength(modalCount + 1);
			expect(Modal.instances[Modal.instances.length - 1]?.opened).toBe(true);
			const sessionId = plugin.coordinator.getSnapshot().id;
			plugin.coordinator.setSetupConcern("output");
			await openedView.onClose();
			expect(Modal.instances[Modal.instances.length - 1]?.opened).toBe(false);
			host.leaves[0].view = undefined;
			host.leaves[0].deferred = true;
			command.callback();
			await tick();
			expect(host.created).toBe(1);
			expect(host.workspace.setActiveLeaf).toHaveBeenCalledTimes(2);
			expect(plugin.coordinator.getSnapshot().id).toBe(sessionId);
			expect(plugin.coordinator.getSnapshot().setupConcern).toBe("output");
			plugin.onunload();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("keeps the worker asset path rooted in the configured plugin directory", async () => {
		const { default: PdfIntakePlugin } = await import("../src/main");
		const host = makeHost();
		const plugin = new PdfIntakePlugin(
			host.app as never,
			{ id: "pdf-intake", dir: "custom-config/plugins/pdf-intake" } as never,
		) as TestPlugin;
		await plugin.onload();
		expect(plugin.getPdfWorkerAssetPath()).toBe(
			"custom-config/plugins/pdf-intake/pdf.worker.mjs",
		);
		plugin.onunload();
	});
});
