import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RouterStore } from "../src/RouterStore.js";
import { registerRunsRoute } from "../src/runs.js";

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
});
