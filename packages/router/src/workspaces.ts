import type { FastifyInstance } from "fastify";
import type { RouterStore } from "./RouterStore.js";

/**
 * Extracts a bearer token from an `Authorization` header, or `undefined` when
 * the header is absent or not a well-formed `Bearer <token>`.
 */
function parseBearerToken(header: string | undefined): string | undefined {
	if (!header) return undefined;
	const prefix = "Bearer ";
	if (!header.startsWith(prefix)) return undefined;
	const token = header.slice(prefix.length).trim();
	return token.length > 0 ? token : undefined;
}

/**
 * Registers `GET /workspaces`: an enrolled device asks the router which Linear
 * workspace ids it serves. Returns 200 `{ workspaceIds }` for a valid device
 * token, or 401 for a missing/malformed/unknown one.
 *
 * A router-mode device holds no Linear token, so it cannot query Linear for its
 * own organization id — yet it needs that id as `repositories[].linearWorkspaceId`
 * to key its issue trackers (`EdgeWorker` looks the tracker up by workspace id
 * when a routed event arrives). Without this route the id has to be copied by
 * hand from the router's `router-config.json`, and a typo fails silently: the
 * device connects, receives events, and drops them for want of a tracker.
 */
export function registerWorkspacesRoute(
	fastify: FastifyInstance,
	store: RouterStore,
	workspaceIds: string[],
): void {
	fastify.get("/workspaces", async (request, reply) => {
		const token = parseBearerToken(request.headers.authorization);
		if (!token) {
			return reply.status(401).send({ error: "missing bearer token" });
		}
		// Tokens are stored hashed; getDeviceByToken hashes before comparing.
		if (!store.getDeviceByToken(token)) {
			return reply.status(401).send({ error: "invalid device token" });
		}
		return reply.status(200).send({ workspaceIds });
	});
}
