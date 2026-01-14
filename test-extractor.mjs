import { PDFDocument } from "pdf-lib";
import { readFileSync } from "fs";

const buffer = readFileSync("/home/luca/vault/test-document.pdf");
const pdf = await PDFDocument.load(buffer);

console.log("=== Extracted Metadata ===\n");
console.log("Title:", pdf.getTitle());
console.log("Author:", pdf.getAuthor());
console.log("Subject:", pdf.getSubject());
console.log("Keywords:", pdf.getKeywords());
console.log("Creator:", pdf.getCreator());
console.log("Producer:", pdf.getProducer());
console.log("Creation Date:", pdf.getCreationDate());
console.log("Modification Date:", pdf.getModificationDate());
console.log("Page Count:", pdf.getPageCount());
console.log("\n=== Test passed ===");
