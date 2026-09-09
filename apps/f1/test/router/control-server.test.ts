// apps/f1/test/router/control-server.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretStore } from "cyrus-router";
import type {
	ContainerExecutor,
	ContainerStatus,
	IssueExecutionContext,
} from "cyrus-router-executors";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	type ControlServer,
	startControlServer,
} from "../../src/router/ControlServer.js";
import { createRouterRig, type RouterRig } from "../../src/router/RouterRig.js";

class RecordingExecutor implements ContainerExecutor {
	readonly provider = "docker";
	readonly calls: string[] = [];
	async ensureRunning(ctx: IssueExecutionContext): Promise<void> {
		ctx.mintDeviceToken();
		this.calls.push(ctx.issueKey);
	}
	async stop(): Promise<void> {}
	async destroy(): Promise<void> {}
	async status(): Promise<ContainerStatus> {
		return "absent";
	}
	async listManaged(): Promise<string[]> {
		return [];
	}
}

describe("control server", () => {
	let rig: RouterRig;
	let control: ControlServer;
	let dir: string;
	let secretsPath: string;
	const exec = new RecordingExecutor();

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "f1-control-"));
		secretsPath = join(dir, "secrets.json");
		rig = await createRouterRig({
			dbPath: ":memory:",
			secretsPath,
			artifactsDir: join(dir, "artifacts"),
			executors: new Map([["docker", exec]]),
			logger: { info: () => {}, warn: () => {} },
		});
		control = await startControlServer({ rig, token: "secret-token" });
	});

	afterAll(async () => {
		await control.stop();
		await rig.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	it("rejects control routes without the bearer token", async () => {
		const res = await fetch(`${control.url}/router/artifact/CYPACK-1`);
		expect(res.status).toBe(401);
	});

	it("binds to loopback only", () => {
		expect(control.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
	});

	it("seeds a user and routes an injected created webhook to the executor", async () => {
		const seed = await fetch(`${control.url}/router/seed-user`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer secret-token",
			},
			body: JSON.stringify({
				email: "cold@example.com",
				linearId: "lin-cold",
				provider: "docker",
				claudeOauthToken: "tok",
			}),
		});
		expect(seed.status).toBe(200);

		const inject = await fetch(`${control.url}/router/inject`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer secret-token",
			},
			body: JSON.stringify({
				kind: "created",
				sessionId: "sess-1",
				issueId: "issue-1",
				identifier: "CYPACK-1",
				title: "Cold",
				creator: { id: "lin-cold", email: "cold@example.com", name: "Cold" },
			}),
		});
		expect(inject.status).toBe(200);
		await vi.waitFor(() => expect(exec.calls).toContain("CYPACK-1"));
	});

	it("forwards env vars from /router/seed-user into the secret store", async () => {
		const seed = await fetch(`${control.url}/router/seed-user`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer secret-token",
			},
			body: JSON.stringify({
				email: "envy@example.com",
				linearId: "lin-envy",
				provider: "docker",
				claudeOauthToken: "claude-tok",
				env: { LINEAR_API_TOKEN: "lin_api_1" },
			}),
		});
		expect(seed.status).toBe(200);

		const stored = new SecretStore(secretsPath).get("envy@example.com");
		expect(stored.CLAUDE_CODE_OAUTH_TOKEN).toBe("claude-tok");
		expect(stored.LINEAR_API_TOKEN).toBe("lin_api_1");
	});

	it("reports the run facts a recovery needs, and why it is not yet recoverable", async () => {
		const strand = await fetch(`${control.url}/router/strand-run`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer secret-token",
			},
			body: JSON.stringify({
				kind: "created",
				sessionId: "sess-strand",
				issueId: "issue-strand",
				identifier: "CYPACK-STRAND",
				title: "Stranded",
				creator: { id: "lin-cold", email: "cold@example.com", name: "Cold" },
			}),
		});
		expect(strand.status).toBe(200);
		const body = (await strand.json()) as {
			runId: string;
			deviceId: number;
			revision: number;
			workerOnline: boolean;
			executorState?: string;
			pendingEvents: boolean;
			sessionAffinityDeviceId?: number;
			issueLockSessionId?: string;
			recoverable: boolean;
			blockedBy?: string;
		};
		expect(body.runId).toBeTruthy();
		expect(body.workerOnline).toBe(false);
		// The affinity and the issue lock the route wrote are held — which is what
		// makes the issue unreachable and a recovery necessary.
		expect(body.sessionAffinityDeviceId).toBe(body.deviceId);
		expect(body.issueLockSessionId).toBe("sess-strand");
		// This executor never connects a worker, so the routed event is still
		// queued and the run is NOT yet recoverable. Reporting that is the whole
		// point: `RouterRunReconciler` refuses to judge a worker's silence about
		// work it has not received, and an endpoint that claimed a strand here
		// would send a drive off to blame recovery for the refusal.
		expect(body.pendingEvents).toBe(true);
		expect(body.recoverable).toBe(false);
		expect(body.blockedBy).toMatch(/undelivered events/i);
		// And it invents no executor state it did not establish.
		expect(body.executorState).toBeUndefined();
	});

	it("refuses to report a strand for a session that was never routed", async () => {
		const strand = await fetch(`${control.url}/router/strand-run`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer secret-token",
			},
			body: JSON.stringify({
				kind: "created",
				sessionId: "sess-unrouted",
				issueId: "issue-unrouted",
				identifier: "CYPACK-UNROUTED",
				title: "Unrouted",
				creator: {
					id: "lin-nobody",
					email: "nobody@example.com",
					name: "Nobody",
				},
			}),
		});
		expect(strand.status).toBe(409);
	});

	it("rejects /router/enroll without the bearer token", async () => {
		const res = await fetch(`${control.url}/router/enroll`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email: "enroll@example.com" }),
		});
		expect(res.status).toBe(401);
	});

	it("mints and redeems an enrollment code for a seeded user", async () => {
		const seed = await fetch(`${control.url}/router/seed-user`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer secret-token",
			},
			body: JSON.stringify({
				email: "enroll@example.com",
				linearId: "lin-enroll",
				provider: "docker",
				claudeOauthToken: "tok",
			}),
		});
		expect(seed.status).toBe(200);

		const enroll = await fetch(`${control.url}/router/enroll`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer secret-token",
			},
			body: JSON.stringify({ email: "enroll@example.com" }),
		});
		expect(enroll.status).toBe(200);
		const body = (await enroll.json()) as { deviceToken: string };
		expect(typeof body.deviceToken).toBe("string");
		expect(body.deviceToken.length).toBeGreaterThan(0);
	});
});
