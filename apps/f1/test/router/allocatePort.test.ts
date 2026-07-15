import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { allocatePort } from "../../src/router/allocatePort.js";

describe("allocatePort", () => {
	it("returns a port that can then be bound", async () => {
		const port = await allocatePort();
		expect(port).toBeGreaterThan(0);
		expect(port).toBeLessThan(65536);
		// The port was released before returning, so we can bind it now.
		await new Promise<void>((resolve, reject) => {
			const srv = createServer();
			srv.once("error", reject);
			srv.listen(port, "127.0.0.1", () => srv.close(() => resolve()));
		});
	});

	it("returns distinct ports across successive calls", async () => {
		const a = await allocatePort();
		const b = await allocatePort();
		expect(a).not.toBe(b);
	});
});
