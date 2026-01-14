#!/usr/bin/env node

/**
 * Generate test PDFs for plugin development
 * Run: node scripts/generate-test-pdfs.mjs <output-folder>
 */

import { PDFDocument, rgb, StandardFonts, PDFName, PDFString, PDFArray, PDFDict, PDFNumber } from "pdf-lib";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

const outputFolder = process.argv[2] || "./test-pdfs";

async function main() {
	await mkdir(outputFolder, { recursive: true });
	console.log(`Generating test PDFs in: ${outputFolder}\n`);

	// 1. Academic paper with DOI and annotations
	await createAcademicPaper();

	// 2. Book with ISBN
	await createBook();

	// 3. Multi-page document with various annotations
	await createAnnotatedDocument();

	// 4. PDF with minimal metadata
	await createMinimalPdf();

	// 5. PDF with full metadata
	await createFullMetadataPdf();

	// 6. Complex document with mixed content
	await createComplexDocument();

	console.log("\nDone! Generated 6 test PDFs.");
}

async function createAcademicPaper() {
	const pdf = await PDFDocument.create();
	const font = await pdf.embedFont(StandardFonts.TimesRoman);
	const boldFont = await pdf.embedFont(StandardFonts.TimesRomanBold);

	// Metadata
	pdf.setTitle("Machine Learning Approaches for Natural Language Processing");
	pdf.setAuthor("Dr. Sarah Chen, Prof. Michael Roberts");
	pdf.setSubject("Artificial Intelligence, NLP, Deep Learning");
	pdf.setKeywords(["machine learning", "NLP", "neural networks", "transformers"]);
	pdf.setCreator("LaTeX with hyperref");
	pdf.setProducer("pdfTeX-1.40.25");
	pdf.setCreationDate(new Date("2024-03-15"));
	pdf.setModificationDate(new Date("2024-06-20"));

	// Page 1 - Title page
	const page1 = pdf.addPage([612, 792]);
	const { width, height } = page1.getSize();

	page1.drawText("Machine Learning Approaches for", {
		x: 50, y: height - 150, size: 24, font: boldFont
	});
	page1.drawText("Natural Language Processing", {
		x: 50, y: height - 180, size: 24, font: boldFont
	});
	page1.drawText("Dr. Sarah Chen¹, Prof. Michael Roberts²", {
		x: 50, y: height - 230, size: 14, font
	});
	page1.drawText("¹ Stanford University, ² MIT", {
		x: 50, y: height - 250, size: 12, font
	});
	page1.drawText("DOI: 10.1038/s41586-024-07893-2", {
		x: 50, y: height - 290, size: 11, font
	});
	page1.drawText("Published in Nature, Volume 628, March 2024", {
		x: 50, y: height - 310, size: 11, font
	});

	// Abstract
	page1.drawText("Abstract", {
		x: 50, y: height - 360, size: 14, font: boldFont
	});
	const abstractText = `This paper presents a comprehensive survey of machine learning approaches for natural language processing (NLP). We examine recent advances in transformer architectures, including BERT, GPT, and their variants. Our analysis covers pre-training strategies, fine-tuning methods, and their applications to various NLP tasks such as sentiment analysis, machine translation, and question answering.`;
	drawWrappedText(page1, abstractText, 50, height - 385, 512, 12, font);

	// Add highlight annotation on "machine learning"
	addHighlightAnnotation(page1, 145, height - 365, 280, height - 350, [1, 1, 0]);

	// Add note annotation
	addNoteAnnotation(page1, 530, height - 290, "Important: This DOI can be used for citation lookup", [1, 0.8, 0]);

	// Page 2 - Introduction
	const page2 = pdf.addPage([612, 792]);
	page2.drawText("1. Introduction", {
		x: 50, y: height - 80, size: 16, font: boldFont
	});
	const introText = `Natural Language Processing has undergone a revolutionary transformation with the advent of deep learning techniques. The introduction of attention mechanisms and transformer architectures has enabled unprecedented performance on a wide range of language understanding tasks.

The key contributions of this work include:
• A systematic review of transformer-based models
• Comparative analysis of pre-training objectives
• Evaluation on standard NLP benchmarks
• Discussion of computational efficiency trade-offs

Recent work by Vaswani et al. (2017) introduced the transformer architecture, which has become the foundation for modern NLP systems. Building on this, BERT (Devlin et al., 2019) demonstrated the power of bidirectional pre-training.`;
	drawWrappedText(page2, introText, 50, height - 110, 512, 12, font);

	// Add underline annotation
	addUnderlineAnnotation(page2, 50, height - 110, 350, height - 98);

	// Add strikeout annotation
	addStrikeoutAnnotation(page2, 50, height - 280, 200, height - 268);

	// Page 3 - Methods
	const page3 = pdf.addPage([612, 792]);
	page3.drawText("2. Methodology", {
		x: 50, y: height - 80, size: 16, font: boldFont
	});
	const methodsText = `Our experimental framework consists of three main components:

2.1 Data Collection
We compiled a diverse corpus of 500 million tokens from academic papers, news articles, and web text. The data was preprocessed using standard NLP pipelines including tokenization, lowercasing, and subword segmentation.

2.2 Model Architecture
We implement a 12-layer transformer encoder with 768 hidden dimensions and 12 attention heads. The model contains approximately 110 million parameters.

2.3 Training Procedure
Models were trained on 8 NVIDIA A100 GPUs for 1 million steps with a batch size of 256. We used the AdamW optimizer with a learning rate of 1e-4 and linear warmup over 10,000 steps.`;
	drawWrappedText(page3, methodsText, 50, height - 110, 512, 12, font);

	// Add freetext annotation
	addFreeTextAnnotation(page3, 400, height - 200, 180, 60, "Review: Strong methodology section");

	// Add multiple highlight annotations
	addHighlightAnnotation(page3, 50, height - 180, 200, height - 168, [0, 1, 0.5]); // Cyan
	addHighlightAnnotation(page3, 50, height - 320, 300, height - 308, [1, 0.5, 0.5]); // Pink

	const pdfBytes = await pdf.save();
	const filename = "academic-paper-with-doi.pdf";
	await writeFile(join(outputFolder, filename), pdfBytes);
	console.log(`✓ ${filename} (3 pages, DOI, 7 annotations)`);
}

async function createBook() {
	const pdf = await PDFDocument.create();
	const font = await pdf.embedFont(StandardFonts.TimesRoman);
	const boldFont = await pdf.embedFont(StandardFonts.TimesRomanBold);
	const italicFont = await pdf.embedFont(StandardFonts.TimesRomanItalic);

	// Metadata
	pdf.setTitle("The Art of Software Architecture: Principles and Practices");
	pdf.setAuthor("Jonathan Hughes");
	pdf.setSubject("Software Engineering, Architecture, Design Patterns");
	pdf.setKeywords(["software architecture", "design patterns", "microservices", "clean code"]);
	pdf.setCreator("Adobe InDesign 2024");
	pdf.setProducer("Adobe PDF Library 17.0");
	pdf.setCreationDate(new Date("2023-09-01"));

	// Page 1 - Title page
	const page1 = pdf.addPage([612, 792]);
	const { width, height } = page1.getSize();

	page1.drawText("The Art of", {
		x: 150, y: height - 200, size: 32, font: italicFont
	});
	page1.drawText("SOFTWARE", {
		x: 100, y: height - 250, size: 48, font: boldFont
	});
	page1.drawText("ARCHITECTURE", {
		x: 70, y: height - 300, size: 40, font: boldFont
	});
	page1.drawText("Principles and Practices", {
		x: 150, y: height - 350, size: 20, font: italicFont
	});
	page1.drawText("Jonathan Hughes", {
		x: 200, y: height - 420, size: 18, font
	});
	page1.drawText("O'Reilly Media", {
		x: 220, y: height - 500, size: 14, font
	});
	page1.drawText("ISBN-13: 978-1-492-04367-5", {
		x: 190, y: height - 540, size: 12, font
	});
	page1.drawText("ISBN-10: 1-492-04367-8", {
		x: 200, y: height - 560, size: 12, font
	});

	// Page 2 - Copyright
	const page2 = pdf.addPage([612, 792]);
	page2.drawText("Copyright © 2023 Jonathan Hughes", {
		x: 50, y: height - 100, size: 11, font
	});
	page2.drawText("All rights reserved. Published by O'Reilly Media, Inc.", {
		x: 50, y: height - 120, size: 11, font
	});
	page2.drawText("ISBN: 978-1-492-04367-5", {
		x: 50, y: height - 160, size: 11, font
	});
	page2.drawText("First Edition: September 2023", {
		x: 50, y: height - 180, size: 11, font
	});

	// Page 3 - Table of Contents
	const page3 = pdf.addPage([612, 792]);
	page3.drawText("Table of Contents", {
		x: 50, y: height - 80, size: 20, font: boldFont
	});

	const toc = [
		"1. Introduction to Software Architecture ............... 1",
		"2. Architectural Patterns .............................. 25",
		"3. Microservices Architecture .......................... 67",
		"4. Event-Driven Architecture .......................... 112",
		"5. Domain-Driven Design ............................... 156",
		"6. Clean Architecture ................................. 198",
		"7. Testing Strategies ................................. 245",
		"8. Performance Optimization ........................... 289",
		"9. Security Considerations ............................ 334",
		"10. Case Studies ...................................... 378"
	];

	toc.forEach((line, i) => {
		page3.drawText(line, {
			x: 50, y: height - 130 - (i * 25), size: 12, font
		});
	});

	// Add note annotation on chapter 3
	addNoteAnnotation(page3, 530, height - 180, "Focus on this chapter for the project", [0.5, 0.8, 1]);

	// Page 4 - Chapter 1
	const page4 = pdf.addPage([612, 792]);
	page4.drawText("Chapter 1", {
		x: 50, y: height - 60, size: 14, font
	});
	page4.drawText("Introduction to Software Architecture", {
		x: 50, y: height - 90, size: 22, font: boldFont
	});

	const chapterText = `Software architecture represents the fundamental organization of a system, embodied in its components, their relationships to each other and the environment, and the principles governing its design and evolution.

The role of a software architect has evolved significantly over the past two decades. Modern architects must balance technical excellence with business acumen, understanding both the code-level details and the strategic implications of architectural decisions.

Key Responsibilities:
• Define system structure and component boundaries
• Make technology selection decisions
• Ensure non-functional requirements are met
• Guide development teams on best practices
• Communicate architecture to stakeholders

"Architecture is about the important stuff. Whatever that is." — Martin Fowler`;
	drawWrappedText(page4, chapterText, 50, height - 130, 512, 12, font);

	// Add multiple annotations
	addHighlightAnnotation(page4, 50, height - 130, 480, height - 116, [1, 1, 0]);
	addUnderlineAnnotation(page4, 250, height - 390, 420, height - 376);

	const pdfBytes = await pdf.save();
	const filename = "software-book-with-isbn.pdf";
	await writeFile(join(outputFolder, filename), pdfBytes);
	console.log(`✓ ${filename} (4 pages, ISBN, 4 annotations)`);
}

async function createAnnotatedDocument() {
	const pdf = await PDFDocument.create();
	const font = await pdf.embedFont(StandardFonts.Helvetica);
	const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);

	pdf.setTitle("Annotation Test Document");
	pdf.setAuthor("Test Author");
	pdf.setSubject("Testing various PDF annotation types");
	pdf.setKeywords(["test", "annotations", "highlights", "notes"]);
	pdf.setCreationDate(new Date());

	// Page 1 - Various annotation types
	const page1 = pdf.addPage([612, 792]);
	const { height } = page1.getSize();

	page1.drawText("PDF Annotation Types Demo", {
		x: 50, y: height - 60, size: 24, font: boldFont
	});

	page1.drawText("1. Highlight Annotations (Yellow)", {
		x: 50, y: height - 120, size: 14, font: boldFont
	});
	page1.drawText("This text has a yellow highlight annotation applied to it.", {
		x: 50, y: height - 145, size: 12, font
	});
	addHighlightAnnotation(page1, 50, height - 148, 400, height - 133, [1, 1, 0]);

	page1.drawText("2. Highlight Annotations (Green)", {
		x: 50, y: height - 190, size: 14, font: boldFont
	});
	page1.drawText("This text demonstrates a green highlight for important notes.", {
		x: 50, y: height - 215, size: 12, font
	});
	addHighlightAnnotation(page1, 50, height - 218, 420, height - 203, [0.5, 1, 0.5]);

	page1.drawText("3. Highlight Annotations (Pink)", {
		x: 50, y: height - 260, size: 14, font: boldFont
	});
	page1.drawText("Pink highlights are often used for questions or concerns.", {
		x: 50, y: height - 285, size: 12, font
	});
	addHighlightAnnotation(page1, 50, height - 288, 400, height - 273, [1, 0.7, 0.7]);

	page1.drawText("4. Note/Comment Annotations", {
		x: 50, y: height - 330, size: 14, font: boldFont
	});
	page1.drawText("Sticky notes can contain detailed comments. See note:", {
		x: 50, y: height - 355, size: 12, font
	});
	addNoteAnnotation(page1, 350, height - 355, "This is a detailed comment explaining the concept further. It can contain multiple sentences and provides additional context.", [1, 1, 0.6]);

	page1.drawText("5. Underline Annotations", {
		x: 50, y: height - 400, size: 14, font: boldFont
	});
	page1.drawText("Underlined text indicates important definitions or terms.", {
		x: 50, y: height - 425, size: 12, font
	});
	addUnderlineAnnotation(page1, 50, height - 428, 420, height - 413);

	page1.drawText("6. Strikeout Annotations", {
		x: 50, y: height - 470, size: 14, font: boldFont
	});
	page1.drawText("Strikeout marks text that should be deleted or ignored.", {
		x: 50, y: height - 495, size: 12, font
	});
	addStrikeoutAnnotation(page1, 50, height - 498, 400, height - 483);

	page1.drawText("7. Free Text Annotations", {
		x: 50, y: height - 540, size: 14, font: boldFont
	});
	addFreeTextAnnotation(page1, 50, height - 620, 250, 50, "This is a free text annotation that appears directly on the page.");

	// Page 2 - More annotations
	const page2 = pdf.addPage([612, 792]);
	page2.drawText("Page 2: Additional Annotations", {
		x: 50, y: height - 60, size: 20, font: boldFont
	});

	page2.drawText("Multiple overlapping highlights:", {
		x: 50, y: height - 110, size: 14, font: boldFont
	});
	page2.drawText("This sentence has multiple annotation layers for testing purposes.", {
		x: 50, y: height - 135, size: 12, font
	});
	addHighlightAnnotation(page2, 50, height - 138, 200, height - 123, [1, 1, 0]);
	addHighlightAnnotation(page2, 180, height - 138, 350, height - 123, [0.5, 1, 0.5]);
	addUnderlineAnnotation(page2, 50, height - 138, 500, height - 123);

	// Add several note annotations
	addNoteAnnotation(page2, 100, height - 200, "First note", [1, 0.8, 0.8]);
	addNoteAnnotation(page2, 200, height - 200, "Second note with more content explaining something", [0.8, 1, 0.8]);
	addNoteAnnotation(page2, 300, height - 200, "Third note", [0.8, 0.8, 1]);
	addNoteAnnotation(page2, 400, height - 200, "Fourth note with a longer explanation that spans multiple lines in the popup", [1, 1, 0.8]);

	page2.drawText("Notes cluster above (see icons)", {
		x: 200, y: height - 240, size: 12, font
	});

	const pdfBytes = await pdf.save();
	const filename = "annotation-types-demo.pdf";
	await writeFile(join(outputFolder, filename), pdfBytes);
	console.log(`✓ ${filename} (2 pages, 15+ annotations)`);
}

async function createMinimalPdf() {
	const pdf = await PDFDocument.create();
	const font = await pdf.embedFont(StandardFonts.Helvetica);

	// No metadata set intentionally

	const page = pdf.addPage([612, 792]);
	page.drawText("This PDF has no metadata.", {
		x: 50, y: 700, size: 16, font
	});
	page.drawText("It should be handled gracefully by the plugin.", {
		x: 50, y: 670, size: 12, font
	});

	const pdfBytes = await pdf.save();
	const filename = "minimal-no-metadata.pdf";
	await writeFile(join(outputFolder, filename), pdfBytes);
	console.log(`✓ ${filename} (1 page, no metadata)`);
}

async function createFullMetadataPdf() {
	const pdf = await PDFDocument.create();
	const font = await pdf.embedFont(StandardFonts.Helvetica);

	// All metadata fields
	pdf.setTitle("Complete Metadata Test Document");
	pdf.setAuthor("Alice Smith, Bob Johnson, Carol Williams");
	pdf.setSubject("Testing all metadata fields in PDF documents");
	pdf.setKeywords(["test", "metadata", "complete", "pdf-lib", "obsidian", "plugin"]);
	pdf.setCreator("PDF Metadata Test Generator v1.0");
	pdf.setProducer("pdf-lib (https://pdf-lib.js.org/)");
	pdf.setCreationDate(new Date("2024-01-15T10:30:00Z"));
	pdf.setModificationDate(new Date("2024-06-20T14:45:00Z"));

	const page = pdf.addPage([612, 792]);
	const { height } = page.getSize();

	page.drawText("Full Metadata Test", {
		x: 50, y: height - 80, size: 24, font
	});

	const info = [
		"Title: Complete Metadata Test Document",
		"Author: Alice Smith, Bob Johnson, Carol Williams",
		"Subject: Testing all metadata fields in PDF documents",
		"Keywords: test, metadata, complete, pdf-lib, obsidian, plugin",
		"Creator: PDF Metadata Test Generator v1.0",
		"Producer: pdf-lib",
		"Creation Date: 2024-01-15",
		"Modification Date: 2024-06-20"
	];

	info.forEach((line, i) => {
		page.drawText(line, {
			x: 50, y: height - 130 - (i * 25), size: 12, font
		});
	});

	const pdfBytes = await pdf.save();
	const filename = "full-metadata.pdf";
	await writeFile(join(outputFolder, filename), pdfBytes);
	console.log(`✓ ${filename} (1 page, all metadata fields)`);
}

async function createComplexDocument() {
	const pdf = await PDFDocument.create();
	const font = await pdf.embedFont(StandardFonts.Helvetica);
	const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);

	pdf.setTitle("Research Notes: Quantum Computing Applications");
	pdf.setAuthor("Research Team Alpha");
	pdf.setSubject("Quantum Computing, Research Notes");
	pdf.setKeywords(["quantum", "computing", "qubits", "algorithms", "research"]);
	pdf.setCreator("Research Notes App");
	pdf.setCreationDate(new Date("2024-05-01"));

	// Create 5 pages with various content and annotations
	for (let i = 1; i <= 5; i++) {
		const page = pdf.addPage([612, 792]);
		const { height } = page.getSize();

		page.drawText(`Page ${i}: Research Notes`, {
			x: 50, y: height - 60, size: 18, font: boldFont
		});

		page.drawText(`Section ${i}.1: Key Findings`, {
			x: 50, y: height - 100, size: 14, font: boldFont
		});

		const content = getPageContent(i);
		drawWrappedText(page, content, 50, height - 130, 512, 11, font);

		// Add varying annotations per page
		if (i === 1) {
			addHighlightAnnotation(page, 50, height - 133, 300, height - 118, [1, 1, 0]);
			addNoteAnnotation(page, 520, height - 130, "Key concept - review later", [1, 0.9, 0.6]);
		}
		if (i === 2) {
			addHighlightAnnotation(page, 50, height - 133, 250, height - 118, [0.6, 1, 0.6]);
			addHighlightAnnotation(page, 50, height - 180, 400, height - 165, [1, 0.8, 0.8]);
			addUnderlineAnnotation(page, 50, height - 210, 350, height - 195);
		}
		if (i === 3) {
			addFreeTextAnnotation(page, 350, height - 300, 200, 80, "TODO: Verify these calculations with the team");
			addNoteAnnotation(page, 100, height - 200, "Cross-reference with paper by Zhang et al.", [0.8, 0.8, 1]);
		}
		if (i === 4) {
			addStrikeoutAnnotation(page, 50, height - 160, 300, height - 145);
			addNoteAnnotation(page, 320, height - 160, "Outdated - see revised figures", [1, 0.7, 0.7]);
			addHighlightAnnotation(page, 50, height - 200, 450, height - 185, [1, 1, 0]);
		}
		if (i === 5) {
			addHighlightAnnotation(page, 50, height - 133, 400, height - 118, [0.7, 0.9, 1]);
			addNoteAnnotation(page, 520, height - 200, "Final conclusions - well supported by data", [0.7, 1, 0.7]);
			addFreeTextAnnotation(page, 50, height - 400, 300, 60, "Summary: Strong evidence for quantum advantage in optimization problems");
		}
	}

	const pdfBytes = await pdf.save();
	const filename = "complex-research-notes.pdf";
	await writeFile(join(outputFolder, filename), pdfBytes);
	console.log(`✓ ${filename} (5 pages, 12 annotations)`);
}

function getPageContent(pageNum) {
	const contents = {
		1: `Quantum computing represents a paradigm shift in computational capability. Unlike classical computers that use bits representing 0 or 1, quantum computers use qubits that can exist in superposition states. This fundamental difference enables quantum computers to explore multiple solutions simultaneously, offering exponential speedups for certain problem classes.

Key areas of application include:
- Cryptography and security
- Drug discovery and molecular simulation
- Optimization problems
- Machine learning acceleration`,

		2: `The development of error-corrected quantum computers remains one of the primary challenges in the field. Current noisy intermediate-scale quantum (NISQ) devices are limited by decoherence and gate errors. Recent advances in topological qubits and surface codes show promise for achieving fault-tolerant quantum computation.

Error rates have improved from 10^-2 to 10^-4 over the past five years. The threshold for fault-tolerant computation is estimated at approximately 10^-6, requiring continued advances in qubit quality and control systems.`,

		3: `Quantum algorithms offer provable speedups for specific problem domains:

Shor's Algorithm: Exponential speedup for integer factorization
Grover's Algorithm: Quadratic speedup for unstructured search
VQE: Variational methods for chemistry simulation
QAOA: Approximate optimization for combinatorial problems

Implementation challenges include circuit depth limitations, connectivity constraints, and the need for problem-specific ansatz design.`,

		4: `Hardware implementations vary significantly across platforms:

Superconducting qubits (IBM, Google): Fast gates, limited coherence
Trapped ions (IonQ, Honeywell): High fidelity, slower operations
Photonic systems (Xanadu, PsiQuantum): Room temperature, limited gates
Neutral atoms (QuEra): Scalable, emerging technology

Each platform presents unique trade-offs between gate fidelity, coherence time, connectivity, and scalability.`,

		5: `Conclusions and Future Directions:

The field of quantum computing has made remarkable progress, with demonstrations of quantum advantage in specific computational tasks. However, practical quantum advantage for commercially relevant problems remains an active area of research.

Near-term focus areas include:
- Improved error mitigation techniques
- Hybrid classical-quantum algorithms
- Application-specific quantum processors
- Quantum networking and distributed computation`
	};
	return contents[pageNum];
}

// Helper function to draw wrapped text
function drawWrappedText(page, text, x, y, maxWidth, fontSize, font) {
	const words = text.split(/\s+/);
	let line = "";
	let currentY = y;
	const lineHeight = fontSize * 1.4;

	for (const word of words) {
		const testLine = line ? `${line} ${word}` : word;
		const testWidth = font.widthOfTextAtSize(testLine, fontSize);

		if (testWidth > maxWidth && line) {
			page.drawText(line, { x, y: currentY, size: fontSize, font });
			line = word;
			currentY -= lineHeight;
		} else {
			line = testLine;
		}
	}
	if (line) {
		page.drawText(line, { x, y: currentY, size: fontSize, font });
	}
}

// Annotation helper functions
function addHighlightAnnotation(page, x1, y1, x2, y2, color) {
	const annot = page.doc.context.obj({
		Type: "Annot",
		Subtype: "Highlight",
		Rect: [x1, y1, x2, y2],
		QuadPoints: [x1, y2, x2, y2, x1, y1, x2, y1],
		C: color,
		CA: 0.5,
		Contents: PDFString.of("Highlighted text"),
		M: PDFString.of(new Date().toISOString()),
		T: PDFString.of("Test User"),
	});
	addAnnotToPage(page, annot);
}

function addNoteAnnotation(page, x, y, contents, color) {
	const annot = page.doc.context.obj({
		Type: "Annot",
		Subtype: "Text",
		Rect: [x, y - 20, x + 20, y],
		Contents: PDFString.of(contents),
		C: color,
		Name: "Comment",
		Open: false,
		M: PDFString.of(new Date().toISOString()),
		T: PDFString.of("Test User"),
	});
	addAnnotToPage(page, annot);
}

function addUnderlineAnnotation(page, x1, y1, x2, y2) {
	const annot = page.doc.context.obj({
		Type: "Annot",
		Subtype: "Underline",
		Rect: [x1, y1, x2, y2],
		QuadPoints: [x1, y2, x2, y2, x1, y1, x2, y1],
		C: [0, 0, 1],
		Contents: PDFString.of("Underlined text"),
		M: PDFString.of(new Date().toISOString()),
	});
	addAnnotToPage(page, annot);
}

function addStrikeoutAnnotation(page, x1, y1, x2, y2) {
	const annot = page.doc.context.obj({
		Type: "Annot",
		Subtype: "StrikeOut",
		Rect: [x1, y1, x2, y2],
		QuadPoints: [x1, y2, x2, y2, x1, y1, x2, y1],
		C: [1, 0, 0],
		Contents: PDFString.of("Struck out text"),
		M: PDFString.of(new Date().toISOString()),
	});
	addAnnotToPage(page, annot);
}

function addFreeTextAnnotation(page, x, y, width, height, contents) {
	const annot = page.doc.context.obj({
		Type: "Annot",
		Subtype: "FreeText",
		Rect: [x, y - height, x + width, y],
		Contents: PDFString.of(contents),
		DA: PDFString.of("/Helv 10 Tf 0 0 0 rg"),
		C: [1, 1, 0.8],
		M: PDFString.of(new Date().toISOString()),
		T: PDFString.of("Test User"),
	});
	addAnnotToPage(page, annot);
}

function addAnnotToPage(page, annot) {
	const annotRef = page.doc.context.register(annot);
	const existingAnnots = page.node.lookup(PDFName.of("Annots"), PDFArray);

	if (existingAnnots) {
		existingAnnots.push(annotRef);
	} else {
		const annotsArray = page.doc.context.obj([annotRef]);
		page.node.set(PDFName.of("Annots"), annotsArray);
	}
}

main().catch(console.error);
