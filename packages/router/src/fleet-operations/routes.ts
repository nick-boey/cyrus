import type { ILogger } from "cyrus-core";
import type { FastifyInstance } from "fastify";
import type { FleetOperations } from "./FleetOperations.js";
import {
	OperatorAuthError,
	type OperatorAuthorizer,
} from "./OperatorAuthorizer.js";

/** Where a client discovers a Cyrus router's operator interface. */
export const DISCOVERY_ROUTE = "/.well-known/cyrus";
/** The authenticated operator's own view of its authority. */
export const OPERATOR_CONTEXT_ROUTE = "/api/v1/operator/context";

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
	fastify.get(DISCOVERY_ROUTE, async (_request, reply) =>
		reply.status(200).send(fleet.describe()),
	);

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
		return reply.status(200).send(fleet.context(principal));
	});
}
