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

export async function extractTextForLookup(
	file: TFile,
	vault: Vault,
	maxPages = 3,
	workerAssetPath?: string,
): Promise<string> {
	const buffer = await vault.readBinary(file);
	if (!workerAssetPath) throw new Error("PDF.js worker asset path is unavailable");
	await ensurePdfWorker(vault, workerAssetPath);
	const pdf = await pdfjsLib.getDocument({
		data: new Uint8Array(buffer),
		disableAutoFetch: true,
		disableStream: true,
	}).promise;
	try {
		const pages: string[] = [];
		for (let pageNumber = 1; pageNumber <= Math.min(maxPages, pdf.numPages); pageNumber++) {
			const page = await pdf.getPage(pageNumber);
			const content = await page.getTextContent();
			pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
		}
		return pages.join("\n");
	} finally {
		await pdf.destroy();
	}
}
