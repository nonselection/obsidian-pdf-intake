import { readFileSync } from "node:fs";
import { Worker as NodeWorker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";

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

function onePagePdf(text: string): ArrayBuffer {
	const stream = `BT /F1 12 Tf 20 80 Td (${text}) Tj ET`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
	];
	let source = "%PDF-1.4\n";
	const offsets = [0];
	for (let index = 0; index < objects.length; index++) {
		offsets.push(source.length);
		source += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
	}
	const xrefOffset = source.length;
	source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets.slice(1))
		source += `${String(offset).padStart(10, "0")} 00000 n \n`;
	source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
	return new TextEncoder().encode(source).buffer;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	workerInstances.length = 0;
	workerSourceForTest = "";
});

describe("PDF.js isolated worker initialization", () => {
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

	it("loads the local worker asset lazily through a Blob module Worker and cleans it up", async () => {
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
		let disposePdfWorker: (() => void) | undefined;

		try {
			vi.resetModules();
			const pdfText = await import("../src/pdf-text");
			disposePdfWorker = pdfText.terminatePdfWorker;
			expect(workerInstances).toHaveLength(0);
			expect(adapterRead).not.toHaveBeenCalled();

			const text = await pdfText.extractTextForLookup(
				{ path: "Inbox/sample.pdf" } as never,
				vault as never,
				3,
				workerAssetPath,
			);

			expect(text).toContain("10.1234/worker-test");
			expect(adapterRead).toHaveBeenCalledTimes(1);
			expect(workerInstances).toHaveLength(1);
			expect(workerInstances[0].scriptUrl).toBe("blob:pdf-intake-worker");
			expect(workerInstances[0].workerType).toBe("module");
			expect(await createdBlob?.text()).toBe(workerSource);
			expect(createObjectURL).toHaveBeenCalledTimes(1);
			expect((globalThis as typeof globalThis & { pdfjsWorker?: unknown }).pdfjsWorker).toBe(
				sentinel,
			);

			disposePdfWorker();
			expect(workerInstances[0].terminated).toBe(true);
			expect(revokeObjectURL).toHaveBeenCalledWith("blob:pdf-intake-worker");
		} finally {
			disposePdfWorker?.();
			if (previousDescriptor) {
				Object.defineProperty(globalThis, "pdfjsWorker", previousDescriptor);
			} else {
				Reflect.deleteProperty(globalThis, "pdfjsWorker");
			}
		}
	});

	it("contains worker initialization errors to the extraction operation", async () => {
		const workerConstructor = vi.fn(() => {
			throw new DOMException("blocked by worker policy", "SecurityError");
		});
		vi.stubGlobal("Worker", workerConstructor);
		vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:failed-pdf-intake-worker");
		const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		const workerSource = "self.addEventListener('message', () => {});";
		const vault = {
			adapter: { read: vi.fn().mockResolvedValue(workerSource) },
			readBinary: vi.fn().mockResolvedValue(onePagePdf("identifier text")),
		};
		let disposePdfWorker: (() => void) | undefined;

		try {
			vi.resetModules();
			const pdfText = await import("../src/pdf-text");
			disposePdfWorker = pdfText.terminatePdfWorker;
			await expect(
				pdfText.extractTextForLookup(
					{ path: "Inbox/sample.pdf" } as never,
					vault as never,
					3,
					".obsidian/plugins/pdf-intake/pdf.worker.mjs",
				),
			).rejects.toThrow(/Could not initialize PDF.js worker.*blocked by worker policy/);
			expect(workerConstructor).toHaveBeenCalledTimes(1);
			expect(revokeObjectURL).toHaveBeenCalledWith("blob:failed-pdf-intake-worker");
		} finally {
			disposePdfWorker?.();
		}
	});
});
