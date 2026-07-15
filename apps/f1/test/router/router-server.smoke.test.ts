// apps/f1/test/router/router-server.smoke.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRouterServer } from "../../router-server.js";

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
