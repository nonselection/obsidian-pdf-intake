import { Notice, normalizePath, Plugin, WorkspaceLeaf } from "obsidian";
import { ApplyChangesService } from "./apply-changes";
import { PluginDataStore } from "./persistence";
import { SessionCoordinator } from "./session";
import { IntakeSettingTab } from "./settings";
import { PdfIntakeView, PDF_INTAKE_VIEW_TYPE } from "./view";
import { terminatePdfWorker } from "./pdf-text";
import { identifyPdf, lookupManualIdentifier } from "./resolver";

export default class PdfIntakePlugin extends Plugin {
	store!: PluginDataStore;
	coordinator!: SessionCoordinator;
	private openingView?: Promise<void>;

	async onload(): Promise<void> {
		const folderPaths = this.vaultFolderPaths();
		this.store = new PluginDataStore({
			loadData: () => this.loadData(),
			saveData: (data) => this.saveData(data),
			folderPaths,
		});
		await this.store.load(folderPaths);
		const applyService = new ApplyChangesService(this.app.vault);
		const vault = this.app.vault;
		this.coordinator = new SessionCoordinator(this.store, {
			applyService,
			vault,
			initialDraft: this.store.getDraftNamespace(),
			planningEnvironment: {
				getSnapshot: () => ({
					filePaths: vault.getFiles().map((file) => file.path),
					folderPaths: ["", ...this.vaultFolderPaths()],
				}),
				getOutputFolderPaths: () => ["", ...this.vaultFolderPaths()],
			},
			identificationRunner: (file, context) =>
				identifyPdf(file, vault, this.getPdfWorkerAssetPath(), {
					shouldCancel: context.shouldCancel,
				}),
			manualIdentifierLookupRunner: (type, value) => lookupManualIdentifier(type, value),
		});
		this.registerView(
			PDF_INTAKE_VIEW_TYPE,
			(leaf) => new PdfIntakeView(leaf, this.coordinator, this),
		);
		this.addSettingTab(new IntakeSettingTab(this.app, this));
		this.addCommand({
			id: "open-pdf-intake",
			name: "Open PDF Intake",
			callback: () => void this.openIntakeView(),
		});
		this.addRibbonIcon("inbox", "Open PDF Intake", () => void this.openIntakeView());
	}

	getPdfWorkerAssetPath(): string {
		const pluginDirectory =
			this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		return normalizePath(`${pluginDirectory}/pdf.worker.mjs`);
	}

	private vaultFolderPaths(): string[] {
		return [
			...new Set(
				this.app.vault
					.getAllFolders()
					.map((folder) => folder.path)
					.filter((path) => !!path && path !== "/"),
			),
		];
	}

	onunload(): void {
		this.coordinator?.dispose();
		terminatePdfWorker();
		this.app.workspace.detachLeavesOfType(PDF_INTAKE_VIEW_TYPE);
	}

	private openIntakeView(): Promise<void> {
		if (this.openingView) return this.openingView;
		this.openingView = this.openOrFocusView().finally(() => {
			this.openingView = undefined;
		});
		return this.openingView;
	}

	private async openOrFocusView(): Promise<void> {
		const workspace = this.app.workspace;
		let leaf: WorkspaceLeaf | undefined = workspace.getLeavesOfType(PDF_INTAKE_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: PDF_INTAKE_VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
		await leaf.loadIfDeferred();
		if (leaf.view instanceof PdfIntakeView) {
			workspace.setActiveLeaf(leaf, { focus: true });
		} else {
			new Notice("Could not open the PDF Intake view.");
		}
	}
}
