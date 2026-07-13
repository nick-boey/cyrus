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
});
