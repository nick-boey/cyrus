import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { RouterStore } from "../src/RouterStore.js";

const NOW = 1_000_000;

// Copy of the pre-migration (v1) SCHEMA constant from RouterStore.ts, used to
// build a v1 database by hand and verify the migration path.
const V1_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT,
  linear_id TEXT
);
CREATE TABLE IF NOT EXISTS devices (
  device_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_ms INTEGER NOT NULL,
  next_seq INTEGER NOT NULL DEFAULT 1,
  last_seen_ms INTEGER
);
CREATE TABLE IF NOT EXISTS enrollment_codes (
  code_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  expires_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  device_id INTEGER NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  enqueued_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL,
  PRIMARY KEY (device_id, seq)
);
CREATE TABLE IF NOT EXISTS rpc_mutations (
  device_id INTEGER NOT NULL,
  mutation_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  PRIMARY KEY (device_id, mutation_id)
);
CREATE TABLE IF NOT EXISTS session_affinity (
  session_id TEXT PRIMARY KEY, device_id INTEGER NOT NULL, creator_json TEXT
);
CREATE TABLE IF NOT EXISTS issue_affinity (
  issue_id TEXT PRIMARY KEY, device_id INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS issue_locks (
  issue_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, device_id INTEGER NOT NULL
);
`;

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

	/**
	 * NOR-263. A restore from a stale state backup rolls `next_seq` back while
	 * the device's `lastAckedSeq` survives in its floor bundle; from then on
	 * every event we issue carries a seq the device discards as a duplicate.
	 *
	 * A freshly enrolled device has `next_seq = 1`, so a device reporting any
	 * `lastAckedSeq >= 1` against it is exactly the post-restore state: the
	 * router's counter sitting at or below the device's high-water mark.
	 */
	describe("event sequence regression repair (reconcileDeviceSeq)", () => {
		it("leaves a healthy counter untouched when the device is behind the router", () => {
			const { store, device } = storeWithDevice();
			const result = store.reconcileDeviceSeq(device.deviceId, 0, NOW);
			expect(result).toEqual({
				repaired: false,
				previousNextSeq: 1,
				nextSeq: 1,
				resequenced: 0,
			});
			// The healthy path must not perturb allocation.
			expect(store.enqueueEvent(device.deviceId, "{}", NOW, 60_000)).toBe(1);
		});

		it("fast-forwards next_seq past a device that has overtaken it", () => {
			const { store, device } = storeWithDevice();
			const result = store.reconcileDeviceSeq(device.deviceId, 7, NOW);
			expect(result).toMatchObject({
				repaired: true,
				previousNextSeq: 1,
				nextSeq: 8,
			});
			// The point of the whole exercise: the next event carries a seq the
			// device will accept rather than discard as a duplicate.
			expect(store.enqueueEvent(device.deviceId, "{}", NOW, 60_000)).toBe(8);
		});

		it("treats next_seq == lastAckedSeq as a regression (the device drops seq <= its mark)", () => {
			const { store, device } = storeWithDevice();
			// Six events issued and acked leaves next_seq at 7.
			for (let i = 0; i < 6; i++) {
				store.enqueueEvent(device.deviceId, "{}", NOW, 60_000);
			}
			store.ackEvent(device.deviceId, 6);

			const result = store.reconcileDeviceSeq(device.deviceId, 7, NOW);
			expect(result).toMatchObject({ repaired: true, previousNextSeq: 7 });
			// Not 7: RouterConnection.onEvent discards `seq <= lastAckedSeq`, so
			// an off-by-one here would leave exactly the observed NOR-263 state.
			expect(store.enqueueEvent(device.deviceId, "{}", NOW, 60_000)).toBe(8);
		});

		it("resequences stranded events above the mark instead of leaving them to be purged as duplicates", () => {
			const { store, device } = storeWithDevice();
			// Enqueued at rolled-back seqs 1 and 2 — e.g. webhooks that landed
			// between the restore and the device's reconnect. The device is at 7
			// and would discard both.
			store.enqueueEvent(device.deviceId, '{"n":1}', NOW, 60_000);
			store.enqueueEvent(device.deviceId, '{"n":2}', NOW, 60_000);

			const result = store.reconcileDeviceSeq(device.deviceId, 7, NOW);
			expect(result).toMatchObject({
				repaired: true,
				nextSeq: 10,
				resequenced: 2,
			});
			// Same payloads, same order, new seqs above the device's mark.
			expect(store.pendingEvents(device.deviceId, 0, NOW)).toEqual([
				{ seq: 8, payloadJson: '{"n":1}' },
				{ seq: 9, payloadJson: '{"n":2}' },
			]);
			expect(store.enqueueEvent(device.deviceId, "{}", NOW, 60_000)).toBe(10);
		});

		it("preserves the original TTL when resequencing, so an aged-out prompt is not resurrected", () => {
			const { store, device } = storeWithDevice();
			store.enqueueEvent(device.deviceId, '{"n":"stale"}', NOW, 1_000);
			// Already expired at reconcile time: left in place for the periodic
			// expireEvents sweep rather than moved.
			const result = store.reconcileDeviceSeq(device.deviceId, 7, NOW + 5_000);
			expect(result).toMatchObject({ repaired: true, resequenced: 0 });
			expect(store.pendingEvents(device.deviceId, 0, NOW + 5_000)).toEqual([]);

			// A live event keeps its own deadline across the move. Reconciled on
			// the same NOW + 5_000 clock, so the aged-out row above stays
			// expired and only the live one is carried over.
			store.enqueueEvent(device.deviceId, '{"n":"live"}', NOW, 60_000);
			store.reconcileDeviceSeq(device.deviceId, 20, NOW + 5_000);
			expect(store.pendingEvents(device.deviceId, 0, NOW + 30_000)).toEqual([
				{ seq: 21, payloadJson: '{"n":"live"}' },
			]);
			expect(store.pendingEvents(device.deviceId, 0, NOW + 90_000)).toEqual([]);
		});

		it("is idempotent across repeated hellos from the same device", () => {
			const { store, device } = storeWithDevice();
			const first = store.reconcileDeviceSeq(device.deviceId, 7, NOW);
			const second = store.reconcileDeviceSeq(device.deviceId, 7, NOW);
			expect(first.repaired).toBe(true);
			expect(second).toEqual({
				repaired: false,
				previousNextSeq: 8,
				nextSeq: 8,
				resequenced: 0,
			});
		});

		it("throws for an unknown device rather than silently inventing a counter", () => {
			const { store } = storeWithDevice();
			expect(() => store.reconcileDeviceSeq(9999, 3, NOW)).toThrow(
				/Unknown device/,
			);
		});
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

	it("re-enrollment releases the old device's lock and affinity", () => {
		const { store, device } = storeWithDevice();
		store.setSessionAffinity("sess-1", device.deviceId);
		store.setIssueAffinity("ISS-1", device.deviceId);
		expect(store.acquireIssueLock("ISS-1", "sess-1", device.deviceId)).toBe(
			true,
		);

		// Re-enroll: get a fresh device for the same user.
		const code2 = store.mintEnrollmentCode("alice@example.com", NOW);
		const device2 = store.redeemEnrollmentCode(code2, NOW);
		expect(device2).toBeDefined();
		if (!device2) throw new Error("redeem failed");
		expect(device2.deviceId).not.toBe(device.deviceId);

		// The stale lock/affinity rows tied to the old device_id must be gone,
		// so a new session on the new device can acquire the same issue lock.
		expect(store.acquireIssueLock("ISS-1", "sess-2", device2.deviceId)).toBe(
			true,
		);
		// The purged affinity was never re-created for device2 — it must
		// resolve to undefined, not silently point at the dead old device.
		expect(store.getSessionAffinity("sess-1")).toBeUndefined();
		expect(store.getIssueAffinity("ISS-1")).toBeUndefined();
	});

	it("re-enrollment purges only the physical device when containers and stranded rows coexist", () => {
		const { store, device: physical } = storeWithDevice();
		const user = store.findUserForCreator({ email: "alice@example.com" });
		if (!user) throw new Error("user missing");
		const container = store.createContainerDevice(
			user.userId,
			"CYPACK-1",
			"docker",
		);
		store.setSessionAffinity("physical-session", physical.deviceId);
		store.setIssueAffinity("physical-issue", physical.deviceId);
		store.acquireIssueLock(
			"physical-lock",
			"physical-session",
			physical.deviceId,
		);
		store.setSessionAffinity("container-session", container.deviceId);
		store.setIssueAffinity("container-issue", container.deviceId);
		store.acquireIssueLock(
			"container-lock",
			"container-session",
			container.deviceId,
		);
		store.recordMutation(container.deviceId, "container-mutation", "ok", NOW);

		const code = store.mintEnrollmentCode("alice@example.com", NOW);
		const replacement = store.redeemEnrollmentCode(code, NOW);
		expect(replacement).toBeDefined();

		expect(store.getDeviceByToken(physical.deviceToken)).toBeUndefined();
		expect(store.getSessionAffinity("physical-session")).toBeUndefined();
		expect(store.getIssueAffinity("physical-issue")).toBeUndefined();
		expect(store.getContainerDeviceForIssue("CYPACK-1")?.deviceId).toBe(
			container.deviceId,
		);
		expect(store.getSessionAffinity("container-session")).toBe(
			container.deviceId,
		);
		expect(store.getIssueAffinity("container-issue")).toBe(container.deviceId);
		expect(store.getMutation(container.deviceId, "container-mutation")).toBe(
			"ok",
		);
		expect(
			store.acquireIssueLock(
				"container-lock",
				"other-session",
				container.deviceId,
			),
		).toBe(false);
	});

	it("removeUser purges the device's locks and affinity", () => {
		const { store, device } = storeWithDevice();
		store.setSessionAffinity("sess-1", device.deviceId);
		store.setIssueAffinity("ISS-1", device.deviceId);
		expect(store.acquireIssueLock("ISS-1", "sess-1", device.deviceId)).toBe(
			true,
		);
		store.recordMutation(device.deviceId, "m-1", '{"success":true}', NOW);

		expect(store.removeUser("alice@example.com")).toBe(true);

		// Re-add the user and enroll a fresh device; the old device's rows
		// must not strand the issue lock or leak stale affinity.
		store.addUser({ email: "alice@example.com", name: "Alice" });
		const code2 = store.mintEnrollmentCode("alice@example.com", NOW);
		const device2 = store.redeemEnrollmentCode(code2, NOW);
		expect(device2).toBeDefined();
		if (!device2) throw new Error("redeem failed");

		expect(store.acquireIssueLock("ISS-1", "sess-new", device2.deviceId)).toBe(
			true,
		);
		expect(store.getSessionAffinity("sess-1")).toBeUndefined();
		expect(store.getMutation(device2.deviceId, "m-1")).toBeUndefined();
	});

	it("listDevices returns physical and container devices joined to their user's email", () => {
		const store = new RouterStore(":memory:");
		const { userId } = store.addUser({ email: "alice@example.com" });
		const code = store.mintEnrollmentCode("alice@example.com", NOW);
		const physical = store.redeemEnrollmentCode(code, NOW);
		if (!physical) throw new Error("redeem failed");
		const container = store.createContainerDevice(userId, "CYPACK-1", "docker");

		const devices = store.listDevices();
		expect(devices).toHaveLength(2);

		const physicalRow = devices.find((d) => d.deviceId === physical.deviceId);
		expect(physicalRow).toMatchObject({
			email: "alice@example.com",
			kind: "device",
			issueKey: undefined,
			provider: undefined,
		});

		const containerRow = devices.find((d) => d.deviceId === container.deviceId);
		expect(containerRow).toMatchObject({
			email: "alice@example.com",
			kind: "container",
			issueKey: "CYPACK-1",
			provider: "docker",
		});
	});

	it("listSessions reports running, locked, and stranded sessions with issue + session ids", () => {
		const { store, device } = storeWithDevice();

		// A running session that also holds an issue lock.
		store.setSessionAffinity(
			"sess-locked",
			device.deviceId,
			JSON.stringify({ email: "alice@example.com", name: "Alice" }),
		);
		store.acquireIssueLock("issue-guid-1", "sess-locked", device.deviceId);

		// A running session with no lock.
		store.setSessionAffinity("sess-running", device.deviceId);

		// A stranded lock: an issue_locks row whose session has no affinity row,
		// the leaked-lock case an operator hunts for when unlocking.
		store.acquireIssueLock("issue-guid-2", "sess-stranded", device.deviceId);

		const sessions = store.listSessions();
		expect(sessions).toHaveLength(3);

		const locked = sessions.find((s) => s.sessionId === "sess-locked");
		expect(locked).toMatchObject({
			issueId: "issue-guid-1",
			locked: true,
			hasAffinity: true,
			email: "alice@example.com",
			creatorEmail: "alice@example.com",
			creatorName: "Alice",
		});

		const running = sessions.find((s) => s.sessionId === "sess-running");
		expect(running).toMatchObject({
			issueId: undefined,
			locked: false,
			hasAffinity: true,
		});

		const stranded = sessions.find((s) => s.sessionId === "sess-stranded");
		expect(stranded).toMatchObject({
			issueId: "issue-guid-2",
			locked: true,
			hasAffinity: false,
		});
	});

	it("removeUser purges scoped rows for EVERY device the user owned, not just the first", () => {
		// Regression test: removeUser used to purge only the first device row
		// returned by `.get()`. A user with a physical device AND container
		// devices would leave the others' issue_locks/session_affinity/
		// rpc_mutations rows stranded once the cascade delete removed their
		// `devices` rows out from under them.
		const store = new RouterStore(":memory:");
		const { userId } = store.addUser({ email: "multi@example.com" });
		const code = store.mintEnrollmentCode("multi@example.com", NOW);
		const physical = store.redeemEnrollmentCode(code, NOW);
		if (!physical) throw new Error("redeem failed");
		const container1 = store.createContainerDevice(
			userId,
			"CYPACK-1",
			"docker",
		);
		const container2 = store.createContainerDevice(
			userId,
			"CYPACK-2",
			"docker",
		);

		store.setSessionAffinity("sess-phys", physical.deviceId);
		store.setSessionAffinity("sess-c1", container1.deviceId);
		store.setSessionAffinity("sess-c2", container2.deviceId);
		store.acquireIssueLock("ISS-phys", "sess-phys", physical.deviceId);
		store.acquireIssueLock("CYPACK-1", "sess-c1", container1.deviceId);
		store.acquireIssueLock("CYPACK-2", "sess-c2", container2.deviceId);
		store.recordMutation(container2.deviceId, "m-1", '{"ok":true}', NOW);

		expect(store.removeUser("multi@example.com")).toBe(true);

		// Re-add the user and mint fresh devices at the same issue keys/locks;
		// none of them should be blocked by a stranded row left behind by a
		// device this fix now purges.
		const { userId: userId2 } = store.addUser({ email: "multi@example.com" });
		const freshContainer1 = store.createContainerDevice(
			userId2,
			"CYPACK-1",
			"docker",
		);
		expect(
			store.acquireIssueLock("CYPACK-1", "sess-new", freshContainer1.deviceId),
		).toBe(true);
		expect(store.getSessionAffinity("sess-c1")).toBeUndefined();
		expect(store.getSessionAffinity("sess-c2")).toBeUndefined();
		expect(store.getMutation(freshContainer1.deviceId, "m-1")).toBeUndefined();
	});
});

describe("container devices (schema v2)", () => {
	it("creates a container device and finds it by issue key and token", () => {
		const store = new RouterStore(":memory:");
		const { userId } = store.addUser({ email: "a@example.com" });
		const { deviceId, deviceToken } = store.createContainerDevice(
			userId,
			"CYPACK-1",
			"docker",
		);
		expect(store.getDeviceByToken(deviceToken)).toEqual({ deviceId, userId });
		expect(store.getContainerDeviceForIssue("CYPACK-1")).toMatchObject({
			deviceId,
			userId,
			issueKey: "CYPACK-1",
			provider: "docker",
		});
		expect(store.getDeviceInfo(deviceId)).toMatchObject({
			kind: "container",
			issueKey: "CYPACK-1",
		});
	});

	it("allows a physical device AND container devices for the same user", () => {
		const store = new RouterStore(":memory:");
		const { userId } = store.addUser({ email: "a@example.com" });
		store.createContainerDevice(userId, "CYPACK-1", "docker");
		store.createContainerDevice(userId, "CYPACK-2", "docker");
		const code = store.mintEnrollmentCode("a@example.com", Date.now());
		const enrolled = store.redeemEnrollmentCode(code, Date.now());
		expect(enrolled).toBeDefined();
		// getDeviceForUser returns ONLY the physical device
		expect(store.getDeviceForUser(userId)?.deviceId).toBe(enrolled?.deviceId);
	});

	it("revokeDevice removes only the physical device row; container devices for the same user survive", () => {
		// Regression test for the bug where `revokeDevice` ran `DELETE FROM
		// devices WHERE user_id = ?` with no `kind` filter: an operator
		// revoking a teammate's laptop (e.g. after a new-laptop enrollment)
		// would ALSO delete every one of that user's running container
		// devices, which ContainerLifecycle's orphan-GC sweep then reaps
		// (container AND volume) within one tick, killing any in-flight
		// session with no session-affinity guard.
		const store = new RouterStore(":memory:");
		const { userId } = store.addUser({ email: "alice@example.com" });
		const code = store.mintEnrollmentCode("alice@example.com", NOW);
		const physical = store.redeemEnrollmentCode(code, NOW);
		if (!physical) throw new Error("redeem failed");
		const container = store.createContainerDevice(userId, "CYPACK-1", "docker");

		expect(store.revokeDevice("alice@example.com")).toBe(true);

		expect(store.getDeviceForUser(userId)).toBeUndefined();
		expect(store.getDeviceByToken(physical.deviceToken)).toBeUndefined();
		// The container device must be untouched.
		expect(store.getContainerDeviceForIssue("CYPACK-1")).toMatchObject({
			deviceId: container.deviceId,
			provider: "docker",
		});
		expect(store.getDeviceInfo(container.deviceId)).toMatchObject({
			kind: "container",
		});
	});

	it("revokeDevice is a no-op (returns false) for a user with only container devices", () => {
		const store = new RouterStore(":memory:");
		const { userId } = store.addUser({ email: "docker-only@example.com" });
		store.createContainerDevice(userId, "CYPACK-1", "docker");

		expect(store.revokeDevice("docker-only@example.com")).toBe(false);
		expect(store.getContainerDeviceForIssue("CYPACK-1")).toBeDefined();
	});

	it("enforces one container per issue", () => {
		const store = new RouterStore(":memory:");
		const { userId } = store.addUser({ email: "a@example.com" });
		store.createContainerDevice(userId, "CYPACK-1", "docker");
		expect(() =>
			store.createContainerDevice(userId, "CYPACK-1", "docker"),
		).toThrow();
	});

	it("rotates a container token, invalidating the old one", () => {
		const store = new RouterStore(":memory:");
		const { userId } = store.addUser({ email: "a@example.com" });
		const { deviceId, deviceToken } = store.createContainerDevice(
			userId,
			"CYPACK-1",
			"docker",
		);
		const fresh = store.rotateContainerDeviceToken(deviceId);
		expect(store.getDeviceByToken(deviceToken)).toBeUndefined();
		expect(store.getDeviceByToken(fresh)?.deviceId).toBe(deviceId);
	});

	it("deletes a container device and purges its scoped rows", () => {
		const store = new RouterStore(":memory:");
		const { userId } = store.addUser({ email: "a@example.com" });
		const { deviceId } = store.createContainerDevice(
			userId,
			"CYPACK-1",
			"docker",
		);
		store.setSessionAffinity("sess-1", deviceId);
		store.deleteContainerDevice(deviceId);
		expect(store.getContainerDeviceForIssue("CYPACK-1")).toBeUndefined();
		expect(store.getSessionAffinity("sess-1")).toBeUndefined();
	});

	it("stores and reads a user executor config", () => {
		const store = new RouterStore(":memory:");
		const { userId } = store.addUser({ email: "a@example.com" });
		expect(store.getUserExecutor(userId)).toBeUndefined();
		expect(store.setUserExecutor("a@example.com", '{"type":"docker"}')).toBe(
			true,
		);
		expect(store.getUserExecutor(userId)).toBe('{"type":"docker"}');
		expect(store.setUserExecutor("a@example.com", null)).toBe(true);
		expect(store.getUserExecutor(userId)).toBeUndefined();
	});

	it("reads a user's email by id, and undefined for an unknown user", () => {
		const store = new RouterStore(":memory:");
		const { userId } = store.addUser({ email: "a@example.com" });
		expect(store.getUserEmail(userId)).toBe("a@example.com");
		expect(store.getUserEmail(userId + 999)).toBeUndefined();
	});

	it("counts session affinity rows per device and tracks last_routed_ms", () => {
		const store = new RouterStore(":memory:");
		const { userId } = store.addUser({ email: "a@example.com" });
		const { deviceId } = store.createContainerDevice(
			userId,
			"CYPACK-1",
			"docker",
		);
		expect(store.countSessionAffinityForDevice(deviceId)).toBe(0);
		store.setSessionAffinity("sess-1", deviceId);
		expect(store.countSessionAffinityForDevice(deviceId)).toBe(1);
		store.enqueueEvent(deviceId, "{}", 1000, 60_000);
		expect(store.listContainerDevices()[0]?.lastRoutedMs).toBe(1000);
	});

	it("stamps established_ms on session affinity and lists it per device", () => {
		const store = new RouterStore(":memory:");
		const { userId } = store.addUser({ email: "a@example.com" });
		const { deviceId } = store.createContainerDevice(userId, "PAR-1", "aca");

		store.setSessionAffinity("sess-1", deviceId, undefined, 1_000);
		store.setSessionAffinity("sess-2", deviceId, undefined, 2_000);

		expect(store.listSessionAffinityForDevice(deviceId)).toEqual([
			{ sessionId: "sess-1", establishedMs: 1_000 },
			{ sessionId: "sess-2", establishedMs: 2_000 },
		]);
	});

	it("refreshes established_ms when affinity is re-established", () => {
		const store = new RouterStore(":memory:");
		const { userId } = store.addUser({ email: "a@example.com" });
		const { deviceId } = store.createContainerDevice(userId, "PAR-1", "aca");

		store.setSessionAffinity("sess-1", deviceId, undefined, 1_000);
		// A re-prompt is a fresh claim, not a continuation of the old one.
		store.setSessionAffinity("sess-1", deviceId, undefined, 9_000);

		expect(store.listSessionAffinityForDevice(deviceId)).toEqual([
			{ sessionId: "sess-1", establishedMs: 9_000 },
		]);
	});

	it("returns an empty list for a device with no affinity", () => {
		const store = new RouterStore(":memory:");
		const { userId } = store.addUser({ email: "a@example.com" });
		const { deviceId } = store.createContainerDevice(userId, "PAR-1", "aca");

		expect(store.listSessionAffinityForDevice(deviceId)).toEqual([]);
	});

	it("includes crashed containers in devicesOfflineSince so stranded locks are reclaimed", () => {
		// A container that died mid-session holds affinity/locks; the existing
		// offline sweep must reclaim them exactly as for physical devices.
		const store = new RouterStore(":memory:");
		const { userId } = store.addUser({ email: "a@example.com" });
		const { deviceId } = store.createContainerDevice(
			userId,
			"CYPACK-1",
			"docker",
		);
		store.touchDevice(deviceId, 1000);
		expect(store.devicesOfflineSince(2000).map((d) => d.deviceId)).toContain(
			deviceId,
		);
	});

	it("migrates a v1 database in place, preserving device ids and events", () => {
		// Build a v1 db by hand, then open it with RouterStore and assert the
		// old device still authenticates and its queued events survive.
		const dir = mkdtempSync(join(tmpdir(), "router-store-"));
		const dbPath = join(dir, "router.db");
		const raw = new Database(dbPath);
		raw.exec(V1_SCHEMA); // copy of the pre-migration SCHEMA constant, inline in the test
		raw.prepare("INSERT INTO users (email) VALUES ('a@example.com')").run();
		raw
			.prepare(
				"INSERT INTO devices (user_id, token_hash, created_ms, next_seq) VALUES (1, ?, 1, 2)",
			)
			.run(createHash("sha256").update("tok").digest("hex"));
		raw
			.prepare(
				"INSERT INTO events (device_id, seq, payload_json, enqueued_ms, expires_ms) VALUES (1, 1, '{}', 1, 99999999999999)",
			)
			.run();
		raw.close();

		const store = new RouterStore(dbPath);
		expect(store.getDeviceByToken("tok")).toEqual({ deviceId: 1, userId: 1 });
		expect(store.pendingEvents(1, 0, 2)).toHaveLength(1);
		// New columns usable post-migration:
		const { deviceId } = store.createContainerDevice(1, "CYPACK-1", "docker");
		expect(deviceId).toBeGreaterThan(1); // AUTOINCREMENT sequence preserved
		store.close();
	});

	it("keeps foreign_keys enforcement live after migrating a v1 database", () => {
		// migrate() turns foreign_keys OFF for the duration of the v1->v2
		// devices rebuild (so DROP TABLE devices doesn't cascade-delete
		// queued events) and must restore it to ON afterwards no matter how
		// the rebuild transaction exits. Verify restoration on the success
		// path by proving ON DELETE CASCADE still fires on this connection:
		// deleting a user must cascade users -> devices -> events.
		const dir = mkdtempSync(join(tmpdir(), "router-store-fk-"));
		const dbPath = join(dir, "router.db");
		const raw = new Database(dbPath);
		raw.exec(V1_SCHEMA);
		raw.prepare("INSERT INTO users (email) VALUES ('b@example.com')").run();
		raw
			.prepare(
				"INSERT INTO devices (user_id, token_hash, created_ms, next_seq) VALUES (1, ?, 1, 2)",
			)
			.run(createHash("sha256").update("tok2").digest("hex"));
		raw
			.prepare(
				"INSERT INTO events (device_id, seq, payload_json, enqueued_ms, expires_ms) VALUES (1, 1, '{}', 1, 99999999999999)",
			)
			.run();
		raw.close();

		const store = new RouterStore(dbPath);
		const device = store.getDeviceByToken("tok2");
		expect(device).toEqual({ deviceId: 1, userId: 1 });
		expect(store.pendingEvents(device!.deviceId, 0, 2)).toHaveLength(1);

		expect(store.removeUser("b@example.com")).toBe(true);
		// If foreign_keys enforcement had been left OFF, both rows below
		// would still be present since the cascade would never have fired.
		expect(store.getDeviceByToken("tok2")).toBeUndefined();
		expect(store.pendingEvents(device!.deviceId, 0, 2)).toHaveLength(0);

		store.close();
	});
	describe("container teardown bookkeeping", () => {
		function seedContainer(store: RouterStore, issueKey = "CYPACK-1") {
			const { userId } = store.addUser({ email: `${issueKey}@example.com` });
			return store.createContainerDevice(userId, issueKey, "aca");
		}

		it("upserts, reads, and lists pending teardowns", () => {
			const store = new RouterStore(":memory:");
			const { deviceId } = seedContainer(store);

			expect(store.getPendingTeardown("CYPACK-1")).toBeUndefined();
			store.upsertPendingTeardown({
				issueKey: "CYPACK-1",
				deviceId,
				action: "closed",
				registeredMs: 10,
				deadlineMs: 610,
			});
			expect(store.getPendingTeardown("CYPACK-1")).toEqual({
				issueKey: "CYPACK-1",
				deviceId,
				action: "closed",
				registeredMs: 10,
				deadlineMs: 610,
				callbackId: undefined,
				callbackReceivedMs: undefined,
				callbackAttempts: 0,
			});
			expect(store.listPendingTeardowns()).toHaveLength(1);

			// An upgrade to `deleted` overwrites in place rather than duplicating.
			store.upsertPendingTeardown({
				issueKey: "CYPACK-1",
				deviceId,
				action: "deleted",
				registeredMs: 20,
				deadlineMs: 620,
			});
			expect(store.listPendingTeardowns()).toHaveLength(1);
			expect(store.getPendingTeardown("CYPACK-1")?.action).toBe("deleted");

			store.deletePendingTeardown("CYPACK-1");
			expect(store.listPendingTeardowns()).toEqual([]);
			store.close();
		});

		it("counts callback deliveries and flags a repeat of the same key as a retry", () => {
			const store = new RouterStore(":memory:");
			const { deviceId } = seedContainer(store);
			store.upsertPendingTeardown({
				issueKey: "CYPACK-1",
				deviceId,
				action: "closed",
				registeredMs: 10,
				deadlineMs: 610,
			});

			const first = store.recordTeardownCallback("CYPACK-1", "cb-1", 100);
			expect(first?.retry).toBe(false);
			expect(first?.info).toMatchObject({
				callbackId: "cb-1",
				callbackReceivedMs: 100,
				callbackAttempts: 1,
			});

			// The device replays the SAME key until we accept it; the first
			// received-at timestamp is preserved so it stays the source of truth.
			const second = store.recordTeardownCallback("CYPACK-1", "cb-1", 200);
			expect(second?.retry).toBe(true);
			expect(second?.info).toMatchObject({
				callbackId: "cb-1",
				callbackReceivedMs: 100,
				callbackAttempts: 2,
			});

			// No pending row -> nothing to record.
			expect(
				store.recordTeardownCallback("CYPACK-404", "cb-9", 300),
			).toBeUndefined();
			store.close();
		});

		it("clears every row, and drops a row when its container device is deleted", () => {
			const store = new RouterStore(":memory:");
			const a = seedContainer(store, "CYPACK-1");
			const b = seedContainer(store, "CYPACK-2");
			for (const [issueKey, deviceId] of [
				["CYPACK-1", a.deviceId],
				["CYPACK-2", b.deviceId],
			] as const) {
				store.upsertPendingTeardown({
					issueKey,
					deviceId,
					action: "closed",
					registeredMs: 1,
					deadlineMs: 2,
				});
			}

			store.deleteContainerDevice(a.deviceId);
			expect(store.listPendingTeardowns().map((r) => r.issueKey)).toEqual([
				"CYPACK-2",
			]);

			expect(store.clearPendingTeardowns()).toBe(1);
			expect(store.listPendingTeardowns()).toEqual([]);
			expect(store.clearPendingTeardowns()).toBe(0);
			store.close();
		});
	});

	describe("parked_at_ms", () => {
		const makeContainerDevice = (store: RouterStore, issueKey: string) => {
			const { userId } = store.addUser({ email: `${issueKey}@example.com` });
			return store.createContainerDevice(userId, issueKey, "aca").deviceId;
		};
		const parkedAtFor = (store: RouterStore, deviceId: number) =>
			store.listContainerDevices().find((d) => d.deviceId === deviceId)
				?.parkedAtMs;

		it("round-trips through listContainerDevices", () => {
			const store = new RouterStore(":memory:");
			const deviceId = makeContainerDevice(store, "PAR-1");

			store.setDeviceParkedAt(deviceId, 1_700_000_000_000);

			expect(parkedAtFor(store, deviceId)).toBe(1_700_000_000_000);
			store.close();
		});

		it("is undefined until a session parks", () => {
			const store = new RouterStore(":memory:");
			const deviceId = makeContainerDevice(store, "PAR-2");

			expect(parkedAtFor(store, deviceId)).toBeUndefined();
			store.close();
		});

		it("clears on clearDeviceParkedAt", () => {
			const store = new RouterStore(":memory:");
			const deviceId = makeContainerDevice(store, "PAR-3");

			store.setDeviceParkedAt(deviceId, 1_700_000_000_000);
			store.clearDeviceParkedAt(deviceId);

			expect(parkedAtFor(store, deviceId)).toBeUndefined();
			store.close();
		});

		it("clears when affinity is re-established for the device", () => {
			// A device with a live session is by definition not parked. Leaving a
			// stale stamp would make the idle clock read from a park that ended.
			const store = new RouterStore(":memory:");
			const deviceId = makeContainerDevice(store, "PAR-4");

			store.setDeviceParkedAt(deviceId, 1_700_000_000_000);
			store.setSessionAffinity("session-1", deviceId);

			expect(parkedAtFor(store, deviceId)).toBeUndefined();
			store.close();
		});

		it("is exposed on getContainerDeviceForIssue too", () => {
			const store = new RouterStore(":memory:");
			const deviceId = makeContainerDevice(store, "PAR-5");

			store.setDeviceParkedAt(deviceId, 42);

			expect(store.getContainerDeviceForIssue("PAR-5")?.parkedAtMs).toBe(42);
			store.close();
		});
	});

	describe("running_since_ms", () => {
		const makeContainerDevice = (store: RouterStore, issueKey: string) => {
			const { userId } = store.addUser({ email: `${issueKey}@example.com` });
			return store.createContainerDevice(userId, issueKey, "aca").deviceId;
		};
		const runningSinceFor = (store: RouterStore, deviceId: number) =>
			store.listContainerDevices().find((d) => d.deviceId === deviceId)
				?.runningSinceMs;

		it("is undefined until the container is marked running", () => {
			const store = new RouterStore(":memory:");
			const deviceId = makeContainerDevice(store, "NOR-1");

			expect(runningSinceFor(store, deviceId)).toBeUndefined();
			store.close();
		});

		it("round-trips through both container-device reads", () => {
			const store = new RouterStore(":memory:");
			const deviceId = makeContainerDevice(store, "NOR-2");

			expect(store.markDeviceRunning(deviceId, 1_700_000_000_000)).toBe(true);

			expect(runningSinceFor(store, deviceId)).toBe(1_700_000_000_000);
			expect(store.getContainerDeviceForIssue("NOR-2")?.runningSinceMs).toBe(
				1_700_000_000_000,
			);
			store.close();
		});

		/**
		 * The whole reason `markDeviceRunning` is set-if-null. `boot()` runs on
		 * every routed event and `ensureRunning` returns immediately for a
		 * container that is already up, so an unconditional stamp would reset the
		 * clock on every user comment — and a sandbox genuinely pinned for eight
		 * hours would report an uptime of seconds, which is exactly the case the
		 * long-running alert exists to catch.
		 */
		it("does not restart a clock that is already running", () => {
			const store = new RouterStore(":memory:");
			const deviceId = makeContainerDevice(store, "NOR-3");

			store.markDeviceRunning(deviceId, 1_000);
			expect(store.markDeviceRunning(deviceId, 9_999)).toBe(false);

			expect(runningSinceFor(store, deviceId)).toBe(1_000);
			store.close();
		});

		it("reports whether clearing actually stopped a running clock", () => {
			const store = new RouterStore(":memory:");
			const deviceId = makeContainerDevice(store, "NOR-4");

			store.markDeviceRunning(deviceId, 1_000);

			expect(store.clearDeviceRunningSince(deviceId)).toBe(true);
			expect(runningSinceFor(store, deviceId)).toBeUndefined();
			// Idempotent: a second clear is a no-op and says so, so callers can
			// emit a stop transition exactly once.
			expect(store.clearDeviceRunningSince(deviceId)).toBe(false);
			store.close();
		});

		it("restarts the clock after a stop, so uptime measures the current run only", () => {
			const store = new RouterStore(":memory:");
			const deviceId = makeContainerDevice(store, "NOR-5");

			store.markDeviceRunning(deviceId, 1_000);
			store.clearDeviceRunningSince(deviceId);
			store.markDeviceRunning(deviceId, 5_000);

			expect(runningSinceFor(store, deviceId)).toBe(5_000);
			store.close();
		});

		/**
		 * `created_ms` is the device ROW's age and survives every stop/resume
		 * cycle, which is why it cannot answer continuous uptime and why this
		 * column had to exist at all.
		 */
		it("is independent of created_ms", () => {
			const store = new RouterStore(":memory:");
			const deviceId = makeContainerDevice(store, "NOR-6");
			const createdMs = store.getContainerDeviceForIssue("NOR-6")?.createdMs;

			store.markDeviceRunning(deviceId, (createdMs ?? 0) + 10_000);

			expect(store.getContainerDeviceForIssue("NOR-6")?.createdMs).toBe(
				createdMs,
			);
			expect(runningSinceFor(store, deviceId)).toBe((createdMs ?? 0) + 10_000);
			store.close();
		});
	});

	describe("last_active_ms", () => {
		const makeContainerDevice = (store: RouterStore, issueKey: string) => {
			const { userId } = store.addUser({ email: `${issueKey}@example.com` });
			return store.createContainerDevice(userId, issueKey, "aca").deviceId;
		};
		const lastActiveFor = (store: RouterStore, deviceId: number) =>
			store.listContainerDevices().find((d) => d.deviceId === deviceId)
				?.lastActiveMs;

		it("is undefined for a device that has never held a session", () => {
			const store = new RouterStore(":memory:");
			const deviceId = makeContainerDevice(store, "NOR-366-a");

			expect(lastActiveFor(store, deviceId)).toBeUndefined();
			store.close();
		});

		/**
		 * The exact inverse of `markDeviceRunning`'s set-if-null contract, and the
		 * distinction the two columns exist for. `running_since_ms` answers "how
		 * long has this sandbox been up" and must survive re-stamping;
		 * `last_active_ms` answers "when did it last do anything", so re-stamping
		 * IS the semantics. Conflating them is what NOR-366 was.
		 */
		it("re-stamps unconditionally, unlike the uptime clock", () => {
			const store = new RouterStore(":memory:");
			const deviceId = makeContainerDevice(store, "NOR-366-b");

			store.markDeviceActive(deviceId, 1_000);
			store.markDeviceActive(deviceId, 9_999);

			expect(lastActiveFor(store, deviceId)).toBe(9_999);
			expect(store.getContainerDeviceForIssue("NOR-366-b")?.lastActiveMs).toBe(
				9_999,
			);
			store.close();
		});

		it("is stamped by setSessionAffinity, so a claim resets the idle clock immediately", () => {
			// The sweep only ever OBSERVES a pin on its next tick. Without the stamp
			// happening in the same call that creates the pin, there is a whole sweep
			// interval in which a just-claimed container looks unpinned and — for any
			// issue whose container is older than idleStopMs — already expired.
			const store = new RouterStore(":memory:");
			const deviceId = makeContainerDevice(store, "NOR-366-c");

			store.setSessionAffinity("review", deviceId, undefined, 4_242);

			expect(lastActiveFor(store, deviceId)).toBe(4_242);
			store.close();
		});

		/**
		 * Backfilled, unlike `running_since_ms`, because this column only ever
		 * DELAYS an idle-stop. Leaving it NULL would make every pre-upgrade
		 * container instantly eligible for the very stop it exists to prevent;
		 * backfilling costs at most one extra idleStopMs before a genuinely idle
		 * container is parked.
		 */
		it("backfills existing container rows on migration rather than leaving them expired", () => {
			const dir = mkdtempSync(join(tmpdir(), "router-store-active-"));
			const dbPath = join(dir, "router.db");
			const before = Date.now();

			const raw = new Database(dbPath);
			raw.exec(V1_SCHEMA);
			raw.prepare("INSERT INTO users (email) VALUES ('c@example.com')").run();
			raw.close();

			// Open once to migrate to v2 (which is what creates the container-device
			// shape at all), seed a container row, then drop the column and reopen so
			// the last_active_ms migration runs against a row that predates it.
			const migrated = new RouterStore(dbPath);
			const { deviceId } = migrated.createContainerDevice(1, "OLD-1", "aca");
			migrated.close();

			const stripped = new Database(dbPath);
			stripped.exec("ALTER TABLE devices DROP COLUMN last_active_ms");
			stripped.close();

			const store = new RouterStore(dbPath);
			const lastActiveMs = lastActiveFor(store, deviceId);
			expect(lastActiveMs).toBeGreaterThanOrEqual(before);
			expect(lastActiveMs).toBeLessThanOrEqual(Date.now());
			store.close();
		});
	});

	describe("getContainerDevice", () => {
		it("re-reads one row by device id, so a stale caller can refresh it", () => {
			// NOR-406: the lifecycle sweep decided from `listContainerDevices()`
			// taken minutes earlier and never saw the route that had landed since.
			const store = new RouterStore(":memory:");
			const { userId } = store.addUser({ email: "fresh@example.com" });
			const { deviceId } = store.createContainerDevice(
				userId,
				"NOR-406-a",
				"aca",
			);
			const stale = store.listContainerDevices()[0];
			expect(stale?.lastRoutedMs).toBeUndefined();

			store.enqueueEvent(deviceId, "{}", 7_777, 60_000);

			expect(store.getContainerDevice(deviceId)?.lastRoutedMs).toBe(7_777);
			store.close();
		});

		it("returns undefined for a deleted row, and never its successor", () => {
			// Keyed by device id rather than issue key on purpose: a destroyed and
			// recreated container is a DIFFERENT container, and a mid-tick sweep
			// must not act on the replacement.
			const store = new RouterStore(":memory:");
			const { userId } = store.addUser({ email: "gone@example.com" });
			const first = store.createContainerDevice(userId, "NOR-406-b", "aca");
			store.deleteContainerDevice(first.deviceId);
			const second = store.createContainerDevice(userId, "NOR-406-b", "aca");

			expect(store.getContainerDevice(first.deviceId)).toBeUndefined();
			expect(store.getContainerDevice(second.deviceId)?.issueKey).toBe(
				"NOR-406-b",
			);
			store.close();
		});

		it("ignores physical device rows", () => {
			const { store, device } = storeWithDevice();

			expect(store.getContainerDevice(device.deviceId)).toBeUndefined();
			store.close();
		});
	});

	describe("getLastAgentRunActivityMs", () => {
		const seedRun = (store: RouterStore, issueKey: string) => {
			const { userId } = store.addUser({ email: `${issueKey}@example.com` });
			const { deviceId } = store.createContainerDevice(userId, issueKey, "aca");
			store.recordAgentRunRouted({
				deviceId,
				issueKey,
				sessionId: `s-${issueKey}`,
				routedMs: 1_000,
			});
			return deviceId;
		};

		it("is undefined for a device whose runs have neither reported nor ended", () => {
			// Routing alone must not arm the settle window: `last_routed_ms` on the
			// device row already covers it, and duplicating it here would turn the
			// veto into a second idle clock.
			const store = new RouterStore(":memory:");
			const deviceId = seedRun(store, "NOR-406-c");

			expect(store.getLastAgentRunActivityMs(deviceId)).toBeUndefined();
			store.close();
		});

		it("reports when a run ended", () => {
			const store = new RouterStore(":memory:");
			const deviceId = seedRun(store, "NOR-406-d");

			store.finishAgentRun(`s-NOR-406-d`, "complete", 50_000);

			expect(store.getLastAgentRunActivityMs(deviceId)).toBe(50_000);
			store.close();
		});

		it("reports a reconciler reclaim too — the router never saw a terminal frame", () => {
			const store = new RouterStore(":memory:");
			const deviceId = seedRun(store, "NOR-406-e");

			store.markAgentRunUnknown(`s-NOR-406-e`, 60_000);

			expect(store.getLastAgentRunActivityMs(deviceId)).toBe(60_000);
			store.close();
		});

		it("takes the latest across every run on the device", () => {
			const store = new RouterStore(":memory:");
			const deviceId = seedRun(store, "NOR-406-f");
			store.finishAgentRun(`s-NOR-406-f`, "complete", 20_000);
			store.recordAgentRunRouted({
				deviceId,
				issueKey: "NOR-406-f",
				sessionId: "s-second",
				routedMs: 30_000,
			});
			store.recordAgentRunActivity("s-second", 40_000);

			expect(store.getLastAgentRunActivityMs(deviceId)).toBe(40_000);
			store.close();
		});

		it("is undefined for a device with no runs at all", () => {
			const store = new RouterStore(":memory:");
			const { userId } = store.addUser({ email: "none@example.com" });
			const { deviceId } = store.createContainerDevice(
				userId,
				"NOR-406-g",
				"aca",
			);

			expect(store.getLastAgentRunActivityMs(deviceId)).toBeUndefined();
			store.close();
		});
	});
});

describe("repository decisions", () => {
	it("returns undefined for an issue with no decision", () => {
		const store = new RouterStore(":memory:");
		expect(store.getIssueRepositories("NOR-1")).toBeUndefined();
	});

	it("round-trips a decision", () => {
		const store = new RouterStore(":memory:");
		store.setIssueRepositories(
			"NOR-1",
			{
				repoNames: ["cyrus-api", "cyrus-web"],
				baseBranchOverrides: { "cyrus-web": "release" },
				method: "description-tag",
			},
			1000,
		);
		expect(store.getIssueRepositories("NOR-1")).toEqual({
			repoNames: ["cyrus-api", "cyrus-web"],
			baseBranchOverrides: { "cyrus-web": "release" },
			method: "description-tag",
			decidedMs: 1000,
		});
	});

	it("replaces an existing decision for the same issue", () => {
		const store = new RouterStore(":memory:");
		store.setIssueRepositories(
			"NOR-1",
			{ repoNames: ["a"], baseBranchOverrides: {}, method: "default" },
			1,
		);
		store.setIssueRepositories(
			"NOR-1",
			{ repoNames: ["b"], baseBranchOverrides: {}, method: "team-based" },
			2,
		);
		expect(store.getIssueRepositories("NOR-1")?.repoNames).toEqual(["b"]);
	});

	it("deletes a decision", () => {
		const store = new RouterStore(":memory:");
		store.setIssueRepositories(
			"NOR-1",
			{ repoNames: ["a"], baseBranchOverrides: {}, method: "default" },
			1,
		);
		store.deleteIssueRepositories("NOR-1");
		expect(store.getIssueRepositories("NOR-1")).toBeUndefined();
	});

	it("treats a corrupt stored row as absent rather than throwing", () => {
		const store = new RouterStore(":memory:");
		store.setIssueRepositories(
			"NOR-1",
			{ repoNames: ["a"], baseBranchOverrides: {}, method: "default" },
			1,
		);
		// Simulate a hand-edited / truncated row.
		store
			.rawDbForTests()
			.prepare(
				"UPDATE issue_repositories SET repos_json = '{ broken' WHERE issue_key = ?",
			)
			.run("NOR-1");
		expect(store.getIssueRepositories("NOR-1")).toBeUndefined();
	});

	it("treats valid-JSON-but-wrong-shape overrides_json as absent rather than returning a non-object", () => {
		const store = new RouterStore(":memory:");
		store.setIssueRepositories(
			"NOR-1",
			{ repoNames: ["a"], baseBranchOverrides: {}, method: "default" },
			1,
		);
		// Syntactically valid JSON, but not an object — e.g. a hand-edited row.
		store
			.rawDbForTests()
			.prepare(
				'UPDATE issue_repositories SET overrides_json = \'["a","b"]\' WHERE issue_key = ?',
			)
			.run("NOR-1");
		expect(store.getIssueRepositories("NOR-1")).toBeUndefined();
	});

	it("treats valid-JSON-but-wrong-element-type repos_json as absent", () => {
		const store = new RouterStore(":memory:");
		store.setIssueRepositories(
			"NOR-1",
			{ repoNames: ["a"], baseBranchOverrides: {}, method: "default" },
			1,
		);
		// An array, but of numbers rather than repo name strings.
		store
			.rawDbForTests()
			.prepare(
				"UPDATE issue_repositories SET repos_json = '[1,2,3]' WHERE issue_key = ?",
			)
			.run("NOR-1");
		expect(store.getIssueRepositories("NOR-1")).toBeUndefined();
	});
});

describe("pending repository selections", () => {
	const row = {
		agentSessionId: "sess-1",
		issueKey: "NOR-1",
		workspaceId: "ws-1",
		options: ["cyrus-api", "cyrus-web"],
		createdEvent: '{"action":"created"}',
		createdMs: 1000,
	};

	it("round-trips a pending selection", () => {
		const store = new RouterStore(":memory:");
		store.createPendingRepoSelection(row);
		expect(store.getPendingRepoSelection("sess-1")).toEqual(row);
	});

	it("returns undefined for an unknown session", () => {
		const store = new RouterStore(":memory:");
		expect(store.getPendingRepoSelection("nope")).toBeUndefined();
	});

	it("degrades a corrupt options_json to an empty options array rather than throwing", () => {
		const store = new RouterStore(":memory:");
		store.createPendingRepoSelection(row);
		store
			.rawDbForTests()
			.prepare(
				"UPDATE pending_repo_selections SET options_json = '{ broken' WHERE agent_session_id = ?",
			)
			.run("sess-1");
		expect(store.getPendingRepoSelection("sess-1")?.options).toEqual([]);
	});

	it("deletes a pending selection", () => {
		const store = new RouterStore(":memory:");
		store.createPendingRepoSelection(row);
		store.deletePendingRepoSelection("sess-1");
		expect(store.getPendingRepoSelection("sess-1")).toBeUndefined();
	});

	it("sweeps only selections older than the cutoff, returning each swept row's identity", () => {
		const store = new RouterStore(":memory:");
		store.createPendingRepoSelection(row);
		store.createPendingRepoSelection({
			...row,
			agentSessionId: "sess-2",
			createdMs: 5000,
		});
		expect(store.sweepPendingRepoSelections(2000)).toEqual([
			{ agentSessionId: "sess-1", workspaceId: "ws-1", issueKey: "NOR-1" },
		]);
		expect(store.getPendingRepoSelection("sess-1")).toBeUndefined();
		expect(store.getPendingRepoSelection("sess-2")).toBeDefined();
	});
});

describe("RouterStore trace context on queued events", () => {
	const TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

	it("persists the enqueue-time trace context with the row", () => {
		// It must be the ENQUEUE-time context, not one derived at delivery: the
		// two are routinely minutes apart (an offline device, a cold sandbox
		// boot), and that gap is exactly what the trace exists to show.
		const { store, device } = storeWithDevice();
		store.enqueueEvent(device.deviceId, "{}", NOW, 60_000, {
			traceparent: TRACEPARENT,
			tracestate: "vendor=v",
		});

		const [pending] = store.pendingEvents(device.deviceId, 0, NOW);
		expect(pending?.traceparent).toBe(TRACEPARENT);
		expect(pending?.tracestate).toBe("vendor=v");
	});

	it("omits the fields entirely when tracing is off", () => {
		// The caller spreads these into a frame the protocol schema validates, so
		// an explicit `undefined` key would be a trap; absence is the contract.
		const { store, device } = storeWithDevice();
		store.enqueueEvent(device.deviceId, "{}", NOW, 60_000);

		const [pending] = store.pendingEvents(device.deviceId, 0, NOW);
		expect(pending).not.toHaveProperty("traceparent");
		expect(pending).not.toHaveProperty("tracestate");
	});

	it("carries trace context across a seq-regression resequence", () => {
		// A resequenced event is the SAME event under a new seq. Dropping its
		// trace context would silently detach exactly the deliveries a seq
		// regression (NOR-263) makes interesting to trace.
		const { store, device } = storeWithDevice();
		store.enqueueEvent(device.deviceId, "{}", NOW, 60_000, {
			traceparent: TRACEPARENT,
		});

		const result = store.reconcileDeviceSeq(device.deviceId, 50, NOW);
		expect(result.repaired).toBe(true);
		expect(result.resequenced).toBe(1);

		const [pending] = store.pendingEvents(device.deviceId, 0, NOW);
		expect(pending?.seq).toBe(51);
		expect(pending?.traceparent).toBe(TRACEPARENT);
	});

	it("migrates a database that predates the columns", () => {
		// Deliberately not backfilled: a row enqueued before this column existed
		// was produced by a router that had no trace to record. NULL is honest,
		// and the delivery path reads it as "no trace context".
		const dir = mkdtempSync(join(tmpdir(), "router-store-trace-"));
		const dbPath = join(dir, "router.db");
		const raw = new Database(dbPath);
		raw.exec(V1_SCHEMA);
		raw.close();

		const store = new RouterStore(dbPath);
		store.addUser({ email: "alice@example.com" });
		const code = store.mintEnrollmentCode("alice@example.com", NOW);
		const device = store.redeemEnrollmentCode(code, NOW + 1000);
		if (!device) throw new Error("redeem failed");

		store.enqueueEvent(device.deviceId, "{}", NOW, 60_000, {
			traceparent: TRACEPARENT,
		});
		expect(store.pendingEvents(device.deviceId, 0, NOW)[0]?.traceparent).toBe(
			TRACEPARENT,
		);
	});
});

describe("RouterStore agent runs", () => {
	it("tracks multiple inputs through one run, then creates a new run after terminal", () => {
		const { store, device } = storeWithDevice();
		const firstRunId = store.recordAgentRunRouted({
			deviceId: device.deviceId,
			issueKey: "NOR-402",
			sessionId: "session-1",
			activityId: "activity-1",
			commentId: "comment-1",
			routedMs: NOW,
		});
		expect(
			store.recordAgentRunRouted({
				deviceId: device.deviceId,
				issueKey: "NOR-402",
				sessionId: "session-1",
				activityId: "activity-2",
				commentId: "comment-2",
				routedMs: NOW + 100,
			}),
		).toBe(firstRunId);

		store.recordAgentRunActivity("session-1", NOW + 200);
		store.setAgentRunState("session-1", "parked");
		store.finishAgentRun("session-1", "complete", NOW + 300);
		const first = store.listAgentRuns({
			userId: 1,
			commentId: "comment-1",
		})[0];
		expect(first).toMatchObject({
			runId: firstRunId,
			state: "complete",
			lastRoutedMs: NOW + 100,
			lastAgentActivityMs: NOW + 200,
			endedMs: NOW + 300,
		});
		expect(first?.inputs).toEqual([
			{ activityId: "activity-1", commentId: "comment-1", routedMs: NOW },
			{
				activityId: "activity-2",
				commentId: "comment-2",
				routedMs: NOW + 100,
			},
		]);

		const secondRunId = store.recordAgentRunRouted({
			deviceId: device.deviceId,
			issueKey: "NOR-402",
			sessionId: "session-1",
			commentId: "comment-3",
			routedMs: NOW + 400,
		});
		expect(secondRunId).not.toBe(firstRunId);
		expect(store.listAgentRuns({ userId: 1 })[0]?.state).toBe("routed");
	});

	it("marks work unknown when its device identity is replaced", () => {
		const { store, device } = storeWithDevice();
		store.recordAgentRunRouted({
			deviceId: device.deviceId,
			issueKey: "NOR-402",
			sessionId: "session-1",
			routedMs: NOW,
		});

		const code = store.mintEnrollmentCode("alice@example.com", NOW);
		store.redeemEnrollmentCode(code, NOW);

		expect(store.listAgentRuns({ userId: 1 })[0]?.state).toBe("unknown");
	});

	it("keeps same-millisecond input on the newly started run", () => {
		const { store, device } = storeWithDevice();
		store.recordAgentRunRouted({
			deviceId: device.deviceId,
			issueKey: "NOR-402",
			sessionId: "session-1",
			routedMs: NOW,
		});
		store.finishAgentRun("session-1", "complete", NOW);

		const second = store.recordAgentRunRouted({
			deviceId: device.deviceId,
			issueKey: "NOR-402",
			sessionId: "session-1",
			routedMs: NOW,
		});
		expect(
			store.recordAgentRunRouted({
				deviceId: device.deviceId,
				issueKey: "NOR-402",
				sessionId: "session-1",
				routedMs: NOW,
			}),
		).toBe(second);
		expect(store.listAgentRuns({ userId: 1 })).toHaveLength(2);
	});

	it("retains active runs while sweeping terminal runs older than the cutoff", () => {
		const { store, device } = storeWithDevice();
		store.recordAgentRunRouted({
			deviceId: device.deviceId,
			issueKey: "NOR-1",
			sessionId: "active",
			routedMs: 1,
		});
		store.recordAgentRunRouted({
			deviceId: device.deviceId,
			issueKey: "NOR-2",
			sessionId: "old",
			routedMs: 2,
		});
		store.finishAgentRun("old", "error", 3);

		expect(store.sweepTerminalAgentRuns(4)).toBe(1);
		expect(
			store.listAgentRuns({ userId: 1 }).map((run) => run.sessionId),
		).toEqual(["active"]);
	});
});
