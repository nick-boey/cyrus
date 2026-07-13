import { EventEmitter } from "node:events";
import type { AgentEvent, IIssueTrackerService } from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
import type { RouterConnection } from "../src/RouterConnection.js";
import { RouterEventTransport } from "../src/RouterEventTransport.js";
import { RouterIssueTrackerService } from "../src/RouterIssueTrackerService.js";

/** Minimal stub matching the brief's shape, cast via `unknown`. */
function makeStubConnection(): {
	rpc: ReturnType<typeof vi.fn>;
	bufferedRpc: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
} {
	return {
		rpc: vi.fn(async () => ({ id: "i1" })),
		bufferedRpc: vi.fn(async () => ({ success: true })),
		on: vi.fn(),
	};
}

/**
 * A real EventEmitter standing in for RouterConnection, used only for
 * scenario (d) where we need `on("event", …)` to actually register and be
 * invocable so we can assert the synchronous re-emit behavior.
 */
function makeEmitterConnection(): RouterConnection {
	const emitter = new EventEmitter();
	return emitter as unknown as RouterConnection;
}

describe("RouterIssueTrackerService", () => {
	it("(a) fetchIssue calls rpc('fetchIssue', ['ws-1', 'ABC-1'])", async () => {
		const conn = makeStubConnection();
		const svc = new RouterIssueTrackerService(
			conn as unknown as RouterConnection,
			"ws-1",
		);

		await svc.fetchIssue("ABC-1");

		expect(conn.rpc).toHaveBeenCalledWith("fetchIssue", ["ws-1", "ABC-1"]);
	});

	it("(b) createAgentActivity calls bufferedRpc with workspace prepended, and the result satisfies AgentActivityPayload (success:true)", async () => {
		const conn = makeStubConnection();
		const svc = new RouterIssueTrackerService(
			conn as unknown as RouterConnection,
			"ws-1",
		);
		const input = {
			agentSessionId: "s1",
			content: { type: "thought" as const, body: "thinking" },
		};

		const result = await svc.createAgentActivity(input as never);

		expect(conn.bufferedRpc).toHaveBeenCalledWith("createAgentActivity", [
			"ws-1",
			input,
		]);
		expect(conn.rpc).not.toHaveBeenCalled();
		// LinearActivitySink.ts reads `.success` — must be present and true
		// whether the router answered live or the call was buffered offline.
		expect(result.success).toBe(true);
	});

	it("(c) getPlatformType returns 'linear'", () => {
		const conn = makeStubConnection();
		const svc = new RouterIssueTrackerService(
			conn as unknown as RouterConnection,
			"ws-1",
		);

		expect(svc.getPlatformType()).toBe("linear");
	});

	it("getPlatformMetadata returns transport + workspaceId", () => {
		const conn = makeStubConnection();
		const svc = new RouterIssueTrackerService(
			conn as unknown as RouterConnection,
			"ws-1",
		);

		expect(svc.getPlatformMetadata()).toEqual({
			transport: "router",
			workspaceId: "ws-1",
		});
	});

	it("(d) createEventTransport returns a transport whose register() does not throw and which re-emits a connection 'event' as a transport 'event'", () => {
		const conn = makeEmitterConnection();
		const svc = new RouterIssueTrackerService(conn, "ws-1");

		const transport = svc.createEventTransport({
			fastifyServer: {} as never,
			platform: "cli",
		});

		expect(() => transport.register()).not.toThrow();

		const received: AgentEvent[] = [];
		transport.on("event", (event: AgentEvent) => {
			received.push(event);
		});

		const payload = {
			type: "AppUserNotification",
			action: "issueAssignedToYou",
		} as unknown as AgentEvent;
		(conn as unknown as EventEmitter).emit("event", payload, 1);

		expect(received).toEqual([payload]);
	});

	it("re-emits synchronously: the transport's 'event' listener fires before RouterConnection.emit('event', …) returns", () => {
		const conn = makeEmitterConnection();
		const svc = new RouterIssueTrackerService(conn, "ws-1");
		const transport = svc.createEventTransport({
			fastifyServer: {} as never,
			platform: "cli",
		});

		let sawEventDuringEmit = false;
		transport.on("event", () => {
			sawEventDuringEmit = true;
		});

		const delivered = (conn as unknown as EventEmitter).emit(
			"event",
			{ type: "AppUserNotification", action: "issueAssignedToYou" },
			1,
		);

		// By the time RouterConnection's own emit() call returns, our
		// transport listener must already have fired synchronously — this is
		// the Task 10 consumer contract RouterEventTransport must honor.
		expect(delivered).toBe(true);
		expect(sawEventDuringEmit).toBe(true);
	});

	it("type-level conformance: RouterIssueTrackerService satisfies IIssueTrackerService", () => {
		const conn = makeStubConnection();
		// This assignment is the conformance gate: it must compile with every
		// IIssueTrackerService method present with the exact signature.
		const svc: IIssueTrackerService = new RouterIssueTrackerService(
			conn as unknown as RouterConnection,
			"ws-1",
		);
		expect(svc.getPlatformType()).toBe("linear");
	});
});

describe("RouterEventTransport", () => {
	it("subscribes to the connection's 'event' synchronously in the constructor", () => {
		const conn = makeEmitterConnection();
		new RouterEventTransport(conn);

		expect((conn as unknown as EventEmitter).listenerCount("event")).toBe(1);
	});
});

/**
 * The router serializes issues to JSON, which strips every lazy member of
 * `Issue` — the five async getters and six methods all live on the SDK class's
 * prototype. These tests pin the reconstruction.
 *
 * The two failure modes they guard against were both observed in production:
 *   - `TypeError: issue.labels is not a function` (methods vanish outright)
 *   - `await issue.team` → `undefined` (getters vanish *silently*, because
 *     `await undefined` is `undefined`, so the caller concludes "no team")
 */
describe("RouterIssueTrackerService issue hydration", () => {
	/** A relation reference as the SDK stores it: `{ id }` and nothing more. */
	type Ref = { id: string } | null;

	/**
	 * Stands in for `LinearSDK.Issue`, reproducing the one structural detail that
	 * decides whether hydration works: the relation ids are **prototype getters**
	 * over private backing fields, not own properties. `JSON.stringify` keeps only
	 * own enumerable properties, so `stateId` and friends never cross the wire —
	 * only `_state`, `_team`, … do.
	 *
	 * Hand-writing the payload with `stateId` as an own property (what this
	 * fixture used to do) is precisely what let the hydration bug ship green.
	 */
	class SdkLikeIssue {
		id = "issue-uuid";
		identifier = "PAR-87";
		title = "Add slash commands";
		description = "body";
		url = "https://linear.app/x/issue/PAR-87";
		branchName = "nboey/par-87";
		labelIds = ["label-1", "label-2"];
		priority = 0;

		_state: Ref;
		_team: Ref;
		_assignee: Ref;
		_parent: Ref;
		_project: Ref;

		constructor(rel: Partial<Record<string, Ref>> = {}) {
			this._state = rel.state !== undefined ? rel.state : { id: "state-1" };
			this._team = rel.team !== undefined ? rel.team : { id: "team-1" };
			this._assignee =
				rel.assignee !== undefined ? rel.assignee : { id: "user-1" };
			this._parent = rel.parent !== undefined ? rel.parent : { id: "parent-1" };
			this._project = rel.project !== undefined ? rel.project : null;
		}

		get stateId() {
			return this._state?.id;
		}
		get teamId() {
			return this._team?.id;
		}
		get assigneeId() {
			return this._assignee?.id;
		}
		get parentId() {
			return this._parent?.id;
		}
		get projectId() {
			return this._project?.id;
		}
	}

	/** The data-only payload a real router sends: an SDK issue through JSON. */
	function sdkWireIssue(
		rel?: Partial<Record<string, Ref>>,
	): Record<string, unknown> {
		return JSON.parse(JSON.stringify(new SdkLikeIssue(rel)));
	}

	const RAW_ISSUE = sdkWireIssue();

	// Guards the fixture itself. If this ever fails, the payload has stopped
	// modelling the SDK and every hydration test below is testing a fiction.
	it("fixture check: serializing an SDK issue drops the relation ids", () => {
		expect(RAW_ISSUE.stateId).toBeUndefined();
		expect(RAW_ISSUE.teamId).toBeUndefined();
		expect(RAW_ISSUE.parentId).toBeUndefined();
		expect(RAW_ISSUE.assigneeId).toBeUndefined();
		// Only the private backing fields survive.
		expect(RAW_ISSUE._state).toEqual({ id: "state-1" });
		expect(RAW_ISSUE._team).toEqual({ id: "team-1" });
	});

	/** Routes each RPC method to a canned payload, and records the calls. */
	function makeRoutingConnection(overrides: Record<string, unknown> = {}) {
		const responses: Record<string, unknown> = {
			fetchIssue: RAW_ISSUE,
			fetchWorkflowState: { id: "state-1", name: "In Progress" },
			fetchUser: { id: "user-1", name: "Nick" },
			fetchTeam: { id: "team-1", key: "PAR", name: "Parrot" },
			fetchLabel: { id: "label-1", name: "bug" },
			fetchIssueAttachments: [{ title: "Sentry", url: "https://sentry.io/1" }],
			fetchComments: { nodes: [{ id: "c1", body: "hi" }] },
			fetchIssueChildren: { ...RAW_ISSUE, children: [], childCount: 0 },
			fetchIssueInverseRelations: [],
			updateIssue: RAW_ISSUE,
			...overrides,
		};
		const calls: Array<{ method: string; params: unknown[] }> = [];
		const rpc = vi.fn(async (method: string, params: unknown[]) => {
			calls.push({ method, params });
			if (!(method in responses)) throw new Error(`unstubbed rpc: ${method}`);
			return responses[method];
		});
		return { conn: { rpc, bufferedRpc: vi.fn(), on: vi.fn() }, calls };
	}

	function makeService(overrides?: Record<string, unknown>) {
		const { conn, calls } = makeRoutingConnection(overrides);
		const svc = new RouterIssueTrackerService(
			conn as unknown as RouterConnection,
			"ws-1",
		);
		return { svc, conn, calls };
	}

	it("preserves the raw data fields", async () => {
		const { svc } = makeService();
		const issue = await svc.fetchIssue("PAR-87");

		expect(issue.id).toBe("issue-uuid");
		expect(issue.identifier).toBe("PAR-87");
		expect(issue.title).toBe("Add slash commands");
	});

	// Regression: `await issue.team` silently yielded undefined, so EdgeWorker
	// logged "No team found" and never moved the issue to In Progress.
	it("resolves the team getter through fetchTeam instead of yielding undefined", async () => {
		const { svc, conn } = makeService();
		const issue = await svc.fetchIssue("PAR-87");

		const team = await issue.team;

		expect(team).toBeDefined();
		expect(team?.key).toBe("PAR");
		expect(conn.rpc).toHaveBeenCalledWith("fetchTeam", ["ws-1", "team-1"]);
	});

	it("resolves the state getter through fetchWorkflowState", async () => {
		const { svc } = makeService();
		const issue = await svc.fetchIssue("PAR-87");

		expect((await issue.state)?.name).toBe("In Progress");
	});

	it("resolves the assignee getter through fetchUser", async () => {
		const { svc } = makeService();
		const issue = await svc.fetchIssue("PAR-87");

		expect((await issue.assignee)?.name).toBe("Nick");
	});

	it("resolves the parent getter through fetchIssue", async () => {
		const { svc, conn } = makeService();
		const issue = await svc.fetchIssue("PAR-87");

		const parent = await issue.parent;

		expect(parent?.id).toBe("issue-uuid");
		expect(conn.rpc).toHaveBeenCalledWith("fetchIssue", ["ws-1", "parent-1"]);
	});

	it("returns undefined for getters whose relation is absent, without an RPC", async () => {
		const { svc, conn } = makeService({
			fetchIssue: sdkWireIssue({ team: null, assignee: null, parent: null }),
		});
		const issue = await svc.fetchIssue("PAR-87");

		expect(issue.team).toBeUndefined();
		expect(issue.assignee).toBeUndefined();
		expect(issue.parent).toBeUndefined();
		expect(conn.rpc).not.toHaveBeenCalledWith("fetchTeam", expect.anything());
	});

	// A non-Linear tracker (CLIIssueTrackerService) builds plain objects that set
	// `stateId` directly and have no `_state` backing field. Both shapes must work.
	it("resolves getters from explicit ids when the payload has no backing fields", async () => {
		const { svc, conn } = makeService({
			fetchIssue: {
				id: "issue-uuid",
				identifier: "PAR-87",
				title: "Add slash commands",
				labelIds: [],
				priority: 0,
				stateId: "state-1",
				teamId: "team-1",
				assigneeId: "user-1",
			},
		});
		const issue = await svc.fetchIssue("PAR-87");

		expect((await issue.team)?.key).toBe("PAR");
		expect((await issue.state)?.name).toBe("In Progress");
		expect((await issue.assignee)?.name).toBe("Nick");
		expect(conn.rpc).toHaveBeenCalledWith("fetchTeam", ["ws-1", "team-1"]);
	});

	// The ids callers read directly (e.g. `issue.teamId`) must be present on the
	// hydrated object even though they never arrived as own properties.
	it("re-projects the resolved relation ids as own properties", async () => {
		const { svc } = makeService();
		const issue = await svc.fetchIssue("PAR-87");

		expect(issue.stateId).toBe("state-1");
		expect(issue.teamId).toBe("team-1");
		expect(issue.assigneeId).toBe("user-1");
	});

	it("memoizes a getter so repeated reads cost one round trip", async () => {
		const { svc, calls } = makeService();
		const issue = await svc.fetchIssue("PAR-87");

		await issue.state;
		await issue.state;
		await issue.state;

		expect(calls.filter((c) => c.method === "fetchWorkflowState")).toHaveLength(
			1,
		);
	});

	// Regression: `TypeError: issue.labels is not a function`
	it("rebuilds labels() as real Label objects from labelIds", async () => {
		const { svc, calls } = makeService();
		const issue = await svc.fetchIssue("PAR-87");

		const labels = await issue.labels();

		expect(labels.nodes).toHaveLength(2);
		expect(labels.nodes[0]?.name).toBe("bug");
		expect(calls.filter((c) => c.method === "fetchLabel")).toHaveLength(2);
	});

	// Regression: `TypeError: issue.attachments is not a function`
	it("rebuilds attachments() with title and url", async () => {
		const { svc } = makeService();
		const issue = await svc.fetchIssue("PAR-87");

		const attachments = await issue.attachments();

		expect(attachments.nodes).toEqual([
			{ title: "Sentry", url: "https://sentry.io/1" },
		]);
	});

	it("rebuilds comments()", async () => {
		const { svc } = makeService();
		const issue = await svc.fetchIssue("PAR-87");

		expect((await issue.comments()).nodes[0]?.body).toBe("hi");
	});

	// Regression: `TypeError: issue.inverseRelations is not a function`.
	// The relation's `issue` is a Promise on the type, which JSON-serializes to
	// `{}` — so the router sends resolved data and the client re-wraps it.
	it("rebuilds inverseRelations() with awaitable, hydrated relation issues", async () => {
		const { svc } = makeService({
			fetchIssueInverseRelations: [
				{
					id: "rel-1",
					type: "blocks",
					issue: { ...RAW_ISSUE, id: "blocker", identifier: "PAR-1" },
					relatedIssue: undefined,
				},
			],
		});
		const issue = await svc.fetchIssue("PAR-87");

		const relations = await issue.inverseRelations();

		expect(relations.nodes).toHaveLength(1);
		expect(relations.nodes[0]?.type).toBe("blocks");

		// The exact access pattern PromptBuilder.fetchBlockingIssues uses.
		const blocking = await relations.nodes[0]?.issue;
		expect(blocking?.identifier).toBe("PAR-1");
		// …and the relation's issue is itself hydrated, not a bare payload.
		expect(typeof blocking?.labels).toBe("function");
	});

	it("hydrates children returned by fetchIssueChildren", async () => {
		const { svc } = makeService({
			fetchIssueChildren: {
				...RAW_ISSUE,
				children: [{ ...RAW_ISSUE, id: "kid", identifier: "PAR-88" }],
				childCount: 1,
			},
		});

		const withChildren = await svc.fetchIssueChildren("PAR-87");

		expect(withChildren.childCount).toBe(1);
		const child = withChildren.children[0];
		expect(child?.identifier).toBe("PAR-88");
		expect(typeof child?.labels).toBe("function");
		expect(await child?.team).toBeDefined();
	});

	it("hydrates the issue returned by updateIssue", async () => {
		const { svc } = makeService();

		const updated = await svc.updateIssue("issue-uuid", { title: "x" });

		expect(typeof updated.labels).toBe("function");
		expect(await updated.team).toBeDefined();
	});

	it("fetchIssueInverseRelations prepends the workspace id", async () => {
		const { svc, conn } = makeService();

		await svc.fetchIssueInverseRelations("issue-uuid");

		expect(conn.rpc).toHaveBeenCalledWith("fetchIssueInverseRelations", [
			"ws-1",
			"issue-uuid",
		]);
	});
});
