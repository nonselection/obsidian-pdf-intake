import type { TFile, Vault } from "obsidian";
import * as pdfjsLib from "pdfjs-dist";

let ownedWorker: Worker | null = null;
let workerBlobUrl: string | null = null;
let workerInitialization: Promise<Worker> | null = null;
let workerGeneration = 0;

async function initializePdfWorker(vault: Vault, assetPath: string): Promise<Worker> {
	let blobUrl: string | null = null;
	let worker: Worker | null = null;
	const generation = workerGeneration;
	try {
		const source = await vault.adapter.read(assetPath);
		if (generation !== workerGeneration) throw new Error("PDF Intake was unloaded");
		blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
		worker = new Worker(blobUrl, { type: "module" });
		if (generation !== workerGeneration) throw new Error("PDF Intake was unloaded");
		pdfjsLib.GlobalWorkerOptions.workerPort = worker;
		ownedWorker = worker;
		workerBlobUrl = blobUrl;
		return worker;
	} catch (error) {
		worker?.terminate();
		if (blobUrl) URL.revokeObjectURL(blobUrl);
		const detail = error instanceof Error ? error.message : String(error);
		const wrappedError = new Error(
			`Could not initialize PDF.js worker from ${assetPath}: ${detail}`,
		);
		Object.defineProperty(wrappedError, "cause", { value: error });
		throw wrappedError;
	}
}

async function ensurePdfWorker(vault: Vault, assetPath: string): Promise<void> {
	if (ownedWorker) return;
	if (!workerInitialization) workerInitialization = initializePdfWorker(vault, assetPath);
	const initialization = workerInitialization;
	try {
		await initialization;
	} finally {
		if (workerInitialization === initialization) workerInitialization = null;
	}
}

export function terminatePdfWorker(): void {
	workerGeneration++;
	workerInitialization = null;
	const worker = ownedWorker;
	ownedWorker = null;
	if (pdfjsLib.GlobalWorkerOptions.workerPort === worker) {
		pdfjsLib.GlobalWorkerOptions.workerPort = null;
	}
	worker?.terminate();
	if (workerBlobUrl) URL.revokeObjectURL(workerBlobUrl);
	workerBlobUrl = null;
}

export interface PdfTextSegment {
	pageNumber: number;
	text: string;
	startOffset: number;
}

export interface PdfTextPage {
	pageNumber: number;
	text: string;
	segments: readonly PdfTextSegment[];
}

export interface PdfTextEvidence {
	pages: readonly PdfTextPage[];
	infoTitle?: string;
}

export class IdentificationCancelledError extends Error {
	constructor() {
		super("PDF identification work was canceled");
		this.name = "IdentificationCancelledError";
	}
}

export interface PdfExtractionOptions {
	shouldCancel?: () => boolean;
}

function checkpoint(options?: PdfExtractionOptions): void {
	if (options?.shouldCancel?.()) throw new IdentificationCancelledError();
}

function assemblePageSegments(pageNumber: number, items: readonly unknown[]): PdfTextPage {
	const rawSegments: string[] = [];
	let current = "";
	const flush = (): void => {
		const text = current.trim();
		if (text) rawSegments.push(text);
		current = "";
	};
	for (const item of items) {
		if (item && typeof item === "object" && "str" in item && typeof item.str === "string") {
			const text = item.str.trim();
			if (text) current = current ? current + " " + text : text;
			if ("hasEOL" in item && item.hasEOL === true) flush();
		}
	}
	flush();
	const segments: PdfTextSegment[] = [];
	let offset = 0;
	for (const text of rawSegments) {
		segments.push({ pageNumber, text, startOffset: offset });
		offset += text.length + 1;
	}
	return {
		pageNumber,
		text: rawSegments.join("\n"),
		segments,
	};
}

export async function extractPdfEvidence(
	file: TFile,
	vault: Vault,
	maxPages = 3,
	workerAssetPath?: string,
	options?: PdfExtractionOptions,
): Promise<PdfTextEvidence> {
	checkpoint(options);
	const buffer = await vault.readBinary(file);
	checkpoint(options);
	if (!workerAssetPath) throw new Error("PDF.js worker asset path is unavailable");
	checkpoint(options);
	await ensurePdfWorker(vault, workerAssetPath);
	checkpoint(options);
	const loadingTask = pdfjsLib.getDocument({
		data: new Uint8Array(buffer),
		disableAutoFetch: true,
		disableStream: true,
	});
	let pdf: Awaited<typeof loadingTask.promise> | undefined;
	try {
		checkpoint(options);
		pdf = await loadingTask.promise;
		checkpoint(options);
		let infoTitle: string | undefined;
		try {
			const metadata = await pdf.getMetadata();
			const info = metadata.info as Record<string, unknown> | undefined;
			if (typeof info?.Title === "string" && info.Title.trim()) infoTitle = info.Title;
		} catch {
			// PDF Info metadata is optional evidence; extraction can continue without it.
		}
		const pages: PdfTextPage[] = [];
		const pageLimit = Math.min(3, Math.max(0, Math.floor(maxPages)), pdf.numPages);
		for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber++) {
			checkpoint(options);
			const page = await pdf.getPage(pageNumber);
			const content = await page.getTextContent();
			checkpoint(options);
			pages.push(assemblePageSegments(pageNumber, content.items));
		}
		checkpoint(options);
		return { pages, ...(infoTitle ? { infoTitle } : {}) };
	} finally {
		try {
			if (pdf) await pdf.destroy();
			else await loadingTask.destroy();
		} catch {
			// Cleanup failures do not replace the extraction outcome or leak PDF.js resources silently.
		}
	}
}
