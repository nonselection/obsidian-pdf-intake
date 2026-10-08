import { describe, expect, it, vi } from "vitest";

vi.mock("../src/settings", () => ({
	IntakeSettingTab: class IntakeSettingTab {},
}));
vi.mock("../src/view", () => ({
	PDF_INTAKE_VIEW_TYPE: "pdf-intake-view",
	PdfIntakeView: class PdfIntakeView {},
}));

describe("plugin lifecycle", () => {
	it("loads and registers its surfaces without constructing or reading a PDF worker", async () => {
		const workerConstructor = vi.fn(() => {
			throw new Error("Worker construction should wait for extraction");
		});
		const adapterRead = vi.fn();
		vi.stubGlobal("Worker", workerConstructor);

		try {
			vi.resetModules();
			const { default: PdfIntakePlugin } = await import("../src/main");
			const plugin = new PdfIntakePlugin(
				{
					vault: { configDir: "custom-config", adapter: { read: adapterRead } },
					workspace: {},
				} as never,
				{ id: "pdf-intake" } as never,
			);

			await plugin.onload();

			expect(workerConstructor).not.toHaveBeenCalled();
			expect(adapterRead).not.toHaveBeenCalled();
			expect(plugin.getPdfWorkerAssetPath()).toBe(
				"custom-config/plugins/pdf-intake/pdf.worker.mjs",
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
