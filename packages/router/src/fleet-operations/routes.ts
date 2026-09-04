import type { ILogger } from "cyrus-core";
import type { FastifyInstance, FastifyReply } from "fastify";
import { type FleetOperations, FleetQueryError } from "./FleetOperations.js";
import {
	OperatorAuthError,
	type OperatorAuthorizer,
} from "./OperatorAuthorizer.js";
import { RunCursorError } from "./RunChangeCursor.js";
import type { OperatorPrincipal } from "./types.js";

/** Where a client discovers a Cyrus router's operator interface. */
export const DISCOVERY_ROUTE = "/.well-known/cyrus";
/** The authenticated operator's own view of its authority. */
export const OPERATOR_CONTEXT_ROUTE = "/api/v1/operator/context";
/** Workspace-authorized, paginated run snapshots. */
export const RUNS_ROUTE = "/api/v1/runs";
/** The durable, ordered feed of material run changes. */
export const RUN_CHANGES_ROUTE = "/api/v1/run-changes";

export interface FleetOperationsRoutesOptions {
	fleet: FleetOperations;
	authorizer: OperatorAuthorizer;
	logger?: ILogger;
}

/**
 * Registers the two Fleet Operations routes.
 *
 * Deliberately thin: every authorization decision belongs to
 * {@link OperatorAuthorizer} and every document to {@link FleetOperations}, so
 * a later route added here inherits both rather than reimplementing either.
 *
 * Must be called BEFORE `RouterServer.start()` — Fastify v5 refuses new routes
 * once the server is listening. Nothing about `/enroll`, `/workspaces`, or
 * `/runs` is touched: those keep their own device-token handling exactly as it
 * is today.
 */
export function registerFleetOperationsRoutes(
	fastify: FastifyInstance,
	options: FleetOperationsRoutesOptions,
): void {
	const { fleet, authorizer, logger } = options;

	// The router's ONLY unauthenticated surface. It answers "what is this and
	// how do I authenticate to it", and nothing that would answer "what is
	// running on it".
	//
	// Wrapped even though `describe()` is validated at construction and cannot
	// realistically throw here: Fastify has no error handler installed on this
	// instance, so an uncaught throw is rendered by its DEFAULT handler, which
	// puts the error's message in the response body. A strict-schema violation
	// would then report the offending key to an anonymous caller — turning the
	// control that exists to prevent a disclosure into the disclosure.
	fastify.get(DISCOVERY_ROUTE, async (_request, reply) => {
		try {
			return reply.status(200).send(fleet.describe());
		} catch (error) {
			logger?.error("Could not build the router discovery document", error);
			return reply.status(500).send({ error: "internal error" });
		}
	});

	fastify.get(OPERATOR_CONTEXT_ROUTE, async (request, reply) => {
		let principal: Awaited<ReturnType<OperatorAuthorizer["authenticate"]>>;
		try {
			principal = await authorizer.authenticate(request.headers.authorization);
		} catch (error) {
			if (error instanceof OperatorAuthError) {
				// The reason stays in the router's logs. A response body that
				// explained a 403 would tell an unauthorized caller which
				// workspaces exist and which principals hold grants over them —
				// precisely the detail this route exists to gate.
				logger?.debug(
					`Operator context denied (${error.status}): ${error.message}`,
				);
				return reply
					.status(error.status)
					.send({ error: error.status === 401 ? "unauthorized" : "forbidden" });
			}
			logger?.error("Operator context authorization failed", error);
			return reply.status(500).send({ error: "internal error" });
		}
		try {
			// `no-store` because this document is per-principal and carries the
			// caller's own display name — on a device token, their email. A shared
			// cache keyed on the URL alone would serve one operator's authority to
			// the next.
			return reply
				.status(200)
				.header("cache-control", "no-store")
				.send(fleet.context(principal));
		} catch (error) {
			// Same reasoning as the discovery route: without this, Fastify's
			// default handler would return the Zod issue list — which names the
			// log-source path it rejected — to a caller the document was being
			// withheld from.
			logger?.error("Could not build the operator context document", error);
			return reply.status(500).send({ error: "internal error" });
		}
	});

	fastify.get<{
		Querystring: Record<string, string | string[] | undefined>;
	}>(RUNS_ROUTE, async (request, reply) => {
		const principal = await authenticate(
			authorizer,
			request.headers,
			reply,
			logger,
		);
		if (!principal) return reply;
		const query = request.query;
		const rawLimit = single(query.limit);
		if (rawLimit !== undefined && !/^\d+$/.test(rawLimit)) {
			return reply.status(400).send({ error: "invalid limit" });
		}
		return runFleetRead(reply, logger, "run listing", () =>
			fleet.listRuns(principal, {
				...pickSingle(query, [
					"runId",
					"agentSessionId",
					"issueId",
					"issueKey",
					"workspace",
					"owner",
					"team",
					"project",
					"lifecycle",
					"runner",
					"model",
					"cursor",
				]),
				...(rawLimit !== undefined ? { limit: Number(rawLimit) } : {}),
			}),
		);
	});

	fastify.get<{ Querystring: { cursor?: string | string[] } }>(
		RUN_CHANGES_ROUTE,
		async (request, reply) => {
			const principal = await authenticate(
				authorizer,
				request.headers,
				reply,
				logger,
			);
			if (!principal) return reply;
			const cursor = single(request.query.cursor);
			return runFleetRead(reply, logger, "run change feed", () =>
				fleet.listChanges(principal, cursor ? { cursor } : {}),
			);
		},
	);
}

/**
 * Authenticates a fleet request, or writes the refusal and returns
 * `undefined`.
 *
 * Shared by both run routes so neither can accidentally answer a differently
 * shaped 401/403 than the context route already does — the body stays
 * "unauthorized"/"forbidden", with the reason kept to the router's own logs.
 */
async function authenticate(
	authorizer: OperatorAuthorizer,
	headers: { authorization?: string },
	reply: FastifyReply,
	logger?: ILogger,
): Promise<OperatorPrincipal | undefined> {
	try {
		return await authorizer.authenticate(headers.authorization);
	} catch (error) {
		if (error instanceof OperatorAuthError) {
			logger?.debug(`Fleet read denied (${error.status}): ${error.message}`);
			void reply
				.status(error.status)
				.send({ error: error.status === 401 ? "unauthorized" : "forbidden" });
			return undefined;
		}
		logger?.error("Fleet read authorization failed", error);
		void reply.status(500).send({ error: "internal error" });
		return undefined;
	}
}

/**
 * Runs an authorized fleet read and renders its refusals.
 *
 * Every refusal a client can act on is modelled — an ambiguous captured name,
 * a cursor from another query, a cursor from a previous router process — and
 * each says which. That is the whole reason the routes cannot just return an
 * empty page: an empty success is what a client mistakes for "nothing has
 * happened", and both cursor faults are exactly the cases where nothing could
 * be further from true.
 *
 * `no-store` for the same reason the context route sets it: a page is scoped to
 * one principal's authority, and a cache keyed on the URL alone would serve one
 * operator's fleet to the next.
 */
function runFleetRead(
	reply: FastifyReply,
	logger: ILogger | undefined,
	what: string,
	read: () => unknown,
): FastifyReply {
	try {
		return reply.status(200).header("cache-control", "no-store").send(read());
	} catch (error) {
		if (error instanceof FleetQueryError) {
			logger?.debug(
				`Fleet ${what} refused (${error.status}): ${error.message}`,
			);
			return reply.status(error.status).send({
				error: error.code,
				...(error.status === 400 ? { message: error.message } : {}),
				...(error.candidates ? { candidates: error.candidates } : {}),
			});
		}
		if (error instanceof RunCursorError) {
			logger?.debug(`Fleet ${what} cursor refused: ${error.message}`);
			return reply
				.status(error.status)
				.send({ error: error.code, message: error.message });
		}
		// Same reasoning as the two documents above: Fastify has no error handler
		// on this instance, so an uncaught throw would put the message — here, a
		// Zod issue list naming rejected paths — into the response body.
		logger?.error(`Could not serve the fleet ${what}`, error);
		return reply.status(500).send({ error: "internal error" });
	}
}

function single(value: string | string[] | undefined): string | undefined {
	const first = Array.isArray(value) ? value[0] : value;
	return typeof first === "string" && first.length > 0 ? first : undefined;
}

/**
 * Reads the named query parameters, taking the FIRST value of a repeated one.
 *
 * Fastify hands a repeated parameter back as an array, and letting one reach a
 * filter would turn `?workspace=a&workspace=b` into a filter compared against
 * an array — which SQLite would silently bind as a string and match nothing.
 */
function pickSingle<K extends string>(
	query: Record<string, string | string[] | undefined>,
	keys: readonly K[],
): Partial<Record<K, string>> {
	const out: Partial<Record<K, string>> = {};
	for (const key of keys) {
		const value = single(query[key]);
		if (value !== undefined) out[key] = value;
	}
	return out;
}
