import type { FastifyInstance } from "fastify";
import type {
	AgentRunInfo,
	AgentRunInput,
	AgentRunState,
	RouterStore,
} from "./RouterStore.js";
import type { SandboxGaugeState } from "./SandboxTelemetry.js";

const ISSUE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface AgentRunObservation {
	runId: string;
	issueKey: string;
	sessionId: string;
	state: AgentRunState;
	startedAt: string;
	lastRoutedAt: string;
	lastAgentActivityAt?: string;
	endedAt?: string;
	inputs: Array<Omit<AgentRunInput, "routedMs"> & { routedAt: string }>;
	executorKind: "device" | "container";
	provider?: string;
	workerOnline: boolean;
	lastHeartbeatAt?: string;
	sandboxState?: SandboxGaugeState;
	sandboxStateObservedAt?: string;
}

export interface AgentRunsResponse {
	observedAt: string;
	runs: AgentRunObservation[];
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
			runs: runs.map((run) => observeRun(run, options)),
		};
		return reply.status(200).send(response);
	});
}

function observeRun(
	run: AgentRunInfo,
	options: RegisterRunsRouteOptions,
): AgentRunObservation {
	const sandbox = options.getSandboxObservation?.(run.deviceId);
	return {
		runId: run.runId,
		issueKey: run.issueKey,
		sessionId: run.sessionId,
		state: run.state,
		startedAt: iso(run.startedMs),
		lastRoutedAt: iso(run.lastRoutedMs),
		...(run.lastAgentActivityMs !== undefined
			? { lastAgentActivityAt: iso(run.lastAgentActivityMs) }
			: {}),
		...(run.endedMs !== undefined ? { endedAt: iso(run.endedMs) } : {}),
		inputs: run.inputs.map(({ activityId, commentId, routedMs }) => ({
			...(activityId ? { activityId } : {}),
			...(commentId ? { commentId } : {}),
			routedAt: iso(routedMs),
		})),
		executorKind: run.executorKind,
		...(run.provider ? { provider: run.provider } : {}),
		workerOnline: options.isDeviceOnline(run.deviceId),
		...(run.lastHeartbeatMs !== undefined
			? { lastHeartbeatAt: iso(run.lastHeartbeatMs) }
			: {}),
		...(run.executorKind === "container"
			? {
					sandboxState: sandbox?.state ?? "unknown",
					...(sandbox
						? { sandboxStateObservedAt: iso(sandbox.observedMs) }
						: {}),
				}
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
