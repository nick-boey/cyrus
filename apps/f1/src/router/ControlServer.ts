// apps/f1/src/router/ControlServer.ts
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { CLIRPCServer } from "cyrus-core";
import Fastify from "fastify";
import { allocatePort } from "./allocatePort.js";
import {
	type Creator,
	createdFixture,
	promptedFixture,
	seedSession,
} from "./fixtures.js";
import type { RouterRig } from "./RouterRig.js";

export interface ControlServer {
	url: string;
	token: string;
	stop(): Promise<void>;
}

interface InjectBody {
	kind: "created" | "prompted";
	sessionId: string;
	actorUserId?: string;
	issueId: string;
	identifier: string;
	title: string;
	body?: string;
	creator: Creator;
}

export async function startControlServer(opts: {
	rig: RouterRig;
	token: string;
	port?: number;
	artifactsDir?: string;
}): Promise<ControlServer> {
	const port = opts.port ?? (await allocatePort());
	const fastify = Fastify();

	// Reuse EdgeWorker's pattern so existing ./f1 issue/session commands work.
	const rpc = new CLIRPCServer({
		fastifyServer: fastify,
		issueTracker: opts.rig.tracker,
		version: "1.0.0",
	});
	rpc.register();

	// Token gate for the /router/* control plane only.
	fastify.addHook("onRequest", async (request, reply) => {
		if (!request.url.startsWith("/router/")) return;
		if (request.headers.authorization !== `Bearer ${opts.token}`) {
			reply.code(401).send({ ok: false, error: "unauthorized" });
		}
	});

	fastify.post("/router/seed-user", async (request, reply) => {
		const b = request.body as {
			email: string;
			linearId: string;
			provider: string;
			claudeOauthToken: string;
			env?: Record<string, string>;
		};
		opts.rig.seedUser(b);
		reply.send({ ok: true });
	});

	fastify.post("/router/inject", async (request, reply) => {
		const b = request.body as InjectBody;
		seedSession(opts.rig.tracker, b.sessionId, b.issueId);
		const issue = { id: b.issueId, identifier: b.identifier, title: b.title };
		const event =
			b.kind === "created"
				? createdFixture({ sessionId: b.sessionId, issue, creator: b.creator })
				: promptedFixture({
						sessionId: b.sessionId,
						actorUserId: b.actorUserId ?? b.creator.id,
						creator: b.creator,
						issue,
						body: b.body ?? "",
					});
		await opts.rig.server.eventRouter.route(event);
		reply.send({ ok: true });
	});

	fastify.post("/router/enroll", async (request, reply) => {
		const b = request.body as { email: string };
		const code = opts.rig.server.store.mintEnrollmentCode(b.email, Date.now());
		const redeemed = opts.rig.server.store.redeemEnrollmentCode(
			code,
			Date.now(),
		);
		if (!redeemed) {
			reply
				.code(500)
				.send({ ok: false, error: "enrollment redemption failed" });
			return;
		}
		reply.send({ deviceToken: redeemed.deviceToken });
	});

	fastify.get("/router/artifact/:issueKey", async (request, reply) => {
		const { issueKey } = request.params as { issueKey: string };
		const dir = opts.artifactsDir;
		if (!dir) {
			reply.send({ present: false });
			return;
		}
		const bundle = join(dir, issueKey, "bundle.tar.gz");
		if (existsSync(bundle)) {
			reply.send({ present: true, bytes: statSync(bundle).size });
		} else {
			reply.send({ present: false });
		}
	});

	await fastify.listen({ port, host: "127.0.0.1" });
	return {
		url: `http://127.0.0.1:${port}`,
		token: opts.token,
		async stop() {
			await fastify.close();
		},
	};
}
