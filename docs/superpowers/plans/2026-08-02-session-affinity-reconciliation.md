# Session Affinity Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a leaked `session_affinity` row from exempting a container device from the idle sweep forever, by making the router re-derive affinity from what the device says it is running.

**Architecture:** A `sessions_query` / `sessions_report` frame pair lets `ContainerLifecycle.sweep()` ask an online device which sessions it is actually running, reclaim affinity rows the device does not claim (subject to a grace window for just-routed sessions), and then re-evaluate the idle clock in the same tick. Offline devices instead age out affinity so stale-destroy can proceed. The router never reclaims on silence, so it can never freeze a live session.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, Zod (protocol frames), better-sqlite3 (`RouterStore`), `ws` (WebSocket gateway).

**Spec:** `docs/superpowers/specs/2026-08-02-session-affinity-leak-design.md`

## Global Constraints

- **`PROTOCOL_VERSION` is NOT bumped.** Both new frames are additive. Do not touch the constant in `packages/router-protocol/src/frames.ts`.
- **Deploy ordering is load-bearing: router BEFORE worker.** `DeviceGateway.handleMessage` closes a socket with `1002 invalid frame` on a parse failure (`DeviceGateway.ts:173-176`), so an old router receiving `sessions_report` from a new worker drops that device. The reverse is safe — `RouterConnection.handleMessage` swallows unknown frames (`RouterConnection.ts:524-525`).
- **The affinity gate stays.** `if (affinity > 0) continue` in `ContainerLifecycle.sweep` is correct and must not be weakened. Only the *set it counts* changes.
- **Never reclaim on silence.** Timeout, offline, unparseable reply, or missing capability must all resolve to "can't tell, skip" — never to "assume no sessions".
- **New `containers.*` config fields must be added to the Zod schema in `apps/cli/src/commands/RouterCommand.ts`.** Unmodelled fields are stripped on every `router start` (see the comment at `RouterCommand.ts:188-192`), so a field missing from the schema silently never reaches `RouterServer`.
- Run `pnpm test:packages:run` and `pnpm typecheck` before each commit.
- Changelog: user-facing entries go in `CHANGELOG.md` under `## [Unreleased]`; internal ones in `CHANGELOG.internal.md`.

---

### Task 1: `established_ms` on `session_affinity`

Affinity rows currently carry no age, so there is no way to distinguish "routed three seconds ago and the worker has not started tracking it yet" from "leaked two hours ago".

**Files:**
- Modify: `packages/router/src/RouterStore.ts` (schema ~line 48, migrations ~line 385, `setSessionAffinity` ~line 1246)
- Test: `packages/router/test/RouterStore.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `setSessionAffinity(sessionId: string, deviceId: number, creatorJson?: string, establishedMs?: number): void` — `establishedMs` defaults to `Date.now()`.
  - `listSessionAffinityForDevice(deviceId: number): Array<{ sessionId: string; establishedMs: number }>`

- [ ] **Step 1: Write the failing tests**

In `packages/router/test/RouterStore.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter cyrus-router test:run -- RouterStore`
Expected: FAIL — `store.listSessionAffinityForDevice is not a function`.

- [ ] **Step 3: Add the column to the fresh-DB schema**

In `RouterStore.ts`, change the `session_affinity` DDL (~line 48):

```sql
CREATE TABLE IF NOT EXISTS session_affinity (
  session_id TEXT PRIMARY KEY, device_id INTEGER NOT NULL, creator_json TEXT, established_ms INTEGER
);
```

- [ ] **Step 4: Add the migration for existing databases**

In the migration block (alongside the `parked_at_ms` migration, ~line 385):

```typescript
// Existing rows predate the column. Backfill them to migration time rather
// than leaving NULL: the offline age-out path reads this as a clock, and
// treating every pre-upgrade row as infinitely old would lift the affinity
// gate on devices we have not actually verified.
const affinityCols = this.db
	.prepare("PRAGMA table_info(session_affinity)")
	.all() as Array<{ name: string }>;
if (
	affinityCols.length > 0 &&
	!affinityCols.some((c) => c.name === "established_ms")
) {
	this.db.exec("ALTER TABLE session_affinity ADD COLUMN established_ms INTEGER");
	this.db
		.prepare("UPDATE session_affinity SET established_ms = ? WHERE established_ms IS NULL")
		.run(Date.now());
}
```

- [ ] **Step 5: Stamp the column on write and add the read**

Replace `setSessionAffinity` (~line 1246) and add the list method after `clearSessionAffinity`:

```typescript
setSessionAffinity(
	sessionId: string,
	deviceId: number,
	creatorJson?: string,
	establishedMs: number = Date.now(),
): void {
	this.db
		.prepare(
			`INSERT INTO session_affinity (session_id, device_id, creator_json, established_ms)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(session_id) DO UPDATE SET
				device_id = excluded.device_id,
				creator_json = excluded.creator_json,
				established_ms = excluded.established_ms`,
		)
		.run(sessionId, deviceId, creatorJson ?? null, establishedMs);
	// A device with a live session is by definition not parked. Leaving the
	// stamp would let the idle clock read from a park that has since ended.
	this.clearDeviceParkedAt(deviceId);
}

/**
 * Affinity rows held for a device, with the time each claim was established.
 * `established_ms` is NOT NULL in practice — the schema stamps it on insert and
 * the migration backfills existing rows — so a NULL can only come from a
 * hand-edited database. Reading that as 0 (ancient) is the safe default:
 * reclamation additionally requires the device to not declare the session, so
 * an ancient-looking row for a live session is still never reclaimed.
 */
listSessionAffinityForDevice(
	deviceId: number,
): Array<{ sessionId: string; establishedMs: number }> {
	const rows = this.db
		.prepare(
			"SELECT session_id, established_ms FROM session_affinity WHERE device_id = ? ORDER BY established_ms ASC",
		)
		.all(deviceId) as Array<{ session_id: string; established_ms: number | null }>;
	return rows.map((r) => ({
		sessionId: r.session_id,
		establishedMs: r.established_ms ?? 0,
	}));
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter cyrus-router test:run -- RouterStore`
Expected: PASS, and every pre-existing `RouterStore` test still passes.

- [ ] **Step 7: Commit**

```bash
git add packages/router/src/RouterStore.ts packages/router/test/RouterStore.test.ts
git commit -m "feat(router): stamp established_ms on session affinity rows"
```

---

### Task 2: `sessions_query` / `sessions_report` protocol frames

**Files:**
- Modify: `packages/router-protocol/src/frames.ts`
- Test: `packages/router-protocol/test/frames.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SESSIONS_QUERY_CAPABILITY = "sessions_query"` (exported const)
  - `SessionsQueryFrame = { type: "sessions_query"; id: string }` — server→device
  - `SessionsReportFrame = { type: "sessions_report"; id: string; activeSessions: string[] }` — device→server
  - `HelloFrame` gains `capabilities?: string[]`

- [ ] **Step 1: Write the failing tests**

In `packages/router-protocol/test/frames.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
	PROTOCOL_VERSION,
	SESSIONS_QUERY_CAPABILITY,
	parseDeviceFrame,
	parseServerFrame,
} from "../src/frames.js";

describe("sessions query frames", () => {
	it("parses a sessions_query as a server frame", () => {
		const raw = JSON.stringify({ type: "sessions_query", id: "q-1" });
		expect(parseServerFrame(raw)).toEqual({ type: "sessions_query", id: "q-1" });
	});

	it("parses a sessions_report as a device frame", () => {
		const raw = JSON.stringify({
			type: "sessions_report",
			id: "q-1",
			activeSessions: ["sess-1", "sess-2"],
		});
		expect(parseDeviceFrame(raw)).toEqual({
			type: "sessions_report",
			id: "q-1",
			activeSessions: ["sess-1", "sess-2"],
		});
	});

	it("accepts an empty activeSessions list, distinct from omitting the field", () => {
		const raw = JSON.stringify({
			type: "sessions_report",
			id: "q-1",
			activeSessions: [],
		});
		expect(parseDeviceFrame(raw)).toEqual({
			type: "sessions_report",
			id: "q-1",
			activeSessions: [],
		});
		expect(() =>
			parseDeviceFrame(JSON.stringify({ type: "sessions_report", id: "q-1" })),
		).toThrow();
	});

	it("carries optional capabilities on hello without bumping PROTOCOL_VERSION", () => {
		const withCaps = parseDeviceFrame(
			JSON.stringify({
				type: "hello",
				deviceToken: "t",
				protocolVersion: PROTOCOL_VERSION,
				lastAckedSeq: 0,
				capabilities: [SESSIONS_QUERY_CAPABILITY],
			}),
		);
		expect(withCaps).toMatchObject({ capabilities: ["sessions_query"] });

		// An old worker omits the field entirely and must still parse.
		const withoutCaps = parseDeviceFrame(
			JSON.stringify({
				type: "hello",
				deviceToken: "t",
				protocolVersion: PROTOCOL_VERSION,
				lastAckedSeq: 0,
			}),
		);
		expect(withoutCaps).not.toHaveProperty("capabilities");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter cyrus-router-protocol test:run`
Expected: FAIL — `SESSIONS_QUERY_CAPABILITY` is not exported.

- [ ] **Step 3: Add the capability constant and frames**

In `frames.ts`, add the constant near the other exported constants:

```typescript
/**
 * Advertised in `hello.capabilities` by a device that answers `sessions_query`.
 *
 * NOT a safety mechanism: a device that omits it simply ignores the frame
 * (`RouterConnection.handleMessage` swallows unknown server frames), and the
 * router's query times out into its "can't tell, skip" path. This exists to
 * turn that 5s timeout per old device per sweep tick into an immediate skip.
 */
export const SESSIONS_QUERY_CAPABILITY = "sessions_query";
```

Add `capabilities` to `helloFrame` (after `activeSessions`, ~line 60):

```typescript
	// Feature flags the device supports, e.g. SESSIONS_QUERY_CAPABILITY.
	// Optional and additive: it does NOT bump PROTOCOL_VERSION.
	capabilities: z.array(z.string()).optional(),
```

Add the two frames next to `sessionStateAckFrame` (~line 106):

```typescript
const sessionsQueryFrame = z.object({
	type: z.literal("sessions_query"),
	id: z.string().min(1),
});
const sessionsReportFrame = z.object({
	type: z.literal("sessions_report"),
	id: z.string().min(1),
	// Required, not optional: an ABSENT list means "can't tell" and an EMPTY
	// list means "I am running nothing". Collapsing them would let a malformed
	// reply be read as permission to reclaim every row.
	activeSessions: z.array(z.string()),
});
```

- [ ] **Step 4: Add both to the unions and export the types**

```typescript
const deviceFrame = z.discriminatedUnion("type", [
	helloFrame,
	eventAckFrame,
	rpcRequestFrame,
	sessionStateFrame,
	sessionsReportFrame,
]);
const serverFrame = z.discriminatedUnion("type", [
	helloAckFrame,
	helloErrorFrame,
	eventFrame,
	rpcResponseFrame,
	sessionStateAckFrame,
	sessionsQueryFrame,
]);
```

And with the other type exports:

```typescript
export type SessionsQueryFrame = z.infer<typeof sessionsQueryFrame>;
export type SessionsReportFrame = z.infer<typeof sessionsReportFrame>;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter cyrus-router-protocol test:run && pnpm --filter cyrus-router-protocol typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/router-protocol/src/frames.ts packages/router-protocol/test/frames.test.ts
git commit -m "feat(protocol): add sessions_query/sessions_report and hello capabilities"
```

---

### Task 3: `DeviceGateway.querySessions`

**Files:**
- Modify: `packages/router/src/DeviceGateway.ts` (`SocketState` ~line 17, `handleConnection` close handler ~line 148, `handleMessage` switch ~line 190, `handleHello` ~line 246)
- Test: `packages/router/test/DeviceGateway.test.ts`

**Interfaces:**
- Consumes: `SESSIONS_QUERY_CAPABILITY`, `SessionsReportFrame` from Task 2.
- Produces: `querySessions(deviceId: number, timeoutMs: number): Promise<string[] | undefined>` — resolves to the declared list, or `undefined` for offline / no-capability / timeout.

- [ ] **Step 1: Write the failing tests**

Add to `packages/router/test/DeviceGateway.test.ts`, following the existing harness in that file for starting a gateway and connecting a fake device socket:

```typescript
it("returns the device's declared sessions", async () => {
	// Device connects advertising the capability.
	const ws = await connectDevice({ capabilities: ["sessions_query"] });
	const pending = gateway.querySessions(deviceId, 1_000);

	const query = await nextFrame(ws); // the sessions_query we just sent
	expect(query).toMatchObject({ type: "sessions_query" });
	ws.send(
		JSON.stringify({
			type: "sessions_report",
			id: query.id,
			activeSessions: ["sess-1"],
		}),
	);

	await expect(pending).resolves.toEqual(["sess-1"]);
});

it("distinguishes an empty declared list from no answer", async () => {
	const ws = await connectDevice({ capabilities: ["sessions_query"] });
	const pending = gateway.querySessions(deviceId, 1_000);
	const query = await nextFrame(ws);
	ws.send(
		JSON.stringify({ type: "sessions_report", id: query.id, activeSessions: [] }),
	);
	await expect(pending).resolves.toEqual([]);
});

it("resolves undefined when the device never replies", async () => {
	await connectDevice({ capabilities: ["sessions_query"] });
	await expect(gateway.querySessions(deviceId, 20)).resolves.toBeUndefined();
});

it("resolves undefined without sending anything when the device lacks the capability", async () => {
	const ws = await connectDevice({});
	const sent: unknown[] = [];
	ws.on("message", (raw) => sent.push(JSON.parse(raw.toString())));

	await expect(gateway.querySessions(deviceId, 20)).resolves.toBeUndefined();
	expect(sent.filter((f) => (f as { type: string }).type === "sessions_query")).toEqual([]);
});

it("resolves undefined for an offline device", async () => {
	await expect(gateway.querySessions(9999, 20)).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter cyrus-router test:run -- DeviceGateway`
Expected: FAIL — `gateway.querySessions is not a function`.

- [ ] **Step 3: Track capabilities and pending queries**

In `DeviceGateway.ts`, add the import:

```typescript
import { randomUUID } from "node:crypto";
```

Extend `SocketState` (~line 17):

```typescript
interface SocketState {
	deviceId?: number;
	isAlive: boolean;
	missedHeartbeats: number;
	helloTimer?: NodeJS.Timeout;
	capabilities?: Set<string>;
}
```

Add fields next to `sockets` (~line 38):

```typescript
private readonly capabilities = new Map<number, Set<string>>();
private readonly pendingSessionQueries = new Map<
	string,
	{ resolve: (v: string[] | undefined) => void; timer: NodeJS.Timeout }
>();
```

In `handleHello`, right after `this.sockets.set(deviceId, ws)` (~line 247):

```typescript
state.capabilities = new Set(frame.capabilities ?? []);
this.capabilities.set(deviceId, state.capabilities);
```

In the `ws.on("close")` handler, inside the `if (this.sockets.get(deviceId) === ws)` block (~line 158):

```typescript
this.capabilities.delete(deviceId);
```

- [ ] **Step 4: Implement `querySessions` and handle the reply**

Add the public method next to `sendSessionStateAck` (~line 103):

```typescript
/**
 * Asks a device which sessions it is currently running.
 *
 * Resolves `undefined` — never an empty array — when the device is offline,
 * does not advertise the capability, or fails to answer in time. Callers
 * treat `undefined` as "can't tell, skip" and an empty array as "running
 * nothing". Collapsing the two would let a silent device be read as
 * permission to reclaim its affinity.
 */
async querySessions(
	deviceId: number,
	timeoutMs: number,
): Promise<string[] | undefined> {
	const ws = this.sockets.get(deviceId);
	if (!ws || ws.readyState !== WebSocket.OPEN) return undefined;
	if (!this.capabilities.get(deviceId)?.has(SESSIONS_QUERY_CAPABILITY)) {
		return undefined;
	}

	const id = randomUUID();
	return new Promise<string[] | undefined>((resolve) => {
		const timer = setTimeout(() => {
			this.pendingSessionQueries.delete(id);
			resolve(undefined);
		}, timeoutMs);
		timer.unref?.();
		this.pendingSessionQueries.set(id, { resolve, timer });
		ws.send(JSON.stringify({ type: "sessions_query", id }));
	});
}
```

Add a case to the `handleMessage` switch (~line 198):

```typescript
case "sessions_report": {
	const pending = this.pendingSessionQueries.get(frame.id);
	if (!pending) break; // Late or unsolicited reply — the timeout already won.
	this.pendingSessionQueries.delete(frame.id);
	clearTimeout(pending.timer);
	pending.resolve(frame.activeSessions);
	break;
}
```

In `close()`, before `this.sockets.clear()` (~line 121), settle anything in flight so a shutdown cannot hang a caller:

```typescript
for (const [id, pending] of this.pendingSessionQueries) {
	clearTimeout(pending.timer);
	pending.resolve(undefined);
	this.pendingSessionQueries.delete(id);
}
this.capabilities.clear();
```

Import the capability constant from `cyrus-router-protocol` at the top of the file.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter cyrus-router test:run -- DeviceGateway`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/router/src/DeviceGateway.ts packages/router/test/DeviceGateway.test.ts
git commit -m "feat(router): add DeviceGateway.querySessions"
```

---

### Task 4: `EventRouter.reconcileDeviceAffinity`

Deliberately a **new method**, not an extension of `reconcileDeviceLocks`. That method's device-wide pending-events bail is correct for locks and has tests; affinity needs a per-row grace window instead, which is what fixes the "skipped exactly when a fresh boot needed it" hole.

**Files:**
- Modify: `packages/router/src/EventRouter.ts` (config interfaces ~lines 92 and 142; add the method after `reconcileDeviceLocks`)
- Test: `packages/router/test/EventRouter.test.ts`

**Interfaces:**
- Consumes: `listSessionAffinityForDevice` (Task 1).
- Produces: `reconcileDeviceAffinity(deviceId: number, declared: string[] | undefined, nowMs: number): number` — returns the affinity count remaining after reclamation. Config gains `affinityGraceMs: number`.

- [ ] **Step 1: Write the failing tests**

In `packages/router/test/EventRouter.test.ts`, in a new `describe("EventRouter reconcileDeviceAffinity")` block following the construction pattern used by the existing `reconcileDeviceLocks` describe (~line 1537):

```typescript
it("reclaims an undeclared row older than the grace window", () => {
	// The PAR-146 shape: affinity for a session that already went terminal,
	// with no issue lock, because routePrompted sets affinity without one.
	store.setSessionAffinity("dead-sess", aliceDevice, undefined, 1_000);

	const remaining = router.reconcileDeviceAffinity(aliceDevice, [], 1_000 + GRACE + 1);

	expect(remaining).toBe(0);
	expect(store.countSessionAffinityForDevice(aliceDevice)).toBe(0);
});

it("keeps an undeclared row still inside the grace window", () => {
	// Just routed: the worker has the event queued but has not started
	// tracking the session yet, so it cannot declare it.
	store.setSessionAffinity("fresh-sess", aliceDevice, undefined, 1_000);

	const remaining = router.reconcileDeviceAffinity(aliceDevice, [], 1_000 + GRACE - 1);

	expect(remaining).toBe(1);
	expect(store.countSessionAffinityForDevice(aliceDevice)).toBe(1);
});

it("keeps a declared row no matter how old it is", () => {
	// A session that has legitimately been working for hours.
	store.setSessionAffinity("live-sess", aliceDevice, undefined, 1_000);

	const remaining = router.reconcileDeviceAffinity(
		aliceDevice,
		["live-sess"],
		1_000 + GRACE * 1_000,
	);

	expect(remaining).toBe(1);
	expect(store.countSessionAffinityForDevice(aliceDevice)).toBe(1);
});

it("reclaims nothing when the device declared no list", () => {
	store.setSessionAffinity("dead-sess", aliceDevice, undefined, 1_000);

	const remaining = router.reconcileDeviceAffinity(
		aliceDevice,
		undefined,
		1_000 + GRACE + 1,
	);

	expect(remaining).toBe(1);
	expect(store.countSessionAffinityForDevice(aliceDevice)).toBe(1);
});

it("preserves the creator gate for rows it keeps", () => {
	store.setSessionAffinity("live-sess", aliceDevice, JSON.stringify({ id: "u1" }), 1_000);

	router.reconcileDeviceAffinity(aliceDevice, ["live-sess"], 1_000 + GRACE + 1);

	expect(store.getSessionCreator("live-sess")).toBe(JSON.stringify({ id: "u1" }));
});
```

Define `const GRACE = 600_000;` in the describe and construct the router with `affinityGraceMs: GRACE`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter cyrus-router test:run -- EventRouter`
Expected: FAIL — `router.reconcileDeviceAffinity is not a function`.

- [ ] **Step 3: Add the config field**

In both config interfaces in `EventRouter.ts` (~line 92 and ~line 142) add:

```typescript
	/** An undeclared affinity row younger than this is never reclaimed — it may
	 *  belong to a session the device was routed but has not started tracking. */
	affinityGraceMs: number;
```

- [ ] **Step 4: Implement the method**

Add after `reconcileDeviceLocks`:

```typescript
/**
 * Re-derives a device's affinity set from what the device says it is running,
 * and returns the count that remains.
 *
 * Affinity is written on routing and cleared only by a terminal frame the
 * worker may never send — `routePrompted` re-establishes it for an
 * already-terminal session (deliberately; a Linear agent session outlives its
 * turns), takes no issue lock, and logs nothing when the device is online. If
 * that session never goes terminal again the row is permanent, and
 * `ContainerLifecycle.sweep` skips the device at its affinity gate forever.
 * That is PAR-146: parked correctly, then ran 28+ minutes at 4 vCPU / 8 GiB.
 *
 * Two guards, both required:
 * - `declared === undefined` means the device could not tell us. Reclaiming
 *   would be a guess, so we do nothing.
 * - A row younger than `affinityGraceMs` is kept even when undeclared: it may
 *   have been routed seconds ago with the event still queued, so the device
 *   genuinely cannot declare it yet.
 */
reconcileDeviceAffinity(
	deviceId: number,
	declared: string[] | undefined,
	nowMs: number,
): number {
	const rows = this.store.listSessionAffinityForDevice(deviceId);
	if (declared === undefined) return rows.length;

	const declaredSet = new Set(declared);
	let remaining = 0;
	for (const { sessionId, establishedMs } of rows) {
		if (declaredSet.has(sessionId)) {
			remaining++;
			continue;
		}
		if (nowMs - establishedMs < this.config.affinityGraceMs) {
			remaining++;
			continue;
		}
		this.store.clearSessionAffinity(sessionId);
		this.logger.info(
			`Reclaimed stale affinity for session ${sessionId} on device ${deviceId}: ` +
				`the device does not report it running (established ${nowMs - establishedMs}ms ago, ` +
				`grace ${this.config.affinityGraceMs}ms)`,
		);
	}
	return remaining;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter cyrus-router test:run -- EventRouter`
Expected: PASS, including every existing `reconcileDeviceLocks` test unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/router/src/EventRouter.ts packages/router/test/EventRouter.test.ts
git commit -m "feat(router): reconcile session affinity against device-declared sessions"
```

---

### Task 5: `ContainerLifecycle` reconciles before it skips

The task that actually fixes the bug. **Write the regression test first.**

**Files:**
- Modify: `packages/router/src/ContainerLifecycle.ts`
- Test: `packages/router/test/ContainerLifecycle.test.ts`

**Interfaces:**
- Consumes: `listSessionAffinityForDevice` (Task 1).
- Produces:
  ```typescript
  export interface SessionReconciler {
      /** Reconciles the device's affinity against what it reports running.
       *  Returns the affinity count remaining afterwards. */
      reconcile(deviceId: number): Promise<number>;
      /** True when the router currently holds a live socket for the device. */
      isOnline(deviceId: number): boolean;
  }
  ```
  `ContainerLifecycleOptions` gains `sessionReconciler?: SessionReconciler` and `offlineAgeOutMs: number`.

- [ ] **Step 1: Write the failing regression test**

```typescript
it("idle-stops a parked device pinned only by a leaked affinity row", async () => {
	// PAR-146 (2026-08-02). Session A completed; a later prompt re-established
	// its affinity via routePrompted (affinity without an issue lock, logged
	// nowhere). Session B then parked. The sweep's affinity gate skipped the
	// device forever and it ran 28+ minutes at 4 vCPU / 8 GiB.
	const { deviceId, createdMs } = makeContainerDevice("PAR-146", "aca");
	const aca = fakeExecutor("aca", { status: "running" });
	const idleStopMs = 300_000;
	const now = createdMs + idleStopMs + 60_000;

	store.setSessionAffinity("session-a-complete", deviceId, undefined, createdMs);
	store.setDeviceParkedAt(deviceId, createdMs + 1_000);

	const lifecycle = new ContainerLifecycle({
		store,
		executors: new Map<string, ContainerExecutor>([["aca", aca]]),
		idleStopMs,
		staleDestroyMs: 14 * 24 * 60 * 60_000,
		offlineAgeOutMs: 3_600_000,
		logger,
		now: () => now,
		sessionReconciler: {
			isOnline: () => true,
			// The worker is up and reports it is running nothing.
			reconcile: async (id: number) => {
				store.clearSessionAffinity("session-a-complete");
				expect(id).toBe(deviceId);
				return 0;
			},
		},
	});

	await lifecycle.sweep();

	expect(aca.stop).toHaveBeenCalledWith("PAR-146");
});

it("never stops a device whose worker still declares a session", async () => {
	const { deviceId, createdMs } = makeContainerDevice("PAR-200", "aca");
	const aca = fakeExecutor("aca", { status: "running" });
	const idleStopMs = 300_000;

	store.setSessionAffinity("live", deviceId, undefined, createdMs);

	const lifecycle = new ContainerLifecycle({
		store,
		executors: new Map<string, ContainerExecutor>([["aca", aca]]),
		idleStopMs,
		staleDestroyMs: 14 * 24 * 60 * 60_000,
		offlineAgeOutMs: 3_600_000,
		logger,
		now: () => createdMs + idleStopMs * 100,
		sessionReconciler: { isOnline: () => true, reconcile: async () => 1 },
	});

	await lifecycle.sweep();

	expect(aca.stop).not.toHaveBeenCalled();
});

it("does not reconcile a device that has no affinity at all", async () => {
	const { createdMs } = makeContainerDevice("PAR-201", "aca");
	const aca = fakeExecutor("aca", { status: "running" });
	const reconcile = vi.fn(async () => 0);

	const lifecycle = new ContainerLifecycle({
		store,
		executors: new Map<string, ContainerExecutor>([["aca", aca]]),
		idleStopMs: 300_000,
		staleDestroyMs: 14 * 24 * 60 * 60_000,
		offlineAgeOutMs: 3_600_000,
		logger,
		now: () => createdMs + 300_001,
		sessionReconciler: { isOnline: () => true, reconcile },
	});

	await lifecycle.sweep();

	expect(reconcile).not.toHaveBeenCalled();
	expect(aca.stop).toHaveBeenCalledWith("PAR-201");
});

it("ages out affinity on an offline device so stale-destroy can proceed", async () => {
	const { deviceId, createdMs } = makeContainerDevice("PAR-202", "aca");
	const aca = fakeExecutor("aca", { status: "running" });
	const offlineAgeOutMs = 3_600_000;
	const reconcile = vi.fn(async () => 1);

	store.setSessionAffinity("orphan", deviceId, undefined, createdMs);

	const lifecycle = new ContainerLifecycle({
		store,
		executors: new Map<string, ContainerExecutor>([["aca", aca]]),
		idleStopMs: 300_000,
		staleDestroyMs: 14 * 24 * 60 * 60_000,
		offlineAgeOutMs,
		logger,
		now: () => createdMs + offlineAgeOutMs + 1,
		sessionReconciler: { isOnline: () => false, reconcile },
	});

	await lifecycle.sweep();

	// Never asked — the device is offline.
	expect(reconcile).not.toHaveBeenCalled();
	expect(aca.stop).toHaveBeenCalledWith("PAR-202");
	// The row itself survives; it carries creator_json for a session that may
	// still be legitimately re-prompted.
	expect(store.countSessionAffinityForDevice(deviceId)).toBe(1);
});

it("keeps an offline device pinned while its affinity is still fresh", async () => {
	const { deviceId, createdMs } = makeContainerDevice("PAR-203", "aca");
	const aca = fakeExecutor("aca", { status: "running" });
	const offlineAgeOutMs = 3_600_000;

	store.setSessionAffinity("recent", deviceId, undefined, createdMs);

	const lifecycle = new ContainerLifecycle({
		store,
		executors: new Map<string, ContainerExecutor>([["aca", aca]]),
		idleStopMs: 300_000,
		staleDestroyMs: 14 * 24 * 60 * 60_000,
		offlineAgeOutMs,
		logger,
		now: () => createdMs + offlineAgeOutMs - 1,
		sessionReconciler: { isOnline: () => false, reconcile: async () => 1 },
	});

	await lifecycle.sweep();

	expect(aca.stop).not.toHaveBeenCalled();
});

it("logs once when a device becomes pinned and once when it clears", async () => {
	const { deviceId, createdMs } = makeContainerDevice("PAR-204", "aca");
	const aca = fakeExecutor("aca", { status: "running" });
	let remaining = 1;

	store.setSessionAffinity("held", deviceId, undefined, createdMs);

	const lifecycle = new ContainerLifecycle({
		store,
		executors: new Map<string, ContainerExecutor>([["aca", aca]]),
		idleStopMs: 300_000,
		staleDestroyMs: 14 * 24 * 60 * 60_000,
		offlineAgeOutMs: 3_600_000,
		logger,
		now: () => createdMs + 300_001,
		sessionReconciler: { isOnline: () => true, reconcile: async () => remaining },
	});

	await lifecycle.sweep();
	await lifecycle.sweep(); // still pinned — must NOT log again

	const pinnedLogs = logger.info.mock.calls.filter(([m]) =>
		String(m).includes("pinned out of idle-stop"),
	);
	expect(pinnedLogs).toHaveLength(1);
	expect(String(pinnedLogs[0]?.[0])).toContain("held");

	remaining = 0;
	store.clearSessionAffinity("held");
	await lifecycle.sweep();

	expect(
		logger.info.mock.calls.filter(([m]) =>
			String(m).includes("no longer pinned"),
		),
	).toHaveLength(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter cyrus-router test:run -- ContainerLifecycle`
Expected: FAIL — `offlineAgeOutMs` / `sessionReconciler` are not valid options, and the leaked-affinity device is skipped.

- [ ] **Step 3: Add the seam and options**

At the top of `ContainerLifecycle.ts`:

```typescript
/**
 * Lets the sweep re-derive a device's affinity from the device itself rather
 * than trusting rows that only ever clear on a frame the worker may never
 * send. Injected so the sweep stays unit-testable without a gateway.
 */
export interface SessionReconciler {
	/** Reconciles the device's affinity against what it reports running.
	 *  Returns the affinity count remaining afterwards. */
	reconcile(deviceId: number): Promise<number>;
	/** True when the router currently holds a live socket for the device. */
	isOnline(deviceId: number): boolean;
}
```

Add to `ContainerLifecycleOptions`:

```typescript
	/** Affinity on an OFFLINE device older than this stops blocking the sweep.
	 *  Safe because an offline device is by definition running nothing, so there
	 *  is no live session to freeze. Default: 1 hour. */
	offlineAgeOutMs: number;
	/** Omitted (e.g. in tests) leaves today's behaviour: affinity is trusted as-is. */
	sessionReconciler?: SessionReconciler;
```

And the corresponding private fields plus constructor assignments:

```typescript
private readonly offlineAgeOutMs: number;
private readonly sessionReconciler: SessionReconciler | undefined;
/** Devices already reported as pinned, so the 60s tick logs on transition only. */
private readonly pinnedDevices = new Set<number>();
```

- [ ] **Step 4: Reconcile before the gate**

Replace the opening of the per-row `try` block in `sweep()` (currently `ContainerLifecycle.ts:88-89`):

```typescript
const affinity = await this.resolveAffinity(row.deviceId, now);
if (affinity > 0) {
	this.notePinned(row.deviceId, row.issueKey);
	continue;
}
this.noteUnpinned(row.deviceId);
```

Add the helpers to the class:

```typescript
/**
 * The affinity count the sweep should actually gate on.
 *
 * A raw row count is not trustworthy: `routePrompted` can leave affinity for a
 * session that never goes terminal again, which pins the device out of
 * idle-stop permanently. So we ask the device when we can, and fall back to
 * ageing out rows when we cannot — but only for an OFFLINE device, where there
 * is no live session that ageing out could freeze.
 */
private async resolveAffinity(deviceId: number, now: number): Promise<number> {
	const affinity = this.store.countSessionAffinityForDevice(deviceId);
	if (affinity === 0 || !this.sessionReconciler) return affinity;

	if (this.sessionReconciler.isOnline(deviceId)) {
		return await this.sessionReconciler.reconcile(deviceId);
	}
	return this.store
		.listSessionAffinityForDevice(deviceId)
		.filter((r) => now - r.establishedMs <= this.offlineAgeOutMs).length;
}

private notePinned(deviceId: number, issueKey: string): void {
	if (this.pinnedDevices.has(deviceId)) return;
	this.pinnedDevices.add(deviceId);
	const held = this.store
		.listSessionAffinityForDevice(deviceId)
		.map((r) => r.sessionId)
		.join(", ");
	// Logged ABOVE the gate on purpose. Until now this path returned before the
	// idle-stop diagnostic, so a device pinned out of idle-stop was completely
	// silent — diagnosing PAR-146 meant downloading and querying the blob backup.
	this.logger.info(
		`Container for ${issueKey} (device=${deviceId}) is pinned out of idle-stop ` +
			`by session affinity: ${held || "none"}`,
	);
}

private noteUnpinned(deviceId: number): void {
	if (!this.pinnedDevices.delete(deviceId)) return;
	this.logger.info(`Container device ${deviceId} is no longer pinned by session affinity`);
}
```

The `Idle-stopped container for …` log line already interpolates `affinity=${affinity}`. Because `affinity` is now the value returned by `resolveAffinity`, that line reports the *reconciled* count with no further change — verify this by reading it, and do not re-read the store for the log.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter cyrus-router test:run -- ContainerLifecycle`
Expected: PASS, including all pre-existing sweep tests (they omit `sessionReconciler`, so affinity is trusted as before — but they now need `offlineAgeOutMs` in their options; add `offlineAgeOutMs: 3_600_000` to each).

- [ ] **Step 6: Commit**

```bash
git add packages/router/src/ContainerLifecycle.ts packages/router/test/ContainerLifecycle.test.ts
git commit -m "fix(router): reconcile affinity before the sweep's idle-stop gate"
```

---

### Task 6: Wire it up in `RouterServer` and the CLI config schema

**Files:**
- Modify: `packages/router/src/RouterServer.ts` (defaults ~line 63, `RouterContainersConfig` ~line 130, `EventRouter` construction, `ContainerLifecycle` construction ~line 739, `deviceConnected` handler ~line 532)
- Modify: `apps/cli/src/commands/RouterCommand.ts` (~line 207)
- Test: `packages/router/test/RouterServer.test.ts`

**Interfaces:**
- Consumes: `reconcileDeviceAffinity` (Task 4), `querySessions` (Task 3), `SessionReconciler` (Task 5).
- Produces: config fields `containers.affinityGraceMs`, `containers.offlineAgeOutMs`, `containers.sessionsQueryTimeoutMs`.

- [ ] **Step 1: Write the failing test**

```typescript
it("reconciles affinity when a device connects, alongside lock reconciliation", async () => {
	// Both reconcilers must run: locks and affinity leak independently, and
	// routePrompted produces affinity with NO lock, which the lock reconciler
	// cannot see.
	const server = await startTestRouter({ containers: testContainersConfig });
	const spy = vi.spyOn(server.eventRouter, "reconcileDeviceAffinity");

	server.gateway.emit("deviceConnected", 1, ["sess-live"]);
	await vi.waitFor(() => expect(spy).toHaveBeenCalled());

	expect(spy).toHaveBeenCalledWith(1, ["sess-live"], expect.any(Number));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-router test:run -- RouterServer`
Expected: FAIL — `reconcileDeviceAffinity` is never called.

- [ ] **Step 3: Add defaults and config fields**

In `RouterServer.ts` near `DEFAULT_IDLE_STOP_MS` (~line 63):

```typescript
/** 10 minutes — default {@link RouterContainersConfig.affinityGraceMs}. Must
 *  exceed the worst-case gap between routing a session and the worker starting
 *  to track it (a cold ACA boot is ~60s). */
const DEFAULT_AFFINITY_GRACE_MS = 600_000;
/** 1 hour — default {@link RouterContainersConfig.offlineAgeOutMs}. */
const DEFAULT_OFFLINE_AGE_OUT_MS = 3_600_000;
/** 5 seconds — default {@link RouterContainersConfig.sessionsQueryTimeoutMs},
 *  well inside the 60s sweep tick. */
const DEFAULT_SESSIONS_QUERY_TIMEOUT_MS = 5_000;
```

In `RouterContainersConfig` (~line 130):

```typescript
	/** Default 600_000 (10 minutes). */
	affinityGraceMs?: number;
	/** Default 3_600_000 (1 hour). */
	offlineAgeOutMs?: number;
	/** Default 5_000 (5 seconds). */
	sessionsQueryTimeoutMs?: number;
```

- [ ] **Step 4: Construct the reconciler and pass it through**

Where `EventRouter` is constructed, add:

```typescript
affinityGraceMs: this.config.containers?.affinityGraceMs ?? DEFAULT_AFFINITY_GRACE_MS,
```

Replace the `ContainerLifecycle` construction (~line 739):

```typescript
const sessionsQueryTimeoutMs =
	containers.sessionsQueryTimeoutMs ?? DEFAULT_SESSIONS_QUERY_TIMEOUT_MS;
this.containerLifecycle = new ContainerLifecycle({
	store: this.store,
	executors,
	idleStopMs: containers.idleStopMs ?? DEFAULT_IDLE_STOP_MS,
	staleDestroyMs: containers.staleDestroyMs ?? DEFAULT_STALE_DESTROY_MS,
	offlineAgeOutMs: containers.offlineAgeOutMs ?? DEFAULT_OFFLINE_AGE_OUT_MS,
	logger: this.logger,
	sessionReconciler: {
		isOnline: (deviceId) => this.gateway.isOnline(deviceId),
		reconcile: async (deviceId) => {
			const declared = await this.gateway.querySessions(
				deviceId,
				sessionsQueryTimeoutMs,
			);
			// `undefined` (no answer) flows straight through: reconcileDeviceAffinity
			// treats it as "can't tell" and reclaims nothing.
			return this.eventRouter.reconcileDeviceAffinity(
				deviceId,
				declared,
				Date.now(),
			);
		},
	},
});
```

- [ ] **Step 5: Reconcile affinity on connect too**

In the `deviceConnected` handler (~line 535), alongside the existing `reconcileDeviceLocks` call:

```typescript
try {
	this.eventRouter.reconcileDeviceAffinity(deviceId, activeSessions, Date.now());
} catch (err: unknown) {
	this.logger.warn(
		`reconcileDeviceAffinity failed for device ${deviceId}: ${String(err)}`,
	);
}
```

- [ ] **Step 6: Add the fields to the CLI Zod schema**

In `apps/cli/src/commands/RouterCommand.ts` next to `idleStopMs` (~line 207):

```typescript
			affinityGraceMs: z.number().optional(),
			offlineAgeOutMs: z.number().optional(),
			sessionsQueryTimeoutMs: z.number().optional(),
```

Unmodelled fields are stripped on every `router start`, so omitting this makes the knobs silently unusable in deployment.

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter cyrus-router test:run && pnpm --filter cyrus-ai typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/router/src/RouterServer.ts packages/router/test/RouterServer.test.ts apps/cli/src/commands/RouterCommand.ts
git commit -m "feat(router): wire affinity reconciliation into the sweep and connect paths"
```

---

### Task 7: The worker answers `sessions_query`

**Files:**
- Modify: `packages/router-client/src/RouterConnection.ts` (`sendHello` ~line 420, `handleMessage` switch ~line 527)
- Test: `packages/router-client/test/RouterConnection.test.ts`

**Interfaces:**
- Consumes: `SESSIONS_QUERY_CAPABILITY`, `SessionsQueryFrame` (Task 2); the existing `getActiveSessions?: () => string[]` option (`RouterConnection.ts:73`).
- Produces: no new public API.

- [ ] **Step 1: Write the failing tests**

```typescript
it("advertises the sessions_query capability on hello when a provider is wired", async () => {
	const conn = makeConnection({ getActiveSessions: () => ["s1"] });
	await conn.connect();
	expect(sentFrames[0]).toMatchObject({
		type: "hello",
		capabilities: ["sessions_query"],
	});
});

it("omits the capability when no provider is wired", async () => {
	const conn = makeConnection({});
	await conn.connect();
	expect(sentFrames[0]).not.toHaveProperty("capabilities");
});

it("replies to sessions_query with the live session ids and echoes the id", async () => {
	const conn = makeConnection({ getActiveSessions: () => ["s1", "s2"] });
	await conn.connect();

	server.send(JSON.stringify({ type: "sessions_query", id: "q-7" }));

	await vi.waitFor(() =>
		expect(sentFrames).toContainEqual({
			type: "sessions_report",
			id: "q-7",
			activeSessions: ["s1", "s2"],
		}),
	);
});

it("reports an empty list rather than staying silent when nothing is running", async () => {
	const conn = makeConnection({ getActiveSessions: () => [] });
	await conn.connect();

	server.send(JSON.stringify({ type: "sessions_query", id: "q-8" }));

	await vi.waitFor(() =>
		expect(sentFrames).toContainEqual({
			type: "sessions_report",
			id: "q-8",
			activeSessions: [],
		}),
	);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter cyrus-router-client test:run -- RouterConnection`
Expected: FAIL — no `capabilities` on hello, no reply sent.

- [ ] **Step 3: Advertise the capability**

In `sendHello` (~line 428), extend the spread:

```typescript
		...(this.getActiveSessions
			? {
					activeSessions: this.getActiveSessions(),
					capabilities: [SESSIONS_QUERY_CAPABILITY],
				}
			: {}),
```

Gating both on the same provider is deliberate: without it there is nothing to answer a query with, and advertising would make the router wait 5s per sweep tick for a reply that can never come.

- [ ] **Step 4: Answer the query**

Add a case to the `handleMessage` switch (~line 542):

```typescript
			case "sessions_query":
				this.onSessionsQuery(frame);
				break;
```

And the handler:

```typescript
/**
 * The router asking which sessions we are actually running, so it can reclaim
 * affinity rows nothing backs. Always answers — an empty list is meaningful
 * ("running nothing"), and staying silent would be read as "can't tell" and
 * leave the container pinned.
 */
private onSessionsQuery(frame: SessionsQueryFrame): void {
	const activeSessions = this.getActiveSessions?.() ?? [];
	this.send({ type: "sessions_report", id: frame.id, activeSessions });
}
```

Use whatever the file's existing send helper is (the same one `sendSessionState` uses); do not write to the socket directly.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter cyrus-router-client test:run && pnpm --filter cyrus-router-client typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/router-client/src/RouterConnection.ts packages/router-client/test/RouterConnection.test.ts
git commit -m "feat(router-client): answer sessions_query from the live session set"
```

---

### Task 8: Worker emits terminal for a prompted event it cannot service

Defence in depth. Reconciliation now catches this within a sweep tick regardless, so this stops the row being *created* — it is not what we rely on.

**Files:**
- Modify: `packages/edge-worker/src/EdgeWorker.ts` (`handleNormalPromptedActivity` ~lines 5433-5441)
- Create: `packages/edge-worker/test/EdgeWorker.unserviceable-prompt.test.ts` — model its harness on `packages/edge-worker/test/EdgeWorker.park-on-elicitation.test.ts`, which already builds an EdgeWorker with `platform: "router"` and a stubbed `routerConnection`

**Interfaces:**
- Consumes: the existing `sessionTerminal` emit path (`EdgeWorker.ts:598-602`).
- Produces: no new public API.

- [ ] **Step 1: Write the failing tests**

```typescript
it("signals terminal when a prompted webhook has no issue", async () => {
	const sendSessionState = vi.fn();
	const worker = makeWorker({ platform: "router", sendSessionState });

	await worker.handleAgentSessionPrompted(
		promptedWebhook({ sessionId: "sess-1", issue: undefined }),
	);

	// Without this the router holds affinity for a session no runner will ever
	// finish, and ContainerLifecycle skips the device forever.
	expect(sendSessionState).toHaveBeenCalledWith("sess-1", "error");
});

it("signals terminal when a prompted webhook has no agentActivity", async () => {
	const sendSessionState = vi.fn();
	const worker = makeWorker({ platform: "router", sendSessionState });

	await worker.handleAgentSessionPrompted(
		promptedWebhook({ sessionId: "sess-2", agentActivity: undefined }),
	);

	expect(sendSessionState).toHaveBeenCalledWith("sess-2", "error");
});

it("does not signal terminal when the prompt is serviced normally", async () => {
	const sendSessionState = vi.fn();
	const worker = makeWorker({ platform: "router", sendSessionState });

	await worker.handleAgentSessionPrompted(promptedWebhook({ sessionId: "sess-3" }));

	expect(sendSessionState).not.toHaveBeenCalledWith("sess-3", "error");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter cyrus-edge-worker test:run -- prompted`
Expected: FAIL — nothing is sent on the early-return paths.

- [ ] **Step 3: Emit terminal on the unserviceable paths**

In `handleNormalPromptedActivity`, replace the two bare early returns (~lines 5433-5441):

```typescript
		if (!issue) {
			this.logger.warn("Cannot handle prompted activity without issue");
			this.signalUnserviceablePrompt(sessionId, "missing issue");
			return;
		}

		if (!webhook.agentActivity) {
			this.logger.warn("Cannot handle prompted activity without agentActivity");
			this.signalUnserviceablePrompt(sessionId, "missing agentActivity");
			return;
		}
```

Add the helper near the other router-signalling helpers:

```typescript
/**
 * Releases the router-side claim for a prompted event we cannot service.
 *
 * The router re-establishes session affinity for EVERY prompt, including one
 * for an already-completed session (deliberately — a Linear agent session
 * outlives its turns). If we then drop the event silently, no terminal frame
 * ever follows and that affinity row is permanent, pinning the container out
 * of the idle sweep. Non-fatal: reconciliation is the real backstop.
 */
private signalUnserviceablePrompt(sessionId: string, reason: string): void {
	if (this.config.platform !== "router") return;
	try {
		this.routerConnection?.sendSessionState(sessionId, "error");
		this.logger.warn(
			`Released router claim for unserviceable prompt on session ${sessionId}: ${reason}`,
		);
	} catch (err) {
		this.logger.warn(
			`Failed to release router claim for session ${sessionId}: ${String(err)}`,
		);
	}
}
```

This mirrors the existing `sessionTerminal` listener at `EdgeWorker.ts:598-617`, which guards with `if (this.config.platform !== "router") return;` and wraps `sendSessionState` in try/catch for the same reason.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter cyrus-edge-worker test:run -- prompted`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/edge-worker/src/EdgeWorker.ts packages/edge-worker/test/
git commit -m "fix(edge-worker): release the router claim for unserviceable prompts"
```

---

### Task 9: E2E coverage, changelog, and the deploy-ordering runbook note

**Files:**
- Modify: `packages/router/test/containers-mcp-reconnect.e2e.test.ts`
- Modify: `docs/ROUTER.md`
- Modify: `CHANGELOG.md`, `CHANGELOG.internal.md`

- [ ] **Step 1: Write the E2E case**

Extend the existing park variant in `containers-mcp-reconnect.e2e.test.ts`:

```typescript
it("idle-stops a parked container that a leaked affinity row is pinning", async () => {
	// End-to-end PAR-146: boot → deliver created → a stale affinity row for a
	// session the worker does not track → park → real sweep → suspended.
	await rig.boot();
	await rig.deliverCreated("PAR-146");

	rig.store.setSessionAffinity(
		"leaked-session",
		rig.deviceId,
		undefined,
		rig.now() - 60 * 60_000,
	);

	await rig.parkSession();
	await rig.advanceClock(rig.idleStopMs + 1_000);
	await rig.lifecycle.sweep();

	expect(await rig.executor.status("PAR-146")).toBe("stopped");
	expect(rig.store.countSessionAffinityForDevice(rig.deviceId)).toBe(0);
});
```

- [ ] **Step 2: Run the E2E suite**

Run: `pnpm --filter cyrus-router test:run -- containers-mcp-reconnect`
Expected: PASS.

- [ ] **Step 3: Document deploy ordering**

In `docs/ROUTER.md`, next to the existing park deploy-ordering note:

> **Deploy the router before the worker image.** `sessions_report` is a new
> device→router frame, and `DeviceGateway` closes a socket with
> `1002 invalid frame` on any frame it cannot parse — so a worker that ships
> ahead of the router would have its connection dropped on the first reply. The
> reverse is safe: `RouterConnection` ignores unknown server frames, so a router
> that ships first simply gets no answer and skips reconciliation for that
> device. A worker image bump already forces sandbox replacement via the
> `cyrus.disk` label, so correct ordering falls out of the normal rollout.

- [ ] **Step 4: Update the changelogs**

`CHANGELOG.md` under `## [Unreleased]` → `### Fixed`:

```markdown
- Containers waiting on a question are now suspended reliably. Previously a finished session could leave a stale claim on its container, which kept the container running (and billing) indefinitely even after the agent had parked.
```

`CHANGELOG.internal.md` under `## [Unreleased]` → `### Fixed`:

```markdown
- `ContainerLifecycle.sweep` now reconciles session affinity against the device's declared session set before applying its `affinity > 0` gate, via a new `sessions_query`/`sessions_report` frame pair. Closes the PAR-146 leak: `routePrompted` re-establishes affinity for an already-terminal session without an issue lock and without logging, so a session that never goes terminal again pinned its device out of idle-stop permanently. Offline devices age affinity out after `offlineAgeOutMs` so stale-destroy can proceed. Pinned/unpinned transitions are now logged.
```

- [ ] **Step 5: Full verification**

Run: `pnpm test:packages:run && pnpm typecheck && pnpm build && pnpm lint`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/router/test/containers-mcp-reconnect.e2e.test.ts docs/ROUTER.md CHANGELOG.md CHANGELOG.internal.md
git commit -m "test(router): e2e leaked-affinity idle-stop; document deploy ordering"
```

---

## Post-Deploy Verification

The stale `7b6ab935-c718-4f42-892b-f51f060e8a30` row for device 10 is deliberately left in the live store (see the spec's Operational remediation section). After deploying, confirm the fix reclaims it rather than assuming it did:

```bash
# Should log: Reclaimed stale affinity for session 7b6ab935… on device 10
az containerapp logs show -n app-cyrus-dev-router -g rg-cyrus --tail 300 --format text \
  | grep -i "reclaimed stale affinity"
```

Then confirm the store agrees, using the blob backup:

```bash
az storage blob download --account-name stcyrusdev -c router-backups -n router.db \
  -f /tmp/router.db --overwrite --auth-mode login -o none
sqlite3 -header -column /tmp/router.db "SELECT session_id, device_id FROM session_affinity;"
# Expected: no row for 7b6ab935-c718-4f42-892b-f51f060e8a30
```

The PAR-146 sandbox (`5bce3626-8f9e-4858-ba5c-554e8eaa9a58`) was snapshotted and
stopped on 2026-08-02 at 04:05Z (snapshot `fe124297-2687-472b-9a36-934d2ceccef8`),
so it will resume on the next prompt via the normal wake path with its blocked
elicitation intact.
