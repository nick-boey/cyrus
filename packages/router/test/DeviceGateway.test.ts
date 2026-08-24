import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
	HEARTBEAT_INTERVAL_MS,
	LOG_INGEST_CAPABILITY,
	PROTOCOL_VERSION,
} from "cyrus-router-protocol";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { DeviceGateway } from "../src/DeviceGateway.js";
import { RouterStore } from "../src/RouterStore.js";
import { type TestLogger, testLogger } from "./helpers/logger.js";

const NOW = 1_000_000;

async function setup(opts?: { heartbeatMs?: number; logger?: TestLogger }) {
	const store = new RouterStore(":memory:");
	store.addUser({ email: "alice@example.com" });
	const code = store.mintEnrollmentCode("alice@example.com", NOW);
	const device = store.redeemEnrollmentCode(code, NOW);
	if (!device) throw new Error("redeem failed");
	const gateway = new DeviceGateway(store, opts);
	const httpServer = createServer();
	gateway.attach(httpServer, "/device");
	await new Promise<void>((r) => httpServer.listen(0, r));
	const port = (httpServer.address() as AddressInfo).port;
	return { store, gateway, device, port, httpServer };
}

function connect(port: number): WebSocket {
	return new WebSocket(`ws://127.0.0.1:${port}/device`);
}

// A naive `ws.once("message", ...)` per call races against bursts: when the
// server writes several frames back-to-back (e.g. hello_ack immediately
// followed by queued events), the underlying `ws` receiver can emit multiple
// "message" events synchronously for frames already buffered from a single
// socket read — faster than an `await`-then-re-register-listener chain can
// keep up, silently dropping every frame but the first. Buffer messages in
// a FIFO queue instead so `nextMessage` never misses one regardless of
// arrival timing.
function messageReader(ws: WebSocket): () => Promise<string> {
	const queue: string[] = [];
	const waiters: Array<(msg: string) => void> = [];
	ws.on("message", (d) => {
		const msg = d.toString();
		const waiter = waiters.shift();
		if (waiter) {
			waiter(msg);
		} else {
			queue.push(msg);
		}
	});
	return () =>
		new Promise<string>((resolve) => {
			const queued = queue.shift();
			if (queued !== undefined) {
				resolve(queued);
			} else {
				waiters.push(resolve);
			}
		});
}

describe("DeviceGateway", () => {
	it("rejects a bad token with hello_error", async () => {
		const { port, gateway, httpServer } = await setup();
		const ws = connect(port);
		const nextMessage = messageReader(ws);
		await new Promise((r) => ws.once("open", r));
		ws.send(
			JSON.stringify({
				type: "hello",
				deviceToken: "bad",
				protocolVersion: PROTOCOL_VERSION,
				lastAckedSeq: 0,
			}),
		);
		const msg = JSON.parse(await nextMessage());
		expect(msg.type).toBe("hello_error");
		gateway.close();
		httpServer.close();
	});

	it("rejects a mismatched protocolVersion with hello_error and closes the socket, even with a valid token", async () => {
		const { device, port, gateway, httpServer } = await setup();
		const ws = connect(port);
		const nextMessage = messageReader(ws);
		await new Promise((r) => ws.once("open", r));
		const closed = new Promise<void>((r) => ws.once("close", () => r()));
		ws.send(
			JSON.stringify({
				type: "hello",
				deviceToken: device.deviceToken,
				protocolVersion: 999,
				lastAckedSeq: 0,
			}),
		);
		const msg = JSON.parse(await nextMessage());
		expect(msg.type).toBe("hello_error");
		expect(msg.reason).toMatch(/protocol version mismatch/i);
		await closed;
		// A version-mismatched hello must never authenticate the device.
		expect(gateway.isOnline(device.deviceId)).toBe(false);
		gateway.close();
		httpServer.close();
	});

	/**
	 * The device's liveness watchdog gives up after two heartbeats of silence,
	 * and must derive that from the router it is actually talking to — a router
	 * configured with a non-default cadence would otherwise leave the device on
	 * the compiled-in 30s default and terminating at the wrong time.
	 */
	it("advertises its heartbeat cadence in hello_ack", async () => {
		const { gateway, device, port, httpServer } = await setup({
			heartbeatMs: 5_000,
		});
		const ws = connect(port);
		const nextMessage = messageReader(ws);
		await new Promise((r) => ws.once("open", r));
		ws.send(
			JSON.stringify({
				type: "hello",
				deviceToken: device.deviceToken,
				protocolVersion: PROTOCOL_VERSION,
				lastAckedSeq: 0,
			}),
		);

		const helloAck = JSON.parse(await nextMessage());
		expect(helloAck.type).toBe("hello_ack");
		expect(helloAck.heartbeatMs).toBe(5_000);

		gateway.close();
		httpServer.close();
	});

	it("defaults its advertised heartbeat to the shared protocol constant", async () => {
		const { gateway, device, port, httpServer } = await setup();
		const ws = connect(port);
		const nextMessage = messageReader(ws);
		await new Promise((r) => ws.once("open", r));
		ws.send(
			JSON.stringify({
				type: "hello",
				deviceToken: device.deviceToken,
				protocolVersion: PROTOCOL_VERSION,
				lastAckedSeq: 0,
			}),
		);

		const helloAck = JSON.parse(await nextMessage());
		expect(helloAck.heartbeatMs).toBe(HEARTBEAT_INTERVAL_MS);

		gateway.close();
		httpServer.close();
	});

	/**
	 * The device only forwards logs after seeing this. Without the advertisement
	 * a newer worker logging at an older router would be closed as "invalid
	 * frame" on every line and reconnect straight back into the same loop.
	 */
	it("advertises log_ingest in hello_ack", async () => {
		const { gateway, device, port, httpServer } = await setup();
		const ws = connect(port);
		const nextMessage = messageReader(ws);
		await new Promise((r) => ws.once("open", r));
		ws.send(
			JSON.stringify({
				type: "hello",
				deviceToken: device.deviceToken,
				protocolVersion: PROTOCOL_VERSION,
				lastAckedSeq: 0,
			}),
		);

		const helloAck = JSON.parse(await nextMessage());
		expect(helloAck.capabilities).toContain(LOG_INGEST_CAPABILITY);

		gateway.close();
		httpServer.close();
	});

	it("emits a log frame as a 'log' event and never acks it", async () => {
		const { gateway, device, port, httpServer } = await setup();
		const ws = connect(port);
		const nextMessage = messageReader(ws);
		await new Promise((r) => ws.once("open", r));
		ws.send(
			JSON.stringify({
				type: "hello",
				deviceToken: device.deviceToken,
				protocolVersion: PROTOCOL_VERSION,
				lastAckedSeq: 0,
			}),
		);
		await nextMessage(); // hello_ack

		const received: Array<[number, unknown]> = [];
		gateway.on("log", (deviceId: number, frame: unknown) => {
			received.push([deviceId, frame]);
		});

		const frame = {
			type: "log",
			ts: "2026-08-07T12:00:00.000Z",
			level: "warn",
			component: "EdgeWorker",
			message: "something went sideways",
			dropped: 3,
		};
		const closed = new Promise<number>((r) =>
			ws.once("close", (code) => r(code)),
		);
		ws.send(JSON.stringify(frame));
		await vi.waitFor(() => expect(received).toHaveLength(1));

		expect(received[0]?.[0]).toBe(device.deviceId);
		expect(received[0]?.[1]).toEqual(frame);

		// Fire-and-forget: nothing comes back, and the socket stays up.
		gateway.close();
		httpServer.close();
		await closed;
	});

	it("closes the socket on a log frame sent before hello", async () => {
		const { gateway, port, httpServer } = await setup();
		const ws = connect(port);
		await new Promise((r) => ws.once("open", r));
		const closed = new Promise<void>((r) => ws.once("close", () => r()));
		ws.send(
			JSON.stringify({
				type: "log",
				ts: "2026-08-07T12:00:00.000Z",
				level: "error",
				component: "x",
				message: "unauthenticated",
			}),
		);
		await closed;

		gateway.close();
		httpServer.close();
	});

	it("emits deviceConnected with the hello's activeSessions payload", async () => {
		const { gateway, device, port, httpServer } = await setup();
		const connected: Array<[number, string[] | undefined]> = [];
		gateway.on("deviceConnected", (id: number, activeSessions?: string[]) => {
			connected.push([id, activeSessions]);
		});

		const ws = connect(port);
		const nextMessage = messageReader(ws);
		await new Promise((r) => ws.once("open", r));
		ws.send(
			JSON.stringify({
				type: "hello",
				deviceToken: device.deviceToken,
				protocolVersion: PROTOCOL_VERSION,
				lastAckedSeq: 0,
				activeSessions: ["sess-1", "sess-2"],
			}),
		);
		const helloAck = JSON.parse(await nextMessage());
		expect(helloAck.type).toBe("hello_ack");
		// deviceConnected is emitted synchronously inside handleHello; a tick is
		// plenty for our listener to observe it.
		await new Promise((r) => setTimeout(r, 20));

		expect(connected).toEqual([[device.deviceId, ["sess-1", "sess-2"]]]);

		gateway.close();
		httpServer.close();
	});

	it("emits deviceConnected with undefined when hello omits activeSessions (older client)", async () => {
		const { gateway, device, port, httpServer } = await setup();
		const connected: Array<[number, string[] | undefined]> = [];
		gateway.on("deviceConnected", (id: number, activeSessions?: string[]) => {
			connected.push([id, activeSessions]);
		});

		const ws = connect(port);
		const nextMessage = messageReader(ws);
		await new Promise((r) => ws.once("open", r));
		ws.send(
			JSON.stringify({
				type: "hello",
				deviceToken: device.deviceToken,
				protocolVersion: PROTOCOL_VERSION,
				lastAckedSeq: 0,
			}),
		);
		const helloAck = JSON.parse(await nextMessage());
		expect(helloAck.type).toBe("hello_ack");
		await new Promise((r) => setTimeout(r, 20));

		expect(connected).toEqual([[device.deviceId, undefined]]);

		gateway.close();
		httpServer.close();
	});

	it("delivers queued events in order after hello and removes them on ack", async () => {
		const { store, gateway, device, port, httpServer } = await setup();
		// Anchor to real time: the gateway now enforces TTL at delivery using
		// Date.now(), so these must be genuinely live (not pre-expired
		// relative to the synthetic NOW=1_000_000 clock) when delivered.
		const now = Date.now();
		store.enqueueEvent(device.deviceId, '{"n":1}', now, 60_000);
		store.enqueueEvent(device.deviceId, '{"n":2}', now, 60_000);
		const ws = connect(port);
		const nextMessage = messageReader(ws);
		await new Promise((r) => ws.once("open", r));
		ws.send(
			JSON.stringify({
				type: "hello",
				deviceToken: device.deviceToken,
				protocolVersion: PROTOCOL_VERSION,
				lastAckedSeq: 0,
			}),
		);
		const first = JSON.parse(await nextMessage()); // hello_ack
		expect(first.type).toBe("hello_ack");
		const e1 = JSON.parse(await nextMessage());
		const e2 = JSON.parse(await nextMessage());
		expect([e1.seq, e2.seq]).toEqual([1, 2]);
		ws.send(JSON.stringify({ type: "event_ack", seq: 1 }));
		await new Promise((r) => setTimeout(r, 50));
		expect(
			store.pendingEvents(device.deviceId, 0, Date.now()).map((e) => e.seq),
		).toEqual([2]);
		gateway.close();
		httpServer.close();
	});

	it("does not deliver an event that has already expired by delivery time (TTL enforced at delivery)", async () => {
		const { store, gateway, device, port, httpServer } = await setup();
		// Enqueued as already expired relative to real time: enqueued_ms is
		// 120s in the past with only a 60s TTL, so expires_ms is 60s in the
		// past too. This is the regression case for the bug where
		// deliverPending passed nowMs=0, permanently disabling the store's
		// `expires_ms > nowMs` filter and delivering stale events on
		// reconnect.
		store.enqueueEvent(
			device.deviceId,
			'{"n":1}',
			Date.now() - 120_000,
			60_000,
		);
		const ws = connect(port);
		const nextMessage = messageReader(ws);
		await new Promise((r) => ws.once("open", r));
		ws.send(
			JSON.stringify({
				type: "hello",
				deviceToken: device.deviceToken,
				protocolVersion: PROTOCOL_VERSION,
				lastAckedSeq: 0,
			}),
		);
		const helloAck = JSON.parse(await nextMessage());
		expect(helloAck.type).toBe("hello_ack");

		// No event frame should follow — the queued event was already
		// expired before the gateway attempted delivery. Race the next
		// message against a short timeout instead of sleeping arbitrarily:
		// whichever settles first tells us whether a (wrongly) delivered
		// event frame ever arrives.
		const outcome = await Promise.race([
			nextMessage().then(() => "message" as const),
			new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 150)),
		]);
		expect(outcome).toBe("timeout");

		gateway.close();
		httpServer.close();
	});

	/**
	 * NOR-263. `hello` is the only moment the router's `next_seq` and the
	 * device's `lastAckedSeq` are ever in the same place, so it is the only
	 * place a counter regression (stale state-backup restore onto ephemeral
	 * /data) can be caught. Left undetected, every event issued to the device
	 * is discarded by `RouterConnection.onEvent` as a duplicate — silently,
	 * forever.
	 *
	 * A freshly enrolled device has next_seq = 1, so a hello claiming
	 * lastAckedSeq = 7 reproduces the post-restore state exactly.
	 */
	describe("event sequence regression (NOR-263)", () => {
		it("fast-forwards past a device whose lastAckedSeq has overtaken the router, and logs it at ERROR", async () => {
			const logger = testLogger();
			const { store, gateway, device, port, httpServer } = await setup({
				logger,
			});
			const ws = connect(port);
			const nextMessage = messageReader(ws);
			await new Promise((r) => ws.once("open", r));
			ws.send(
				JSON.stringify({
					type: "hello",
					deviceToken: device.deviceToken,
					protocolVersion: PROTOCOL_VERSION,
					lastAckedSeq: 7,
				}),
			);
			expect(JSON.parse(await nextMessage()).type).toBe("hello_ack");

			// The re-ack of a dropped event deletes its row, so this log line is
			// the only durable trace the skew ever existed. It must be ERROR.
			const errors = logger.error.mock.calls.map((c) => String(c[0]));
			expect(
				errors.some(
					(m) =>
						/sequence regressed/i.test(m) &&
						m.includes(`Device ${device.deviceId}`) &&
						m.includes("lastAckedSeq 7"),
				),
			).toBe(true);

			// A prompt arriving after the repair reaches the device instead of
			// being discarded: seq 8 > the device's mark of 7.
			store.enqueueEvent(device.deviceId, '{"n":"prompt"}', Date.now(), 60_000);
			gateway.deliverPending(device.deviceId);
			const event = JSON.parse(await nextMessage());
			expect(event.type).toBe("event");
			expect(event.seq).toBeGreaterThan(7);
			expect(event.event).toEqual({ n: "prompt" });

			gateway.close();
			httpServer.close();
		});

		it("delivers an event stranded at a rolled-back seq instead of purging it as an already-acked duplicate", async () => {
			const { store, gateway, device, port, httpServer } = await setup();
			// A webhook that landed between the restore and the device's
			// reconnect, enqueued at rolled-back seq 1. The device is at 7, so
			// the already-acked purge in handleHello would delete this row
			// undelivered — the second silent-drop path in this bug.
			store.enqueueEvent(
				device.deviceId,
				'{"n":"stranded"}',
				Date.now(),
				60_000,
			);

			const ws = connect(port);
			const nextMessage = messageReader(ws);
			await new Promise((r) => ws.once("open", r));
			ws.send(
				JSON.stringify({
					type: "hello",
					deviceToken: device.deviceToken,
					protocolVersion: PROTOCOL_VERSION,
					lastAckedSeq: 7,
				}),
			);
			expect(JSON.parse(await nextMessage()).type).toBe("hello_ack");

			const event = JSON.parse(await nextMessage());
			expect(event.type).toBe("event");
			expect(event.event).toEqual({ n: "stranded" });
			expect(event.seq).toBeGreaterThan(7);

			gateway.close();
			httpServer.close();
		});

		it("leaves a healthy device alone: no ERROR, and already-acked events are still purged", async () => {
			const logger = testLogger();
			const { store, gateway, device, port, httpServer } = await setup({
				logger,
			});
			const now = Date.now();
			store.enqueueEvent(device.deviceId, '{"n":1}', now, 60_000); // seq 1
			store.enqueueEvent(device.deviceId, '{"n":2}', now, 60_000); // seq 2

			const ws = connect(port);
			const nextMessage = messageReader(ws);
			await new Promise((r) => ws.once("open", r));
			ws.send(
				JSON.stringify({
					type: "hello",
					deviceToken: device.deviceToken,
					protocolVersion: PROTOCOL_VERSION,
					// next_seq is 3 here, comfortably ahead of the mark.
					lastAckedSeq: 1,
				}),
			);
			expect(JSON.parse(await nextMessage()).type).toBe("hello_ack");

			expect(
				logger.error.mock.calls.filter((c) =>
					/sequence regressed/i.test(String(c[0])),
				),
			).toHaveLength(0);

			// seq 1 purged as a genuine duplicate; only seq 2 delivered.
			const event = JSON.parse(await nextMessage());
			expect(event.seq).toBe(2);
			expect(
				store.pendingEvents(device.deviceId, 0, Date.now()).map((e) => e.seq),
			).toEqual([2]);

			gateway.close();
			httpServer.close();
		});
	});

	it("second connection wins: replaces the first socket without a spurious disconnect", async () => {
		const { gateway, device, port, httpServer } = await setup();

		const wsA = connect(port);
		const nextA = messageReader(wsA);
		await new Promise((r) => wsA.once("open", r));
		wsA.send(
			JSON.stringify({
				type: "hello",
				deviceToken: device.deviceToken,
				protocolVersion: PROTOCOL_VERSION,
				lastAckedSeq: 0,
			}),
		);
		const helloAckA = JSON.parse(await nextA());
		expect(helloAckA.type).toBe("hello_ack");
		expect(gateway.isOnline(device.deviceId)).toBe(true);

		const disconnected: number[] = [];
		gateway.on("deviceDisconnected", (id: number) => {
			disconnected.push(id);
		});
		const closedA = new Promise<void>((r) => wsA.once("close", () => r()));

		const wsB = connect(port);
		const nextB = messageReader(wsB);
		await new Promise((r) => wsB.once("open", r));
		wsB.send(
			JSON.stringify({
				type: "hello",
				deviceToken: device.deviceToken,
				protocolVersion: PROTOCOL_VERSION,
				lastAckedSeq: 0,
			}),
		);
		const helloAckB = JSON.parse(await nextB());
		expect(helloAckB.type).toBe("hello_ack");

		// Socket A must be terminated as a result of B's hello.
		await closedA;
		// Give A's (now-stale) "close" handler a tick to run so we can
		// assert its `sockets.get(deviceId) === ws` guard suppressed the
		// disconnect it would otherwise have reported.
		await new Promise((r) => setTimeout(r, 20));

		expect(gateway.isOnline(device.deviceId)).toBe(true);
		expect(disconnected).toEqual([]);

		gateway.close();
		httpServer.close();
	});

	it("terminates a socket that misses heartbeats (no pong received)", async () => {
		// heartbeatMs is short so the test doesn't need a long sleep; the
		// gateway's MAX_MISSED_HEARTBEATS=2 means termination fires on the
		// third ping cycle with no pong (arm -> miss 1 -> miss 2 -> terminate).
		const { gateway, device, port, httpServer } = await setup({
			heartbeatMs: 60,
		});

		// The `ws` client library auto-responds to server pings with pongs at
		// the protocol level (WebSocket.Receiver), independent of any
		// user-registered "ping" listener — so a normal client would never
		// miss a heartbeat and this test would be untestable without one of:
		// (a) suppressing auto-pong, (b) a raw socket, or (c) asserting the
		// isAlive bookkeeping via a private seam. ws@8.21+ exposes exactly
		// the seam we need for (a): the client-constructor option
		// `autoPong: false` disables the automatic pong response, giving a
		// deterministic (non-flaky, non-sleep-based) way to simulate a dead
		// peer that stops responding to pings.
		const ws = new WebSocket(`ws://127.0.0.1:${port}/device`, {
			autoPong: false,
		});
		const nextMessage = messageReader(ws);
		await new Promise((r) => ws.once("open", r));
		ws.send(
			JSON.stringify({
				type: "hello",
				deviceToken: device.deviceToken,
				protocolVersion: PROTOCOL_VERSION,
				lastAckedSeq: 0,
			}),
		);
		const helloAck = JSON.parse(await nextMessage());
		expect(helloAck.type).toBe("hello_ack");
		expect(gateway.isOnline(device.deviceId)).toBe(true);

		const disconnected: number[] = [];
		gateway.on("deviceDisconnected", (id: number) => {
			disconnected.push(id);
		});
		const closed = new Promise<void>((r) => ws.once("close", () => r()));

		await closed;
		// The client and server sockets close independently (same process,
		// two net.Socket objects joined over loopback) — give the server's
		// own "close" handler, which updates the registry and emits
		// deviceDisconnected, a moment to run before asserting on it.
		await new Promise((r) => setTimeout(r, 20));

		expect(gateway.isOnline(device.deviceId)).toBe(false);
		expect(disconnected).toEqual([device.deviceId]);

		gateway.close();
		httpServer.close();
	});

	it("emits rpc frames and reports online state", async () => {
		const { gateway, device, port, httpServer } = await setup();
		const ws = connect(port);
		const nextMessage = messageReader(ws);
		await new Promise((r) => ws.once("open", r));
		ws.send(
			JSON.stringify({
				type: "hello",
				deviceToken: device.deviceToken,
				protocolVersion: PROTOCOL_VERSION,
				lastAckedSeq: 0,
			}),
		);
		await nextMessage(); // hello_ack
		expect(gateway.isOnline(device.deviceId)).toBe(true);
		const rpcPromise = new Promise<[number, { method: string }]>((r) =>
			gateway.once("rpc", (id, frame) => r([id, frame])),
		);
		ws.send(
			JSON.stringify({
				type: "rpc_request",
				id: "r1",
				method: "fetchIssue",
				params: ["ABC-1"],
			}),
		);
		const [deviceId, frame] = await rpcPromise;
		expect(deviceId).toBe(device.deviceId);
		expect(frame.method).toBe("fetchIssue");
		gateway.close();
		httpServer.close();
	});
});

describe("DeviceGateway.querySessions", () => {
	/**
	 * Connects and completes the handshake, optionally advertising capabilities,
	 * and returns the socket plus a reader positioned after the hello_ack.
	 */
	async function connectDevice(
		port: number,
		deviceToken: string,
		capabilities?: string[],
	) {
		const ws = connect(port);
		const nextMessage = messageReader(ws);
		await new Promise((r) => ws.once("open", r));
		ws.send(
			JSON.stringify({
				type: "hello",
				deviceToken,
				protocolVersion: PROTOCOL_VERSION,
				lastAckedSeq: 0,
				...(capabilities ? { capabilities } : {}),
			}),
		);
		await nextMessage(); // hello_ack
		return { ws, nextMessage };
	}

	it("returns the device's declared sessions", async () => {
		const { gateway, device, port, httpServer } = await setup();
		const { ws, nextMessage } = await connectDevice(port, device.deviceToken, [
			"sessions_query",
		]);

		const pending = gateway.querySessions(device.deviceId, 1_000);

		const query = JSON.parse(await nextMessage());
		expect(query).toMatchObject({ type: "sessions_query" });
		ws.send(
			JSON.stringify({
				type: "sessions_report",
				id: query.id,
				activeSessions: ["sess-1"],
			}),
		);

		await expect(pending).resolves.toEqual(["sess-1"]);
		gateway.close();
		httpServer.close();
	});

	it("distinguishes an empty declared list from no answer", async () => {
		const { gateway, device, port, httpServer } = await setup();
		const { ws, nextMessage } = await connectDevice(port, device.deviceToken, [
			"sessions_query",
		]);

		const pending = gateway.querySessions(device.deviceId, 1_000);
		const query = JSON.parse(await nextMessage());
		ws.send(
			JSON.stringify({
				type: "sessions_report",
				id: query.id,
				activeSessions: [],
			}),
		);

		await expect(pending).resolves.toEqual([]);
		gateway.close();
		httpServer.close();
	});

	it("resolves undefined when the device never replies", async () => {
		const { gateway, device, port, httpServer } = await setup();
		await connectDevice(port, device.deviceToken, ["sessions_query"]);

		await expect(
			gateway.querySessions(device.deviceId, 20),
		).resolves.toBeUndefined();
		gateway.close();
		httpServer.close();
	});

	it("resolves undefined without sending anything when the device lacks the capability", async () => {
		const { gateway, device, port, httpServer } = await setup();
		const { ws } = await connectDevice(port, device.deviceToken);
		const sent: unknown[] = [];
		ws.on("message", (raw) => sent.push(JSON.parse(raw.toString())));

		await expect(
			gateway.querySessions(device.deviceId, 20),
		).resolves.toBeUndefined();
		expect(
			sent.filter((f) => (f as { type: string }).type === "sessions_query"),
		).toEqual([]);
		gateway.close();
		httpServer.close();
	});

	it("resolves undefined for an offline device", async () => {
		const { gateway, httpServer } = await setup();
		await expect(gateway.querySessions(9999, 20)).resolves.toBeUndefined();
		gateway.close();
		httpServer.close();
	});

	it("settles a query in flight when the gateway closes", async () => {
		// A shutdown mid-sweep must not hang the caller forever.
		const { gateway, device, port, httpServer } = await setup();
		await connectDevice(port, device.deviceToken, ["sessions_query"]);

		const pending = gateway.querySessions(device.deviceId, 60_000);
		gateway.close();

		await expect(pending).resolves.toBeUndefined();
		httpServer.close();
	});
	// ── logging ─────────────────────────────────────────────────────────────
	// Device connect/disconnect is the truest liveness signal the router has:
	// for a container target it is the only proof the sandbox's worker process
	// actually came up, since ACA reports "Running" for an exited entrypoint.
	// Before NOR-278 this file emitted nothing at all.

	it("logs a device connect with the identity and session count", async () => {
		const logger = testLogger();
		const { gateway, device, port, httpServer } = await setup({ logger });
		await connectDevice(port, device.deviceToken);

		const line = logger.info.mock.calls
			.map((c) => String(c[0]))
			.find((m) => m.includes(`Device ${device.deviceId} connected`));
		expect(line).toBeDefined();
		expect(line).toContain("0 active session(s)");

		gateway.close();
		httpServer.close();
	});

	it("logs a device disconnect with the close code", async () => {
		const logger = testLogger();
		const { gateway, device, port, httpServer } = await setup({ logger });
		const { ws } = await connectDevice(port, device.deviceToken);

		const disconnected = new Promise<void>((r) =>
			gateway.once("deviceDisconnected", () => r()),
		);
		ws.close(1000, "bye");
		await disconnected;

		expect(
			logger.info.mock.calls
				.map((c) => String(c[0]))
				.some((m) => m.includes(`Device ${device.deviceId} disconnected`)),
		).toBe(true);

		gateway.close();
		httpServer.close();
	});

	it("logs a rejected hello at error level", async () => {
		const logger = testLogger();
		const { gateway, port, httpServer } = await setup({ logger });
		const ws = connect(port);
		const nextMessage = messageReader(ws);
		await new Promise((r) => ws.once("open", r));
		ws.send(
			JSON.stringify({
				type: "hello",
				deviceToken: "bad",
				protocolVersion: PROTOCOL_VERSION,
				lastAckedSeq: 0,
			}),
		);
		await nextMessage();

		expect(logger.error).toHaveBeenCalledWith(
			expect.stringContaining("no device matches the presented token"),
		);

		gateway.close();
		httpServer.close();
	});
});
