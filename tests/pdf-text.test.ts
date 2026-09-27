import { describe, expect, it, vi } from "vitest";
import { extractTextForLookup } from "../src/pdf-text";

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

describe("PDF.js bundled worker initialization", () => {
	it("extracts text through the bundled main-thread worker", async () => {
		const data = onePagePdf("doi: 10.1234/worker-test");
		const vault = { readBinary: vi.fn().mockResolvedValue(data) };
		const text = await extractTextForLookup(
			{ path: "Inbox/sample.pdf" } as never,
			vault as never,
		);
		expect(text).toContain("10.1234/worker-test");
	});
});
