import { vi } from "vitest";

export interface TestRequestOptions {
	url: string;
	headers?: Record<string, string>;
}

export interface TestResponse {
	status: number;
	json: Record<string, unknown>;
}

export const requestUrl = vi.fn<(options: TestRequestOptions) => Promise<TestResponse>>();

export class Plugin {
	app: unknown;
	manifest: unknown;

	constructor(app: unknown, manifest: unknown) {
		this.app = app;
		this.manifest = manifest;
	}

	loadData(): Promise<unknown> {
		return Promise.resolve(null);
	}

	async saveData(_data: unknown): Promise<void> {}

	registerView(_type: string, _creator: (leaf: unknown) => unknown): void {}
	addSettingTab(_tab: unknown): void {}
	addCommand(_command: unknown): void {}
	addRibbonIcon(_icon: string, _title: string, _callback: () => void): void {}
}

export class WorkspaceLeaf {}

export class Notice {
	constructor(_message: string) {}
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}
