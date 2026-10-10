import { describe, expect, it, vi } from "vitest";
import type { Vault } from "obsidian";
import { App, Notice, TFile, TFolder, type TAbstractFile } from "./obsidian";
import { PluginDataStore } from "../src/persistence";
import { SessionCoordinator } from "../src/session";
import { VaultPdfChooserModal } from "../src/vault-pdf-chooser";
import { TestElement } from "./obsidian";

function makeVault() {
	const root = new TFolder("/");
	const entries = new Map<string, TAbstractFile>([["/", root]]);
	const ensureFolder = (path: string): TFolder => {
		const current = entries.get(path);
		if (current instanceof TFolder) return current;
		const slash = path.lastIndexOf("/");
		const parent = slash < 0 ? root : ensureFolder(path.slice(0, slash));
		const folder = new TFolder(path, parent);
		parent.children.push(folder);
		entries.set(path, folder);
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
	const replaceFile = (
		path: string,
		stat: { ctime: number; mtime: number; size: number },
	): TFile => {
		const previous = entries.get(path);
		if (previous?.parent) {
			const index = previous.parent.children.indexOf(previous);
			if (index >= 0) previous.parent.children.splice(index, 1);
		}
		entries.delete(path);
		return addFile(path, stat);
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
	const enumeration = {
		getFiles: vi.fn(() =>
			[...entries.values()].filter((entry): entry is TFile => entry instanceof TFile),
		),
		getAllLoadedFiles: vi.fn(() => [...entries.values()]),
	};
	const vault = {
		getRoot: () => root,
		getAbstractFileByPath,
		getAllFolders: vi.fn(() =>
			[...entries.values()].filter((entry): entry is TFolder => entry instanceof TFolder),
		),
		readBinary: vi.fn(),
		...enumeration,
		...mutations,
	};
	return {
		vault: vault as unknown as Vault,
		entries,
		root,
		addFile,
		replaceFile,
		mutations,
		enumeration,
	};
}

async function createChooser() {
	const host = makeVault();
	const store = new PluginDataStore({
		loadData: () => Promise.resolve(null),
		saveData: vi.fn(() => Promise.resolve()),
		folderPaths: [],
	});
	await store.load([]);
	const coordinator = new SessionCoordinator(store, { vault: host.vault });
	const app = new App();
	app.vault = host.vault;
	const dismissed = vi.fn();
	const sessionId = coordinator.getSnapshot().id;
	const chooser = new VaultPdfChooserModal(app as never, coordinator, sessionId, dismissed);
	chooser.open();
	return { host, coordinator, app, chooser, dismissed, sessionId };
}

function elements(root: TestElement, predicate: (element: TestElement) => boolean): TestElement[] {
	return root.find(predicate);
}

function button(root: TestElement, label: string): TestElement {
	const found = elements(
		root,
		(element) => element.tagName === "button" && element.textContent === label,
	)[0];
	if (!found) throw new Error(`Missing button: ${label}`);
	return found;
}

function checkbox(root: TestElement, label: string): TestElement {
	const found = elements(
		root,
		(element) => element.tagName === "input" && element.getAttribute("aria-label") === label,
	)[0];
	if (!found) throw new Error(`Missing checkbox: ${label}`);
	return found;
}

function setChecked(input: TestElement, checked: boolean): void {
	input.checked = checked;
	input.trigger("change");
}

function modalContent(chooser: VaultPdfChooserModal): TestElement {
	return chooser.contentEl as unknown as TestElement;
}

describe("vault-scoped PDF chooser", () => {
	it("starts every invocation at vault root and discards navigation and selection on close", async () => {
		const { host, coordinator, app, chooser, sessionId, dismissed } = await createChooser();
		host.addFile("Folder/inside.pdf");
		host.addFile("root.PDF");
		chooser.close();
		dismissed.mockClear();

		const first = new VaultPdfChooserModal(app as never, coordinator, sessionId);
		first.open();
		const firstContent = modalContent(first);
		expect(
			elements(firstContent, (element) =>
				element.className.includes("pdf-intake-chooser-path"),
			).map((element) => element.textContent),
		).toContain("Vault root");
		setChecked(checkbox(firstContent, "Select root.PDF, root.PDF"), true);
		button(firstContent, "Folder").trigger("click");
		expect(
			elements(modalContent(first), (item) => item.textContent === "inside.pdf"),
		).toHaveLength(1);
		first.close();
		expect(dismissed).not.toHaveBeenCalled();
		expect(coordinator.getSnapshot().items).toEqual([]);

		const reopened = new VaultPdfChooserModal(app as never, coordinator, sessionId);
		reopened.open();
		const content = modalContent(reopened);
		expect(elements(content, (item) => item.textContent === "root.PDF")).toHaveLength(1);
		expect(elements(content, (item) => item.textContent === "inside.pdf")).toHaveLength(0);
		expect(checkbox(content, "Select root.PDF, root.PDF").checked).toBe(false);
		expect(button(content, "Vault root").disabled).toBe(true);
		reopened.close();
	});

	it("browses only direct children, supports nested breadcrumbs, and filters case-insensitive PDFs", async () => {
		const { host, chooser, coordinator, sessionId } = await createChooser();
		host.addFile("Root.Pdf");
		host.addFile("Folder/direct.pdf");
		host.addFile("Folder/Nested/deep.PDF");
		host.addFile("Folder/notes.txt");
		host.addFile("Folder/Nested/third.pdf");
		const root = host.root;
		const outside = new TFolder("../outside", root);
		root.children.push(outside);
		host.entries.set(outside.path, outside);
		chooser.close();
		const modal = new VaultPdfChooserModal(chooser.app, coordinator, sessionId);
		modal.open();
		let content = modalContent(modal);
		expect(elements(content, (item) => item.textContent === "Root.Pdf")).toHaveLength(1);
		expect(elements(content, (item) => item.textContent === "outside")).toHaveLength(0);
		button(content, "Folder").trigger("click");
		content = modalContent(modal);
		expect(button(content, "Folder").disabled).toBe(true);
		expect(elements(content, (item) => item.textContent === "direct.pdf")).toHaveLength(1);
		expect(elements(content, (item) => item.textContent === "deep.PDF")).toHaveLength(0);
		expect(elements(content, (item) => item.textContent === "notes.txt")).toHaveLength(0);
		button(content, "Nested").trigger("click");
		content = modalContent(modal);
		expect(button(content, "Folder").disabled).toBe(false);
		expect(button(content, "Nested").disabled).toBe(true);
		expect(elements(content, (item) => item.textContent === "deep.PDF")).toHaveLength(1);
		expect(elements(content, (item) => item.textContent === "third.pdf")).toHaveLength(1);
		expect(
			elements(
				content,
				(item) =>
					item.tagName === "button" &&
					item.getAttribute("aria-label")?.startsWith("Open folder ../") === true,
			),
		).toHaveLength(0);
		modal.close();
	});

	it("selects multiple paths across folders in selection order and keeps selection while navigating", async () => {
		const { host, chooser, coordinator, sessionId } = await createChooser();
		host.addFile("root.pdf");
		host.addFile("Folder/inside.pdf");
		host.addFile("Folder/Nested/deep.pdf");
		chooser.close();
		const modal = new VaultPdfChooserModal(chooser.app, coordinator, sessionId);
		modal.open();
		let content = modalContent(modal);
		const rootCheckbox = checkbox(content, "Select root.pdf, root.pdf");
		rootCheckbox.focus();
		setChecked(rootCheckbox, true);
		expect(rootCheckbox.focused).toBe(true);
		expect(elements(content, (item) => item === rootCheckbox)).toEqual([rootCheckbox]);
		expect(
			elements(content, (item) =>
				item.className.includes("pdf-intake-chooser-selection-count"),
			)[0]?.textContent,
		).toBe("1 selected");
		expect(button(content, "Add selected PDFs").disabled).toBe(false);
		button(content, "Folder").trigger("click");
		content = modalContent(modal);
		setChecked(checkbox(content, "Select inside.pdf, Folder/inside.pdf"), true);
		button(content, "Nested").trigger("click");
		content = modalContent(modal);
		setChecked(checkbox(content, "Select deep.pdf, Folder/Nested/deep.pdf"), true);
		expect(
			elements(
				content,
				(item) => item.tagName === "button" && item.textContent === "Vault root",
			),
		).toHaveLength(1);
		button(content, "Vault root").trigger("click");
		content = modalContent(modal);
		expect(checkbox(content, "Select root.pdf, root.pdf").checked).toBe(true);
		button(content, "Add selected PDFs").trigger("click");
		expect(coordinator.getSnapshot().items.map((item) => item.sourceObservation.path)).toEqual([
			"root.pdf",
			"Folder/inside.pdf",
			"Folder/Nested/deep.pdf",
		]);
		expect((modal as unknown as { opened: boolean }).opened).toBe(false);
	});

	it("shows child folders in empty folders and provides no route above root", async () => {
		const { host, chooser, coordinator, sessionId } = await createChooser();
		host.addFile("Empty/Nested/child.pdf");
		chooser.close();
		const modal = new VaultPdfChooserModal(chooser.app, coordinator, sessionId);
		modal.open();
		let content = modalContent(modal);
		button(content, "Empty").trigger("click");
		content = modalContent(modal);
		expect(button(content, "Empty").disabled).toBe(true);
		expect(
			elements(content, (item) => item.textContent === "No PDFs in this folder."),
		).toHaveLength(1);
		button(content, "Nested").trigger("click");
		content = modalContent(modal);
		expect(elements(content, (item) => item.textContent === "child.pdf")).toHaveLength(1);
		expect(
			elements(
				content,
				(item) =>
					item.tagName === "button" &&
					item.getAttribute("aria-label")?.startsWith("Open folder ../") === true,
			),
		).toHaveLength(0);
		button(content, "Vault root").trigger("click");
		expect(elements(modalContent(modal), (item) => item.textContent === "Empty")).toHaveLength(
			1,
		);
		modal.close();
	});

	it("marks exact-path and retained-binding members as disabled chooser selections", async () => {
		const { host, coordinator, chooser, sessionId } = await createChooser();
		const exact = host.addFile("A/exact.pdf");
		const renamed = host.addFile("B/renamed.pdf");
		coordinator.addPdfs([exact.path, renamed.path], sessionId);
		const oldParent = renamed.parent;
		oldParent?.children.splice(oldParent.children.indexOf(renamed), 1);
		host.entries.delete(renamed.path);
		Object.defineProperty(renamed, "path", { value: "B/current-name.pdf", configurable: true });
		Object.defineProperty(renamed, "name", { value: "current-name.pdf", configurable: true });
		host.entries.set(renamed.path, renamed);
		renamed.parent?.children.push(renamed);
		chooser.close();
		const modal = new VaultPdfChooserModal(chooser.app, coordinator, sessionId);
		modal.open();
		let content = modalContent(modal);
		button(content, "A").trigger("click");
		content = modalContent(modal);
		const exactCheckbox = checkbox(content, "Already added exact.pdf, A/exact.pdf");
		expect(elements(content, (item) => item.textContent === "Already added")).toHaveLength(1);
		button(content, "Vault root").trigger("click");
		content = modalContent(modal);
		button(content, "B").trigger("click");
		content = modalContent(modal);
		const renamedCheckbox = checkbox(
			content,
			"Already added current-name.pdf, B/current-name.pdf",
		);
		expect(exactCheckbox.disabled).toBe(true);
		expect(renamedCheckbox.disabled).toBe(true);
		expect(elements(content, (item) => item.textContent === "Already added")).toHaveLength(1);
		modal.close();
	});

	it("uses paths only until confirmation and admits the current valid PDF at that path", async () => {
		const { host, coordinator, chooser, sessionId } = await createChooser();
		const selected = host.addFile("replaceable.pdf", { ctime: 1, mtime: 10, size: 20 });
		chooser.close();
		const modal = new VaultPdfChooserModal(chooser.app, coordinator, sessionId);
		modal.open();
		setChecked(checkbox(modalContent(modal), "Select replaceable.pdf, replaceable.pdf"), true);
		host.replaceFile(selected.path, { ctime: 2, mtime: 30, size: 40 });
		button(modalContent(modal), "Add selected PDFs").trigger("click");
		expect(coordinator.getSnapshot().items[0]?.sourceObservation).toEqual({
			path: "replaceable.pdf",
			mtime: 30,
			size: 40,
		});
		expect(host.mutations.rename).not.toHaveBeenCalled();
		expect(host.mutations.modifyBinary).not.toHaveBeenCalled();
		expect(host.mutations.delete).not.toHaveBeenCalled();
	});

	it("revalidates disappeared, folder, and non-PDF paths at confirmation", async () => {
		const { host, coordinator, chooser, sessionId } = await createChooser();
		const disappears = host.addFile("gone.pdf");
		const becomesFolder = host.addFile("folder-now.pdf");
		host.addFile("text-now.pdf");
		chooser.close();
		const modal = new VaultPdfChooserModal(chooser.app, coordinator, sessionId);
		modal.open();
		const content = modalContent(modal);
		setChecked(checkbox(content, "Select gone.pdf, gone.pdf"), true);
		setChecked(checkbox(content, "Select folder-now.pdf, folder-now.pdf"), true);
		setChecked(checkbox(content, "Select text-now.pdf, text-now.pdf"), true);
		host.entries.delete(disappears.path);
		host.entries.set(becomesFolder.path, new TFolder(becomesFolder.path, host.root));
		const nonPdf = new TFile("text-now.txt", { ctime: 1, mtime: 2, size: 3 }, host.root);
		host.root.children.push(nonPdf);
		host.entries.set("text-now.pdf", nonPdf);
		button(content, "Add selected PDFs").trigger("click");
		expect(coordinator.getSnapshot().items).toEqual([]);
		expect(coordinator.getSnapshot().revision).toBe(0);
	});

	it("identifies a single rejected path in the confirmation notice", async () => {
		const { host, coordinator, chooser, sessionId } = await createChooser();
		host.addFile("Folder/gone.pdf");
		chooser.close();
		const modal = new VaultPdfChooserModal(chooser.app, coordinator, sessionId);
		modal.open();
		let content = modalContent(modal);
		button(content, "Folder").trigger("click");
		content = modalContent(modal);
		setChecked(checkbox(content, "Select gone.pdf, Folder/gone.pdf"), true);
		host.entries.delete("Folder/gone.pdf");
		const noticeStart = Notice.messages.length;
		button(content, "Add selected PDFs").trigger("click");

		expect(Notice.messages.slice(noticeStart)).toEqual(["Could not add: Folder/gone.pdf"]);
		expect(coordinator.getSnapshot().items).toEqual([]);
	});

	it("lists multiple rejected paths while keeping successful admission", async () => {
		const { host, coordinator, chooser, sessionId } = await createChooser();
		host.addFile("good.pdf");
		host.addFile("Folder/a.pdf");
		host.addFile("Other/b.pdf");
		chooser.close();
		const modal = new VaultPdfChooserModal(chooser.app, coordinator, sessionId);
		modal.open();
		let content = modalContent(modal);
		setChecked(checkbox(content, "Select good.pdf, good.pdf"), true);
		button(content, "Folder").trigger("click");
		content = modalContent(modal);
		setChecked(checkbox(content, "Select a.pdf, Folder/a.pdf"), true);
		button(content, "Vault root").trigger("click");
		content = modalContent(modal);
		button(content, "Other").trigger("click");
		content = modalContent(modal);
		setChecked(checkbox(content, "Select b.pdf, Other/b.pdf"), true);
		host.entries.delete("Folder/a.pdf");
		host.entries.delete("Other/b.pdf");
		const noticeStart = Notice.messages.length;
		button(content, "Add selected PDFs").trigger("click");

		expect(Notice.messages.slice(noticeStart)).toEqual([
			"1 PDF added. Could not add: Folder/a.pdf; Other/b.pdf",
		]);
		expect(coordinator.getSnapshot().items.map((item) => item.sourceObservation.path)).toEqual([
			"good.pdf",
		]);
		expect(coordinator.getSnapshot().revision).toBe(1);
	});

	it("cancel and native close discard temporary state without changing membership", async () => {
		const { host, coordinator, chooser, sessionId } = await createChooser();
		host.addFile("Folder/selected.pdf");
		chooser.close();
		const modal = new VaultPdfChooserModal(chooser.app, coordinator, sessionId);
		modal.open();
		let content = modalContent(modal);
		button(content, "Folder").trigger("click");
		content = modalContent(modal);
		setChecked(checkbox(content, "Select selected.pdf, Folder/selected.pdf"), true);
		button(content, "Cancel").trigger("click");
		expect(coordinator.getSnapshot().items).toEqual([]);
		const reopened = new VaultPdfChooserModal(chooser.app, coordinator, sessionId);
		reopened.open();
		button(modalContent(reopened), "Folder").trigger("click");
		expect(
			checkbox(modalContent(reopened), "Select selected.pdf, Folder/selected.pdf").checked,
		).toBe(false);
		setChecked(
			checkbox(modalContent(reopened), "Select selected.pdf, Folder/selected.pdf"),
			true,
		);
		reopened.close(); // Obsidian's Escape/backdrop dismissal reaches the same onClose path.
		expect(coordinator.getSnapshot().items).toEqual([]);
	});

	it("does not enumerate the vault or expose selection controls outside the open chooser", async () => {
		const { host, coordinator, chooser, sessionId } = await createChooser();
		const { enumeration } = host;
		host.addFile("one.pdf");
		chooser.close();
		const modal = new VaultPdfChooserModal(chooser.app, coordinator, sessionId);
		modal.open();
		expect(enumeration.getFiles).not.toHaveBeenCalled();
		expect(enumeration.getAllLoadedFiles).not.toHaveBeenCalled();
		expect(checkbox(modalContent(modal), "Select one.pdf, one.pdf").disabled).toBe(false);
		modal.close();
		expect(enumeration.getFiles).not.toHaveBeenCalled();
		expect(enumeration.getAllLoadedFiles).not.toHaveBeenCalled();
	});
});
