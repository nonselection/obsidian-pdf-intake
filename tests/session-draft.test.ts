import { describe, expect, it } from "vitest";
import { encodeSessionDraft, decodeSessionDraft } from "../src/session-draft";
import { createFreshSession } from "../src/session";
import { createFactoryConfiguration, type CanonicalBibliographicRecord } from "../src/types";
import type { IntakeSession, SessionPdf } from "../src/session";

function record(): CanonicalBibliographicRecord {
	return {
		title: "Example title",
		authorship: {
			authors: [
				{ kind: "person", given: "Ada", family: "Lovelace" },
				{ kind: "organization", literal: "Analytical Society" },
				{ kind: "unresolved", position: 2, reference: "Provider author omitted" },
			],
			completeness: "partial",
			totalCountKnown: false,
		},
		year: 2024,
		doi: "10.1234/example",
		isbns: ["9780306406157"],
		journal: "Journal of Examples",
		publisher: "Example Press",
		provenance: {
			provider: "crossref",
			route: "doi",
			identifier: "10.1234/example",
			query: "private query context",
		},
	};
}

function draftSession(): IntakeSession {
	const session = createFreshSession(createFactoryConfiguration(), "runtime-session");
	session.phase = "working";
	session.setupOpen = false;
	session.setupConcern = "output";
	session.configuration.output = { mode: "vault-folder", folderPath: "Sources/Processed" };
	const item: SessionPdf = {
		id: "item-1",
		admissionObservation: { path: "Sources/article.pdf", mtime: 10, size: 20 },
		sourceObservation: { path: "Sources/article.pdf", mtime: 10, size: 20 },
		identification: {
			status: "needs-user",
			reason: "Provider identity was ambiguous.",
			evidence: {
				identifiers: [
					{
						type: "doi",
						rawText: "https://doi.org/10.1234/example",
						normalizedValue: "10.1234/example",
						valid: true,
						pageNumber: 1,
						textOffset: 3,
						labeled: true,
					},
				],
				attempts: [
					{
						provider: "crossref",
						route: "bibliographic-query",
						lookupValue: "private extracted full query context",
						outcome: "ambiguous",
						candidateRecord: {
							provider: "crossref",
							title: "Example title",
							authorship: record().authorship,
							year: 2024,
							isbns: [],
							diagnostics: ["authors-incomplete"],
						},
					},
				],
				titleCandidates: ["Example title"],
				queryContext: "whole extracted pages and query data",
				diagnostics: ["ambiguous-fallback-evidence"],
			},
		},
		repairActivity: "manual-lookup-pending",
		acceptedMachineRecord: record(),
		recordDecision: {
			kind: "user-edited-record",
			record: {
				...record(),
				provenance: {
					kind: "user-edited",
					basedOn: {
						provider: "crossref",
						route: "bibliographic-query",
						lookupValue: "private query",
					},
				},
			},
			basedOn: {
				provider: "crossref",
				route: "bibliographic-query",
				lookupValue: "private query",
			},
		},
		repairEvidence: [
			{
				type: "doi",
				identifier: "10.1234/example",
				provider: "crossref",
				route: "doi",
				outcome: "candidate",
				candidateRecord: record(),
				conflictingTitle: "An earlier title",
			},
		],
		identificationHistory: [
			{
				status: "needs-you",
				reason: "Ambiguous",
				attempts: [
					{
						provider: "crossref",
						route: "bibliographic-query",
						lookupValue: "private full query",
						outcome: "ambiguous",
					},
				],
			},
		],
		applyOutcome: {
			itemId: "item-1",
			status: "blocked",
			reason: "source-changed",
			message: "raw internal detail",
		},
		applyOutcomeRevision: 9,
		plan: { status: "eligible", itemId: "item-1" } as never,
	};
	session.items.push(item);
	session.pendingInspectorForm = {
		itemId: item.id,
		unsaved: true,
		values: {
			title: "Unsaved title",
			year: "",
			doi: "",
			isbns: [],
			journal: "",
			publisher: "",
			authors: [{ kind: "literal", literal: "Unparsed name stays literal" }],
			authorshipCompleteness: "partial",
			totalCountKnown: false,
		},
	};
	session.planningSnapshot = { sessionId: "runtime-session", sessionRevision: 9, results: [] };
	session.applyState = { status: "applying", invocationId: "runtime-token" };
	return session;
}

describe("unfinished session draft codec", () => {
	it("round-trips v1 detached session data and preserves canonical authorship", () => {
		const encoded = encodeSessionDraft(draftSession(), "draft-id", "2026-10-11T10:00:00.000Z");
		const decoded = decodeSessionDraft(encoded);
		expect(encoded.draftVersion).toBe(1);
		expect(decoded.status).toBe("supported");
		if (decoded.status !== "supported") return;
		expect(decoded.draft.phase).toBe("working");
		expect(decoded.draft.configuration.output).toEqual({
			mode: "vault-folder",
			folderPath: "Sources/Processed",
		});
		expect(decoded.draft.items[0]?.admissionObservation).toEqual({
			path: "Sources/article.pdf",
			mtime: 10,
			size: 20,
		});
		expect(decoded.draft.items[0]?.recordDecision?.kind).toBe("user-edited-record");
		expect(decoded.draft.items[0]?.recordDecision?.record.authorship.authors).toEqual(
			record().authorship.authors,
		);
		expect(decoded.draft.items[0]?.identification).toMatchObject({
			status: "needs-user",
			evidence: {
				identifiers: [
					{
						type: "doi",
						normalizedValue: "10.1234/example",
						valid: true,
						pageNumber: 1,
						textOffset: 3,
						labeled: true,
					},
				],
			},
		});
		expect(decoded.draft.pendingInspectorForm?.unsaved).toBe(true);
		expect(JSON.stringify(decoded.draft)).not.toContain("runtime-session");
	});

	it("writes only detached allowlisted values and omits runtime authority and raw query data", () => {
		const encoded = encodeSessionDraft(draftSession(), "draft-id");
		const json = JSON.stringify(encoded);
		for (const forbidden of [
			"rawText",
			"https://doi.org/10.1234/example",
			"queryContext",
			"private extracted full query context",
			"private full query",
			"whole extracted pages",
			"runtime-token",
			"planningSnapshot",
			"invocationId",
			"raw internal detail",
		]) {
			expect(json).not.toContain(forbidden);
		}
		const item = encoded.items[0];
		expect(item.identification.status).toBe("needs-user");
		expect(
			item.identification.status === "needs-user"
				? item.identification.evidence?.attempts[0]?.lookupValue
				: undefined,
		).toBe("");
		expect(item.lastApplySummary).toEqual({ status: "blocked", reason: "source-changed" });
		expect(encoded.pendingInspectorForm?.unsaved).toBe(true);
		expect(encoded.items[0]).not.toHaveProperty("repairActivity");
	});

	it("rejects arbitrary identifier text and query context in a manually built v1 draft", () => {
		const encoded = encodeSessionDraft(draftSession(), "draft-id");
		const withRawText = JSON.parse(JSON.stringify(encoded)) as {
			items: { identification: { evidence?: { identifiers: Record<string, unknown>[] } } }[];
		};
		const identifier = withRawText.items[0]?.identification.evidence?.identifiers[0];
		if (!identifier) throw new Error("Expected identifier evidence");
		identifier.rawText = "unrelated prose copied from a PDF page";
		expect(decodeSessionDraft(withRawText)).toEqual({
			status: "unavailable",
			reason: "malformed",
		});

		const withQueryContext = JSON.parse(JSON.stringify(encoded)) as {
			items: { identification: { evidence?: Record<string, unknown> } }[];
		};
		const evidence = withQueryContext.items[0]?.identification.evidence;
		if (!evidence) throw new Error("Expected identifier evidence");
		evidence.queryContext = "the complete extracted pages";
		expect(decodeSessionDraft(withQueryContext)).toEqual({
			status: "unavailable",
			reason: "malformed",
		});
	});

	it("bounds candidates and prior histories while retaining the latest detailed evidence", () => {
		const session = draftSession();
		const item = session.items[0];
		if (!item || item.identification.status !== "needs-user")
			throw new Error("Expected seeded Needs-you item");
		item.identification.evidence = {
			identifiers: [],
			attempts: Array.from({ length: 30 }, (_, index) => ({
				provider: "crossref" as const,
				route: "bibliographic-query" as const,
				lookupValue: `private query ${index}`,
				outcome: "ambiguous" as const,
			})),
			titleCandidates: Array.from({ length: 8 }, (_, index) => `Title ${index}`),
			diagnostics: Array.from({ length: 30 }, (_, index) => `Diagnostic ${index}`),
		};
		item.identificationHistory = Array.from({ length: 5 }, (_, index) => ({
			status: "needs-you" as const,
			reason: `Prior run ${index}`,
			attempts: [],
		}));
		item.repairEvidence = Array.from({ length: 5 }, (_, index) => ({
			type: "doi" as const,
			identifier: `10.1234/${index}`,
			provider: "crossref" as const,
			route: "doi" as const,
			outcome: "no-record" as const,
		}));
		const encoded = encodeSessionDraft(session, "draft-id");
		const recovered = encoded.items[0];
		if (!recovered || recovered.identification.status !== "needs-user")
			throw new Error("Expected bounded Needs-you evidence");
		expect(recovered.identification.evidence?.attempts).toHaveLength(24);
		expect(recovered.identification.evidence?.titleCandidates).toHaveLength(5);
		expect(recovered.identificationHistory?.map((run) => run.reason)).toEqual([
			"Prior run 3",
			"Prior run 4",
		]);
		expect(recovered.repairEvidence?.map((entry) => entry.identifier)).toEqual([
			"10.1234/2",
			"10.1234/3",
			"10.1234/4",
		]);
	});

	it("restores interrupted Identifying as safely unattempted", () => {
		const session = draftSession();
		session.items[0].identification = { status: "identifying" };
		const decoded = decodeSessionDraft(encodeSessionDraft(session, "draft-id"));
		expect(decoded.status).toBe("supported");
		if (decoded.status === "supported")
			expect(decoded.draft.items[0]?.identification).toEqual({ status: "unattempted" });
	});

	it("keeps malformed and future versions unavailable without attempting a migration", () => {
		expect(decodeSessionDraft({ draftVersion: 1, configuration: {} })).toEqual({
			status: "unavailable",
			reason: "malformed",
		});
		expect(decodeSessionDraft({ draftVersion: 2, opaque: "keep" })).toEqual({
			status: "unavailable",
			reason: "unsupported-future",
		});
		expect(decodeSessionDraft(null)).toEqual({ status: "none" });
	});
});
