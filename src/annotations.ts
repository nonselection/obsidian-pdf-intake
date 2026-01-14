import { TFile, Vault } from "obsidian";
import * as pdfjsLib from "pdfjs-dist";
import { AnnotationType, AnnotationGrouping, PdfAnnotation } from "./types";

interface TextItem {
	str: string;
	transform: number[];
	width: number;
	height: number;
}

const HIGHLIGHT_TYPES: AnnotationType[] = ["Highlight", "Underline", "StrikeOut", "Squiggly"];

export async function extractAnnotations(
	file: TFile,
	vault: Vault,
	allowedTypes?: AnnotationType[]
): Promise<PdfAnnotation[]> {
	const buffer = await vault.readBinary(file);
	const uint8Array = new Uint8Array(buffer);

	const pdf = await pdfjsLib.getDocument({
		data: uint8Array,
		disableAutoFetch: true,
		disableStream: true,
	}).promise;

	const annotations: PdfAnnotation[] = [];

	for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
		const page = await pdf.getPage(pageNum);
		const pageAnnotations = await page.getAnnotations({ intent: "display" });

		for (const annot of pageAnnotations) {
			const type = annot.subtype as AnnotationType;

			if (!isRelevantType(type)) continue;
			if (allowedTypes && !allowedTypes.includes(type)) continue;

			const annotation: PdfAnnotation = {
				id: annot.id || `${pageNum}-${annotations.length}`,
				type,
				pageNumber: pageNum,
				rect: annot.rect as [number, number, number, number],
				color: annot.color,
				contents: annot.contents,
				author: annot.title,
				creationDate: parseDate(annot.creationDate),
				modificationDate: parseDate(annot.modificationDate),
			};

			// Extract text from highlight-type annotations
			if (isHighlightType(type) && annot.quadPoints) {
				annotation.extractedText = await extractTextFromQuadPoints(
					page,
					annot.quadPoints
				);
			}

			annotations.push(annotation);
		}
	}

	return annotations;
}

function isRelevantType(type: string): type is AnnotationType {
	const relevantTypes: string[] = [
		"Highlight",
		"Underline",
		"StrikeOut",
		"Squiggly",
		"FreeText",
		"Text",
		"Ink",
	];
	return relevantTypes.includes(type);
}

function isHighlightType(type: AnnotationType): boolean {
	return HIGHLIGHT_TYPES.includes(type);
}

function parseDate(dateStr: string | undefined): Date | undefined {
	if (!dateStr) return undefined;

	// PDF date format: D:YYYYMMDDHHmmSS or similar
	if (dateStr.startsWith("D:")) {
		const match = dateStr.match(/D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/);
		if (match) {
			const [, year, month, day, hour = "0", min = "0", sec = "0"] = match;
			return new Date(
				parseInt(year),
				parseInt(month) - 1,
				parseInt(day),
				parseInt(hour),
				parseInt(min),
				parseInt(sec)
			);
		}
	}

	const parsed = new Date(dateStr);
	return isNaN(parsed.getTime()) ? undefined : parsed;
}

async function extractTextFromQuadPoints(
	page: { getTextContent: () => Promise<{ items: unknown[] }>; getViewport: (opts: { scale: number }) => { scale: number } },
	quadPoints: number[]
): Promise<string | null> {
	try {
		const textContent = await page.getTextContent();
		const viewport = page.getViewport({ scale: 1 });

		// Convert quadPoints to rectangles
		// QuadPoints are 8 values per quad: x1,y1,x2,y2,x3,y3,x4,y4 (corners)
		const rects = quadPointsToRects(quadPoints);

		if (rects.length === 0) return null;

		// Filter text items that intersect with highlight rectangles
		const matchingItems: { item: TextItem; index: number }[] = [];

		for (let i = 0; i < textContent.items.length; i++) {
			const item = textContent.items[i];
			if (!("str" in item)) continue;

			const textItem = item as TextItem;
			if (!textItem.str.trim()) continue;

			// Get item bounds in PDF coordinates
			const itemRect = getTextItemRect(textItem, viewport);

			// Check if item intersects any highlight rect
			for (const rect of rects) {
				if (rectsIntersect(itemRect, rect)) {
					matchingItems.push({ item: textItem, index: i });
					break;
				}
			}
		}

		if (matchingItems.length === 0) return null;

		// Sort by index to maintain reading order
		matchingItems.sort((a, b) => a.index - b.index);

		// Join text with proper spacing
		let result = "";
		for (let i = 0; i < matchingItems.length; i++) {
			const { item } = matchingItems[i];
			if (i > 0 && item.str[0] !== " " && !result.endsWith(" ")) {
				result += " ";
			}
			result += item.str;
		}

		return result.trim() || null;
	} catch (error) {
		console.error("Failed to extract text from highlight:", error);
		return null;
	}
}

function quadPointsToRects(quadPoints: number[]): Rect[] {
	const rects: Rect[] = [];

	// QuadPoints: array of [x1,y1,x2,y2,x3,y3,x4,y4] for each quad
	// Points are: bottom-left, bottom-right, top-right, top-left
	for (let i = 0; i < quadPoints.length; i += 8) {
		const x1 = Math.min(quadPoints[i], quadPoints[i + 2], quadPoints[i + 4], quadPoints[i + 6]);
		const x2 = Math.max(quadPoints[i], quadPoints[i + 2], quadPoints[i + 4], quadPoints[i + 6]);
		const y1 = Math.min(quadPoints[i + 1], quadPoints[i + 3], quadPoints[i + 5], quadPoints[i + 7]);
		const y2 = Math.max(quadPoints[i + 1], quadPoints[i + 3], quadPoints[i + 5], quadPoints[i + 7]);

		rects.push({ x1, y1, x2, y2 });
	}

	return rects;
}

interface Rect {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

function getTextItemRect(item: TextItem, viewport: { scale: number }): Rect {
	// TextItem has transform: [scaleX, skewX, skewY, scaleY, x, y]
	const transform = item.transform;
	const x = transform[4];
	const y = transform[5];
	const width = item.width;
	const height = item.height;

	return {
		x1: x,
		y1: y,
		x2: x + width,
		y2: y + height,
	};
}

function rectsIntersect(a: Rect, b: Rect): boolean {
	// Add small tolerance for floating point issues
	const tolerance = 0.5;
	return !(
		a.x2 < b.x1 - tolerance ||
		a.x1 > b.x2 + tolerance ||
		a.y2 < b.y1 - tolerance ||
		a.y1 > b.y2 + tolerance
	);
}

// Formatting functions

export function formatAnnotationsForNote(
	annotations: PdfAnnotation[],
	grouping: AnnotationGrouping,
	includeColors: boolean
): string {
	if (annotations.length === 0) {
		return "";
	}

	switch (grouping) {
		case "type":
			return formatByType(annotations, includeColors);
		case "page":
			return formatByPage(annotations, includeColors);
		case "date":
			return formatByDate(annotations, includeColors);
		case "flat":
		default:
			return formatFlat(annotations, includeColors);
	}
}

function formatByType(annotations: PdfAnnotation[], includeColors: boolean): string {
	const groups = new Map<AnnotationType, PdfAnnotation[]>();

	for (const annot of annotations) {
		const group = groups.get(annot.type) || [];
		group.push(annot);
		groups.set(annot.type, group);
	}

	const sections: string[] = [];

	const typeOrder: AnnotationType[] = [
		"Highlight",
		"Underline",
		"StrikeOut",
		"Squiggly",
		"Text",
		"FreeText",
		"Ink",
	];

	for (const type of typeOrder) {
		const group = groups.get(type);
		if (!group || group.length === 0) continue;

		const typeName = getTypeName(type);
		const items = group.map((a) => formatSingleAnnotation(a, includeColors, true));

		sections.push(`### ${typeName}\n\n${items.join("\n\n")}`);
	}

	return sections.join("\n\n");
}

function formatByPage(annotations: PdfAnnotation[], includeColors: boolean): string {
	const groups = new Map<number, PdfAnnotation[]>();

	for (const annot of annotations) {
		const group = groups.get(annot.pageNumber) || [];
		group.push(annot);
		groups.set(annot.pageNumber, group);
	}

	const pages = Array.from(groups.keys()).sort((a, b) => a - b);
	const sections: string[] = [];

	for (const page of pages) {
		const group = groups.get(page)!;
		const items = group.map((a) => formatSingleAnnotation(a, includeColors, false));

		sections.push(`### Page ${page}\n\n${items.join("\n\n")}`);
	}

	return sections.join("\n\n");
}

function formatByDate(annotations: PdfAnnotation[], includeColors: boolean): string {
	const sorted = [...annotations].sort((a, b) => {
		const dateA = a.creationDate?.getTime() || 0;
		const dateB = b.creationDate?.getTime() || 0;
		return dateA - dateB;
	});

	const items = sorted.map((a, i) => {
		const date = a.creationDate ? formatDate(a.creationDate) : "Unknown date";
		const content = formatSingleAnnotation(a, includeColors, true);
		return `${i + 1}. **${date}** - ${content}`;
	});

	return items.join("\n\n");
}

function formatFlat(annotations: PdfAnnotation[], includeColors: boolean): string {
	const items = annotations.map((a) => formatSingleAnnotation(a, includeColors, true));
	return items.join("\n\n");
}

function formatSingleAnnotation(
	annotation: PdfAnnotation,
	includeColors: boolean,
	includePage: boolean
): string {
	const parts: string[] = [];

	// Color indicator
	if (includeColors && annotation.color) {
		const colorHex = rgbToHex(annotation.color);
		parts.push(`<span style="color: ${colorHex};">●</span>`);
	}

	// Page reference
	const pageRef = includePage ? ` (p. ${annotation.pageNumber})` : "";

	// Content based on type
	if (isHighlightType(annotation.type)) {
		if (annotation.extractedText) {
			parts.push(`> "${annotation.extractedText}"${pageRef}`);
		} else if (annotation.contents) {
			parts.push(`> ${annotation.contents}${pageRef}`);
		} else {
			parts.push(`- ${getTypeName(annotation.type)}${pageRef}`);
		}

		// Add comment if present alongside highlight
		if (annotation.contents && annotation.extractedText) {
			parts.push(`\n  - Note: ${annotation.contents}`);
		}
	} else if (annotation.type === "Text" || annotation.type === "FreeText") {
		const content = annotation.contents || "(empty)";
		parts.push(`- **${getTypeName(annotation.type)}**${pageRef}: ${content}`);
	} else if (annotation.type === "Ink") {
		parts.push(`- **Drawing**${pageRef}${annotation.contents ? `: ${annotation.contents}` : ""}`);
	} else {
		parts.push(`- ${annotation.contents || getTypeName(annotation.type)}${pageRef}`);
	}

	// Author
	if (annotation.author) {
		parts.push(`\n  - Author: ${annotation.author}`);
	}

	return parts.join("");
}

function getTypeName(type: AnnotationType): string {
	const names: Record<AnnotationType, string> = {
		Highlight: "Highlights",
		Underline: "Underlines",
		StrikeOut: "Strikethroughs",
		Squiggly: "Squiggly Underlines",
		FreeText: "Free Text",
		Text: "Comments",
		Ink: "Drawings",
	};
	return names[type] || type;
}

function rgbToHex(color: number[]): string {
	if (color.length < 3) return "#ffff00"; // Default yellow

	// PDF colors can be 0-1 or 0-255
	const normalize = (v: number) => (v <= 1 ? Math.round(v * 255) : Math.round(v));

	const r = normalize(color[0]);
	const g = normalize(color[1]);
	const b = normalize(color[2]);

	return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function formatDate(date: Date): string {
	return date.toISOString().split("T")[0];
}

export function hasAnnotations(annotations: PdfAnnotation[]): boolean {
	return annotations.length > 0;
}

export function getAnnotationStats(annotations: PdfAnnotation[]): Record<AnnotationType, number> {
	const stats: Partial<Record<AnnotationType, number>> = {};

	for (const annot of annotations) {
		stats[annot.type] = (stats[annot.type] || 0) + 1;
	}

	return stats as Record<AnnotationType, number>;
}
