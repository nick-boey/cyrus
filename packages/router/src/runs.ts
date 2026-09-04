import type {
	AgentRunObservation,
	AgentRunsResponse,
	ExecutorKindV1,
	ExecutorStateV1,
	RunInputV1,
	RunLifecycleStateV1,
	RunWaitV1,
} from "cyrus-operator-protocol";
import type { FastifyInstance } from "fastify";
import type {
	AgentRunInfo,
	AgentRunRouting,
	RouterStore,
} from "./RouterStore.js";
import type { SandboxGaugeState } from "./SandboxTelemetry.js";

const ISSUE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * The wire shape of this route now lives in `cyrus-operator-protocol` so the
 * CLI can consume it without importing a router implementation module. It is
 * re-exported here so existing importers of `cyrus-router` keep working, and
 * `toLegacyObservation` below is annotated with it — which is what makes a
 * drift between the router's own unions and the published contract a compile
 * error rather than a silent wire change.
 */
export type { AgentRunObservation, AgentRunsResponse };

/**
 * Everything the router knows about one run, with the corrected run-vs-executor
 * semantics: a worker-reported {@link RunLifecycleStateV1} that has no `parked`
 * in it, the wait that is the evidence for `waiting`, and the sampled executor
 * state kept separately as infrastructure state.
 *
 * This is the INTERNAL shape, deliberately not `RunObservationV1`. The v1
 * contract requires `issueId`, `runner`, and a full `routing` snapshot, and a
 * run routed before the CYR-68 migration has none of them — so rendering one as
 * v1 would fail validation and drop the run from the fleet view entirely. That
 * is the constraint `runObservationV1Schema`'s own doc comment hands to whoever
 * adds `/api/v1/runs`: scope the route to runs routed after the migration, or
 * backfill. Until then this type carries the same facts with the pre-migration
 * gaps expressed honestly as `undefined`, and both the legacy route below and
 * that future route render from it rather than from raw rows.
 */
export interface RunObservation {
	runId: string;
	agentSessionId: string;
	issueKey: string;
	issueId?: string;
	routing: AgentRunRouting;
	runner?: string;
	model?: string;
	executorKind: ExecutorKindV1;
	provider?: string;
	lifecycle: RunLifecycleStateV1;
	/** Present exactly when `lifecycle` is `waiting`. Never inferred. */
	wait?: RunWaitV1;
	/** Absent on a run that has ended: it cannot carry live background work. */
	pendingWorkCount?: number;
	inputs: RunInputV1[];
	lastPublishedActivityAt?: string;
	startedAt: string;
	lastRoutedAt: string;
	endedAt?: string;
	/** Query-time evidence, not a health verdict. */
	worker: { online: boolean; lastHeartbeatAt?: string };
	/** Infrastructure state of the machine, never worker-process liveness. */
	executorState?: ExecutorStateV1;
	executorStateObservedAt?: string;
	revision: number;
}

export interface RegisterRunsRouteOptions {
	isDeviceOnline(deviceId: number): boolean;
	getSandboxObservation?(
		deviceId: number,
	): { state: SandboxGaugeState; observedMs: number } | undefined;
	now?: () => number;
}

/** Device-token-authenticated, owner-scoped run observations. */
export function registerRunsRoute(
	fastify: FastifyInstance,
	store: RouterStore,
	options: RegisterRunsRouteOptions,
): void {
	fastify.get<{
		Querystring: { issueKey?: string; commentId?: string; since?: string };
	}>("/runs", async (request, reply) => {
		const token = parseBearerToken(request.headers.authorization);
		const device = token ? store.getDeviceByToken(token) : undefined;
		if (!device) {
			return reply.status(401).send({ error: "unauthorized" });
		}
		const deviceInfo = store.getDeviceInfo(device.deviceId);
		if (!deviceInfo) {
			return reply.status(401).send({ error: "unauthorized" });
		}
		if (deviceInfo.kind === "container" && !deviceInfo.issueKey) {
			return reply.status(403).send({ error: "forbidden" });
		}

		const issueKey = singleQueryValue(request.query.issueKey);
		const commentId = singleQueryValue(request.query.commentId);
		const since = singleQueryValue(request.query.since);
		if (request.query.issueKey !== undefined && issueKey === undefined) {
			return reply.status(400).send({ error: "invalid issueKey" });
		}
		if (issueKey !== undefined && !ISSUE_KEY_RE.test(issueKey)) {
			return reply.status(400).send({ error: "invalid issueKey" });
		}
		if (request.query.commentId !== undefined && !commentId) {
			return reply.status(400).send({ error: "invalid commentId" });
		}

		let sinceMs: number | undefined;
		if (since !== undefined) {
			sinceMs = Date.parse(since);
			if (!Number.isFinite(sinceMs)) {
				return reply.status(400).send({ error: "invalid since timestamp" });
			}
		} else if (request.query.since !== undefined) {
			return reply.status(400).send({ error: "invalid since timestamp" });
		}

		if (
			deviceInfo.kind === "container" &&
			issueKey !== undefined &&
			issueKey.toLowerCase() !== deviceInfo.issueKey?.toLowerCase()
		) {
			return reply.status(403).send({ error: "forbidden" });
		}

		const runs = store.listAgentRuns({
			userId: device.userId,
			...(deviceInfo.kind === "container"
				? { issueKey: deviceInfo.issueKey }
				: issueKey
					? { issueKey }
					: {}),
			...(commentId ? { commentId } : {}),
			...(sinceMs !== undefined ? { sinceMs } : {}),
		});
		const now = options.now?.() ?? Date.now();
		const response: AgentRunsResponse = {
			observedAt: iso(now),
			runs: runs.map((run) => toLegacyObservation(observeRun(run, options))),
		};
		return reply.status(200).send(response);
	});
}

/**
 * Projects a stored run into the corrected internal observation.
 *
 * Exported because it is the single place run-vs-executor semantics are
 * decided: every consumer — this route's legacy mapping, and the future
 * `/api/v1/runs` — renders from its output rather than re-deriving the
 * distinction from raw columns.
 */
export function observeRun(
	run: AgentRunInfo,
	options: RegisterRunsRouteOptions,
): RunObservation {
	const sandbox = options.getSandboxObservation?.(run.deviceId);
	return {
		runId: run.runId,
		agentSessionId: run.sessionId,
		issueKey: run.issueKey,
		...(run.issueId !== undefined ? { issueId: run.issueId } : {}),
		routing: run.routing,
		...(run.runner !== undefined ? { runner: run.runner } : {}),
		...(run.model !== undefined ? { model: run.model } : {}),
		executorKind: run.executorKind,
		...(run.provider ? { provider: run.provider } : {}),
		lifecycle: run.state,
		...(run.wait
			? {
					wait: {
						reason: run.wait.reason,
						since: iso(run.wait.sinceMs),
						...(run.wait.reportedCondition
							? { reportedCondition: run.wait.reportedCondition }
							: {}),
					},
				}
			: {}),
		// Pending work belongs to a run that can still resume. A run that has
		// ENDED cannot be carrying live background work, and the store clears the
		// column on every terminal transition — this is the second guard, so a row
		// that predates that clearing cannot produce a contradictory observation.
		...(run.pendingWorkCount !== undefined && run.endedMs === undefined
			? { pendingWorkCount: run.pendingWorkCount }
			: {}),
		inputs: run.inputs.map(({ activityId, commentId, routedMs }) => ({
			...(activityId ? { activityId } : {}),
			...(commentId ? { commentId } : {}),
			routedAt: iso(routedMs),
		})),
		...(run.lastAgentActivityMs !== undefined
			? { lastPublishedActivityAt: iso(run.lastAgentActivityMs) }
			: {}),
		startedAt: iso(run.startedMs),
		lastRoutedAt: iso(run.lastRoutedMs),
		...(run.endedMs !== undefined ? { endedAt: iso(run.endedMs) } : {}),
		worker: {
			online: options.isDeviceOnline(run.deviceId),
			...(run.lastHeartbeatMs !== undefined
				? { lastHeartbeatAt: iso(run.lastHeartbeatMs) }
				: {}),
		},
		// Only a container has a sampled executor state: park applies to a
		// container, and a physical device is not something the router samples.
		...(run.executorKind === "container"
			? {
					executorState: sandbox?.state ?? "unknown",
					// A sample with no observation time cannot be aged, so the two
					// travel together. `unknown` with no time is the honest reading of
					// "never sampled", not a stale gauge presented as current.
					...(sandbox
						? { executorStateObservedAt: iso(sandbox.observedMs) }
						: {}),
				}
			: {}),
		revision: run.revision,
	};
}

/**
 * Renders the corrected observation back into the UNVERSIONED shape this route
 * has always served.
 *
 * `waiting` maps to the legacy `parked`, which is the same mapping read
 * backwards: the old state name meant "blocked on a user answer", and every
 * existing client reads it that way. The wait's reason, the pending-work count,
 * the routing snapshot, the runner and the revision are all dropped — this
 * shape is frozen, and new facts belong on the v1 observation and its own
 * route.
 */
function toLegacyObservation(run: RunObservation): AgentRunObservation {
	return {
		runId: run.runId,
		issueKey: run.issueKey,
		sessionId: run.agentSessionId,
		state: run.lifecycle === "waiting" ? "parked" : run.lifecycle,
		startedAt: run.startedAt,
		lastRoutedAt: run.lastRoutedAt,
		...(run.lastPublishedActivityAt !== undefined
			? { lastAgentActivityAt: run.lastPublishedActivityAt }
			: {}),
		...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
		inputs: run.inputs,
		executorKind: run.executorKind,
		...(run.provider ? { provider: run.provider } : {}),
		workerOnline: run.worker.online,
		...(run.worker.lastHeartbeatAt !== undefined
			? { lastHeartbeatAt: run.worker.lastHeartbeatAt }
			: {}),
		...(run.executorState !== undefined
			? { sandboxState: run.executorState }
			: {}),
		...(run.executorStateObservedAt !== undefined
			? { sandboxStateObservedAt: run.executorStateObservedAt }
			: {}),
	};
}

function parseBearerToken(header: string | undefined): string | undefined {
	const match = header?.match(/^Bearer ([^\s]+)$/);
	return match?.[1];
}

function singleQueryValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}
