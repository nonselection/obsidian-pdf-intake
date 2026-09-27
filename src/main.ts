import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { DEFAULT_SETTINGS } from "./types";
import type { IntakeSettings } from "./types";
import { IntakeSettingTab } from "./settings";
import { PdfIntakeView, PDF_INTAKE_VIEW_TYPE } from "./view";

export default class PdfIntakePlugin extends Plugin {
	settings: IntakeSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		const saved = (await this.loadData()) as
			(Partial<IntakeSettings> & { intakeFolders?: string[] }) | null;
		this.settings = {
			...DEFAULT_SETTINGS,
			...saved,
			intakeFolder:
				saved?.intakeFolder ?? saved?.intakeFolders?.[0] ?? DEFAULT_SETTINGS.intakeFolder,
		};
		this.registerView(PDF_INTAKE_VIEW_TYPE, (leaf) => new PdfIntakeView(leaf, this));
		this.addSettingTab(new IntakeSettingTab(this.app, this));
		this.addCommand({
			id: "open-pdf-intake",
			name: "Open PDF Intake",
			callback: () => void this.openIntakeView(),
		});
	}

	onunload(): void {
		this.app.workspace.detachLeavesOfType(PDF_INTAKE_VIEW_TYPE);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private async openIntakeView(): Promise<void> {
		const workspace = this.app.workspace;
		let leaf: WorkspaceLeaf | undefined = workspace.getLeavesOfType(PDF_INTAKE_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: PDF_INTAKE_VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
		await leaf.loadIfDeferred();
		if (leaf.view instanceof PdfIntakeView) await leaf.view.refresh();
		else new Notice("Could not open the PDF Intake view.");
	}
}
