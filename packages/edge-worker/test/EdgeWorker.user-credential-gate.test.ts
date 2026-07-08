import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ILogger } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { UserCredentialResolver } from "../src/UserCredentialResolver.js";

/**
 * Unit tests for the multi-user webhook gate and the warm-session guard.
 * Exercises the real private methods on a bare EdgeWorker prototype object
 * so no full EdgeWorker construction (transports, servers) is needed.
 */
function makeLogger() {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	} as unknown as ILogger;
}

function makeWorker(resolver: UserCredentialResolver) {
	const worker = Object.create(EdgeWorker.prototype);
	worker.logger = makeLogger();
	worker.userCredentialResolver = resolver;
	worker.issueTrackers = new Map([["org-1", { tracker: true }]]);
	worker.postActivityDirect = vi.fn().mockResolvedValue(undefined);
	return worker;
}

const webhook = (creator?: { id?: string; email?: string; name?: string }) =>
	({
		organizationId: "org-1",
		agentSession: { id: "session-1", creator },
	}) as any;

describe("EdgeWorker.checkUserCredentialsOrBlock", () => {
	let dir: string;
	let logger: ILogger;

	beforeEach(() => {
		logger = makeLogger();
		dir = mkdtempSync(join(tmpdir(), "cyrus-gate-"));
		writeFileSync(join(dir, ".env"), "CLAUDE_CODE_OAUTH_TOKEN=tok");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const registry = () => [
		{ linearUser: { email: "alice@org.com" }, credentialsDir: dir },
	];

	it("passes everything through when multi-user mode is off", async () => {
		const worker = makeWorker(
			new UserCredentialResolver(undefined, undefined, logger),
		);
		await expect(
			worker.checkUserCredentialsOrBlock(webhook(undefined)),
		).resolves.toBe(true);
		expect(worker.postActivityDirect).not.toHaveBeenCalled();
	});

	it("allows a registered creator", async () => {
		const worker = makeWorker(
			new UserCredentialResolver(registry(), undefined, logger),
		);
		await expect(
			worker.checkUserCredentialsOrBlock(
				webhook({ email: "alice@org.com", name: "Alice" }),
			),
		).resolves.toBe(true);
		expect(worker.postActivityDirect).not.toHaveBeenCalled();
	});

	it("blocks an unregistered creator and posts registration instructions", async () => {
		const worker = makeWorker(
			new UserCredentialResolver(registry(), undefined, logger),
		);
		await expect(
			worker.checkUserCredentialsOrBlock(
				webhook({ email: "mallory@org.com", name: "Mallory" }),
			),
		).resolves.toBe(false);
		expect(worker.postActivityDirect).toHaveBeenCalledTimes(1);
		const [, input] = vi.mocked(worker.postActivityDirect).mock.calls[0]!;
		expect(input.agentSessionId).toBe("session-1");
		expect(input.content.body).toContain("Mallory");
		expect(input.content.body).toContain("cyrus users add");
	});

	it("fails closed when the webhook carries no creator", async () => {
		const worker = makeWorker(
			new UserCredentialResolver(registry(), undefined, logger),
		);
		await expect(
			worker.checkUserCredentialsOrBlock(webhook(undefined)),
		).resolves.toBe(false);
	});
});

describe("EdgeWorker.isWarmSessionsEnabled under multi-user mode", () => {
	const saved = process.env.CYRUS_ENABLE_WARM_SESSIONS;

	afterEach(() => {
		if (saved === undefined) {
			delete process.env.CYRUS_ENABLE_WARM_SESSIONS;
		} else {
			process.env.CYRUS_ENABLE_WARM_SESSIONS = saved;
		}
	});

	it("forces warm sessions off when users are registered", () => {
		process.env.CYRUS_ENABLE_WARM_SESSIONS = "1";
		const dir = mkdtempSync(join(tmpdir(), "cyrus-warm-"));
		writeFileSync(join(dir, ".env"), "CLAUDE_CODE_OAUTH_TOKEN=tok");
		const worker = makeWorker(
			new UserCredentialResolver(
				[{ linearUser: { email: "a@b.c" }, credentialsDir: dir }],
				undefined,
				makeLogger(),
			),
		);
		expect(worker.isWarmSessionsEnabled()).toBe(false);
		rmSync(dir, { recursive: true, force: true });
	});

	it("keeps the env opt-in when multi-user mode is off", () => {
		process.env.CYRUS_ENABLE_WARM_SESSIONS = "1";
		const worker = makeWorker(
			new UserCredentialResolver(undefined, undefined, makeLogger()),
		);
		expect(worker.isWarmSessionsEnabled()).toBe(true);
	});
});
