import { describe, expect, it } from "vitest";
import {
	filesInIntakeFolder,
	finalDestinationPath,
	generateFilename,
	planEntries,
	processEntry,
	updateEntryPlan,
	validateFolders,
} from "../src/intake";
import type { BibliographicMetadata, IntakeEntry, IntakeSettings } from "../src/types";

function resolved(overrides: Partial<BibliographicMetadata> = {}): BibliographicMetadata {
	return {
		title: "A Study: Findings?",
		authors: ["Ada Lovelace", "Grace Hopper"],
		firstAuthor: "Ada Lovelace",
		year: 2024,
		status: "resolved",
		...overrides,
	};
}

function file(path: string) {
	const slash = path.lastIndexOf("/");
	return {
		path,
		name: path.slice(slash + 1),
		extension: "pdf",
		parent: { path: slash < 0 ? "" : path.slice(0, slash) },
	};
}

const settings: IntakeSettings = {
	intakeFolder: "Inbox",
	processedFolderMode: "intake",
	processedFolder: "",
	renameTemplate: "{author} - {title} ({year})",
};

describe("bibliographic filename generation", () => {
	it("replaces placeholders using publication year and first author", () => {
		expect(generateFilename(resolved(), "{author} - {title} ({year})")).toBe(
			"Ada Lovelace - A Study Findings (2024).pdf",
		);
		expect(generateFilename(resolved(), "{authors} - {journal} - {publisher}")).toBe(
			"Ada Lovelace, Grace Hopper.pdf",
		);
	});

	it("sanitizes invalid filesystem characters and preserves the PDF extension", () => {
		expect(generateFilename(resolved(), "{title}")).toBe("A Study Findings.pdf");
		expect(generateFilename(resolved(), "{title}.pdf")).toBe("A Study Findings.pdf");
	});

	it("does not create meaningless names when critical metadata is missing", () => {
		expect(
			generateFilename(resolved({ title: undefined }), "{author} - {title} ({year})"),
		).toBeNull();
		expect(
			generateFilename(resolved({ firstAuthor: undefined }), "{author} - {title} ({year})"),
		).toBeNull();
	});
});

describe("intake preview decisions", () => {
	it("keeps ready, unresolved, conflict, and error statuses independent", () => {
		const entries: IntakeEntry[] = [
			{
				file: file("Inbox/ready.pdf") as never,
				selected: true,
				status: "unprocessed",
				manualIdentifier: "",
				metadata: resolved({ title: "Other title" }),
			},
			{
				file: file("Inbox/unresolved.pdf") as never,
				selected: true,
				status: "unprocessed",
				manualIdentifier: "",
				metadata: { authors: [], status: "unresolved", error: "No identifier" },
			},
			{
				file: file("Inbox/conflict.pdf") as never,
				selected: true,
				status: "unprocessed",
				manualIdentifier: "",
				metadata: resolved(),
			},
			{
				file: file("Inbox/error.pdf") as never,
				selected: true,
				status: "unprocessed",
				manualIdentifier: "",
				metadata: { authors: [], status: "error", error: "Unreadable PDF" },
			},
		];
		planEntries(entries, settings, [
			"Inbox/ready.pdf",
			"Inbox/conflict.pdf",
			"Inbox/Ada Lovelace - A Study Findings (2024).pdf",
		]);
		expect(entries.map(({ status }) => status)).toEqual([
			"ready",
			"unresolved",
			"conflict",
			"error",
		]);
		expect(entries[0].finalPath).toBe("Inbox/Ada Lovelace - Other title (2024).pdf");
	});

	it("marks an unchanged final path as a no-op", () => {
		const entry: IntakeEntry = {
			file: file("Inbox/Ada Lovelace - A Study Findings (2024).pdf") as never,
			selected: false,
			status: "unprocessed",
			manualIdentifier: "",
			metadata: resolved(),
		};
		updateEntryPlan(entry, settings, [entry.file.path]);
		expect(entry.status).toBe("unchanged");
		expect(entry.finalPath).toBe(entry.file.path);
	});
});

describe("folder and final-path safety", () => {
	it("uses the source folder by default and a single configured folder for moves", () => {
		expect(finalDestinationPath("Inbox/sub/paper.pdf", "Resolved.pdf", "intake", "")).toBe(
			"Inbox/sub/Resolved.pdf",
		);
		expect(
			finalDestinationPath("Inbox/paper.pdf", "Resolved.pdf", "another", "Sources/Processed"),
		).toBe("Sources/Processed/Resolved.pdf");
	});

	it("checks conflicts at the final destination path", () => {
		const entry = {
			file: file("Inbox/paper.pdf"),
			selected: true,
			status: "unprocessed",
			manualIdentifier: "",
			metadata: resolved(),
		} as IntakeEntry;
		const movedSettings: IntakeSettings = {
			...settings,
			processedFolderMode: "another",
			processedFolder: "Sources",
		};
		updateEntryPlan(entry, movedSettings, [
			"Inbox/paper.pdf",
			"Inbox/Ada Lovelace - A Study Findings (2024).pdf",
		]);
		expect(entry.status).toBe("ready");
		expect(entry.finalPath).toBe("Sources/Ada Lovelace - A Study Findings (2024).pdf");
		updateEntryPlan(entry, movedSettings, [
			"Inbox/paper.pdf",
			"Sources/Ada Lovelace - A Study Findings (2024).pdf",
		]);
		expect(entry.status).toBe("conflict");

		entry.status = "ready";
		planEntries([entry], movedSettings, [entry.file.path], ["Inbox"]);
		expect(entry.status).toBe("error");
		expect(entry.finalPath).toBeUndefined();
	});

	it("blocks invalid folders without falling back to the whole vault", () => {
		const allFiles = [file("Inbox/paper.pdf"), file("Elsewhere/other.pdf")];
		expect(filesInIntakeFolder(allFiles as never, "Typo", ["Inbox"]).files).toEqual([]);
		expect(filesInIntakeFolder(allFiles as never, "Inbox", ["Inbox"]).files).toHaveLength(1);
		expect(validateFolders("Typo", "intake", "", ["Inbox"]).valid).toBe(false);
		expect(validateFolders("Inbox", "another", "Missing", ["Inbox"]).valid).toBe(false);
		expect(validateFolders("Inbox", "another", "Sources", ["Inbox", "Sources"]).valid).toBe(
			true,
		);
	});

	it("recursively scans intake while excluding only a valid nested processed folder", () => {
		const allFiles = [
			file("Inbox/paper.pdf"),
			file("Inbox/Nested/ordinary.pdf"),
			file("Inbox/Processed/already-done.pdf"),
			file("Inbox/Processed/Deep/also-done.pdf"),
		];
		const result = filesInIntakeFolder(
			allFiles as never,
			"Inbox",
			["Inbox", "Inbox/Nested", "Inbox/Processed", "Inbox/Processed/Deep"],
			"another",
			"Inbox/Processed",
		);

		expect(result.files.map((item) => item.path)).toEqual([
			"Inbox/paper.pdf",
			"Inbox/Nested/ordinary.pdf",
		]);
	});

	it("does not exclude files when the processed folder is outside intake", () => {
		const allFiles = [file("Inbox/paper.pdf"), file("Inbox/Nested/ordinary.pdf")];
		const result = filesInIntakeFolder(
			allFiles as never,
			"Inbox",
			["Inbox", "Inbox/Nested", "Sources/Processed"],
			"another",
			"Sources/Processed",
		);

		expect(result.files).toHaveLength(2);
	});

	it("does not exclude the intake tree when processed folder equals intake", () => {
		const allFiles = [file("Inbox/paper.pdf"), file("Inbox/Nested/ordinary.pdf")];
		const result = filesInIntakeFolder(
			allFiles as never,
			"Inbox",
			["Inbox", "Inbox/Nested"],
			"another",
			"Inbox",
		);

		expect(result.files).toHaveLength(2);
	});

	it("marks entries processed only after a successful path mutation and refuses no-ops", async () => {
		const ready: IntakeEntry = {
			file: file("Inbox/paper.pdf") as never,
			selected: true,
			status: "ready",
			manualIdentifier: "",
			finalPath: "Sources/Resolved.pdf",
		};
		const failingVault = {
			getFiles: () => [ready.file],
			rename: () => Promise.reject(new Error("failed")),
		} as never;
		expect(await processEntry(ready, failingVault)).toBe(false);
		expect(ready.status).toBe("error");

		ready.status = "ready";
		const successfulVault = {
			getFiles: () => [ready.file],
			rename: () => Promise.resolve(),
		} as never;
		expect(await processEntry(ready, successfulVault)).toBe(true);
		expect(ready.status).toBe("processed");
		ready.status = "unchanged";
		const noOpVault = {
			getFiles: () => [ready.file],
			rename: () => Promise.resolve(),
		} as never;
		expect(await processEntry(ready, noOpVault)).toBe(false);
		expect(ready.status).toBe("unchanged");
	});
});
