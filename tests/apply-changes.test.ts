import { describe, expect, it, vi } from "vitest";
import { ApplyChangesService } from "../src/apply-changes";
import { normalizePathConflictKey, type ApplyInvocation } from "../src/planning";

function file(path: string, overrides: Record<string, unknown> = {}) {
	const slash = path.lastIndexOf("/");
	return {
		type: "file",
		path,
		name: path.slice(slash + 1),
		extension: path.toLowerCase().endsWith(".pdf") ? "pdf" : "txt",
		stat: { mtime: 100, size: 200 },
		parent: { type: "folder", path: slash < 0 ? "" : path.slice(0, slash) },
		...overrides,
	};
}

function invocation(
	paths: string[] = ["Inbox/source.pdf"],
	targets: string[] = ["Inbox/Target.pdf"],
): ApplyInvocation {
	return {
		invocationId: "invocation-1",
		sessionId: "session-1",
		sessionRevision: 4,
		operations: paths.map((sourcePath, index) => ({
			itemId: `item-${index + 1}`,
			sourcePath,
			sourceMtime: 100,
			sourceSize: 200,
			destinationPath: targets[index],
			proposedName: targets[index].slice(targets[index].lastIndexOf("/") + 1),
			effects: { path: true as const, pdfBytes: false as const },
		})),
	};
}

function vault(files: ReturnType<typeof file>[], folders = ["Inbox", "Sources"]) {
	const root = { type: "folder", path: "" };
	const folderObjects = new Map(folders.map((path) => [path, { type: "folder", path }]));
	const allFolders = [root, ...folderObjects.values()];
	return {
		getFiles: vi.fn(() => files),
		getAllFolders: vi.fn(() => allFolders),
		getRoot: vi.fn(() => root),
		getAbstractFileByPath: vi.fn(
			(path: string) =>
				files.find((entry) => entry.path === path) ?? folderObjects.get(path) ?? null,
		),
		rename: vi.fn((_file: unknown, _path: string): Promise<void> => Promise.resolve()),
	};
}

function statefulVault(files: ReturnType<typeof file>[]) {
	const root = { type: "folder", path: "" };
	const folderObjects = new Map(["Inbox"].map((path) => [path, { type: "folder", path }]));
	const allFolders = [root, ...folderObjects.values()];
	return {
		getFiles: vi.fn(() => files),
		getAllFolders: vi.fn(() => allFolders),
		getRoot: vi.fn(() => root),
		getAbstractFileByPath: vi.fn(
			(path: string) =>
				files.find((entry) => entry.path === path) ?? folderObjects.get(path) ?? null,
		),
		rename: vi.fn((rawFile: unknown, destinationPath: string): Promise<void> => {
			const source = rawFile as ReturnType<typeof file>;
			if (!files.includes(source)) throw new Error("source is no longer in the vault");
			if (files.some((entry) => entry !== source && entry.path === destinationPath)) {
				throw new Error("destination is occupied");
			}
			source.path = destinationPath;
			source.name = destinationPath.slice(destinationPath.lastIndexOf("/") + 1);
			return Promise.resolve();
		}),
	};
}

function bindingsFor(invocationValue: ApplyInvocation, files: ReturnType<typeof file>[]) {
	return new Map(
		invocationValue.operations.map((operation, index) => [operation.itemId, files[index]]),
	) as never;
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((yes) => (resolve = yes));
	return { promise, resolve };
}

describe("ApplyChangesService", () => {
	it("rejects cross-operation rename chains before either order can mutate the vault", async () => {
		const cases = [
			{
				sourcePaths: ["Inbox/b.pdf", "Inbox/a.pdf"],
				destinationPaths: ["Inbox/c.pdf", "Inbox/b.pdf"],
			},
			{
				sourcePaths: ["Inbox/a.pdf", "Inbox/b.pdf"],
				destinationPaths: ["Inbox/b.pdf", "Inbox/c.pdf"],
			},
		];
		for (const testCase of cases) {
			const sources = testCase.sourcePaths.map((path) => file(path));
			const originalPaths = sources.map((source) => source.path);
			const host = statefulVault(sources);
			const plan = invocation(testCase.sourcePaths, testCase.destinationPaths);
			const result = await new ApplyChangesService(host as never).apply(
				plan,
				bindingsFor(plan, sources),
			);
			expect(result).toMatchObject({ status: "rejected" });
			expect(host.rename).not.toHaveBeenCalled();
			expect(sources.map((source) => source.path)).toEqual(originalPaths);
		}
	});

	it("renames exactly to the reviewed destination and reports path-only success after resolution", async () => {
		const source = file("Inbox/source.pdf");
		const host = vault([source]);
		const gate = deferred();
		host.rename.mockImplementation(() => gate.promise);
		const service = new ApplyChangesService(host as never);
		const plan = invocation();
		const running = service.apply(plan, bindingsFor(plan, [source]));
		expect(host.rename).toHaveBeenCalledTimes(1);
		expect(host.rename).toHaveBeenCalledWith(source, "Inbox/Target.pdf");
		gate.resolve();
		await expect(running).resolves.toMatchObject({
			status: "completed",
			outcomes: [{ status: "renamed", effects: { path: true, pdfBytes: false } }],
		});
	});

	it("reports a rejected rename as failed and continues only the remaining frozen operations", async () => {
		const first = file("Inbox/one.pdf");
		const second = file("Inbox/two.pdf");
		const host = vault([first, second]);
		host.rename.mockImplementationOnce(() => Promise.reject(new Error("write rejected")));
		const plan = invocation([first.path, second.path], ["Inbox/One.pdf", "Inbox/Two.pdf"]);
		const result = await new ApplyChangesService(host as never).apply(
			plan,
			bindingsFor(plan, [first, second]),
		);
		expect(result).toMatchObject({
			status: "completed",
			outcomes: [{ status: "failed", message: "write rejected" }, { status: "renamed" }],
		});
		expect(host.rename).toHaveBeenCalledTimes(2);
	});

	it("does no work for empty scope and rejects malformed scope before any write", async () => {
		const host = vault([]);
		const service = new ApplyChangesService(host as never);
		await expect(service.apply(invocation([], []), new Map())).resolves.toMatchObject({
			status: "completed",
			outcomes: [],
		});
		const duplicate = invocation(
			["Inbox/a.pdf", "Inbox/b.pdf"],
			["Inbox/Target.pdf", "Inbox/target.pdf"],
		);
		await expect(service.apply(duplicate, new Map())).resolves.toMatchObject({
			status: "rejected",
		});
		const escaping = invocation(["../outside.pdf"], ["Inbox/Target.pdf"]);
		await expect(service.apply(escaping, new Map())).resolves.toMatchObject({
			status: "rejected",
		});
		expect(host.rename).not.toHaveBeenCalled();
	});

	it("rechecks files and folders at the destination, including case-folded conflicts", async () => {
		const source = file("Inbox/source.pdf");
		for (const occupied of [
			file("Inbox/TARGET.pdf"),
			{ type: "folder", path: "Inbox/Target.pdf" },
		]) {
			const host = vault([source]);
			host.getFiles.mockReturnValue(
				occupied.type === "file" ? [source, occupied as ReturnType<typeof file>] : [source],
			);
			if (occupied.type === "folder")
				host.getAllFolders.mockReturnValue([
					{ type: "folder", path: "" },
					{ type: "folder", path: "Inbox" },
					occupied,
				] as never);
			const plan = invocation();
			const result = await new ApplyChangesService(host as never).apply(
				plan,
				bindingsFor(plan, [source]),
			);
			expect(result).toMatchObject({
				status: "completed",
				outcomes: [{ status: "blocked", reason: "destination-conflict" }],
			});
			expect(host.rename).not.toHaveBeenCalled();
		}
	});

	it("blocks missing/replaced/changed/non-PDF sources without substituting another file", async () => {
		const source = file("Inbox/source.pdf");
		const plan = invocation();
		const cases = [
			vault([]),
			vault([file("Inbox/source.pdf")]),
			vault([file("Inbox/source.pdf", { extension: "txt" })]),
			vault([file("Inbox/source.pdf", { stat: { mtime: 101, size: 200 } })]),
			vault([file("Inbox/source.pdf", { stat: { mtime: 100, size: 201 } })]),
		];
		for (const host of cases) {
			const result = await new ApplyChangesService(host as never).apply(
				plan,
				new Map([["item-1", source]]) as never,
			);
			expect(result).toMatchObject({
				status: "completed",
				outcomes: [{ status: "blocked" }],
			});
			expect(host.rename).not.toHaveBeenCalled();
		}
		const host = vault([source]);
		const missingBinding = await new ApplyChangesService(host as never).apply(plan, new Map());
		expect(missingBinding).toMatchObject({
			outcomes: [{ status: "blocked", reason: "missing-binding" }],
		});
	});

	it("blocks a vanished destination parent and accepts explicit vault-root destinations", async () => {
		const source = file("Inbox/source.pdf");
		const plan = invocation();
		const host = vault([source], []);
		const result = await new ApplyChangesService(host as never).apply(
			plan,
			bindingsFor(plan, [source]),
		);
		expect(result).toMatchObject({
			outcomes: [{ status: "blocked", reason: "invalid-destination" }],
		});
		expect(host.rename).not.toHaveBeenCalled();
		const rootPlan = invocation([source.path], ["Target.pdf"]);
		const rootResult = await new ApplyChangesService(vault([source]) as never).apply(
			rootPlan,
			bindingsFor(rootPlan, [source]),
		);
		expect(rootResult).toMatchObject({
			outcomes: [{ status: "renamed", destinationPath: "Target.pdf" }],
		});
	});

	it("keeps in-flight source scope detached from caller maps and rejects a concurrent invocation", async () => {
		const first = file("Inbox/one.pdf");
		const second = file("Inbox/two.pdf");
		const extra = file("Inbox/extra.pdf");
		const host = vault([first, second, extra]);
		const gate = deferred();
		host.rename.mockImplementationOnce(async () => gate.promise);
		const service = new ApplyChangesService(host as never);
		const reviewed = invocation([first.path, second.path], ["Inbox/One.pdf", "Inbox/Two.pdf"]);
		const originalBindings = new Map([
			["item-1", first],
			["item-2", second],
		]);
		const running = service.apply(reviewed, originalBindings as never);
		originalBindings.clear();
		originalBindings.set("extra", extra);
		const concurrent = await service.apply(invocation(), new Map() as never);
		expect(concurrent.status).toBe("busy");
		gate.resolve();
		const result = await running;
		expect(result).toMatchObject({
			status: "completed",
			outcomes: [{ status: "renamed" }, { status: "renamed" }],
		});
		expect(host.rename).toHaveBeenCalledTimes(2);
		expect(host.rename.mock.calls.map((call) => call[0])).toEqual([first, second]);
	});

	it("allows an own-source case-only rename but never reports a no-op as a rename", async () => {
		const source = file("Inbox/name.pdf");
		const host = vault([source]);
		const casePlan = invocation([source.path], ["Inbox/NAME.pdf"]);
		await expect(
			new ApplyChangesService(host as never).apply(casePlan, bindingsFor(casePlan, [source])),
		).resolves.toMatchObject({
			outcomes: [{ status: "renamed" }],
		});
		const confusable = file("Inbox/NAME.pdf");
		const occupiedHost = vault([source, confusable]);
		await expect(
			new ApplyChangesService(occupiedHost as never).apply(
				casePlan,
				bindingsFor(casePlan, [source]),
			),
		).resolves.toMatchObject({
			outcomes: [{ status: "blocked", reason: "destination-conflict" }],
		});
		expect(occupiedHost.rename).not.toHaveBeenCalled();
		const noOp = invocation([source.path], [source.path]);
		await expect(
			new ApplyChangesService(host as never).apply(noOp, bindingsFor(noOp, [source])),
		).resolves.toMatchObject({ status: "rejected" });
	});

	it("uses locale-independent conflict keys compatible with planning", async () => {
		const localeFold = vi
			.spyOn(String.prototype, "toLocaleLowerCase")
			.mockImplementation(function (this: string) {
				return this.toString().replace(/I/g, "ı").toLowerCase();
			});
		try {
			const source = file("Inbox/source.pdf");
			const occupied = file("Inbox/istanbul.pdf");
			const host = vault([source, occupied]);
			const plan = invocation([source.path], ["Inbox/Istanbul.pdf"]);
			const result = await new ApplyChangesService(host as never).apply(
				plan,
				bindingsFor(plan, [source]),
			);
			expect(normalizePathConflictKey("Inbox/Istanbul.pdf")).toBe(
				normalizePathConflictKey("Inbox/istanbul.pdf"),
			);
			expect(result).toMatchObject({
				status: "completed",
				outcomes: [{ status: "blocked", reason: "destination-conflict" }],
			});
			expect(host.rename).not.toHaveBeenCalled();
			expect(localeFold).not.toHaveBeenCalled();
		} finally {
			localeFold.mockRestore();
		}
	});
});
