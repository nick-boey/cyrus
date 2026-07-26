import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PROTOCOL_VERSION } from "cyrus-router-protocol";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { DeviceGateway } from "../src/DeviceGateway.js";
import { RouterStore } from "../src/RouterStore.js";

const NOW = 1_000_000;

async function setup(opts?: { heartbeatMs?: number }) {
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
