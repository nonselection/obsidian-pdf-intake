import { PDFDocument, StandardFonts } from "pdf-lib";
import { writeFileSync } from "fs";

const pdf = await PDFDocument.create();

// Set metadata
pdf.setTitle("Test Document for PDF Metadata Plugin");
pdf.setAuthor("Luca Gabriel Oelfke");
pdf.setSubject("Testing PDF metadata extraction");
pdf.setKeywords(["test", "obsidian", "plugin", "metadata"]);
pdf.setCreator("pdf-lib test script");
pdf.setProducer("pdf-lib");
pdf.setCreationDate(new Date());
pdf.setModificationDate(new Date());

// Add a page with some content
const page = pdf.addPage([595, 842]); // A4 size
const font = await pdf.embedFont(StandardFonts.Helvetica);

page.drawText("PDF Metadata Plugin Test", {
	x: 50,
	y: 750,
	size: 24,
	font,
});

page.drawText("This PDF contains embedded metadata for testing.", {
	x: 50,
	y: 700,
	size: 12,
	font,
});

page.drawText("Metadata fields:", {
	x: 50,
	y: 650,
	size: 14,
	font,
});

const metadata = [
	"Title: Test Document for PDF Metadata Plugin",
	"Author: Luca Gabriel Oelfke",
	"Subject: Testing PDF metadata extraction",
	"Keywords: test, obsidian, plugin, metadata",
];

metadata.forEach((line, i) => {
	page.drawText(`• ${line}`, {
		x: 70,
		y: 620 - i * 25,
		size: 11,
		font,
	});
});

const pdfBytes = await pdf.save();
writeFileSync("/home/luca/vault/test-document.pdf", pdfBytes);

console.log("Created: /home/luca/vault/test-document.pdf");
