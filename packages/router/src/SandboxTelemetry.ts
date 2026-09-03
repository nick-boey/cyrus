import {
	cyrusAttributes,
	type ILogger,
	type LogEventAttributes,
} from "cyrus-core";

/**
 * The sandbox lifecycle event vocabulary.
 *
 * Shares the naming scheme of the cross-package vocabulary in
 * `cyrus-core`'s `CYRUS_EVENTS` (`webhook.received`, `session.started`, …):
 * dotted lowercase, domain segment first, emitted through {@link ILogger.event}
 * so they reach the structured stream. `debug`/`info` are deliberately never
 * forwarded (see `Logger.debug`'s comment), so anything an operator needs to
 * query — in particular the per-tick gauge — MUST go through `event()`.
 *
 * Lives here rather than in `CYRUS_EVENTS` because nothing outside the router
 * can emit one: a sandbox is a router-side concept and `packages/core` is
 * depended on by every runner and the CLI.
 *
 * Every name is prefixed `sandbox.` so one KQL predicate
 * (`event startswith "sandbox."`) selects the whole family.
 *
 * The lifecycle these names describe:
 *
 * ```
 *   boot_started ──► running ──► parked ⇄ unparked
 *        │             │  ▲            │
 *        ▼             │  └────────────┘
 *   boot_failed        ▼
 *                  idle_stopped ──► (next route) boot_started
 *                      │  │
 *                      │  └──► stranded_session   (invariant violation)
 *                      ▼
 *   teardown_completed / destroyed
 * ```
 */
export const SANDBOX_EVENTS = {
	/** The router asked a provider to boot or resume an issue's sandbox. */
	bootStarted: "sandbox.boot_started",
	/** The provider reported the sandbox running. INFRASTRUCTURE state only —
	 *  the worker process still has to dial back over WSS. */
	running: "sandbox.running",
	/** `ensureRunning` rejected. Pairs with `bootStarted`: a `bootStarted` with
	 *  neither a `running` nor a `boot_failed` is a provider call that hung. */
	bootFailed: "sandbox.boot_failed",
	/** A session on the sandbox blocked on a user answer; affinity released. */
	parked: "sandbox.parked",
	/** A park was reversed — the agent went back to work; affinity restored. */
	unparked: "sandbox.unparked",
	/** The lifecycle sweep stopped an affinity-free sandbox past `idleStopMs`. */
	idleStopped: "sandbox.idle_stopped",
	/**
	 * The router holds session affinity for a sandbox that is not making progress
	 * on it. `cyrus.reason` says which of two shapes:
	 *
	 *  - `offline_pinned` — the sandbox is not running and its worker is not
	 *    connected. Structurally impossible, and how NOR-366 turned a 38-second
	 *    race into a nine-hour outage.
	 *  - `no_progress` — nothing routed to it and nothing posted by it for
	 *    {@link ContainerLifecycleOptions.sessionNoProgressMs}. Looks entirely
	 *    healthy from every other angle, which is why CAN-133 held an issue
	 *    unreachable for 5h17m while reporting `running`/`online` (NOR-402).
	 *
	 * Either way Linear shows a live agent session the whole time, so this is
	 * invisible from every other angle.
	 *
	 * Emitted once per sweep tick for as long as it holds, so an alert rule can
	 * key on a non-zero count in its window. Deliberately NOT emitted during the
	 * cold-boot window, when `offline_pinned`'s three facts are the expected state
	 * of a container that was just routed to and has not dialled back yet.
	 */
	strandedSession: "sandbox.stranded_session",
	/** The sandbox (and its disk/volume) was destroyed. `reason` says why. */
	destroyed: "sandbox.destroyed",
	/** A terminal teardown finished: worker cleaned up and the row was deleted. */
	teardownCompleted: "sandbox.teardown_completed",
	/** Per-sandbox gauge sample, one per sandbox per lifecycle sweep tick. */
	gauge: "sandbox.gauge",
	/** Per-tick rollup of the gauge samples: how many sandboxes are open. */
	sweepCompleted: "sandbox.sweep_completed",
} as const;

export type SandboxEventName =
	(typeof SANDBOX_EVENTS)[keyof typeof SANDBOX_EVENTS];

/** Why a sandbox was destroyed. Kept closed so a KQL `summarize by reason` has
 *  a bounded set of values. */
export type SandboxDestroyReason =
	| "stale"
	| "orphan"
	| "terminal_teardown"
	| "provider_switch";

/**
 * The subset of a container device row every sandbox event carries, so an
 * operator can join a lifecycle transition to the gauge series without
 * remembering which events happen to include which identifiers.
 */
export interface SandboxIdentity {
	issueKey: string;
	/**
	 * Absent only for an orphan — a container a provider still owns with no
	 * device row at all, which is exactly what makes it an orphan. Emitted as
	 * `null` rather than dropped so a KQL `where isnull(device_id)` finds them.
	 */
	deviceId?: number;
	provider: string;
}

function identityAttributes(id: SandboxIdentity): LogEventAttributes {
	return {
		issue_key: id.issueKey,
		device_id: id.deviceId ?? null,
		provider: id.provider,
	};
}

/**
 * Emit one sandbox lifecycle event.
 *
 * Attribute keys stay flat (Log Analytics projects each into its own dynamic
 * column) but live under the `cyrus.*` namespace, so a query reads
 * `where p["cyrus.issue_key"] == "NOR-279"` without parsing the message and
 * without risking a collision with a future OTel standard attribute.
 */
export function emitSandboxEvent(
	logger: ILogger,
	name: SandboxEventName,
	identity: SandboxIdentity,
	attributes?: LogEventAttributes,
): void {
	logger.event(
		name,
		cyrusAttributes({ ...identityAttributes(identity), ...attributes }),
	);
}

/**
 * The state a sandbox is in, as reported by its provider, normalised across
 * providers. `unknown` is emitted rather than omitted when the provider could
 * not be listed this tick — a missing sample and an unreadable one are
 * different operational facts, and only one of them warrants paging someone.
 */
export type SandboxGaugeState = "running" | "stopped" | "absent" | "unknown";

/**
 * One gauge sample. Deliberately carries BOTH the provider's infrastructure
 * state and the router's own liveness view (`online` / `last_seen_age_ms`),
 * because per our documented invariant ACA reports `Running` for a sandbox
 * whose entrypoint has exited — an alert on `state` alone fires on a zombie or
 * misses a hung worker. Any alert on long-running sandboxes must combine them.
 */
export interface SandboxGaugeSample extends SandboxIdentity {
	state: SandboxGaugeState;
	/** Live session-affinity rows held by this device after reconciliation. */
	sessions: number;
	/** True when the router currently holds a live WSS socket for the device. */
	online: boolean;
	/** Continuous time running, from `devices.running_since_ms`. Undefined when
	 *  the sandbox is not running. */
	uptimeMs?: number;
	/** Device-row age, from `devices.created_ms`. Survives stop/resume, so it is
	 *  NOT uptime — it answers "how long has this issue had a sandbox". */
	ageMs: number;
	/** Time since the worker's last heartbeat. Undefined if it never connected. */
	lastSeenAgeMs?: number;
	/** Time since a session on this device parked. Undefined when not parked. */
	parkedForMs?: number;
	/** Time since the router last routed an event to this device. */
	lastRoutedAgeMs?: number;
}

export function emitSandboxGauge(
	logger: ILogger,
	sample: SandboxGaugeSample,
): void {
	emitSandboxEvent(logger, SANDBOX_EVENTS.gauge, sample, {
		state: sample.state,
		sessions: sample.sessions,
		online: sample.online,
		age_ms: sample.ageMs,
		uptime_ms: sample.uptimeMs ?? null,
		last_seen_age_ms: sample.lastSeenAgeMs ?? null,
		parked_for_ms: sample.parkedForMs ?? null,
		last_routed_age_ms: sample.lastRoutedAgeMs ?? null,
	});
}
