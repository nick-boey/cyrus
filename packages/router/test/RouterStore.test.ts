import { describe, expect, it } from "vitest";
import { RouterStore } from "../src/RouterStore.js";

const NOW = 1_000_000;

function storeWithDevice() {
	const store = new RouterStore(":memory:");
	store.addUser({ email: "alice@example.com", name: "Alice" });
	const code = store.mintEnrollmentCode("alice@example.com", NOW);
	const device = store.redeemEnrollmentCode(code, NOW + 1000);
	if (!device) throw new Error("redeem failed");
	return { store, device };
}

describe("RouterStore", () => {
	it("enrolls a device via one-time code and burns the code", () => {
		const { store, device } = storeWithDevice();
		expect(store.getDeviceByToken(device.deviceToken)?.deviceId).toBe(
			device.deviceId,
		);
		// burned: second redeem fails
		expect(store.redeemEnrollmentCode("nonsense", NOW)).toBeUndefined();
	});

	it("expires enrollment codes after 15 minutes", () => {
		const store = new RouterStore(":memory:");
		store.addUser({ email: "a@x.com" });
		const code = store.mintEnrollmentCode("a@x.com", NOW);
		expect(store.redeemEnrollmentCode(code, NOW + 16 * 60_000)).toBeUndefined();
	});

	it("re-enrollment replaces the device and invalidates the old token", () => {
		const { store, device } = storeWithDevice();
		const code2 = store.mintEnrollmentCode("alice@example.com", NOW);
		const device2 = store.redeemEnrollmentCode(code2, NOW);
		expect(device2).toBeDefined();
		expect(store.getDeviceByToken(device.deviceToken)).toBeUndefined();
	});

	it("matches creators by email case-insensitively and by linearId", () => {
		const store = new RouterStore(":memory:");
		store.addUser({ email: "Bob@Example.com", linearId: "lin-1" });
		expect(
			store.findUserForCreator({ email: "bob@example.com" }),
		).toBeDefined();
		expect(store.findUserForCreator({ id: "lin-1" })).toBeDefined();
		expect(store.findUserForCreator({ email: "nobody@x.com" })).toBeUndefined();
	});

	it("queues events FIFO per device with monotonic seq and ack removal", () => {
		const { store, device } = storeWithDevice();
		const s1 = store.enqueueEvent(device.deviceId, '{"n":1}', NOW, 60_000);
		const s2 = store.enqueueEvent(device.deviceId, '{"n":2}', NOW, 60_000);
		expect(s2).toBe(s1 + 1);
		expect(
			store.pendingEvents(device.deviceId, 0, NOW).map((e) => e.seq),
		).toEqual([s1, s2]);
		store.ackEvent(device.deviceId, s1);
		expect(
			store.pendingEvents(device.deviceId, 0, NOW).map((e) => e.seq),
		).toEqual([s2]);
	});

	it("never reuses a seq after the queue fully drains", () => {
		const { store, device } = storeWithDevice();
		const s1 = store.enqueueEvent(device.deviceId, '{"n":1}', NOW, 60_000);
		store.ackEvent(device.deviceId, s1);
		const s2 = store.enqueueEvent(device.deviceId, '{"n":2}', NOW, 60_000);
		expect(s2).toBe(s1 + 1); // a MAX(seq)-based counter would reuse s1 here and the client would drop the event
	});

	it("records and replays mutation responses idempotently", () => {
		const { store, device } = storeWithDevice();
		expect(store.getMutation(device.deviceId, "m-1")).toBeUndefined();
		store.recordMutation(device.deviceId, "m-1", '{"success":true}', NOW);
		expect(store.getMutation(device.deviceId, "m-1")).toBe('{"success":true}');
	});

	it("tracks device last-seen for offline sweeps", () => {
		const { store, device } = storeWithDevice();
		store.touchDevice(device.deviceId, NOW);
		expect(store.devicesOfflineSince(NOW - 1)).toHaveLength(0);
		expect(store.devicesOfflineSince(NOW + 1).map((d) => d.deviceId)).toEqual([
			device.deviceId,
		]);
	});

	it("expireEvents removes and returns events past their TTL", () => {
		const { store, device } = storeWithDevice();
		store.enqueueEvent(device.deviceId, '{"n":1}', NOW, 1000);
		const expired = store.expireEvents(NOW + 2000);
		expect(expired).toHaveLength(1);
		expect(store.pendingEvents(device.deviceId, 0, NOW + 2000)).toHaveLength(0);
	});

	it("issue lock is exclusive per issue and released by session", () => {
		const { store, device } = storeWithDevice();
		expect(store.acquireIssueLock("ISS-1", "sess-1", device.deviceId)).toBe(
			true,
		);
		// same session re-acquire is fine
		expect(store.acquireIssueLock("ISS-1", "sess-1", device.deviceId)).toBe(
			true,
		);
		expect(store.acquireIssueLock("ISS-1", "sess-2", device.deviceId)).toBe(
			false,
		);
		store.releaseIssueLockForSession("sess-1");
		expect(store.acquireIssueLock("ISS-1", "sess-2", device.deviceId)).toBe(
			true,
		);
	});

	it("stores session and issue affinity", () => {
		const { store, device } = storeWithDevice();
		store.setSessionAffinity("sess-1", device.deviceId);
		store.setIssueAffinity("ISS-1", device.deviceId);
		expect(store.getSessionAffinity("sess-1")).toBe(device.deviceId);
		expect(store.getIssueAffinity("ISS-1")).toBe(device.deviceId);
	});
});
