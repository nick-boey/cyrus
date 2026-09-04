import { runObservationV1Schema } from "cyrus-operator-protocol";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RouterStore } from "../src/RouterStore.js";
import {
	observeRun,
	registerRunsRoute,
	toRunObservationV1,
	UNREPORTED_RUNNER,
} from "../src/runs.js";

const NOW = 1_000_000;

describe("GET /runs", () => {
	let store: RouterStore;
	let fastify: ReturnType<typeof Fastify>;
	let physicalToken: string;
	let containerToken: string;
	let containerDeviceId: number;

	beforeEach(() => {
		store = new RouterStore(":memory:");
		store.addUser({ email: "alice@example.com" });
		const code = store.mintEnrollmentCode("alice@example.com", NOW);
		const physical = store.redeemEnrollmentCode(code, NOW);
		if (!physical) throw new Error("enrollment failed");
		physicalToken = physical.deviceToken;
		const container = store.createContainerDevice(1, "NOR-402", "aca");
		containerToken = container.deviceToken;
		containerDeviceId = container.deviceId;

		store.recordAgentRunRouted({
			deviceId: container.deviceId,
			issueKey: "NOR-402",
			sessionId: "session-a",
			activityId: "activity-a",
			commentId: "comment-a",
			routedMs: NOW,
		});
		store.recordAgentRunActivity("session-a", NOW + 100);
		store.touchDevice(container.deviceId, NOW + 200);

		store.recordAgentRunRouted({
			deviceId: physical.deviceId,
			issueKey: "NOR-403",
			sessionId: "session-b",
			commentId: "comment-b",
			routedMs: NOW - 10_000,
		});
		store.finishAgentRun("session-b", "complete", NOW - 9_000);

		store.addUser({ email: "bob@example.com" });
		const bobCode = store.mintEnrollmentCode("bob@example.com", NOW);
		const bob = store.redeemEnrollmentCode(bobCode, NOW);
		if (!bob) throw new Error("bob enrollment failed");
		store.recordAgentRunRouted({
			deviceId: bob.deviceId,
			issueKey: "OTHER-1",
			sessionId: "session-c",
			routedMs: NOW,
		});

		fastify = Fastify();
		registerRunsRoute(fastify, store, {
			now: () => NOW + 500,
			isDeviceOnline: (deviceId) => deviceId === containerDeviceId,
			getSandboxObservation: (deviceId) =>
				deviceId === containerDeviceId
					? { state: "running", observedMs: NOW + 300 }
					: undefined,
		});
	});

	afterEach(async () => {
		await fastify.close();
		store.close();
	});

	it("returns only the bearer token owner's runs with live worker and sandbox facts", async () => {
		const response = await fastify.inject({
			method: "GET",
			url: "/runs",
			headers: { authorization: `Bearer ${physicalToken}` },
		});

		expect(response.statusCode).toBe(200);
		const body = response.json();
		expect(body.observedAt).toBe(new Date(NOW + 500).toISOString());
		expect(body.runs).toHaveLength(2);
		expect(body.runs[0]).toMatchObject({
			issueKey: "NOR-402",
			state: "active",
			lastAgentActivityAt: new Date(NOW + 100).toISOString(),
			executorKind: "container",
			provider: "aca",
			workerOnline: true,
			lastHeartbeatAt: new Date(NOW + 200).toISOString(),
			sandboxState: "running",
			sandboxStateObservedAt: new Date(NOW + 300).toISOString(),
			inputs: [
				{
					activityId: "activity-a",
					commentId: "comment-a",
					routedAt: new Date(NOW).toISOString(),
				},
			],
		});
		expect(JSON.stringify(body)).not.toContain("bob@example.com");
		expect(JSON.stringify(body)).not.toContain("OTHER-1");
	});

	it("filters by comment and routed time", async () => {
		const response = await fastify.inject({
			method: "GET",
			url: `/runs?commentId=comment-a&since=${encodeURIComponent(new Date(NOW - 1).toISOString())}`,
			headers: { authorization: `Bearer ${physicalToken}` },
		});

		expect(response.statusCode).toBe(200);
		expect(
			response.json().runs.map((run: { issueKey: string }) => run.issueKey),
		).toEqual(["NOR-402"]);
	});

	it("limits a container token to its own issue", async () => {
		const own = await fastify.inject({
			method: "GET",
			url: "/runs",
			headers: { authorization: `Bearer ${containerToken}` },
		});
		expect(own.statusCode).toBe(200);
		expect(
			own.json().runs.map((run: { issueKey: string }) => run.issueKey),
		).toEqual(["NOR-402"]);

		const other = await fastify.inject({
			method: "GET",
			url: "/runs?issueKey=NOR-403",
			headers: { authorization: `Bearer ${containerToken}` },
		});
		expect(other.statusCode).toBe(403);
	});

	it("rejects missing credentials and malformed filters", async () => {
		expect(
			(await fastify.inject({ method: "GET", url: "/runs" })).statusCode,
		).toBe(401);
		expect(
			(
				await fastify.inject({
					method: "GET",
					url: "/runs?since=not-a-date",
					headers: { authorization: `Bearer ${physicalToken}` },
				})
			).statusCode,
		).toBe(400);
	});

	it("reports a waiting run to a legacy client as `parked`", async () => {
		store.setAgentRunState("session-a", "waiting", {
			wait: { reason: "elicitation", sinceMs: NOW + 400 },
		});

		const body = (
			await fastify.inject({
				method: "GET",
				url: "/runs",
				headers: { authorization: `Bearer ${physicalToken}` },
			})
		).json();

		// The frozen shape has no `waiting`, and its `parked` has always meant
		// exactly this — "blocked on a user answer". Every existing client reads it
		// that way, so the mapping is the old name read backwards, not a downgrade.
		expect(body.runs[0].state).toBe("parked");
		// New facts are deliberately absent here. They belong on the v1
		// observation and its own route; this shape does not grow.
		expect(body.runs[0]).not.toHaveProperty("wait");
		expect(body.runs[0]).not.toHaveProperty("revision");
		expect(body.runs[0]).not.toHaveProperty("routing");
	});

	it("separates the run's wait from its executor's sampled state", () => {
		store.setAgentRunState("session-a", "waiting", {
			wait: {
				reason: "other",
				sinceMs: NOW + 400,
				reportedCondition: "waiting on a deploy lock",
			},
			runner: "claude",
			model: "claude-opus-5",
		});
		const [run] = store.listAgentRuns({ userId: 1, issueKey: "NOR-402" });
		if (!run) throw new Error("expected the run");

		const observed = observeRun(run, {
			isDeviceOnline: () => true,
			getSandboxObservation: () => ({
				state: "running",
				observedMs: NOW + 300,
			}),
		});

		// The RUN is waiting; the CONTAINER is running. Collapsing the two is what
		// made a waiting run indistinguishable from a parked container.
		expect(observed.lifecycle).toBe("waiting");
		expect(observed.wait).toEqual({
			reason: "other",
			since: new Date(NOW + 400).toISOString(),
			reportedCondition: "waiting on a deploy lock",
		});
		expect(observed.executorState).toBe("running");
		expect(observed.executorStateObservedAt).toBe(
			new Date(NOW + 300).toISOString(),
		);
		expect(observed.runner).toBe("claude");
		expect(observed.model).toBe("claude-opus-5");
	});

	it("keeps a long pending-work run active and observable with its count", () => {
		// The seven-hour cron case. It is not waiting and it has not failed; the
		// only honest report is an active run carrying what is holding it open.
		store.setAgentRunState("session-a", "active", { pendingWorkCount: 2 });
		const [run] = store.listAgentRuns({ userId: 1, issueKey: "NOR-402" });
		if (!run) throw new Error("expected the run");

		const observed = observeRun(run, { isDeviceOnline: () => true });

		expect(observed.lifecycle).toBe("active");
		expect(observed.pendingWorkCount).toBe(2);
		expect(observed.wait).toBeUndefined();
		expect(observed.endedAt).toBeUndefined();
	});

	it("never reports pending work on a run that has ended", () => {
		store.setAgentRunState("session-a", "active", { pendingWorkCount: 2 });
		store.finishAgentRun("session-a", "complete", NOW + 900);
		const [run] = store.listAgentRuns({ userId: 1, issueKey: "NOR-402" });
		if (!run) throw new Error("expected the run");

		const observed = observeRun(run, { isDeviceOnline: () => false });

		// Live background work under a run that has ENDED is the one contradiction
		// the v1 observation refuses outright.
		expect(observed.lifecycle).toBe("complete");
		expect(observed.pendingWorkCount).toBeUndefined();
	});

	it("carries the routing snapshot the run was routed under", () => {
		const [run] = store.listAgentRuns({ userId: 1, issueKey: "NOR-402" });
		if (!run) throw new Error("expected the run");

		const observed = observeRun(run, { isDeviceOnline: () => true });

		// Owner and workspace come from the device's own row, so they are present
		// even for a route that carried no Linear team or project.
		expect(observed.routing.ownerUserId).toBe("1");
		expect(observed.routing.ownerName).toBe("alice@example.com");
		expect(observed.routing.routedAtMs).toBe(NOW);
	});
});

describe("v1 observation projection (CYR-69)", () => {
	let store: RouterStore;
	let deviceId: number;

	beforeEach(() => {
		store = new RouterStore(":memory:");
		const { userId } = store.addUser({
			email: "alice@example.com",
			name: "Alice",
		});
		deviceId = store.createContainerDevice(userId, "CYR-69", "aca").deviceId;
	});

	afterEach(() => {
		store.close();
	});

	const routeRun = (routing?: Record<string, string>) => {
		store.recordAgentRunRouted({
			deviceId,
			issueKey: "CYR-69",
			...(routing === undefined ? {} : { issueId: "issue-1" }),
			sessionId: "session-1",
			routedMs: NOW,
			...(routing ? { routing } : {}),
		});
		const [run] = store.listAgentRuns({ userId: 1 });
		if (!run) throw new Error("expected the run");
		return run;
	};

	const observedAt = new Date(NOW + 1_000).toISOString();

	it("renders a complete run against the published schema", () => {
		const run = routeRun({ workspaceId: "ws-a", workspaceName: "Acme" });
		store.setAgentRunState("session-1", "active", { runner: "claude" });
		const [latest] = store.listAgentRuns({ userId: 1 });

		const v1 = toRunObservationV1(observeRun(latest ?? run), observedAt);

		expect(v1).toBeDefined();
		expect(runObservationV1Schema.parse(v1)).toEqual(v1);
		expect(v1).toMatchObject({
			schemaVersion: 1,
			issueId: "issue-1",
			runner: "claude",
			observedAt,
			routing: { workspaceId: "ws-a", ownerUserId: "1", ownerName: "Alice" },
		});
	});

	it("reports an unreported runner rather than dropping a freshly routed run", () => {
		// The runner arrives on the worker's first state frame, so requiring it
		// would hide every run during the window an operator is most likely to be
		// watching one.
		const run = routeRun({ workspaceId: "ws-a" });

		const v1 = toRunObservationV1(observeRun(run), observedAt);

		expect(v1?.runner).toBe(UNREPORTED_RUNNER);
		expect(runObservationV1Schema.safeParse(v1).success).toBe(true);
	});

	it("declines a run that predates the routing-snapshot migration", () => {
		const run = routeRun();
		expect(toRunObservationV1(observeRun(run), observedAt)).toBeUndefined();
	});

	it("reads connectivity and the gauge off the run when no live source is given", () => {
		// This is what makes a stored observation renderable long after the sample
		// that produced it left memory — the change feed's whole premise.
		routeRun({ workspaceId: "ws-a" });
		store.setRunWorkerConnectivity(deviceId, true, NOW + 10);
		store.setRunExecutorState(deviceId, "running", NOW + 20);
		const [run] = store.listAgentRuns({ userId: 1 });
		if (!run) throw new Error("expected the run");

		const observed = observeRun(run);

		expect(observed.worker.online).toBe(true);
		expect(observed.executorState).toBe("running");
		expect(observed.executorStateObservedAt).toBe(
			new Date(NOW + 20).toISOString(),
		);
	});

	it("still prefers a live source when one is supplied", () => {
		// The legacy route keeps its in-memory reads exactly as they were.
		routeRun({ workspaceId: "ws-a" });
		store.setRunWorkerConnectivity(deviceId, true, NOW + 10);
		const [run] = store.listAgentRuns({ userId: 1 });
		if (!run) throw new Error("expected the run");

		expect(observeRun(run, { isDeviceOnline: () => false }).worker.online).toBe(
			false,
		);
	});
});
