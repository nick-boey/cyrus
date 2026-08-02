# Parked Sessions and 5-Minute Idle Suspend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Suspend an ACA sandbox idle for more than 5 minutes — including while its agent is blocked on a user elicitation — without ever suspending one that still has work in flight.

**Architecture:** Introduce a non-terminal `parked` session state. The worker decides *whether* it is safe to suspend (it alone sees elicitation state and live background tasks) and tells the router over the existing durable `session_state` frame; the router decides *how long is too long* via `idleStopMs`. The affinity gate in `ContainerLifecycle` is unchanged — we change what counts as a live session, not the gate.

**Tech Stack:** TypeScript, pnpm workspaces, vitest, better-sqlite3, zod, `@anthropic-ai/claude-agent-sdk` 0.3.220.

**Spec:** `docs/superpowers/specs/2026-08-02-parked-sessions-idle-suspend-design.md`

## Global Constraints

- `PROTOCOL_VERSION` in `packages/router-protocol/src/frames.ts` MUST NOT be bumped. The change is additive; bumping would reject older workers.
- Deploy order is load-bearing: **router first, worker image second**. An old router cannot parse `parked` and would drop the device connection.
- `liveBackgroundTasks` on `AgentPendingWork` MUST be optional (`?`). Making it required breaks existing runner fakes in `packages/edge-worker/test/AgentSessionManager.stop-session.test.ts:257,296`.
- Park/unpark signalling MUST be non-fatal on error and guarded by `platform === "router"`. A failed park is a missed cost saving, never a correctness failure.
- A `parked` frame MUST NOT release the issue lock. Only affinity.
- Never park when any pending work exists (crons, Stop-hook background tasks, or live background tasks).
- Run `pnpm lint` before each commit; the repo uses biome and a pre-commit hook that runs a full build + typecheck.

---

### Task 1: Live background-task tracking in ClaudeRunner

The SDK emits `system` / `background_tasks_changed` whenever background-task membership changes. It is a **level** signal carrying the full live set — replace, never merge. This closes the mid-turn blind spot: `pendingBackgroundTasks` comes only from the Stop hook and is reset at query start, so mid-turn it is always empty.

**Files:**
- Modify: `packages/core/src/agent-runner-types.ts:43-52` (add `LiveBackgroundTask`, extend `AgentPendingWork`)
- Modify: `packages/core/src/index.ts` (export the new type)
- Modify: `packages/claude-runner/src/ClaudeRunner.ts:276` (field), `:468` (reset), `~:820` (message loop), `:1020` (`getPendingWork`), `:1031` (`hasPendingWork`)
- Test: `packages/claude-runner/test/pending-work-lifecycle.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `LiveBackgroundTask { taskId: string; taskType: string; description: string }` exported from `cyrus-core`; `AgentPendingWork.liveBackgroundTasks?: LiveBackgroundTask[]`; `ClaudeRunner.hasPendingWork(): boolean` now also true when live tasks exist.

- [ ] **Step 1: Write the failing tests**

Add to `packages/claude-runner/test/pending-work-lifecycle.test.ts`. Follow the existing file's mock idiom (SDK mocked at module level, messages emitted through the fake query).

```typescript
function makeBackgroundTasksChanged(
	tasks: { task_id: string; task_type: string; description: string }[],
): SDKMessage {
	return {
		type: "system",
		subtype: "background_tasks_changed",
		tasks,
		session_id: "claude-session-1",
		uuid: "uuid-bg-1",
	} as unknown as SDKMessage;
}

describe("live background tasks", () => {
	it("records the live set from background_tasks_changed", async () => {
		const runner = makeRunner();
		await startRunnerWithMessages(runner, [
			makeSystemInit(),
			makeBackgroundTasksChanged([
				{ task_id: "t1", task_type: "bash", description: "pnpm build" },
			]),
		]);

		expect(runner.getPendingWork().liveBackgroundTasks).toEqual([
			{ taskId: "t1", taskType: "bash", description: "pnpm build" },
		]);
		expect(runner.hasPendingWork()).toBe(true);
	});

	it("replaces rather than merges the live set", async () => {
		const runner = makeRunner();
		await startRunnerWithMessages(runner, [
			makeSystemInit(),
			makeBackgroundTasksChanged([
				{ task_id: "t1", task_type: "bash", description: "pnpm build" },
				{ task_id: "t2", task_type: "agent", description: "review" },
			]),
			makeBackgroundTasksChanged([
				{ task_id: "t2", task_type: "agent", description: "review" },
			]),
		]);

		expect(runner.getPendingWork().liveBackgroundTasks).toEqual([
			{ taskId: "t2", taskType: "agent", description: "review" },
		]);
	});

	it("reports no pending work once the live set empties", async () => {
		const runner = makeRunner();
		await startRunnerWithMessages(runner, [
			makeSystemInit(),
			makeBackgroundTasksChanged([
				{ task_id: "t1", task_type: "bash", description: "pnpm build" },
			]),
			makeBackgroundTasksChanged([]),
		]);

		expect(runner.getPendingWork().liveBackgroundTasks).toEqual([]);
		expect(runner.hasPendingWork()).toBe(false);
	});
});
```

Reuse the file's existing helpers for `makeRunner()` and driving the mock query. If the existing file names them differently, adapt these three tests to that idiom rather than introducing a second one.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter cyrus-claude-runner test -- pending-work-lifecycle`
Expected: FAIL — `liveBackgroundTasks` is undefined on the returned object.

- [ ] **Step 3: Add the core type**

In `packages/core/src/agent-runner-types.ts`, directly above `AgentPendingWork`:

```typescript
/**
 * A background task currently live inside the CLI process, from the SDK's
 * `background_tasks_changed` level signal. Distinct from the Stop hook's
 * `BackgroundTaskSummary`: this one is observable MID-turn, which is what
 * makes it usable as a "safe to suspend?" predicate while the agent is
 * blocked on an elicitation.
 */
export interface LiveBackgroundTask {
	taskId: string;
	taskType: string;
	description: string;
}
```

Then extend `AgentPendingWork` (keep the existing two fields unchanged):

```typescript
	/**
	 * Live background work as of the last `background_tasks_changed` signal.
	 * Optional: runners predating the signal omit it, and an absent value
	 * means "unknown", which callers treat as empty.
	 */
	liveBackgroundTasks?: LiveBackgroundTask[];
```

Export `LiveBackgroundTask` from `packages/core/src/index.ts` alongside `BackgroundTaskSummary`.

- [ ] **Step 4: Implement in ClaudeRunner**

Add the import to the existing `cyrus-core` type import block, add the field beside `pendingBackgroundTasks` (`ClaudeRunner.ts:276`):

```typescript
	/**
	 * Live background tasks, keyed by task id. REPLACE semantics — the SDK
	 * emits the full set on every membership change, so merging would leak
	 * completed tasks and wedge `hasPendingWork()` on forever.
	 */
	private liveBackgroundTasks = new Map<string, LiveBackgroundTask>();
```

In the query-start reset block (`ClaudeRunner.ts:468`, beside the two existing resets):

```typescript
		// The level signal is per-CLI-process and nothing is emitted at startup,
		// so a set carried across a restart would block suspends forever.
		this.liveBackgroundTasks.clear();
```

In the message loop, immediately before `this.processMessage(message)`:

```typescript
				if (
					message.type === "system" &&
					message.subtype === "background_tasks_changed"
				) {
					this.liveBackgroundTasks = new Map(
						message.tasks.map((task) => [
							task.task_id,
							{
								taskId: task.task_id,
								taskType: task.task_type,
								description: task.description,
							},
						]),
					);
					this.logger.event("live_background_tasks_changed", {
						liveBackgroundTaskCount: this.liveBackgroundTasks.size,
						claudeSessionId: this.sessionInfo?.sessionId,
					});
				}
```

Update `getPendingWork()` (`:1020`):

```typescript
	getPendingWork(): AgentPendingWork {
		return {
			sessionCrons: [...this.pendingSessionCrons],
			backgroundTasks: [...this.pendingBackgroundTasks],
			liveBackgroundTasks: [...this.liveBackgroundTasks.values()],
		};
	}
```

Update `hasPendingWork()` (`:1031`):

```typescript
	hasPendingWork(): boolean {
		return (
			this.pendingSessionCrons.length > 0 ||
			this.pendingBackgroundTasks.length > 0 ||
			this.liveBackgroundTasks.size > 0
		);
	}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter cyrus-claude-runner test -- pending-work-lifecycle`
Expected: PASS, including the pre-existing tests in the file.

⚠️ This widens `hasPendingWork()`, which also feeds the existing terminal-deferral at `ClaudeRunner.ts:842`. Turns will now be held open for background tasks the Stop hook never reported. Confirm the whole file still passes, not just the new block.

- [ ] **Step 6: Run the full runner suite**

Run: `pnpm --filter cyrus-claude-runner test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/agent-runner-types.ts packages/core/src/index.ts \
  packages/claude-runner/src/ClaudeRunner.ts \
  packages/claude-runner/test/pending-work-lifecycle.test.ts
git commit -m "feat(runner): track live background tasks from the SDK level signal"
```

---

### Task 2: Add `parked` to the session_state protocol

**Files:**
- Modify: `packages/router-protocol/src/frames.ts:76-82`
- Modify: `packages/router-client/src/RouterConnection.ts:125-129` (`SessionStateEntry`), `:336` (`sendSessionState`)
- Test: `packages/router-client/test/RouterConnection.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SessionStateFrame["state"]` includes `"parked"`; `RouterConnection.sendSessionState(sessionId: string, state: "complete" | "error" | "stopped" | "parked"): void`.

- [ ] **Step 1: Write the failing test**

Add to `packages/router-client/test/RouterConnection.test.ts`:

```typescript
it("sends a parked session_state frame and buffers it until acked", async () => {
	const { connection, sent } = await connectedHarness();

	connection.sendSessionState("session-1", "parked");

	const frame = JSON.parse(sent.at(-1)!);
	expect(frame).toMatchObject({
		type: "session_state",
		sessionId: "session-1",
		state: "parked",
	});
	expect(frame.id).toEqual(expect.any(String));
});

it("supersedes an unacked parked frame with a later terminal frame", async () => {
	const { connection, sent } = await connectedHarness();

	connection.sendSessionState("session-1", "parked");
	connection.sendSessionState("session-1", "complete");

	connection.replayForTest();
	const replayed = sent.filter((raw) => JSON.parse(raw).sessionId === "session-1");
	const states = replayed.map((raw) => JSON.parse(raw).state);
	expect(states.at(-1)).toBe("complete");
	expect(states.filter((s) => s === "parked")).toHaveLength(1);
});
```

Use the file's existing harness helper rather than `connectedHarness`/`replayForTest` if it names them differently — the assertions are the point, not the helper names.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-router-client test -- RouterConnection`
Expected: FAIL — TypeScript rejects `"parked"` as an argument.

- [ ] **Step 3: Widen the frame schema**

`packages/router-protocol/src/frames.ts`, in `sessionStateFrame`:

```typescript
	// `parked` is NON-TERMINAL: the session is blocked on the user, not
	// finished. The router releases session affinity for it but KEEPS the
	// issue lock. Additive — PROTOCOL_VERSION is deliberately not bumped, so
	// an older worker simply never sends it. Deploy the router BEFORE the
	// worker image: an older router cannot parse this value.
	state: z.enum(["complete", "error", "stopped", "parked"]),
```

- [ ] **Step 4: Widen the client**

In `packages/router-client/src/RouterConnection.ts`, update `SessionStateEntry.state` and the `sendSessionState` parameter to `"complete" | "error" | "stopped" | "parked"`. No other logic changes — the durable append, per-session supersede compaction (`:798`), replay, and ack removal all already key on `sessionId` and are agnostic to the value.

Update the `sendSessionState` doc comment to note that a `parked` frame releases affinity only, so losing one costs a suspend rather than stranding an issue.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter cyrus-router-client test -- RouterConnection`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/router-protocol/src/frames.ts \
  packages/router-client/src/RouterConnection.ts \
  packages/router-client/test/RouterConnection.test.ts
git commit -m "feat(protocol): add non-terminal parked session_state"
```

---

### Task 3: Persist `parked_at_ms` on the container device row

**Files:**
- Modify: `packages/router/src/RouterStore.ts:15-25` (SCHEMA `devices`), `:317` (`migrate`), `:125-156` (row/info types), `:247` (`toContainerDeviceInfo`), `:718` (`listContainerDevices`), `:1203` (`setSessionAffinity`)
- Test: `packages/router/test/RouterStore.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ContainerDeviceInfo.parkedAtMs?: number`; `RouterStore.setDeviceParkedAt(deviceId: number, parkedAtMs: number): void`; `RouterStore.clearDeviceParkedAt(deviceId: number): void`.

- [ ] **Step 1: Write the failing test**

Add to `packages/router/test/RouterStore.test.ts` (follow the file's existing store-construction helper):

```typescript
describe("parked_at_ms", () => {
	it("round-trips through listContainerDevices", () => {
		const store = makeStore();
		const { userId } = store.addUser({ email: "a@b.c" });
		const { deviceId } = store.addContainerDevice({
			userId,
			issueKey: "PAR-1",
			provider: "aca",
		});

		store.setDeviceParkedAt(deviceId, 1_700_000_000_000);

		const row = store.listContainerDevices().find((d) => d.deviceId === deviceId);
		expect(row?.parkedAtMs).toBe(1_700_000_000_000);
	});

	it("clears on clearDeviceParkedAt", () => {
		const store = makeStore();
		const { userId } = store.addUser({ email: "a@b.c" });
		const { deviceId } = store.addContainerDevice({
			userId,
			issueKey: "PAR-2",
			provider: "aca",
		});

		store.setDeviceParkedAt(deviceId, 1_700_000_000_000);
		store.clearDeviceParkedAt(deviceId);

		const row = store.listContainerDevices().find((d) => d.deviceId === deviceId);
		expect(row?.parkedAtMs).toBeUndefined();
	});

	it("clears when affinity is re-established for the device", () => {
		const store = makeStore();
		const { userId } = store.addUser({ email: "a@b.c" });
		const { deviceId } = store.addContainerDevice({
			userId,
			issueKey: "PAR-3",
			provider: "aca",
		});

		store.setDeviceParkedAt(deviceId, 1_700_000_000_000);
		store.setSessionAffinity("session-1", deviceId);

		const row = store.listContainerDevices().find((d) => d.deviceId === deviceId);
		expect(row?.parkedAtMs).toBeUndefined();
	});
});
```

Match `addContainerDevice`'s real signature from the store — if it differs, use whatever the file's other container-device tests use.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-router test -- RouterStore`
Expected: FAIL — `setDeviceParkedAt` is not a function.

- [ ] **Step 3: Add the column and migration**

In `SCHEMA`, add to the `devices` table after `last_routed_ms`:

```sql
  parked_at_ms INTEGER
```

In `migrate()`, after the existing `entra_object_id` check, using the same `PRAGMA table_info` idiom:

```typescript
		// `deviceCols` is snapshotted before the v1->v2 rebuild above, so re-read
		// it here: the rebuild creates the table without parked_at_ms.
		const deviceColsAfter = this.db
			.prepare("PRAGMA table_info(devices)")
			.all() as Array<{ name: string }>;
		if (
			deviceColsAfter.length > 0 &&
			!deviceColsAfter.some((c) => c.name === "parked_at_ms")
		) {
			this.db.exec("ALTER TABLE devices ADD COLUMN parked_at_ms INTEGER");
		}
```

- [ ] **Step 4: Thread it through the types and reads**

Add `parked_at_ms: number | null` to `DeviceRow` and `ContainerDeviceRow`; add `parkedAtMs?: number` to `ContainerDeviceInfo`; add `parkedAtMs: row.parked_at_ms ?? undefined` to `toContainerDeviceInfo`; add `parked_at_ms` to the `SELECT` in `listContainerDevices`.

- [ ] **Step 5: Add the writers**

```typescript
	/**
	 * Stamp when a session on this device parked (blocked on the user). Read by
	 * ContainerLifecycle as the idle clock, so an agent that worked for a long
	 * time before asking a question isn't suspended on the very next sweep.
	 */
	setDeviceParkedAt(deviceId: number, parkedAtMs: number): void {
		this.db
			.prepare("UPDATE devices SET parked_at_ms = ? WHERE device_id = ?")
			.run(parkedAtMs, deviceId);
	}

	clearDeviceParkedAt(deviceId: number): void {
		this.db
			.prepare("UPDATE devices SET parked_at_ms = NULL WHERE device_id = ?")
			.run(deviceId);
	}
```

In `setSessionAffinity`, after the existing INSERT, clear the stamp — a device with live affinity is by definition not parked:

```typescript
		this.clearDeviceParkedAt(deviceId);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter cyrus-router test -- RouterStore`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/router/src/RouterStore.ts packages/router/test/RouterStore.test.ts
git commit -m "feat(router): persist parked_at_ms on container device rows"
```

---

### Task 4: Handle `parked` in EventRouter

**Files:**
- Modify: `packages/router/src/EventRouter.ts:346-360` (`handleSessionState`)
- Test: `packages/router/test/EventRouter.test.ts`

**Interfaces:**
- Consumes: `SessionStateFrame["state"]` includes `"parked"` (Task 2); `RouterStore.setDeviceParkedAt` (Task 3).
- Produces: `handleSessionState` releases affinity only for `parked`.

- [ ] **Step 1: Write the failing test**

```typescript
describe("parked session state", () => {
	it("releases affinity but keeps the issue lock", () => {
		const { router, store, deviceId } = makeRouterHarness();
		store.setSessionAffinity("session-1", deviceId);
		store.acquireIssueLock("issue-1", "session-1", deviceId);

		router.handleSessionState(deviceId, {
			type: "session_state",
			id: "frame-1",
			sessionId: "session-1",
			state: "parked",
		});

		expect(store.getSessionAffinity("session-1")).toBeUndefined();
		expect(store.getIssueLockSessionId("issue-1")).toBe("session-1");
	});

	it("stamps parkedAtMs on the device", () => {
		const { router, store, deviceId } = makeRouterHarness({ now: () => 5_000 });
		store.setSessionAffinity("session-1", deviceId);

		router.handleSessionState(deviceId, {
			type: "session_state",
			id: "frame-1",
			sessionId: "session-1",
			state: "parked",
		});

		const row = store.listContainerDevices().find((d) => d.deviceId === deviceId);
		expect(row?.parkedAtMs).toBe(5_000);
	});

	it("still releases the lock for terminal states", () => {
		const { router, store, deviceId } = makeRouterHarness();
		store.setSessionAffinity("session-1", deviceId);
		store.acquireIssueLock("issue-1", "session-1", deviceId);

		router.handleSessionState(deviceId, {
			type: "session_state",
			id: "frame-1",
			sessionId: "session-1",
			state: "complete",
		});

		expect(store.getSessionAffinity("session-1")).toBeUndefined();
		expect(store.getIssueLockSessionId("issue-1")).toBeUndefined();
	});
});
```

Use the file's existing harness and lock-inspection helpers; if `getIssueLockSessionId` does not exist, assert via whatever accessor the existing lock tests use.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-router test -- EventRouter`
Expected: FAIL — the parked frame releases the issue lock too.

- [ ] **Step 3: Split handleSessionState**

Replace the body of `handleSessionState` (`EventRouter.ts:351`):

```typescript
	/**
	 * Applies a `session_state` frame.
	 *
	 * Terminal states (complete / error / stopped) release both the issue lock
	 * and session affinity, and forget the session's in-memory bookkeeping.
	 *
	 * `parked` is NOT terminal: the session is blocked on a user answer with no
	 * work in flight. It releases session affinity ONLY — which is what lets
	 * ContainerLifecycle idle-stop the container — while keeping the issue lock
	 * so no other session claims the issue mid-conversation, and keeping the
	 * workspace/notified bookkeeping the session still needs when it resumes.
	 */
	handleSessionState(deviceId: number, frame: SessionStateFrame): void {
		if (frame.state === "parked") {
			this.store.clearSessionAffinity(frame.sessionId);
			this.store.setDeviceParkedAt(deviceId, this.now());
			this.logger.info(
				`Session ${frame.sessionId} parked on device ${deviceId}; released affinity, retained the issue lock`,
			);
			return;
		}
		this.store.releaseIssueLockForSession(frame.sessionId);
		this.store.clearSessionAffinity(frame.sessionId);
		this.notifiedSessions.delete(frame.sessionId);
		this.sessionWorkspace.delete(frame.sessionId);
		this.logger.info(
			`Session ${frame.sessionId} reached terminal state '${frame.state}' on device ${deviceId}; released lock and affinity`,
		);
	}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter cyrus-router test -- EventRouter`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/router/src/EventRouter.ts packages/router/test/EventRouter.test.ts
git commit -m "feat(router): release affinity only for parked sessions"
```

---

### Task 5: Use `parkedAtMs` as the idle clock and drop the default to 5 minutes

**Files:**
- Modify: `packages/router/src/ContainerLifecycle.ts:108-128`
- Modify: `packages/router/src/RouterServer.ts:62-63` (`DEFAULT_IDLE_STOP_MS`)
- Test: `packages/router/test/ContainerLifecycle.test.ts`

**Interfaces:**
- Consumes: `ContainerDeviceInfo.parkedAtMs` (Task 3).
- Produces: no new exports; behaviour change only.

- [ ] **Step 1: Write the failing test**

```typescript
it("measures idle from parkedAtMs, not lastRoutedMs", async () => {
	const now = 20 * 60_000;
	const { lifecycle, executor } = makeLifecycle({
		idleStopMs: 300_000,
		now: () => now,
		devices: [
			{
				deviceId: 1,
				issueKey: "PAR-146",
				provider: "aca",
				createdMs: 0,
				// Routed 20 minutes ago — the agent then worked for 18 of them and
				// parked 2 minutes ago. It must NOT be stopped yet.
				lastRoutedMs: 0,
				parkedAtMs: now - 120_000,
			},
		],
	});

	await lifecycle.sweep();

	expect(executor.stop).not.toHaveBeenCalled();
});

it("stops a device parked longer than idleStopMs", async () => {
	const now = 20 * 60_000;
	const { lifecycle, executor } = makeLifecycle({
		idleStopMs: 300_000,
		now: () => now,
		devices: [
			{
				deviceId: 1,
				issueKey: "PAR-146",
				provider: "aca",
				createdMs: 0,
				lastRoutedMs: 0,
				parkedAtMs: now - 360_000,
			},
		],
	});

	await lifecycle.sweep();

	expect(executor.stop).toHaveBeenCalledWith("PAR-146");
});

it("never stops a device that still holds affinity", async () => {
	const now = 20 * 60_000;
	const { lifecycle, executor } = makeLifecycle({
		idleStopMs: 300_000,
		now: () => now,
		affinityByDevice: { 1: 1 },
		devices: [
			{
				deviceId: 1,
				issueKey: "PAR-146",
				provider: "aca",
				createdMs: 0,
				lastRoutedMs: 0,
				parkedAtMs: now - 360_000,
			},
		],
	});

	await lifecycle.sweep();

	expect(executor.stop).not.toHaveBeenCalled();
});
```

Extend the file's existing fake-store helper to accept `parkedAtMs` and `affinityByDevice`; do not build a second harness.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter cyrus-router test -- ContainerLifecycle`
Expected: FAIL — the first test stops the container, because the clock is still `lastRoutedMs`.

- [ ] **Step 3: Update the idle clock**

In `ContainerLifecycle.sweep`, replace the `idleSince` computation (`:108`):

```typescript
					// `parkedAtMs` is when a session on this device blocked on the
					// user. Without it the clock is `lastRoutedMs`, so an agent that
					// worked for 20 minutes and then asked a question would be
					// suspended on the very next tick — the clock having expired
					// while it was legitimately busy.
					const idleSince = Math.max(
						row.lastRoutedMs ?? 0,
						row.parkedAtMs ?? 0,
						row.createdMs,
					);
```

Add `parkedAtMs` to the existing idle-stop log line so the decision stays diagnosable from one line:

```typescript
								`lastRoutedMs=${row.lastRoutedMs ?? "none"} ` +
								`parkedAtMs=${row.parkedAtMs ?? "none"} ` +
```

Note the stale-destroy branch above already uses its own `lastTouch`; leave it alone. A parked device is still touched for staleness purposes by `createdMs`/`lastSeenMs`, and its 14-day backstop is unchanged.

- [ ] **Step 4: Drop the default idle threshold**

`packages/router/src/RouterServer.ts:62`:

```typescript
/** 5 minutes — default {@link RouterContainersConfig.idleStopMs}. */
const DEFAULT_IDLE_STOP_MS = 300_000;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter cyrus-router test -- ContainerLifecycle`
Expected: PASS.

- [ ] **Step 6: Run the full router suite**

Run: `pnpm --filter cyrus-router test`
Expected: PASS. The existing `ContainerLifecycle.test.ts` cases pass `idleStopMs: 900_000` explicitly to the constructor (`:77`, `:105`, `:134`, `:158`) so they are unaffected by the default change — leave them alone. Only a test that asserts `DEFAULT_IDLE_STOP_MS` itself, or constructs a `RouterServer` without `idleStopMs` and asserts the resolved value, needs updating to 300_000. That is the intended change, not a regression.

- [ ] **Step 7: Commit**

```bash
git add packages/router/src/ContainerLifecycle.ts packages/router/src/RouterServer.ts \
  packages/router/test/ContainerLifecycle.test.ts
git commit -m "feat(router): idle-stop from parkedAtMs and default to 5 minutes"
```

---

### Task 6: Park/unpark events on AgentSessionManager

**Files:**
- Modify: `packages/edge-worker/src/AgentSessionManager.ts:44-62` (events type), `:522-535` (`getRunnerPendingWork`)
- Test: `packages/edge-worker/test/AgentSessionManager.pending-work.test.ts`

**Interfaces:**
- Consumes: `AgentPendingWork.liveBackgroundTasks` (Task 1).
- Produces: events `sessionParked: (sessionId: string) => void` and `sessionUnparked: (sessionId: string) => void`; method `AgentSessionManager.hasPendingWork(sessionId: string): boolean`.

- [ ] **Step 1: Write the failing test**

```typescript
describe("hasPendingWork", () => {
	it("is true when only live background tasks exist", () => {
		const manager = makeManagerWithRunner({
			sessionCrons: [],
			backgroundTasks: [],
			liveBackgroundTasks: [
				{ taskId: "t1", taskType: "bash", description: "pnpm build" },
			],
		});
		expect(manager.hasPendingWork("session-1")).toBe(true);
	});

	it("is false when every pending-work source is empty", () => {
		const manager = makeManagerWithRunner({
			sessionCrons: [],
			backgroundTasks: [],
			liveBackgroundTasks: [],
		});
		expect(manager.hasPendingWork("session-1")).toBe(false);
	});

	it("is false when the runner does not report pending work at all", () => {
		const manager = makeManagerWithRunner(undefined);
		expect(manager.hasPendingWork("session-1")).toBe(false);
	});
});
```

Reuse the file's existing fake-runner factory (it already takes a `pendingWork` argument at `:134`).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-edge-worker test -- AgentSessionManager.pending-work`
Expected: FAIL — `hasPendingWork` is not a function.

- [ ] **Step 3: Add the events**

In `AgentSessionManagerEvents`, after `sessionResumed`:

```typescript
	/**
	 * Emitted when a session blocks on a user answer with no work in flight.
	 * Router platform mode listens for this to send a non-terminal `parked`
	 * frame, which releases session affinity so the container can be
	 * idle-suspended while it waits.
	 */
	sessionParked: (sessionId: string) => void;
	/**
	 * Emitted when a parked session stops waiting — answered, cancelled, or
	 * aborted. Router platform mode listens for this to drop any still-unacked
	 * `parked` frame, so a later reconnect cannot replay it over a live turn.
	 */
	sessionUnparked: (sessionId: string) => void;
```

- [ ] **Step 4: Add the predicate**

Update `getRunnerPendingWork` to count live tasks, and expose a public predicate:

```typescript
	private getRunnerPendingWork(sessionId: string): AgentPendingWork | null {
		const runner = this.sessions.get(sessionId)?.agentRunner;
		if (!runner?.getPendingWork) return null;
		const pendingWork = runner.getPendingWork();
		return pendingWork.sessionCrons.length > 0 ||
			pendingWork.backgroundTasks.length > 0 ||
			(pendingWork.liveBackgroundTasks?.length ?? 0) > 0
			? pendingWork
			: null;
	}

	/**
	 * Whether the session has any work that will wake it later. Used as the
	 * "safe to park?" gate: a session blocked on the user with a background
	 * build still running must NOT be parked, because suspending the container
	 * would freeze that build.
	 */
	hasPendingWork(sessionId: string): boolean {
		return this.getRunnerPendingWork(sessionId) !== null;
	}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter cyrus-edge-worker test -- AgentSessionManager.pending-work`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/edge-worker/src/AgentSessionManager.ts \
  packages/edge-worker/test/AgentSessionManager.pending-work.test.ts
git commit -m "feat(edge-worker): add park/unpark events and a pending-work predicate"
```

---

### Task 7: Park while blocked on AskUserQuestion

**Files:**
- Modify: `packages/edge-worker/src/EdgeWorker.ts:552-575` (listeners), `:7128-7143` (`createAskUserQuestionCallback`)
- Test: `packages/edge-worker/test/EdgeWorker.park-on-elicitation.test.ts` (create)

**Interfaces:**
- Consumes: `sessionParked`/`sessionUnparked` and `hasPendingWork` (Task 6); `sendSessionState(..., "parked")` (Task 2).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Create `packages/edge-worker/test/EdgeWorker.park-on-elicitation.test.ts`. Mirror the mocking style of the existing `EdgeWorker.*.test.ts` files.

```typescript
import { describe, expect, it, vi } from "vitest";

describe("park on elicitation", () => {
	it("parks before awaiting the answer when nothing is pending", async () => {
		const { worker, routerConnection, resolveQuestion } =
			await makeWorkerAwaitingQuestion({ pendingWork: false });

		expect(routerConnection.sendSessionState).toHaveBeenCalledWith(
			"session-1",
			"parked",
		);

		resolveQuestion("CSV only");
		await vi.waitFor(() =>
			expect(routerConnection.discardBufferedSessionState).toHaveBeenCalledWith(
				"session-1",
			),
		);
	});

	it("does not park while background work is in flight", async () => {
		const { routerConnection } = await makeWorkerAwaitingQuestion({
			pendingWork: true,
		});

		expect(routerConnection.sendSessionState).not.toHaveBeenCalledWith(
			"session-1",
			"parked",
		);
	});

	it("unparks even when the question handler throws", async () => {
		const { routerConnection, rejectQuestion } =
			await makeWorkerAwaitingQuestion({ pendingWork: false });

		rejectQuestion(new Error("boom"));
		await vi.waitFor(() =>
			expect(routerConnection.discardBufferedSessionState).toHaveBeenCalledWith(
				"session-1",
			),
		);
	});
});
```

Write `makeWorkerAwaitingQuestion` in the test file: construct an `EdgeWorker` with `platform: "router"`, a mocked `routerConnection` exposing `sendSessionState` and `discardBufferedSessionState` as `vi.fn()`, an `agentSessionManager` whose `hasPendingWork` returns the flag, then invoke the callback returned by `createAskUserQuestionCallback` and hand back resolvers for the elicitation promise.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-edge-worker test -- EdgeWorker.park-on-elicitation`
Expected: FAIL — `sendSessionState` is never called with `"parked"`.

- [ ] **Step 3: Wire the listeners**

In `EdgeWorker`, beside the existing `sessionTerminal` / `sessionResumed` listeners (`:538` and `:554`):

```typescript
		// Router mode: a session blocked on a user answer releases its device so
		// the container can be idle-suspended while it waits. Non-fatal — a
		// failed park costs a suspend, never correctness.
		this.agentSessionManager.on("sessionParked", (sessionId: string) => {
			if (this.config.platform !== "router") return;
			try {
				this.routerConnection?.sendSessionState(sessionId, "parked");
			} catch (error) {
				this.logger.error(
					`Failed to signal parked state for session ${sessionId}; its container will stay up until the next transition`,
					error,
				);
			}
		});

		// The counterpart. Terminal-frame durability cuts both ways: replaying a
		// stale `parked` on a later reconnect would clear the affinity a live
		// turn is posting under — the same hazard `sessionResumed` guards.
		this.agentSessionManager.on("sessionUnparked", (sessionId: string) => {
			if (this.config.platform !== "router") return;
			try {
				this.routerConnection?.discardBufferedSessionState(sessionId);
			} catch (error) {
				this.logger.error(
					`Failed to discard the buffered parked frame for session ${sessionId}`,
					error,
				);
			}
		});
```

- [ ] **Step 4: Wrap the elicitation callback**

Replace the body of `createAskUserQuestionCallback` (`:7129`):

```typescript
		return async (input, _sessionId, signal) => {
			// Park only when nothing will wake this session on its own. With a
			// background build in flight, suspending the container would freeze
			// it, so we hold the device instead (spec decision 2).
			const canPark = !this.agentSessionManager.hasPendingWork(
				linearAgentSessionId,
			);
			if (canPark) {
				this.agentSessionManager.emit("sessionParked", linearAgentSessionId);
			}
			try {
				return await this.askUserQuestionHandler.handleAskUserQuestion(
					input,
					linearAgentSessionId,
					organizationId,
					signal,
				);
			} finally {
				if (canPark) {
					this.agentSessionManager.emit(
						"sessionUnparked",
						linearAgentSessionId,
					);
				}
			}
		};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter cyrus-edge-worker test -- EdgeWorker.park-on-elicitation`
Expected: PASS.

- [ ] **Step 6: Run the full edge-worker suite**

Run: `pnpm --filter cyrus-edge-worker test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/edge-worker/src/EdgeWorker.ts \
  packages/edge-worker/test/EdgeWorker.park-on-elicitation.test.ts
git commit -m "feat(edge-worker): park the session while blocked on AskUserQuestion"
```

---

### Task 8: Park while awaiting repository selection

A different mechanism from Task 7: `RepositoryRouter.elicitUserRepositorySelection` stores a pending selection in a map and **returns** — there is no blocking promise and no runner yet. So there is no pending work to check, and parking is unconditionally safe.

**Files:**
- Modify: `packages/edge-worker/src/RepositoryRouter.ts:626` (park after storing), `:730` (unpark on response)
- Modify: `packages/edge-worker/src/EdgeWorker.ts` (pass an `onSessionParked`/`onSessionUnparked` callback pair into `RepositoryRouter` deps)
- Test: `packages/edge-worker/test/RepositoryRouter.test.ts`

**Interfaces:**
- Consumes: the `sessionParked`/`sessionUnparked` emit path from Task 7.
- Produces: `RepositoryRouterDeps.onSessionParked?: (agentSessionId: string) => void` and `onSessionUnparked?: (agentSessionId: string) => void`.

- [ ] **Step 1: Write the failing test**

```typescript
it("parks the session after posting the repository elicitation", async () => {
	const onSessionParked = vi.fn();
	const router = makeRepositoryRouter({ onSessionParked });

	await router.elicitUserRepositorySelection(createdWebhook, [repoA, repoB]);

	expect(onSessionParked).toHaveBeenCalledWith(createdWebhook.agentSession.id);
});

it("unparks when the selection is resolved", async () => {
	const onSessionUnparked = vi.fn();
	const router = makeRepositoryRouter({ onSessionUnparked });
	await router.elicitUserRepositorySelection(createdWebhook, [repoA, repoB]);

	await router.selectRepositoryFromResponse(
		createdWebhook.agentSession.id,
		repoA.name,
	);

	expect(onSessionUnparked).toHaveBeenCalledWith(createdWebhook.agentSession.id);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-edge-worker test -- RepositoryRouter`
Expected: FAIL — the callbacks are never invoked.

- [ ] **Step 3: Add the deps and calls**

Add both optional callbacks to `RepositoryRouterDeps`. In `elicitUserRepositorySelection`, call `this.deps.onSessionParked?.(agentSessionId)` **after** the elicitation activity has been posted successfully — parking before the post would release the device while the post could still fail, leaving nothing to wake it.

In `selectRepositoryFromResponse`, call `this.deps.onSessionUnparked?.(agentSessionId)` immediately after `this.pendingSelections.delete(agentSessionId)`.

Also call it on the early-return path where `pendingData` is missing? No — if there was no pending selection, this session was never parked by this path. Leave that branch alone.

- [ ] **Step 4: Wire from EdgeWorker**

Where `RepositoryRouter` is constructed, pass:

```typescript
			onSessionParked: (agentSessionId: string) =>
				this.agentSessionManager.emit("sessionParked", agentSessionId),
			onSessionUnparked: (agentSessionId: string) =>
				this.agentSessionManager.emit("sessionUnparked", agentSessionId),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter cyrus-edge-worker test -- RepositoryRouter`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/edge-worker/src/RepositoryRouter.ts packages/edge-worker/src/EdgeWorker.ts \
  packages/edge-worker/test/RepositoryRouter.test.ts
git commit -m "feat(edge-worker): park the session while awaiting repository selection"
```

---

### Task 9: End-to-end park → suspend → resume, plus deploy config

**Files:**
- Modify: `packages/router/test/containers-mcp-reconnect.e2e.test.ts`
- Modify: `docker/worker/README.md:80-81,151-152` (document the new default and `parked`)
- Modify: `infra/azure/README.md` (deploy-ordering note)
- Modify: `infra/azure/terraform/` — add `idleStopMs: 300000` to the `CYRUS_ROUTER_CONTAINERS_JSON` the router app receives

**Interfaces:**
- Consumes: everything from Tasks 1-8.
- Produces: no new exports.

- [ ] **Step 1: Write the failing E2E test**

Add to `containers-mcp-reconnect.e2e.test.ts`, reusing its existing `DeviceStack` rig and real `RouterServer` + real `ContainerLifecycle.sweep()`:

```typescript
it("parks, idle-stops, and resumes with the pending question intact", async () => {
	const stack = await bootDeviceStack({ issueKey: "PAR-146" });

	// Turn 1 blocks on an elicitation with no pending work.
	stack.device.sendSessionState("session-1", "parked");
	await vi.waitFor(() =>
		expect(stack.store.getSessionAffinity("session-1")).toBeUndefined(),
	);

	// The real sweep stops it once past idleStopMs.
	stack.clock.advance(6 * 60_000);
	await stack.lifecycle.sweep();
	expect(stack.executor.stop).toHaveBeenCalledWith("PAR-146");

	// The user's reply routes back to the same device and resumes it.
	await stack.router.routePrompted(promptedFixture({ sessionId: "session-1" }));
	await vi.waitFor(() =>
		expect(stack.executor.ensureRunning).toHaveBeenCalled(),
	);
	expect(stack.store.getSessionAffinity("session-1")).toBe(stack.deviceId);
});
```

Adapt the helper names to whatever the file already defines — `promptedFixture` and `DeviceStack` exist there today.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-router test -- containers-mcp-reconnect`
Expected: FAIL before Tasks 1-8 land; PASS after. If run last, confirm it passes and that no other case in the file regressed.

- [ ] **Step 3: Set the deployed threshold explicitly**

Add `"idleStopMs": 300000` to the containers JSON in the Terraform that renders `CYRUS_ROUTER_CONTAINERS_JSON`. Do not rely on the new default alone — the deployed config should state the value it depends on.

- [ ] **Step 4: Document**

In `docker/worker/README.md`, update the `idleStopMs` row to `300000` (5 min) and add a line describing `parked`: a session blocked on a user answer with no pending work releases affinity, so its container is idle-stopped on the normal schedule.

In `infra/azure/README.md`, add to the deploy runbook: **deploy the router before bumping the worker image** — an older router rejects the `parked` frame and would drop the device connection.

- [ ] **Step 5: Full verification**

```bash
pnpm lint
pnpm typecheck
pnpm test
```
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/router/test/containers-mcp-reconnect.e2e.test.ts \
  docker/worker/README.md infra/azure/README.md infra/azure/terraform/
git commit -m "test(router): e2e park-suspend-resume; set idleStopMs to 5 minutes"
```

---

## Manual verification after deploy

1. Deploy the router, confirm it starts and existing workers stay connected.
2. Build and repin the worker image; confirm sandboxes are replaced (the `cyrus.disk` label changes).
3. Drive an issue to an `AskUserQuestion` elicitation.
4. Confirm the router logs `Session … parked on device …; released affinity, retained the issue lock`.
5. Within ~6 minutes confirm `Idle-stopped container for …` and that the ACA sandbox reports `Suspended` with a snapshot.
6. Answer the question in Linear; confirm the sandbox resumes and the agent continues the same turn rather than restarting it.
7. Repeat with a background task in flight (`Bash` with `run_in_background`) and confirm the container is **not** parked or stopped.
