import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createLogger,
	cyrusAttributes,
	LogLevel,
	resetGlobalLogSink,
	setGlobalLogSink,
} from "cyrus-core";
import { RouterConnection, RouterLogForwarder } from "cyrus-router-client";
import type { LogFrame } from "cyrus-router-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceGateway } from "../src/DeviceGateway.js";
import { RouterStore } from "../src/RouterStore.js";
import { SANDBOX_LOG_SOURCE, SandboxLogRelay } from "../src/SandboxLogRelay.js";

/**
 * End-to-end proof of NOR-280's "done when": a log line emitted inside the
 * sandbox worker's process reaches the router's stdout — the one stream Log
 * Analytics already collects — attributed to the right issue and device.
 *
 * Everything real except Azure: a genuine `RouterConnection` dialling a genuine
 * `DeviceGateway` over a loopback WebSocket, with the forwarder installed as
 * the process-wide log sink exactly as `EdgeWorker` installs it.
 */
describe("sandbox worker logs, device → router → stdout", () => {
	let store: RouterStore;
	let gateway: DeviceGateway;
	let httpServer: ReturnType<typeof createServer>;
	let connection: RouterConnection;
	let stateDir: string;
	/** Lines the RELAY wrote — i.e. what Log Analytics would actually collect. */
	let relayed: Array<Record<string, unknown>>;
	/** Every console line, including the worker's own local rendering. */
	let allLines: Array<Record<string, unknown>>;

	beforeEach(async () => {
		process.env.CYRUS_LOG_FORMAT = "json";
		relayed = [];
		allLines = [];
		// Device and router share this process, so both write to the same console.
		// The relay stamps `cyrus.source: "sandbox"`, which is exactly how an
		// operator tells the two apart in KQL — so the test separates them the
		// same way.
		const capture = (line: unknown) => {
			const record = JSON.parse(String(line)) as Record<string, unknown>;
			allLines.push(record);
			if (record["cyrus.source"] === SANDBOX_LOG_SOURCE) relayed.push(record);
		};
		vi.spyOn(console, "warn").mockImplementation(capture);
		vi.spyOn(console, "log").mockImplementation(capture);
		vi.spyOn(console, "error").mockImplementation(capture);

		store = new RouterStore(":memory:");
		const { userId } = store.addUser({ email: "alice@example.com" });
		// A container device, so the relay has an issue to attribute to — the
		// case Phase 2 exists for.
		const container = store.createContainerDevice(userId, "NOR-280", "aca");

		gateway = new DeviceGateway(store);
		const relay = new SandboxLogRelay();
		gateway.on("log", (deviceId: number, frame: LogFrame) => {
			const info = store.getDeviceInfo(deviceId);
			relay.relay(frame, {
				deviceId,
				...(info?.issueKey ? { issueKey: info.issueKey } : {}),
				...(info?.provider ? { provider: info.provider } : {}),
			});
		});

		httpServer = createServer();
		gateway.attach(httpServer, "/device");
		await new Promise<void>((r) => httpServer.listen(0, r));
		const port = (httpServer.address() as AddressInfo).port;

		stateDir = mkdtempSync(join(tmpdir(), "cyrus-sandbox-logs-"));
		connection = new RouterConnection({
			url: `ws://127.0.0.1:${port}`,
			deviceToken: container.deviceToken,
			stateDir,
		});
		const connected = new Promise<void>((r) =>
			connection.once("connected", () => r()),
		);
		connection.connect();
		await connected;

		setGlobalLogSink(new RouterLogForwarder({ connection, env: {} }));
	});

	afterEach(() => {
		resetGlobalLogSink();
		connection.close();
		gateway.close();
		httpServer.close();
		store.close();
		rmSync(stateDir, { recursive: true, force: true });
		vi.restoreAllMocks();
		delete process.env.CYRUS_LOG_FORMAT;
	});

	it("negotiates log_ingest before the device forwards anything", () => {
		expect(connection.acceptsLogs).toBe(true);
	});

	it("lands a worker warning on the router's stdout, attributed to the issue", async () => {
		createLogger({ component: "EdgeWorker", level: LogLevel.SILENT })
			.withContext({ sessionId: "sess-1" })
			.warn("git push failed");

		await vi.waitFor(() =>
			expect(relayed.some((r) => r.message === "git push failed")).toBe(true),
		);
		const line = relayed.find((r) => r.message === "git push failed");
		expect(line).toMatchObject({
			level: "warn",
			component: "sandbox/EdgeWorker",
			"cyrus.source": "sandbox",
			"cyrus.issue_key": "NOR-280",
			"cyrus.provider": "aca",
			sessionId: "sess-1",
		});
		expect(typeof line?.["cyrus.device_id"]).toBe("number");
		// Emitted at SILENT locally: the worker's own console said nothing, and
		// the line still reached the router. The local level governs the console,
		// the sink governs what leaves the process — that separation is the point.
		expect(
			allLines.filter(
				(r) =>
					r.message === "git push failed" && r["cyrus.source"] === undefined,
			),
		).toEqual([]);
	});

	it("ships a named lifecycle event even though it is below the WARN threshold", async () => {
		createLogger({ component: "ContainerLifecycle" }).event(
			"sandbox.gauge",
			cyrusAttributes({ sessions: 2, online: true }),
		);

		await vi.waitFor(() =>
			expect(relayed.some((r) => r.event === "sandbox.gauge")).toBe(true),
		);
		expect(relayed.find((r) => r.event === "sandbox.gauge")).toMatchObject({
			"cyrus.source": "sandbox",
			"cyrus.issue_key": "NOR-280",
			"cyrus.sessions": 2,
			"cyrus.online": true,
			component: "sandbox/ContainerLifecycle",
		});
	});

	it("does not forward an INFO line under the default threshold", async () => {
		createLogger({ component: "EdgeWorker" }).info("routine chatter");
		// Give a real round trip time to happen if it were going to.
		await new Promise((r) => setTimeout(r, 50));
		expect(relayed.some((r) => r.message === "routine chatter")).toBe(false);
	});

	it("keeps the socket alive across a burst — a log line never costs the connection", async () => {
		for (let i = 0; i < 200; i++) {
			createLogger({ component: "EdgeWorker", level: LogLevel.SILENT }).warn(
				`burst ${i}`,
			);
		}
		await vi.waitFor(() =>
			expect(relayed.some((r) => r.message === "burst 0")).toBe(true),
		);
		// The rate limit clamped the burst rather than shipping all 200…
		const burst = relayed.filter((r) => String(r.message).startsWith("burst "));
		expect(burst.length).toBeLessThan(200);
		// …and the connection is still up, which is what a version-negotiated
		// frame buys us over an unnegotiated one.
		expect(connection.connected).toBe(true);
	});
});
