import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouterStore } from "./RouterStore.js";

const enrollBodySchema = z.object({ code: z.string().min(1) });

/**
 * Registers `POST /enroll`: a device redeems a one-time enrollment code minted
 * by an admin (`cyrus router users add`) for a long-lived device token. Returns
 * 200 `{ deviceToken }` on success, 401 for an unknown/expired code, or 400 for
 * a malformed body.
 */
export function registerEnrollmentRoute(
	fastify: FastifyInstance,
	store: RouterStore,
): void {
	fastify.post("/enroll", async (request, reply) => {
		const parsed = enrollBodySchema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: "invalid request body" });
		}
		const result = store.redeemEnrollmentCode(parsed.data.code, Date.now());
		if (!result) {
			return reply.status(401).send({ error: "invalid or expired code" });
		}
		return reply.status(200).send({ deviceToken: result.deviceToken });
	});
}
