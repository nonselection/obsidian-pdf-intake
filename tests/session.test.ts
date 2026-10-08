import { describe, expect, it, vi } from "vitest";
import { PluginDataStore, type PluginDataEnvelope } from "../src/persistence";
import { SessionCoordinator, type IntakeSession } from "../src/session";
import type { ApplyInvocation } from "../src/planning";
import type { ApplyInvocationResult } from "../src/apply-changes";
import { createFactoryConfiguration } from "../src/types";

function stored(
	policy: "future-sessions" | "session-only" = "future-sessions",
): PluginDataEnvelope {
	return {
		schemaVersion: 1,
		settings: { workspaceEditPolicy: policy, defaults: createFactoryConfiguration() },
		unfinishedSessionDraft: { opaque: "retained" },
	};
}

async function storeWith(
	raw: unknown = stored(),
	saveData = vi.fn(() => Promise.resolve(undefined)),
) {
	const store = new PluginDataStore({ loadData: () => Promise.resolve(raw), saveData });
	await store.load(["Sources"]);
	return { store, saveData };
}

function seedTestItem(coordinator: SessionCoordinator): void {
	const testSession = coordinator as unknown as { session: IntakeSession };
	testSession.session.items.push({
		id: "item-1",
		sourceObservation: { path: "Inbox/source.pdf", mtime: 100, size: 200 },
		identification: {
			status: "resolved",
			record: {
				title: "Example",
				authorship: {
					authors: [{ kind: "person", given: "Ada", family: "Lovelace" }],
					completeness: "complete",
					totalCountKnown: true,
				},
				year: 2024,
			},
		},
	});
}

function recordingApplyService() {
	const apply = vi.fn((invocation: ApplyInvocation): Promise<ApplyInvocationResult> =>
		Promise.resolve({
			status: "completed",
			invocationId: invocation.invocationId,
			outcomes: [],
		}),
	);
	return { apply, service: { apply } };
}

function deferred() {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

describe("plugin-owned session coordinator", () => {
	it("assigns a fresh identity to each coordinator after plugin reload", async () => {
		const { store } = await storeWith();
		const beforeReload = new SessionCoordinator(store).getSnapshot();
		const afterReload = new SessionCoordinator(store).getSnapshot();
		expect(afterReload.id).not.toBe(beforeReload.id);
	});

	it("creates fresh empty setup sessions from detached defaults", async () => {
		const { store } = await storeWith();
		const coordinator = new SessionCoordinator(store);
		const first = coordinator.getSnapshot();
		expect(first).toMatchObject({
			revision: 0,
			phase: "setup",
			setupOpen: true,
			setupConcern: "pdfs",
			items: [],
		});
		expect(first.configuration.output).toEqual({ mode: "current-folders" });
		const second = coordinator.createNewSession();
		expect(second.id).not.toBe(first.id);
		expect(second.items).toEqual([]);
		expect(second.configuration).not.toBe(first.configuration);
		expect(second.configuration.metadataAndNaming).not.toBe(
			first.configuration.metadataAndNaming,
		);
		first.configuration.output.mode = "vault-folder";
		expect(coordinator.getSnapshot().configuration.output).toEqual({ mode: "current-folders" });
	});

	it("keeps setup concern changes from resetting identity, revision or configuration", async () => {
		const { store } = await storeWith();
		const coordinator = new SessionCoordinator(store);
		const before = coordinator.getSnapshot();
		coordinator.setSetupConcern("metadata-and-naming");
		const after = coordinator.getSnapshot();
		expect(after.setupConcern).toBe("metadata-and-naming");
		expect(after.id).toBe(before.id);
		expect(after.revision).toBe(before.revision);
		expect(after.configuration).toEqual(before.configuration);
		expect(coordinator.beginReview()).toEqual({
			allowed: false,
			reason: "Add at least one PDF before beginning review.",
		});
	});

	it("updates the current session and future defaults under the committed future-sessions policy", async () => {
		const { store, saveData } = await storeWith();
		const coordinator = new SessionCoordinator(store);
		const original = coordinator.getSnapshot();
		const edit = await coordinator.updateOutput(
			{ mode: "vault-folder", folderPath: "Sources" },
			["Sources"],
		);
		expect(edit).toMatchObject({ updated: true, savedForFutureSessions: true });
		expect(coordinator.getSnapshot().configuration.output).toEqual({
			mode: "vault-folder",
			folderPath: "Sources",
		});
		expect(store.getSettings().defaults.output).toEqual({
			mode: "vault-folder",
			folderPath: "Sources",
		});
		expect(original.configuration.output).toEqual({ mode: "current-folders" });
		expect(coordinator.createNewSession().configuration.output).toEqual({
			mode: "vault-folder",
			folderPath: "Sources",
		});
		expect(saveData).toHaveBeenCalledTimes(1);
	});

	it("keeps session-only edits out of defaults and draft writes", async () => {
		const { store, saveData } = await storeWith(stored("session-only"));
		const coordinator = new SessionCoordinator(store);
		const edit = await coordinator.updateOutput(
			{ mode: "vault-folder", folderPath: "Sources" },
			["Sources"],
		);
		expect(edit).toMatchObject({ updated: true, savedForFutureSessions: false });
		expect(store.getSettings().defaults.output).toEqual({ mode: "current-folders" });
		expect(store.getDraftNamespace()).toEqual({ opaque: "retained" });
		expect(saveData).not.toHaveBeenCalled();
		expect(coordinator.createNewSession().configuration.output).toEqual({
			mode: "current-folders",
		});
	});

	it("does not retroactively copy later Settings defaults into an existing session", async () => {
		const { store } = await storeWith();
		const coordinator = new SessionCoordinator(store);
		const existing = coordinator.getSnapshot();
		await store.updateSettings({
			defaults: { output: { mode: "vault-folder", folderPath: "Sources" } },
		});
		expect(coordinator.getSnapshot().configuration.output).toEqual(
			existing.configuration.output,
		);
		expect(coordinator.createNewSession().configuration.output).toEqual({
			mode: "vault-folder",
			folderPath: "Sources",
		});
	});

	it("updates the session immediately on save failure while keeping committed defaults intact", async () => {
		const gate = deferred();
		const saveData = vi.fn(async () => gate.promise);
		const { store } = await storeWith(stored(), saveData);
		const coordinator = new SessionCoordinator(store);
		const pending = coordinator.updateOutput({ mode: "vault-folder", folderPath: "Sources" }, [
			"Sources",
		]);
		expect(coordinator.getSnapshot().configuration.output).toEqual({
			mode: "vault-folder",
			folderPath: "Sources",
		});
		expect(store.getSettings().defaults.output).toEqual({ mode: "current-folders" });
		gate.reject(new Error("offline"));
		const result = await pending;
		expect(result.updated).toBe(true);
		expect(result.savedForFutureSessions).toBe(false);
		expect(result.message).toContain("not saved");
		expect(store.getSettings().defaults.output).toEqual({ mode: "current-folders" });
		expect(coordinator.getSnapshot().configuration.output).toEqual({
			mode: "vault-folder",
			folderPath: "Sources",
		});
	});

	it("requires existing output folders and accepts an explicit root choice", async () => {
		const { store } = await storeWith();
		const coordinator = new SessionCoordinator(store);
		await expect(
			coordinator.updateOutput({ mode: "vault-folder", folderPath: "Missing" }, ["Sources"]),
		).resolves.toMatchObject({
			updated: false,
		});
		await expect(
			coordinator.updateOutput({ mode: "vault-folder", folderPath: "" }, []),
		).resolves.toMatchObject({
			updated: true,
		});
	});

	it("rejects a fabricated eligible result for an owned item when no coordinator plan exists", async () => {
		const { store } = await storeWith();
		const { apply, service } = recordingApplyService();
		const coordinator = new SessionCoordinator(store, service as never);
		seedTestItem(coordinator);
		const session = coordinator.getSnapshot();
		const fabricated = {
			sessionId: session.id,
			sessionRevision: session.revision,
			results: [
				{
					itemId: "item-1",
					status: "eligible",
					proposedRename: {
						itemId: "item-1",
						sourceObservation: { path: "Inbox/source.pdf", mtime: 100, size: 200 },
						destinationPath: "Elsewhere/arbitrary.pdf",
						proposedName: "arbitrary.pdf",
						effects: { path: true, pdfBytes: false },
					},
					diagnostics: [],
				},
			],
		};
		const callerView = coordinator.getSnapshot();
		callerView.planningSnapshot = fabricated as never;
		const callerItem = callerView.items[0];
		if (!callerItem) throw new Error("Expected the test item");
		callerItem.plan = fabricated.results[0] as never;

		const result = await coordinator.applyReviewedPlan();

		expect(result.status).toBe("rejected");
		expect(apply).not.toHaveBeenCalled();
		expect(coordinator.getSnapshot().planningSnapshot).toBeNull();
		expect(coordinator.getSnapshot().items[0]?.plan).toBeUndefined();
		expect("setPlanningSnapshot" in coordinator).toBe(false);
		expect(coordinator.beginReview().allowed).toBe(false);
	});

	it("derives and stores detached plans from current coordinator state", async () => {
		const { store } = await storeWith();
		const { apply, service } = recordingApplyService();
		const coordinator = new SessionCoordinator(store, service as never);
		seedTestItem(coordinator);
		const filePaths = ["Inbox/source.pdf"];
		const folderPaths = ["Inbox"];
		const returnedPlan = coordinator.planCurrentSession(filePaths, folderPaths);
		const expectedDestination = "Inbox/Lovelace (2024). Example.pdf";

		expect(returnedPlan.results[0]).toMatchObject({
			status: "eligible",
			proposedRename: { destinationPath: expectedDestination },
		});
		filePaths[0] = "Elsewhere/replacement.pdf";
		folderPaths[0] = "Elsewhere";
		const returnedEligible = returnedPlan.results[0];
		if (returnedEligible.status !== "eligible") throw new Error("Expected an eligible plan");
		returnedEligible.proposedRename.destinationPath = "Elsewhere/hostile.pdf";
		returnedEligible.proposedRename.sourceObservation.path = "Elsewhere/replacement.pdf";

		const stored = coordinator.getSnapshot();
		expect(stored.planningSnapshot?.results[0]).toMatchObject({
			status: "eligible",
			proposedRename: {
				destinationPath: expectedDestination,
				sourceObservation: { path: "Inbox/source.pdf" },
			},
		});
		expect(stored.items[0]?.plan).toEqual(stored.planningSnapshot?.results[0]);
		await expect(coordinator.applyReviewedPlan()).resolves.toMatchObject({
			status: "completed",
		});
		expect(apply.mock.calls[0]?.[0].operations[0]?.destinationPath).toBe(expectedDestination);
	});

	it("rejects plans after session, revision, configuration, evidence or source observations change", async () => {
		{
			const { store } = await storeWith();
			const { apply, service } = recordingApplyService();
			const coordinator = new SessionCoordinator(store, service as never);
			seedTestItem(coordinator);
			coordinator.planCurrentSession(["Inbox/source.pdf"], ["Inbox"]);
			coordinator.createNewSession();
			expect(await coordinator.applyReviewedPlan()).toMatchObject({
				status: "rejected",
			});
			expect(apply).not.toHaveBeenCalled();
		}
		{
			const { store } = await storeWith();
			const { apply, service } = recordingApplyService();
			const coordinator = new SessionCoordinator(store, service as never);
			seedTestItem(coordinator);
			const stale = coordinator.planCurrentSession(["Inbox/source.pdf"], ["Inbox"]);
			await coordinator.updateOutput({ mode: "vault-folder", folderPath: "Sources" }, [
				"Sources",
			]);
			expect(coordinator.getSnapshot().revision).toBe(stale.sessionRevision + 1);
			expect(coordinator.getSnapshot().planningSnapshot).toBeNull();
			expect(await coordinator.applyReviewedPlan()).toMatchObject({
				status: "rejected",
			});
			expect(apply).not.toHaveBeenCalled();
		}
		for (const changedField of ["evidence", "source"] as const) {
			const { store } = await storeWith();
			const { apply, service } = recordingApplyService();
			const coordinator = new SessionCoordinator(store, service as never);
			seedTestItem(coordinator);
			coordinator.planCurrentSession(["Inbox/source.pdf"], ["Inbox"]);
			const testSession = coordinator as unknown as { session: IntakeSession };
			const item = testSession.session.items[0];
			if (!item) throw new Error("Expected the test item");
			if (changedField === "evidence" && item.identification.status === "resolved") {
				item.identification.record.title = "Changed evidence";
			} else if (changedField === "source") {
				item.sourceObservation.mtime++;
			}
			expect(await coordinator.applyReviewedPlan()).toMatchObject({
				status: "rejected",
			});
			expect(apply).not.toHaveBeenCalled();
		}
	});

	it("notifies attached views and preserves the coordinator across unsubscribe/re-subscribe", async () => {
		const { store } = await storeWith();
		const coordinator = new SessionCoordinator(store);
		const seen: string[] = [];
		const stop = coordinator.subscribe((snapshot) => seen.push(snapshot.setupConcern));
		coordinator.setSetupConcern("output");
		stop();
		coordinator.setSetupConcern("metadata-and-naming");
		expect(seen).toEqual(["pdfs", "output"]);
		const reopened: string[] = [];
		coordinator.subscribe((snapshot) => reopened.push(snapshot.setupConcern));
		expect(reopened).toEqual(["metadata-and-naming"]);
		coordinator.dispose();
	});
});
