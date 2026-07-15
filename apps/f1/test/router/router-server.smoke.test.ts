// apps/f1/test/router/router-server.smoke.test.ts
import { mkdtempSync, rmSync } from "node:fs";
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
});
