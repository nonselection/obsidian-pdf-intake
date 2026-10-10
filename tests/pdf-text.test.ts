import { readFileSync } from "node:fs";
import { Worker as NodeWorker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TFile, Vault } from "obsidian";

const workerInstances: IsolatedTestWorker[] = [];
let workerSourceForTest = "";

class IsolatedTestWorker extends EventTarget {
	private readonly thread: NodeWorker;
	readonly scriptUrl: string;
	readonly workerType: string | undefined;
	terminated = false;

	constructor(scriptUrl: string | URL, options?: WorkerOptions) {
		super();
		this.scriptUrl = String(scriptUrl);
		this.workerType = options?.type;
		this.thread = new NodeWorker(new URL("./pdf-worker-bootstrap.mjs", import.meta.url), {
			workerData: workerSourceForTest,
		});
		this.thread.on("message", (data: unknown) => {
			this.dispatchEvent(new MessageEvent("message", { data }));
		});
		this.thread.on("error", (error: Error) => {
			this.dispatchEvent(new ErrorEvent("error", { error, message: error.message }));
		});
		workerInstances.push(this);
	}

	postMessage(message: unknown, transfer: Transferable[] = []): void {
		this.thread.postMessage(message, transfer as ArrayBuffer[]);
	}

	terminate(): void {
		this.terminated = true;
		void this.thread.terminate();
	}
}

class StubWorker extends EventTarget {
	terminated = false;
	constructor(_scriptUrl: string | URL, _options?: WorkerOptions) {
		super();
	}
	postMessage(_message: unknown, _transfer: Transferable[] = []): void {}
	terminate(): void {
		this.terminated = true;
	}
}

function onePagePdf(text: string): ArrayBuffer {
	const stream = "BT /F1 12 Tf 20 80 Td (" + text + ") Tj ET";
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		"<< /Length " + stream.length + " >>\nstream\n" + stream + "\nendstream",
	];
	let source = "%PDF-1.4\n";
	const offsets = [0];
	for (let index = 0; index < objects.length; index++) {
		offsets.push(source.length);
		source += index + 1 + " 0 obj\n" + objects[index] + "\nendobj\n";
	}
	const xrefOffset = source.length;
	source += "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n";
	for (const offset of offsets.slice(1)) {
		source += String(offset).padStart(10, "0") + " 00000 n \n";
	}
	source +=
		"trailer\n<< /Size " +
		(objects.length + 1) +
		" /Root 1 0 R >>\nstartxref\n" +
		xrefOffset +
		"\n%%EOF";
	return new TextEncoder().encode(source).buffer;
}

function mockVault() {
	return {
		adapter: { read: vi.fn().mockResolvedValue("stub worker source") },
		readBinary: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
	} as unknown as Vault & {
		adapter: { read: ReturnType<typeof vi.fn> };
		readBinary: ReturnType<typeof vi.fn>;
	};
}

async function loadMockPdfText(document: Record<string, unknown>) {
	const getDocument = vi.fn(() => ({
		promise: Promise.resolve(document),
		destroy: vi.fn().mockResolvedValue(undefined),
	}));
	vi.doMock("pdfjs-dist", () => ({
		GlobalWorkerOptions: { workerPort: null },
		getDocument,
	}));
	vi.stubGlobal("Worker", StubWorker);
	vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:stub-worker");
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
	vi.resetModules();
	const pdfText = await import("../src/pdf-text");
	return { pdfText, getDocument };
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.doUnmock("pdfjs-dist");
	workerInstances.length = 0;
	workerSourceForTest = "";
});

describe("PDF.js isolated worker and bounded evidence extraction", () => {
	it("does not create a Worker or modify the renderer global on module import", async () => {
		const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, "pdfjsWorker");
		const workerConstructor = vi.fn(() => {
			throw new Error("Worker construction should be lazy");
		});
		Reflect.deleteProperty(globalThis, "pdfjsWorker");
		vi.stubGlobal("Worker", workerConstructor);

		try {
			vi.resetModules();
			await import("../src/pdf-text");
			expect(workerConstructor).not.toHaveBeenCalled();
			expect(Object.getOwnPropertyDescriptor(globalThis, "pdfjsWorker")).toBeUndefined();
		} finally {
			if (previousDescriptor) {
				Object.defineProperty(globalThis, "pdfjsWorker", previousDescriptor);
			} else {
				Reflect.deleteProperty(globalThis, "pdfjsWorker");
			}
		}
	});

	it("loads the matching worker lazily and returns bounded page evidence", async () => {
		vi.stubGlobal("Worker", IsolatedTestWorker);
		const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, "pdfjsWorker");
		const sentinel = { WorkerMessageHandler: "owned by another PDF.js instance" };
		Object.defineProperty(globalThis, "pdfjsWorker", {
			configurable: true,
			writable: true,
			value: sentinel,
		});
		const workerSource = readFileSync(
			new URL("../node_modules/pdfjs-dist/build/pdf.worker.mjs", import.meta.url),
			"utf8",
		);
		workerSourceForTest = workerSource;
		let createdBlob: Blob | undefined;
		const createObjectURL = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
			createdBlob = blob as Blob;
			return "blob:pdf-intake-worker";
		});
		const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		const workerAssetPath = "custom-config/plugins/pdf-intake/pdf.worker.mjs";
		const adapterRead = vi.fn((path: string) => {
			expect(path).toBe(workerAssetPath);
			return Promise.resolve(workerSource);
		});
		const vault = {
			adapter: { read: adapterRead },
			readBinary: vi.fn().mockResolvedValue(onePagePdf("doi: 10.1234/worker-test")),
		};
		let terminatePdfWorker: (() => void) | undefined;

		try {
			vi.resetModules();
			const pdfText = await import("../src/pdf-text");
			terminatePdfWorker = pdfText.terminatePdfWorker;
			expect(workerInstances).toHaveLength(0);
			expect(adapterRead).not.toHaveBeenCalled();

			const evidence = await pdfText.extractPdfEvidence(
				{ path: "Inbox/sample.pdf" } as TFile,
				vault as never,
				3,
				workerAssetPath,
			);

			expect(evidence.pages).toHaveLength(1);
			expect(evidence.pages[0]?.text).toContain("10.1234/worker-test");
			expect(evidence.pages[0]?.segments[0]?.startOffset).toBe(0);
			expect(adapterRead).toHaveBeenCalledTimes(1);
			expect(workerInstances).toHaveLength(1);
			expect(workerInstances[0]?.scriptUrl).toBe("blob:pdf-intake-worker");
			expect(workerInstances[0]?.workerType).toBe("module");
			expect(await createdBlob?.text()).toBe(workerSource);
			expect(createObjectURL).toHaveBeenCalledTimes(1);
			expect((globalThis as typeof globalThis & { pdfjsWorker?: unknown }).pdfjsWorker).toBe(
				sentinel,
			);

			terminatePdfWorker();
			expect(workerInstances[0]?.terminated).toBe(true);
			expect(revokeObjectURL).toHaveBeenCalledWith("blob:pdf-intake-worker");
		} finally {
			terminatePdfWorker?.();
			if (previousDescriptor) {
				Object.defineProperty(globalThis, "pdfjsWorker", previousDescriptor);
			} else {
				Reflect.deleteProperty(globalThis, "pdfjsWorker");
			}
		}
	});

	it("forms deterministic hasEOL segments, skips marked content, tracks offsets, and reads at most three pages", async () => {
		const pageReads: number[] = [];
		const destroy = vi.fn().mockResolvedValue(undefined);
		const document = {
			numPages: 6,
			getMetadata: vi.fn().mockResolvedValue({ info: { Title: "A Useful PDF Info Title" } }),
			getPage: vi.fn((pageNumber: number) => {
				pageReads.push(pageNumber);
				return Promise.resolve({
					getTextContent: vi.fn().mockResolvedValue({
						items:
							pageNumber === 1
								? [
										{ str: "Journal header", hasEOL: true },
										{ str: "A plausible article title", hasEOL: false },
										{ type: "beginMarkedContent", id: "marked" },
										{ str: "continued", hasEOL: true },
										{ str: "", hasEOL: true },
										{ str: "tail segment", hasEOL: false },
									]
								: [{ str: "Page " + pageNumber + " title text", hasEOL: true }],
					}),
				});
			}),
			destroy,
		};
		const { pdfText, getDocument } = await loadMockPdfText(document);
		const evidence = await pdfText.extractPdfEvidence(
			{ path: "A/sample.pdf" } as TFile,
			mockVault(),
			10,
			"plugins/pdf-intake/pdf.worker.mjs",
		);
		expect(pageReads).toEqual([1, 2, 3]);
		expect(evidence.infoTitle).toBe("A Useful PDF Info Title");
		expect(evidence.pages[0]?.segments).toEqual([
			{ pageNumber: 1, text: "Journal header", startOffset: 0 },
			{ pageNumber: 1, text: "A plausible article title continued", startOffset: 15 },
			{ pageNumber: 1, text: "tail segment", startOffset: 51 },
		]);
		expect(evidence.pages[0]?.text).toBe(
			"Journal header\nA plausible article title continued\ntail segment",
		);
		expect(evidence.pages[1]?.segments[0]?.startOffset).toBe(0);
		expect(getDocument).toHaveBeenCalledTimes(1);
		expect(destroy).toHaveBeenCalledTimes(1);
	});

	it("reads Info Title from the already loaded document and tolerates unusable metadata", async () => {
		const document = {
			numPages: 0,
			getMetadata: vi.fn().mockRejectedValue(new Error("optional metadata unavailable")),
			destroy: vi.fn().mockResolvedValue(undefined),
			getPage: vi.fn(),
		};
		const { pdfText } = await loadMockPdfText(document);
		const evidence = await pdfText.extractPdfEvidence(
			{ path: "A/sample.pdf" } as TFile,
			mockVault(),
			3,
			"plugins/pdf-intake/pdf.worker.mjs",
		);
		expect(evidence).toEqual({ pages: [] });
		expect(document.destroy).toHaveBeenCalledTimes(1);
	});

	it("checks cancellation after an unabortable vault read and avoids worker initialization", async () => {
		let canceled = false;
		const vault = mockVault();
		const readBinaryCalls = (): number => vault.readBinary.mock.calls.length;
		vault.readBinary.mockImplementation(() => {
			canceled = true;
			return Promise.resolve(new ArrayBuffer(8));
		});
		const adapterReadCalls = (): number => vault.adapter.read.mock.calls.length;
		const { pdfText } = await loadMockPdfText({
			numPages: 0,
			getMetadata: vi.fn(),
			destroy: vi.fn().mockResolvedValue(undefined),
			getPage: vi.fn(),
		});
		await expect(
			pdfText.extractPdfEvidence(
				{ path: "A/sample.pdf" } as TFile,
				vault,
				3,
				"plugins/pdf-intake/pdf.worker.mjs",
				{ shouldCancel: () => canceled },
			),
		).rejects.toBeInstanceOf(pdfText.IdentificationCancelledError);
		expect(readBinaryCalls()).toBe(1);
		expect(adapterReadCalls()).toBe(0);
	});

	it("checks cancellation after worker setup before creating a PDF loading task", async () => {
		let canceled = false;
		const worker = new StubWorker("blob:worker");
		const workerConstructor = vi.fn(() => worker);
		const document = {
			numPages: 0,
			getMetadata: vi.fn(),
			destroy: vi.fn().mockResolvedValue(undefined),
			getPage: vi.fn(),
		};
		const { pdfText, getDocument } = await loadMockPdfText(document);
		vi.stubGlobal("Worker", workerConstructor);
		const vault = mockVault();
		vault.adapter.read.mockImplementation(() => {
			canceled = true;
			return Promise.resolve("worker source");
		});
		await expect(
			pdfText.extractPdfEvidence(
				{ path: "A/sample.pdf" } as TFile,
				vault,
				3,
				"plugins/pdf-intake/pdf.worker.mjs",
				{ shouldCancel: () => canceled },
			),
		).rejects.toBeInstanceOf(pdfText.IdentificationCancelledError);
		expect(workerConstructor).toHaveBeenCalledTimes(1);
		expect(getDocument).not.toHaveBeenCalled();
		expect(document.getPage).not.toHaveBeenCalled();
		pdfText.terminatePdfWorker();
		expect(worker.terminated).toBe(true);
	});

	it("destroys the document and rejects cancellation between page reads", async () => {
		let pageReads = 0;
		const document = {
			numPages: 3,
			getMetadata: vi.fn().mockResolvedValue({ info: {} }),
			getPage: vi.fn(() =>
				Promise.resolve({
					getTextContent: vi.fn(() => {
						pageReads++;
						return Promise.resolve({
							items: [{ str: "A useful title segment", hasEOL: true }],
						});
					}),
				}),
			),
			destroy: vi.fn().mockResolvedValue(undefined),
		};
		const { pdfText } = await loadMockPdfText(document);
		await expect(
			pdfText.extractPdfEvidence(
				{ path: "A/sample.pdf" } as TFile,
				mockVault(),
				3,
				"plugins/pdf-intake/pdf.worker.mjs",
				{ shouldCancel: () => pageReads >= 1 },
			),
		).rejects.toBeInstanceOf(pdfText.IdentificationCancelledError);
		expect(pageReads).toBe(1);
		expect(document.destroy).toHaveBeenCalledTimes(1);
	});

	it("contains worker initialization errors to the extraction operation", async () => {
		const workerConstructor = vi.fn(() => {
			throw new DOMException("blocked by worker policy", "SecurityError");
		});
		const { pdfText } = await loadMockPdfText({
			numPages: 0,
			getMetadata: vi.fn(),
			destroy: vi.fn().mockResolvedValue(undefined),
			getPage: vi.fn(),
		});
		vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:failed-pdf-intake-worker");
		const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		vi.stubGlobal("Worker", workerConstructor);
		const vault = mockVault();
		await expect(
			pdfText.extractPdfEvidence(
				{ path: "Inbox/sample.pdf" } as TFile,
				vault,
				3,
				".obsidian/plugins/pdf-intake/pdf.worker.mjs",
			),
		).rejects.toThrow(/Could not initialize PDF.js worker.*blocked by worker policy/);
		expect(workerConstructor).toHaveBeenCalledTimes(1);
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:failed-pdf-intake-worker");
	});
});
