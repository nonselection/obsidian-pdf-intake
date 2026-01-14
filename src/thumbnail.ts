import { TFile, Vault } from "obsidian";
import * as pdfjsLib from "pdfjs-dist";

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = "";

export async function generateThumbnail(
	file: TFile,
	vault: Vault,
	scale: number,
	pageNumber: number = 1
): Promise<ArrayBuffer> {
	const buffer = await vault.readBinary(file);
	const uint8Array = new Uint8Array(buffer);

	const pdf = await pdfjsLib.getDocument({
		data: uint8Array,
		disableAutoFetch: true,
		disableStream: true,
	}).promise;

	// Handle page number: 0 means last page, negative counts from end
	let targetPage = pageNumber;
	if (targetPage <= 0) {
		targetPage = pdf.numPages + targetPage;
	}
	targetPage = Math.max(1, Math.min(targetPage, pdf.numPages));

	const page = await pdf.getPage(targetPage);
	const viewport = page.getViewport({ scale });

	const canvas = document.createElement("canvas");
	const context = canvas.getContext("2d");

	if (!context) {
		throw new Error("Could not get canvas context");
	}

	canvas.width = viewport.width;
	canvas.height = viewport.height;

	await page.render({
		canvasContext: context,
		viewport,
	}).promise;

	return await canvasToPng(canvas);
}

async function canvasToPng(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => {
				if (!blob) {
					reject(new Error("Failed to create blob from canvas"));
					return;
				}
				blob.arrayBuffer().then(resolve).catch(reject);
			},
			"image/png",
			0.9
		);
	});
}

export function getThumbnailPath(pdfPath: string, folder: string): string {
	const fileName = getFileNameWithoutExtension(pdfPath);
	return `${folder}/${fileName}.png`;
}

export async function saveThumbnail(
	pdfFile: TFile,
	thumbnailData: ArrayBuffer,
	folder: string,
	vault: Vault
): Promise<string> {
	const thumbnailPath = getThumbnailPath(pdfFile.path, folder);

	// Ensure folder exists
	await ensureFolderExists(folder, vault);

	// Check if thumbnail already exists
	const existing = vault.getAbstractFileByPath(thumbnailPath);
	if (existing instanceof TFile) {
		await vault.modifyBinary(existing, thumbnailData);
	} else {
		await vault.createBinary(thumbnailPath, thumbnailData);
	}

	return thumbnailPath;
}

async function ensureFolderExists(folderPath: string, vault: Vault): Promise<void> {
	const parts = folderPath.split("/");
	let currentPath = "";

	for (const part of parts) {
		currentPath = currentPath ? `${currentPath}/${part}` : part;
		const folder = vault.getAbstractFileByPath(currentPath);
		if (!folder) {
			await vault.createFolder(currentPath);
		}
	}
}

function getFileNameWithoutExtension(path: string): string {
	const parts = path.split("/");
	const fileName = parts[parts.length - 1];
	return fileName.replace(/\.pdf$/i, "");
}

export function getThumbnailEmbed(thumbnailPath: string): string {
	return `![[${thumbnailPath}]]`;
}

export async function getPdfPageCount(file: TFile, vault: Vault): Promise<number> {
	const buffer = await vault.readBinary(file);
	const uint8Array = new Uint8Array(buffer);

	const pdf = await pdfjsLib.getDocument({
		data: uint8Array,
		disableAutoFetch: true,
		disableStream: true,
	}).promise;

	return pdf.numPages;
}

export interface ThumbnailResult {
	page: number;
	data: ArrayBuffer;
	path?: string;
}

export async function generateMultipleThumbnails(
	file: TFile,
	vault: Vault,
	scale: number,
	pageCount: number
): Promise<ThumbnailResult[]> {
	const buffer = await vault.readBinary(file);
	const uint8Array = new Uint8Array(buffer);

	const pdf = await pdfjsLib.getDocument({
		data: uint8Array,
		disableAutoFetch: true,
		disableStream: true,
	}).promise;

	const results: ThumbnailResult[] = [];
	const pagesToRender = Math.min(pageCount, pdf.numPages);

	for (let i = 1; i <= pagesToRender; i++) {
		const page = await pdf.getPage(i);
		const viewport = page.getViewport({ scale });

		const canvas = document.createElement("canvas");
		const context = canvas.getContext("2d");

		if (!context) {
			throw new Error("Could not get canvas context");
		}

		canvas.width = viewport.width;
		canvas.height = viewport.height;

		await page.render({
			canvasContext: context,
			viewport,
		}).promise;

		const data = await canvasToPng(canvas);
		results.push({ page: i, data });
	}

	return results;
}

export async function saveMultipleThumbnails(
	pdfFile: TFile,
	thumbnails: ThumbnailResult[],
	folder: string,
	vault: Vault
): Promise<string[]> {
	await ensureFolderExists(folder, vault);

	const paths: string[] = [];
	const baseName = getFileNameWithoutExtension(pdfFile.path);

	for (const thumb of thumbnails) {
		const thumbnailPath = `${folder}/${baseName}-p${thumb.page}.png`;

		const existing = vault.getAbstractFileByPath(thumbnailPath);
		if (existing instanceof TFile) {
			await vault.modifyBinary(existing, thumb.data);
		} else {
			await vault.createBinary(thumbnailPath, thumb.data);
		}

		paths.push(thumbnailPath);
	}

	return paths;
}

export async function generateThumbnailAsDataUrl(
	file: TFile,
	vault: Vault,
	scale: number,
	pageNumber: number = 1
): Promise<string> {
	const buffer = await vault.readBinary(file);
	const uint8Array = new Uint8Array(buffer);

	const pdf = await pdfjsLib.getDocument({
		data: uint8Array,
		disableAutoFetch: true,
		disableStream: true,
	}).promise;

	let targetPage = pageNumber;
	if (targetPage <= 0) {
		targetPage = pdf.numPages + targetPage;
	}
	targetPage = Math.max(1, Math.min(targetPage, pdf.numPages));

	const page = await pdf.getPage(targetPage);
	const viewport = page.getViewport({ scale });

	const canvas = document.createElement("canvas");
	const context = canvas.getContext("2d");

	if (!context) {
		throw new Error("Could not get canvas context");
	}

	canvas.width = viewport.width;
	canvas.height = viewport.height;

	await page.render({
		canvasContext: context,
		viewport,
	}).promise;

	return canvas.toDataURL("image/png");
}
