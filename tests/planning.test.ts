import { describe, expect, it, vi } from "vitest";
import {
	createApplyInvocation,
	isUsableLegacyTemplate,
	normalizePathConflictKey,
	planRenames,
	type PlanningInput,
	type PlanningItem,
} from "../src/planning";
import {
	createFactoryConfiguration,
	type CanonicalBibliographicRecord,
	type SessionConfiguration,
} from "../src/types";

function record(
	overrides: Partial<CanonicalBibliographicRecord> = {},
): CanonicalBibliographicRecord {
	return {
		title: "A Study: Findings?",
		authorship: {
			authors: [
				{ kind: "person", given: "Ada", family: "Lovelace" },
				{ kind: "person", given: "Grace", family: "Hopper" },
			],
			completeness: "complete",
			totalCountKnown: true,
		},
		year: 2024,
		...overrides,
	};
}

function item(itemId: string, path = `Inbox/${itemId}.pdf`, value = record()): PlanningItem {
	return {
		itemId,
		sourceObservation: { path, mtime: 100, size: 200 },
		identification: { status: "resolved", record: value },
	};
}

function input(
	items: PlanningItem[],
	configuration: SessionConfiguration = createFactoryConfiguration(),
): PlanningInput {
	return {
		sessionId: "session-1",
		sessionRevision: 4,
		configuration,
		items,
		vaultFilePaths: items.map((entry) => entry.sourceObservation.path),
		vaultFolderPaths: ["Inbox", "Inbox/Nested", "Sources"],
	};
}

describe("pure rename planning", () => {
	it("uses the factory family-name convention without requiring an intake folder", () => {
		const actual = planRenames(
			input([
				item(
					"paper",
					"paper.pdf",
					record({
						title: "Example Title",
						year: 2023,
						authorship: {
							authors: [
								{ kind: "person", family: "Tesar" },
								{ kind: "person", family: "Other" },
							],
							completeness: "complete",
							totalCountKnown: true,
						},
					}),
				),
			]),
		);
		expect(actual.results[0]).toMatchObject({
			status: "eligible",
			proposedRename: { destinationPath: "Tesar et al. (2023). Example Title.pdf" },
		});
	});

	it("preserves exact valid legacy template semantics and rejects unsupported syntax", () => {
		const configuration = createFactoryConfiguration();
		configuration.metadataAndNaming.filenameFormat = {
			kind: "legacy-template",
			template: "{author} - {year} - {title}",
		};
		const result = planRenames(input([item("one")], configuration));
		expect(result.results[0]).toMatchObject({
			status: "eligible",
			proposedRename: { destinationPath: "Inbox/Ada Lovelace - 2024 - A Study Findings.pdf" },
		});
		expect(isUsableLegacyTemplate("Literal title {title}")).toBe(true);
		expect(isUsableLegacyTemplate("{bad-field}")).toBe(false);
		expect(isUsableLegacyTemplate("{title")).toBe(false);
	});

	it("uses each source parent and supports explicit folder and vault-root destinations", () => {
		const current = planRenames(input([item("root", "paper.pdf")]));
		expect(current.results[0]).toMatchObject({
			status: "eligible",
			proposedRename: { destinationPath: "Lovelace et al. (2024). A Study Findings.pdf" },
		});
		const nested = planRenames(input([item("nested", "Inbox/Nested/paper.pdf")]));
		expect(
			(nested.results[0] as { proposedRename?: { destinationPath: string } }).proposedRename
				?.destinationPath,
		).toBe("Inbox/Nested/Lovelace et al. (2024). A Study Findings.pdf");
		const rootConfig = createFactoryConfiguration();
		rootConfig.output = { mode: "vault-folder", folderPath: "" };
		expect(
			(
				planRenames(input([item("rootdest")], rootConfig)).results[0] as {
					proposedRename?: { destinationPath: string };
				}
			).proposedRename?.destinationPath,
		).toBe("Lovelace et al. (2024). A Study Findings.pdf");
		const folderConfig = createFactoryConfiguration();
		folderConfig.output = { mode: "vault-folder", folderPath: "Sources" };
		expect(
			(
				planRenames(input([item("folderdest")], folderConfig)).results[0] as {
					proposedRename?: { destinationPath: string };
				}
			).proposedRename?.destinationPath,
		).toBe("Sources/Lovelace et al. (2024). A Study Findings.pdf");
	});

	it("blocks unavailable explicit destinations while retaining bibliographic evidence", () => {
		const configuration = createFactoryConfiguration();
		configuration.output = { mode: "vault-folder", folderPath: "Deleted" };
		const result = planRenames(input([item("one")], configuration));
		expect(result.results[0]).toMatchObject({ status: "blocked", reason: "invalid-output" });
		expect((result.results[0] as { status: string }).status).toBe("blocked");
	});

	it("keeps identification state separate from naming and output blockers", () => {
		const unresolved: PlanningItem = {
			...item("unresolved"),
			identification: { status: "needs-user", reason: "No identifier" },
		};
		const pending: PlanningItem = {
			...item("pending"),
			identification: { status: "identifying" },
		};
		const missingTitle = item("title", "Inbox/title.pdf", record({ title: undefined }));
		const missingAuthor = item(
			"author",
			"Inbox/author.pdf",
			record({
				authorship: { authors: [], completeness: "unknown", totalCountKnown: false },
			}),
		);
		const result = planRenames(input([unresolved, pending, missingTitle, missingAuthor]));
		expect(
			result.results.map((entry) =>
				entry.status === "blocked" ? entry.reason : entry.status,
			),
		).toEqual([
			"identification-required",
			"identification-pending",
			"missing-title",
			"missing-authorship",
		]);
	});

	it("blocks existing files, folders, planned collisions and overwrite chains", () => {
		const one = item("one", "Inbox/one.pdf", record({ title: "Shared" }));
		const two = item("two", "Inbox/two.pdf", record({ title: "Shared" }));
		const three = item("three", "Inbox/three.pdf", record({ title: "Shared" }));
		for (const values of [
			[one, two, three],
			[three, two, one],
		]) {
			const result = planRenames(input(values));
			expect(
				result.results.map((entry) => entry.status === "blocked" && entry.reason),
			).toEqual(["planned-collision", "planned-collision", "planned-collision"]);
		}
		const target = "Inbox/Lovelace et al. (2024). A Study Findings.pdf";
		expect(
			planRenames({ ...input([item("one")]), vaultFolderPaths: ["Inbox", target] })
				.results[0],
		).toMatchObject({
			status: "blocked",
			reason: "destination-conflict",
		});
		const chain = item("chain", "Inbox/other-source.pdf", record({ title: "Target" }));
		const existingSource = "Inbox/Lovelace et al. (2024). Target.pdf";
		expect(
			planRenames({
				...input([chain]),
				vaultFilePaths: [chain.sourceObservation.path, existingSource],
			}).results[0],
		).toMatchObject({
			status: "blocked",
			reason: "destination-conflict",
		});
	});

	it("allows an exact-source case-only rename but blocks a distinct case-confusable file", () => {
		const configuration = createFactoryConfiguration();
		configuration.metadataAndNaming.filenameFormat = {
			kind: "legacy-template",
			template: "{title}",
		};
		const value = item("one", "Inbox/TARGET.pdf", record({ title: "target" }));
		const exactSource = planRenames(input([value], configuration));
		expect(exactSource.results[0]).toMatchObject({
			status: "eligible",
			proposedRename: { destinationPath: "Inbox/target.pdf" },
		});
		const distinctVariant = planRenames({
			...input([value], configuration),
			vaultFilePaths: [value.sourceObservation.path, "Inbox/Target.pdf"],
		});
		expect(distinctVariant.results[0]).toMatchObject({
			status: "blocked",
			reason: "destination-conflict",
		});
		const exactName = item("same", "Inbox/Lovelace et al. (2024). A Study Findings.pdf");
		expect(planRenames(input([exactName])).results[0]).toMatchObject({ status: "no-change" });
	});

	it("uses locale-independent conservative conflict keys for planning", () => {
		const localeFold = vi
			.spyOn(String.prototype, "toLocaleLowerCase")
			.mockImplementation(function (this: string) {
				return this.toString().replace(/I/g, "ı").toLowerCase();
			});
		try {
			const configuration = createFactoryConfiguration();
			configuration.metadataAndNaming.filenameFormat = {
				kind: "legacy-template",
				template: "{title}",
			};
			const value = item("one", "Inbox/source.pdf", record({ title: "Istanbul" }));
			const result = planRenames({
				...input([value], configuration),
				vaultFilePaths: [value.sourceObservation.path, "Inbox/istanbul.pdf"],
			});
			expect(normalizePathConflictKey("Inbox/Istanbul.pdf")).toBe(
				normalizePathConflictKey("Inbox/istanbul.pdf"),
			);
			expect(result.results[0]).toMatchObject({
				status: "blocked",
				reason: "destination-conflict",
			});
			expect(localeFold).not.toHaveBeenCalled();
		} finally {
			localeFold.mockRestore();
		}
	});

	it("does not mutate inputs and freezes a detached reviewed invocation", () => {
		const configuration = createFactoryConfiguration();
		configuration.metadataAndNaming.embeddedPdfMetadata = { requested: true };
		const source = item("one");
		const originalSource = JSON.stringify(source);
		const originalConfig = JSON.stringify(configuration);
		const planInput = input([source], configuration);
		const snapshot = planRenames(planInput);
		expect(JSON.stringify(source)).toBe(originalSource);
		expect(JSON.stringify(configuration)).toBe(originalConfig);
		configuration.output = { mode: "vault-folder", folderPath: "Sources" };
		source.sourceObservation.path = "Changed.pdf";
		const built = createApplyInvocation(snapshot, 4, "apply-1");
		expect(built.ok).toBe(true);
		if (!built.ok) return;
		const operation = built.invocation.operations[0];
		expect(operation.sourcePath).toBe("Inbox/one.pdf");
		expect(operation.destinationPath).toBe(
			"Inbox/Lovelace et al. (2024). A Study Findings.pdf",
		);
		expect(operation.effects).toEqual({ path: true, pdfBytes: false });
		expect(Object.isFrozen(built.invocation)).toBe(true);
		expect(Object.isFrozen(built.invocation.operations)).toBe(true);
		expect(Object.isFrozen(operation.effects)).toBe(true);
		expect("metadata" in operation).toBe(false);
		expect(createApplyInvocation(snapshot, 5, "apply-2")).toMatchObject({
			ok: false,
			reason: "stale-revision",
		});
	});

	it("keeps full canonical author lists and never creates metadata write operations", () => {
		const many = Array.from({ length: 8 }, (_, index) => ({
			kind: "person" as const,
			family: `Author${index}`,
		}));
		const canonical = record({
			authorship: { authors: many, completeness: "complete", totalCountKnown: true },
		});
		const snapshot = planRenames(input([item("many", "Inbox/many.pdf", canonical)]));
		const built = createApplyInvocation(snapshot, 4, "apply-3");
		expect(canonical.authorship.authors).toHaveLength(8);
		expect(snapshot.results[0]).toMatchObject({
			status: "eligible",
			proposedRename: { effects: { path: true, pdfBytes: false } },
		});
		expect(built.ok && built.invocation.operations[0]?.effects).toEqual({
			path: true,
			pdfBytes: false,
		});
	});
});
