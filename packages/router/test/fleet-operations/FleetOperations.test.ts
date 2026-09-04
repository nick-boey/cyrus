import {
	runChangePageV1Schema,
	runObservationPageV1Schema,
} from "cyrus-operator-protocol";
import { beforeEach, describe, expect, it } from "vitest";
import {
	FleetOperations,
	type FleetQueryError,
} from "../../src/fleet-operations/FleetOperations.js";
import { RunCursorCodec } from "../../src/fleet-operations/RunChangeCursor.js";
import type { OperatorPrincipal } from "../../src/fleet-operations/types.js";
import { RouterStore } from "../../src/RouterStore.js";

const NOW = 1_700_000_000_000;
const WS_A = "workspace-a";
const WS_B = "workspace-b";

/**
 * An Entra/local operator: scoped by workspace, never by owner. Built by hand
 * rather than through `OperatorAuthorizer` because these tests are about what a
 * principal may READ, and routing every case through token minting would test
 * the authorizer twice and the reads once.
 */
function operator(
	workspaceIds: string[],
	capabilities: Array<"runs.list" | "runs.changes"> = [
		"runs.list",
		"runs.changes",
	],
): { principal: OperatorPrincipal; capabilities: typeof capabilities } {
	return {
		principal: {
			id: "oid-1",
			authKind: "entra",
			roles: new Set(["fleet.read"] as const),
			workspaceIds: new Set(workspaceIds),
		},
		capabilities,
	};
}

/** A device token: owner-scoped, which is the narrowing that must survive. */
function device(userId: number, workspaceIds: string[]): OperatorPrincipal {
	return {
		id: `device:${userId}`,
		authKind: "device",
		roles: new Set(["fleet.read"] as const),
		workspaceIds: new Set(workspaceIds),
		ownerUserId: userId,
	};
}

describe("FleetOperations run observations (CYR-69)", () => {
	let store: RouterStore;
	let alice: number;
	let bob: number;
	let aliceDevice: number;
	let bobDevice: number;

	const build = (
		capabilities: Array<"runs.list" | "runs.changes"> = [
			"runs.list",
			"runs.changes",
		],
		cursors?: RunCursorCodec,
	) =>
		new FleetOperations({
			config: { capabilities },
			workspaceIds: [WS_A, WS_B],
			store,
			...(cursors ? { cursors } : {}),
			now: () => NOW,
		});

	beforeEach(() => {
		store = new RouterStore(":memory:");
		alice = store.addUser({ email: "alice@example.com", name: "Alice" }).userId;
		bob = store.addUser({ email: "bob@example.com", name: "Bob" }).userId;
		aliceDevice = store.createContainerDevice(alice, "AAA-1", "aca").deviceId;
		bobDevice = store.createContainerDevice(bob, "BBB-1", "aca").deviceId;

		store.recordAgentRunRouted({
			deviceId: aliceDevice,
			issueKey: "AAA-1",
			issueId: "issue-a",
			sessionId: "session-a",
			routedMs: NOW - 20_000,
			routing: {
				workspaceId: WS_A,
				workspaceName: "Acme",
				linearTeamId: "team-1",
				linearTeamName: "Platform",
				linearProjectId: "project-1",
				linearProjectName: "Fleet",
			},
			workerOnline: true,
		});
		store.recordAgentRunRouted({
			deviceId: bobDevice,
			issueKey: "BBB-1",
			issueId: "issue-b",
			sessionId: "session-b",
			routedMs: NOW - 10_000,
			routing: {
				workspaceId: WS_B,
				workspaceName: "Beta",
				linearTeamId: "team-2",
				// Deliberately the same captured name as team-1: two teams, one name.
				linearTeamName: "Platform",
			},
		});
	});

	describe("listRuns", () => {
		it("renders a v1 page for the caller's authorized workspaces only", () => {
			const { principal } = operator([WS_A]);

			const page = build().listRuns(principal);

			expect(runObservationPageV1Schema.safeParse(page).success).toBe(true);
			expect(page.runs.map((run) => run.agentSessionId)).toEqual(["session-a"]);
			expect(page.observedAt).toBe(new Date(NOW).toISOString());
			expect(page.runs[0]).toMatchObject({
				issueId: "issue-a",
				issueKey: "AAA-1",
				lifecycle: "routed",
				executorKind: "container",
				worker: { online: true },
				routing: {
					workspaceId: WS_A,
					workspaceName: "Acme",
					ownerUserId: String(alice),
					ownerName: "Alice",
					linearTeamId: "team-1",
					linearProjectId: "project-1",
				},
			});
			// The worker has reported nothing yet, so the required `runner` is
			// reported as unknown rather than the run being dropped from the view.
			expect(page.runs[0]?.runner).toBe("unknown");
		});

		it("refuses a principal that does not hold runs.list", () => {
			const { principal } = operator([WS_A]);
			expect(() => build(["runs.changes"]).listRuns(principal)).toThrowError(
				expect.objectContaining({ status: 403 }),
			);
		});

		it("narrows a device token to its own owner's runs", () => {
			// Both workspaces are authorized, so only the owner scope can exclude
			// Bob's run — which is the whole point of `ownerUserId`.
			const page = build().listRuns(device(alice, [WS_A, WS_B]));
			expect(page.runs.map((run) => run.agentSessionId)).toEqual(["session-a"]);
		});

		it("applies authorization before filtering, so a filter cannot widen it", () => {
			const { principal } = operator([WS_A]);
			const page = build().listRuns(principal, { workspace: WS_B });
			expect(page.runs).toEqual([]);
		});

		it("filters on every dimension the route accepts", () => {
			const { principal } = operator([WS_A, WS_B]);
			const fleet = build();
			const only = (query: Parameters<typeof fleet.listRuns>[1]) =>
				fleet.listRuns(principal, query).runs.map((run) => run.agentSessionId);

			expect(only({ agentSessionId: "session-b" })).toEqual(["session-b"]);
			expect(only({ issueId: "issue-a" })).toEqual(["session-a"]);
			expect(only({ issueKey: "aaa-1" })).toEqual(["session-a"]);
			expect(only({ workspace: WS_B })).toEqual(["session-b"]);
			expect(only({ owner: String(alice) })).toEqual(["session-a"]);
			expect(only({ team: "team-2" })).toEqual(["session-b"]);
			expect(only({ project: "project-1" })).toEqual(["session-a"]);
			expect(only({ lifecycle: "routed" })).toEqual(["session-b", "session-a"]);
			expect(only({ runId: fleet.listRuns(principal).runs[0]?.runId })).toEqual(
				["session-b"],
			);
		});

		it("resolves an exact captured name to its canonical id", () => {
			const { principal } = operator([WS_A, WS_B]);
			expect(
				build()
					.listRuns(principal, { project: "Fleet" })
					.runs.map((run) => run.agentSessionId),
			).toEqual(["session-a"]);
		});

		it("refuses an ambiguous captured name with 400 and its candidates", () => {
			const { principal } = operator([WS_A, WS_B]);
			let thrown: FleetQueryError | undefined;
			try {
				build().listRuns(principal, { team: "Platform" });
			} catch (error) {
				thrown = error as FleetQueryError;
			}
			expect(thrown?.status).toBe(400);
			expect(thrown?.code).toBe("ambiguous_name");
			expect(thrown?.candidates).toEqual([
				{ id: "team-1", name: "Platform" },
				{ id: "team-2", name: "Platform" },
			]);
		});

		it("does not report candidates from a workspace the caller cannot read", () => {
			// The same name is unambiguous once the unauthorized workspace's team is
			// out of scope — which is why authorization runs before resolution.
			const { principal } = operator([WS_A]);
			expect(
				build()
					.listRuns(principal, { team: "Platform" })
					.runs.map((run) => run.agentSessionId),
			).toEqual(["session-a"]);
		});

		it("treats an unmatched value as an id with no runs, not an error", () => {
			const { principal } = operator([WS_A, WS_B]);
			expect(
				build().listRuns(principal, { team: "team-missing" }).runs,
			).toEqual([]);
		});

		it("paginates without duplicating or skipping a run", () => {
			const { principal } = operator([WS_A, WS_B]);
			const fleet = build();

			const first = fleet.listRuns(principal, { limit: 1 });
			expect(first.runs.map((run) => run.agentSessionId)).toEqual([
				"session-b",
			]);
			expect(first.nextCursor).toBeDefined();

			const second = fleet.listRuns(principal, {
				limit: 1,
				cursor: first.nextCursor,
			});
			expect(second.runs.map((run) => run.agentSessionId)).toEqual([
				"session-a",
			]);
			// Last page carries no cursor.
			expect(second.nextCursor).toBeUndefined();
		});

		it("refuses a cursor presented against a different query", () => {
			const { principal } = operator([WS_A, WS_B]);
			const fleet = build();
			const cursor = fleet.listRuns(principal, { limit: 1 }).nextCursor;

			expect(() =>
				fleet.listRuns(principal, { limit: 1, cursor, lifecycle: "active" }),
			).toThrowError(
				expect.objectContaining({ status: 400, code: "cursor_query_mismatch" }),
			);
		});

		it("refuses another principal's cursor even for the same filters", () => {
			const fleet = build();
			const cursor = fleet.listRuns(operator([WS_A, WS_B]).principal, {
				limit: 1,
			}).nextCursor;

			expect(() =>
				fleet.listRuns(device(alice, [WS_A, WS_B]), { limit: 1, cursor }),
			).toThrowError(expect.objectContaining({ status: 400 }));
		});

		it("excludes a run that predates the routing-snapshot migration", () => {
			store.recordAgentRunRouted({
				deviceId: aliceDevice,
				issueKey: "AAA-9",
				sessionId: "session-legacy",
				routedMs: NOW,
			});
			const { principal } = operator([WS_A, WS_B]);
			expect(
				build()
					.listRuns(principal)
					.runs.map((run) => run.agentSessionId),
			).toEqual(["session-b", "session-a"]);
		});
	});

	describe("listChanges", () => {
		it("reports a transition that begins and ends between two snapshots", () => {
			const { principal } = operator([WS_A]);
			const fleet = build();

			const start = fleet.listChanges(principal);
			// Consume the routing entries so the assertion is about what happens
			// NEXT, the way a watching client would.
			store.setRunWorkerConnectivity(aliceDevice, false, NOW + 1);
			store.setRunWorkerConnectivity(aliceDevice, true, NOW + 2);

			const page = fleet.listChanges(principal, { cursor: start.nextCursor });

			expect(runChangePageV1Schema.safeParse(page).success).toBe(true);
			expect(
				page.changes.map((change) => [
					change.kind,
					change.observation.worker.online,
				]),
			).toEqual([
				["worker_connectivity", false],
				["worker_connectivity", true],
			]);
			expect(page.streamEpoch).toBe(store.changeStreamEpoch);
		});

		it("refuses a principal that does not hold runs.changes", () => {
			const { principal } = operator([WS_A]);
			expect(() => build(["runs.list"]).listChanges(principal)).toThrowError(
				expect.objectContaining({ status: 403 }),
			);
		});

		it("withholds entries for workspaces the caller cannot read", () => {
			const { principal } = operator([WS_A]);
			const page = build().listChanges(principal);
			expect(
				page.changes.every(
					(change) => change.observation.routing.workspaceId === WS_A,
				),
			).toBe(true);
		});

		it("narrows a device token's feed to its own owner", () => {
			const page = build().listChanges(device(bob, [WS_A, WS_B]));
			expect(page.changes.map((change) => change.observation.issueKey)).toEqual(
				["BBB-1"],
			);
		});

		it("returns a usable cursor on an empty page", () => {
			// A watch that polled and saw nothing still has to make progress; a
			// cursor that stood still would make other people's traffic look, to
			// this caller, like a stalled feed.
			const { principal } = operator([WS_A]);
			const fleet = build();
			const drained = fleet.listChanges(principal, {
				cursor: fleet.listChanges(principal).nextCursor,
			});

			expect(drained.changes).toEqual([]);
			expect(drained.nextCursor).toBeDefined();
			expect(
				fleet.listChanges(principal, { cursor: drained.nextCursor }).changes,
			).toEqual([]);
		});

		it("advances past entries the caller may not read", () => {
			const { principal } = operator([WS_A]);
			const fleet = build();
			const page = fleet.listChanges(principal);
			// Bob's entry was scanned and filtered out, so the cursor must be past
			// it — otherwise this caller re-scans it forever.
			expect(page.changes).toHaveLength(1);
			expect(
				fleet.listChanges(principal, { cursor: page.nextCursor }).changes,
			).toEqual([]);
		});

		it("answers 410 to a cursor from a previous router process", () => {
			const { principal } = operator([WS_A]);
			const before = build(
				["runs.list", "runs.changes"],
				new RunCursorCodec("epoch-before"),
			);
			const stale = before.listChanges(principal).nextCursor;

			const after = build(
				["runs.list", "runs.changes"],
				new RunCursorCodec("epoch-after"),
			);
			expect(() =>
				after.listChanges(principal, { cursor: stale }),
			).toThrowError(
				expect.objectContaining({ status: 410, code: "stream_gone" }),
			);
			// And the client can re-list and resume rather than being stuck.
			expect(after.listChanges(principal).nextCursor).toBeDefined();
		});
	});
});
