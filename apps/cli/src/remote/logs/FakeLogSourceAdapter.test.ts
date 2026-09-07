import { describe, expect, it } from "vitest";
import { TransientError } from "../errors.js";
import { FakeLogSourceAdapter } from "./FakeLogSourceAdapter.js";
import { fakeDescriptor, query, record } from "./fixtures/index.js";

/**
 * The fake's own affordances — the ones its CONSUMERS depend on but the shared
 * contract has no reason to test, because they exist to drive a test rather
 * than to satisfy an operator.
 *
 * Its behaviour as an adapter is covered by the contract suite in
 * `LogSourceAdapter.contract.test.ts`, which runs against this class.
 */
describe("FakeLogSourceAdapter", () => {
	it("declares itself a `fake` source, which the wire contract admits", () => {
		// Not a test-only escape hatch: a router configured against a fake source
		// is a supported deployment, so the same selection code runs in production.
		expect(new FakeLogSourceAdapter({}).kind).toBe("fake");
	});

	it("records every query it was asked, so a command test can assert on them", () => {
		const adapter = new FakeLogSourceAdapter({});

		expect(adapter.queries).toEqual([]);
	});

	it("captures the compiled query, including the range the command chose", async () => {
		const adapter = new FakeLogSourceAdapter({});

		await adapter.query(fakeDescriptor(), query({ issueKey: "NOR-402" }));

		expect(adapter.queries).toHaveLength(1);
		expect(adapter.queries[0]).toMatchObject({
			issueKey: "NOR-402",
			range: {
				from: "2026-09-07T00:00:00.000Z",
				to: "2026-09-07T00:15:00.000Z",
			},
		});
	});

	it("records the query even when it is about to refuse it", async () => {
		// A command test asserting "the descriptor was read before the backend was
		// touched" needs the attempt to be visible whether or not it succeeded.
		const adapter = new FakeLogSourceAdapter({
			failure: new TransientError("down"),
		});

		await expect(adapter.query(fakeDescriptor(), query())).rejects.toThrow();
		expect(adapter.queries).toHaveLength(1);
	});

	it("lets a follow test advance the fleet between polls", async () => {
		const adapter = new FakeLogSourceAdapter({
			records: [record({ recordId: "a", message: "a" })],
		});
		const first = await adapter.query(fakeDescriptor(), query());

		adapter.append(
			record({
				recordId: "b",
				message: "b",
				timestamp: "2026-09-07T00:06:00.000Z",
			}),
		);
		const second = await adapter.query(fakeDescriptor(), query());

		expect(first.records).toHaveLength(1);
		expect(second.records.map((r) => r.message)).toEqual(["a", "b"]);
	});

	it("lets a test replace the whole record set", async () => {
		const adapter = new FakeLogSourceAdapter({
			records: [record({ recordId: "a", message: "a" })],
		});

		adapter.setRecords([record({ recordId: "c", message: "c" })]);

		expect(
			(await adapter.query(fakeDescriptor(), query())).records.map(
				(r) => r.message,
			),
		).toEqual(["c"]);
	});

	it("lets a test clear a seeded failure, so recovery is drivable", async () => {
		const adapter = new FakeLogSourceAdapter({
			records: [record()],
			failure: new TransientError("down"),
		});

		await expect(adapter.query(fakeDescriptor(), query())).rejects.toThrow();
		adapter.setFailure(undefined);

		expect(
			(await adapter.query(fakeDescriptor(), query())).records,
		).toHaveLength(1);
	});

	it("reports a backend latency when one was configured", async () => {
		const adapter = new FakeLogSourceAdapter({ backendLatencyMs: 250 });

		expect(
			(await adapter.query(fakeDescriptor(), query())).backendLatencyMs,
		).toBe(250);
	});

	it("omits backend latency when none was configured", async () => {
		// Omitted rather than reported as zero: "the backend took no time" and "we
		// do not know how long it took" are different claims.
		const adapter = new FakeLogSourceAdapter({});

		expect(
			(await adapter.query(fakeDescriptor(), query())).backendLatencyMs,
		).toBeUndefined();
	});

	it("copies the seeded records, so a caller's array cannot mutate it later", async () => {
		const seed = [record({ recordId: "a", message: "a" })];
		const adapter = new FakeLogSourceAdapter({ records: seed });

		seed.push(record({ recordId: "b", message: "b" }));

		expect(
			(await adapter.query(fakeDescriptor(), query())).records,
		).toHaveLength(1);
	});
});
