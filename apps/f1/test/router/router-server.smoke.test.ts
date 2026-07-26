// apps/f1/test/router/router-server.smoke.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	parseRequiredSecretKeys,
	startRouterServer,
} from "../../router-server.js";

describe("router-server smoke (fake executor)", () => {
	let handle: Awaited<ReturnType<typeof startRouterServer>>;
	let dir: string;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "f1-router-server-"));
		handle = await startRouterServer({
			home: dir,
			controlToken: "t",
			fakeExecutor: true,
		});
	});

	afterAll(async () => {
		await handle.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	it("boots the control server on loopback and answers an authed artifact check", async () => {
		const res = await fetch(`${handle.control.url}/router/artifact/CYPACK-1`, {
			headers: { authorization: "Bearer t" },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ present: false });
	});

	it("resolves artifacts from the same artifactsDir the rig was configured with", async () => {
		const bundleDir = join(dir, "artifacts", "CYFLOOR-9");
		mkdirSync(bundleDir, { recursive: true });
		const bundleBytes = Buffer.from("f1-router-server-smoke-test-bundle");
		writeFileSync(join(bundleDir, "bundle.tar.gz"), bundleBytes);

		const res = await fetch(`${handle.control.url}/router/artifact/CYFLOOR-9`, {
			headers: { authorization: "Bearer t" },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			present: true,
			bytes: bundleBytes.length,
		});
	});
});

describe("parseRequiredSecretKeys", () => {
	it("splits a comma-separated list, trimming whitespace and empty entries", () => {
		expect(parseRequiredSecretKeys("GIT_TOKEN, LINEAR_API_TOKEN,")).toEqual([
			"GIT_TOKEN",
			"LINEAR_API_TOKEN",
		]);
	});

	it("returns undefined for unset or blank input", () => {
		expect(parseRequiredSecretKeys(undefined)).toBeUndefined();
		expect(parseRequiredSecretKeys("")).toBeUndefined();
		expect(parseRequiredSecretKeys(" , ")).toBeUndefined();
	});
});

describe("router-server requiredSecretKeys passthrough (fake executor)", () => {
	let handle: Awaited<ReturnType<typeof startRouterServer>>;
	let dir: string;
	const logger = { info: vi.fn(), warn: vi.fn() };

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "f1-router-server-gate-"));
		handle = await startRouterServer({
			home: dir,
			controlToken: "t",
			fakeExecutor: true,
			requiredSecretKeys: ["LINEAR_API_TOKEN"],
			logger,
		});
	});

	afterAll(async () => {
		await handle.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	it("blocks a control-plane-seeded user missing the required key", async () => {
		const headers = {
			"content-type": "application/json",
			authorization: "Bearer t",
		};
		const seed = await fetch(`${handle.control.url}/router/seed-user`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				email: "gated@example.com",
				linearId: "lin-g",
				provider: "docker",
				claudeOauthToken: "tok", // no LINEAR_API_TOKEN
			}),
		});
		expect(seed.status).toBe(200);
		const inject = await fetch(`${handle.control.url}/router/inject`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				kind: "created",
				sessionId: "sess-gate-1",
				issueId: "issue-gate-1",
				identifier: "CYGATE-1",
				title: "Gated",
				creator: { id: "lin-g", email: "gated@example.com", name: "G" },
			}),
		});
		expect(inject.status).toBe(200);
		await vi.waitFor(() =>
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining("missing LINEAR_API_TOKEN"),
			),
		);
	});
});
