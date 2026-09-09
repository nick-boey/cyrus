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
			claudeOauthToken?: string;
			defaultRunner?: string;
			codexAuthJson?: string;
			env?: Record<string, string>;
		};
		await opts.rig.seedUser(b);
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

	// Routes an issue and reports whether its run has reached the shape guarded
	// recovery exists for, WITHOUT fabricating any part of it.
	//
	// Two preconditions have to hold before a recovery can conclude anything,
	// and only one of them is F1's to produce. Routing writes the run row, the
	// session affinity and the issue lock; the executor boots the container and
	// its worker drains the router's queue. What makes the run STRANDED is the
	// worker then going away — a container stop, a suspend, a killed process —
	// which is the drive's own act, not this endpoint's.
	//
	// So this waits for the strand rather than asserting one. The earlier
	// version wrote `executor_state = 'stopped'` and returned: that records a
	// fact about an executor nobody stopped, and it returns a run whose event is
	// still queued — which `RouterRunReconciler.describeUnsettledWork` correctly
	// refuses to judge ("the worker's session list is not yet authoritative"). A
	// drive would have read that refusal as a recovery bug.
	//
	// It exists because `cyrus recover` takes a run id and the operator surface
	// will not hand one out for a run the caller has not already listed.
	fastify.post("/router/strand-run", async (request, reply) => {
		const b = request.body as InjectBody & { timeoutMs?: number };
		seedSession(opts.rig.tracker, b.sessionId, b.issueId);
		await opts.rig.server.eventRouter.route(
			createdFixture({
				sessionId: b.sessionId,
				issue: { id: b.issueId, identifier: b.identifier, title: b.title },
				creator: b.creator,
			}),
		);
		const store = opts.rig.server.store;
		const routed = store.getAgentRunForSession(b.sessionId);
		if (!routed) {
			// The route was rejected — an unenrolled creator, a locked issue, a
			// missing required secret. Saying so beats returning a half-built
			// scenario a drive would then blame recovery for.
			reply.code(409).send({
				ok: false,
				error: `Session ${b.sessionId} was not routed, so no run exists to strand`,
			});
			return;
		}
		const deadline = Date.now() + Math.max(0, b.timeoutMs ?? 0);
		let current = routed;
		let pendingEvents = true;
		while (true) {
			current = store.getAgentRunById(routed.runId) ?? current;
			pendingEvents = store.hasPendingEvents(routed.deviceId, Date.now());
			if (!pendingEvents && !current.workerOnline) break;
			if (Date.now() >= deadline) break;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		const affinity = store
			.listSessionAffinityForDevice(routed.deviceId)
			.find((row) => row.sessionId === b.sessionId);
		// Only the two facts this endpoint can actually check. The router's
		// `containers.affinityGraceMs` is the third precondition and is not
		// readable from here, so `sessionClaimedMsAgo` is reported raw for the
		// drive to measure against its own configuration rather than guessed at.
		const blockedBy = pendingEvents
			? "the device still has undelivered events, so the worker has not received this work yet"
			: current.workerOnline
				? "the worker is still connected; stop its container to strand the run"
				: undefined;
		reply.send({
			ok: true,
			runId: current.runId,
			sessionId: current.sessionId,
			deviceId: current.deviceId,
			issueKey: current.issueKey,
			state: current.state,
			revision: current.revision,
			workerOnline: current.workerOnline,
			executorState: current.executorState,
			pendingEvents,
			sessionAffinityDeviceId: store.getSessionAffinity(b.sessionId),
			issueLockSessionId: store.getIssueLock(b.issueId)?.sessionId,
			sessionClaimedMsAgo:
				affinity === undefined
					? undefined
					: Date.now() - affinity.establishedMs,
			recoverable: blockedBy === undefined,
			...(blockedBy ? { blockedBy } : {}),
		});
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
