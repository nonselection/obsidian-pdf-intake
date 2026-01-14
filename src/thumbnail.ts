import { TFile, Vault } from "obsidian";
import * as pdfjsLib from "pdfjs-dist";

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = "";

export async function generateThumbnail(
	file: TFile,
	vault: Vault,
	scale: number
): Promise<ArrayBuffer> {
	const buffer = await vault.readBinary(file);
	const uint8Array = new Uint8Array(buffer);

	const pdf = await pdfjsLib.getDocument({
		data: uint8Array,
		disableAutoFetch: true,
		disableStream: true,
	}).promise;

	const page = await pdf.getPage(1);
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
