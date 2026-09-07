import type {
	LogRecordV1,
	LogSourceDescriptorV1,
} from "cyrus-operator-protocol";
import { describe, expect, it } from "vitest";
import { ExitCode } from "../exitCodes.js";
import { FakeLogSourceAdapter } from "./FakeLogSourceAdapter.js";
import { fakeDescriptor, query, record } from "./fixtures/index.js";
import {
	type LogSourceAdapter,
	MAX_RECORD_BYTES,
	MAX_TOTAL_OUTPUT_BYTES,
} from "./LogSourceAdapter.js";

/**
 * The contract every {@link LogSourceAdapter} must satisfy.
 *
 * Written against a factory rather than a concrete adapter so a future backend
 * is held to the same suite by adding one `describe` block. The rules here are
 * the ones an operator's conclusions depend on — which records come back, in
 * what order, and what happens instead of a short answer — and they are exactly
 * the rules that are cheap to get subtly wrong in a new adapter and expensive to
 * notice, because a wrong answer here looks like a quiet fleet rather than an
 * error.
 *
 * The Azure adapter is driven through the same suite in
 * `AzureLogAnalyticsAdapter.test.ts`, over a stub client.
 */
export function describeLogSourceAdapterContract(
	name: string,
	create: (records: LogRecordV1[]) => {
		adapter: LogSourceAdapter;
		descriptor: LogSourceDescriptorV1;
		/** Makes the next query fail with the given error. */
		failWith?: (error: Error) => void;
	},
): void {
	describe(`${name} (LogSourceAdapter contract)`, () => {
		/**
		 * Records are identified by their MESSAGE, not by `recordId`.
		 *
		 * `recordId` is a fingerprint the adapter derives from the backend row, so
		 * it is deliberately not preserved across a round trip — an adapter that
		 * echoed a seeded id would be failing to fingerprint. The message is the
		 * one field that survives every adapter unchanged, which makes it the only
		 * honest way for a backend-agnostic suite to name a record.
		 */
		const ids = (records: readonly LogRecordV1[]): string[] =>
			records.map((r) => r.message);

		const at = (minute: number, overrides: Partial<LogRecordV1> = {}) =>
			record({
				recordId: `record-${minute}`,
				message: `record-${minute}`,
				timestamp: `2026-09-07T00:${String(minute).padStart(2, "0")}:00.000Z`,
				...overrides,
			});

		describe("filters", () => {
			it("returns everything in range when nothing is filtered", async () => {
				const { adapter, descriptor } = create([at(1), at(2), at(3)]);

				const result = await adapter.query(descriptor, query());

				expect(result.records).toHaveLength(3);
			});

			it.each([
				["workspaceId", { workspaceId: "ws-2" }, { workspaceId: "ws-2" }],
				["ownerUserId", { ownerUserId: "user-2" }, { ownerUserId: "user-2" }],
				["issueKey", { issueKey: "NOR-9" }, { issueKey: "NOR-9" }],
				["runId", { runId: "run-2" }, { runId: "run-2" }],
				["sessionId", { sessionId: "session-2" }, { sessionId: "session-2" }],
				["component", { component: "Sweeper" }, { component: "Sweeper" }],
				[
					"traceId",
					{ traceId: "0af7651916cd43dd8448eb211c80319c" },
					{ traceId: "0af7651916cd43dd8448eb211c80319c" },
				],
			])("narrows on %s", async (_name, filter, marker) => {
				const { adapter, descriptor } = create([
					at(1, marker as Partial<LogRecordV1>),
					at(2),
				]);

				const result = await adapter.query(descriptor, query(filter as never));

				expect(ids(result.records)).toEqual(["record-1"]);
			});

			it("narrows on team, which lives in the attribute bag", async () => {
				const { adapter, descriptor } = create([
					at(1, { attributes: { "cyrus.team_id": "team-9" } }),
					at(2, { attributes: { "cyrus.team_id": "team-1" } }),
				]);

				const result = await adapter.query(
					descriptor,
					query({ teamId: "team-9" }),
				);

				expect(ids(result.records)).toEqual(["record-1"]);
			});

			it("narrows on project", async () => {
				const { adapter, descriptor } = create([
					at(1, { attributes: { "cyrus.project_id": "project-9" } }),
					at(2, { attributes: { "cyrus.project_id": "project-1" } }),
				]);

				const result = await adapter.query(
					descriptor,
					query({ projectId: "project-9" }),
				);

				expect(ids(result.records)).toEqual(["record-1"]);
			});

			it("narrows on level, keeping every level named", async () => {
				const { adapter, descriptor } = create([
					at(1, { level: "debug" }),
					at(2, { level: "warn" }),
					at(3, { level: "error" }),
				]);

				const result = await adapter.query(
					descriptor,
					query({ levels: ["warn", "error"] }),
				);

				expect(ids(result.records)).toEqual(["record-2", "record-3"]);
			});

			it("matches text case-insensitively, as the backend's `contains` does", async () => {
				// The two adapters have to agree here, or the same flag means two
				// different things depending on which backend answers.
				const { adapter, descriptor } = create([
					at(1, { message: "Timed Out waiting" }),
					at(2, { message: "routed" }),
				]);

				const result = await adapter.query(
					descriptor,
					query({ text: "timed out" }),
				);

				expect(ids(result.records)).toEqual(["Timed Out waiting"]);
			});

			it("composes filters as an intersection", async () => {
				const { adapter, descriptor } = create([
					at(1, { runId: "run-2", level: "error" }),
					at(2, { runId: "run-2", level: "info" }),
					at(3, { runId: "run-1", level: "error" }),
				]);

				const result = await adapter.query(
					descriptor,
					query({ runId: "run-2", levels: ["error"] }),
				);

				expect(ids(result.records)).toEqual(["record-1"]);
			});

			it("excludes records outside the range, on a half-open interval", async () => {
				// Half-open so a `follow` resuming from its own previous `to` does not
				// re-read the boundary record on every poll. Deduplication would hide
				// that, which is worse than not having the bug.
				const { adapter, descriptor } = create([
					record({ message: "before", timestamp: "2026-09-06T23:59:59.999Z" }),
					record({ message: "first", timestamp: "2026-09-07T00:00:00.000Z" }),
					record({ message: "last", timestamp: "2026-09-07T00:14:59.999Z" }),
					record({ message: "after", timestamp: "2026-09-07T00:15:00.000Z" }),
				]);

				const result = await adapter.query(descriptor, query());

				expect(ids(result.records)).toEqual(["first", "last"]);
			});
		});

		describe("workspace scope", () => {
			it("keeps a record carrying no workspace attribution", () => {
				// The workspace is the implicit scope every query carries, and most of
				// what the router writes is a plain `logger.info` with no `cyrus.*`
				// attribution at all. Treating the scope as a strict equality dropped
				// every one of those — including from a query with no filters — so
				// `cyrus logs query` reported a quiet fleet while the table was full.
				const { adapter, descriptor } = create([
					at(1, { workspaceId: undefined }),
					at(2, { workspaceId: "ws-1" }),
					at(3, { workspaceId: "ws-other" }),
				]);

				return adapter
					.query(descriptor, query({ workspaceId: "ws-1" }))
					.then((result) => {
						expect(ids(result.records)).toEqual(["record-1", "record-2"]);
					});
			});

			it("still excludes a record belonging to a DIFFERENT workspace", () => {
				// Widened, not removed.
				const { adapter, descriptor } = create([
					at(1, { workspaceId: "ws-other" }),
				]);

				return adapter
					.query(descriptor, query({ workspaceId: "ws-1" }))
					.then((result) => {
						expect(result.records).toEqual([]);
					});
			});

			it("does not widen the explicit narrowing filters the same way", async () => {
				// Asking for `--team X` means a line with no team is not a match. Only
				// the implicit workspace scope admits the unattributed.
				const { adapter, descriptor } = create([at(1, { attributes: {} })]);

				const result = await adapter.query(
					descriptor,
					query({ teamId: "team-1" }),
				);

				expect(result.records).toEqual([]);
			});
		});

		describe("redaction", () => {
			it("removes a credential-named attribute before returning", async () => {
				// Part of the seam, not of one adapter: "known secrets are removed
				// before output" has to be a property of the interface, or the next
				// backend rediscovers it and the failure mode is a credential in a CI
				// log rather than a test going red.
				const { adapter, descriptor } = create([
					at(1, { attributes: { "cyrus.access_token": "aaaa1111bbbb" } }),
				]);

				const result = await adapter.query(descriptor, query());

				expect(result.records[0]?.attributes?.["cyrus.access_token"]).toBe(
					"[redacted]",
				);
				expect(result.records[0]?.redacted).toBe(true);
			});
		});

		describe("order", () => {
			it("returns records oldest first", async () => {
				const { adapter, descriptor } = create([at(3), at(1), at(2)]);

				const result = await adapter.query(descriptor, query());

				expect(ids(result.records)).toEqual([
					"record-1",
					"record-2",
					"record-3",
				]);
			});

			it("breaks ties on identical timestamps deterministically", async () => {
				// Without a TOTAL order the same query returns a different subset each
				// run once a limit is applied, and a `follow` built on it shows records
				// appearing and disappearing.
				//
				// What is asserted is DETERMINISM, not a particular tiebreaker: the
				// fake orders by record id and the Azure adapter orders by the raw log
				// line, and both are correct. Pinning one would make the contract
				// describe an implementation rather than a requirement.
				const same = "2026-09-07T00:05:00.000Z";
				const { adapter, descriptor } = create([
					record({ message: "b", timestamp: same }),
					record({ message: "a", timestamp: same }),
				]);

				const first = await adapter.query(descriptor, query());
				const second = await adapter.query(descriptor, query());

				expect(ids(first.records).sort()).toEqual(["a", "b"]);
				expect(ids(second.records)).toEqual(ids(first.records));
			});
		});

		describe("cancellation", () => {
			it("refuses an already-aborted query rather than billing for it", async () => {
				const { adapter, descriptor } = create([at(1)]);
				const controller = new AbortController();
				controller.abort();

				await expect(
					adapter.query(descriptor, query(), controller.signal),
				).rejects.toMatchObject({ exitCode: ExitCode.usage });
			});

			it("reports cancellation as this process's decision, not the backend's", async () => {
				// A cancelled request must NOT report as transient: telling an
				// orchestrator to retry describes our own choice as a backend fault.
				const { adapter, descriptor } = create([at(1)]);
				const controller = new AbortController();
				controller.abort();

				await expect(
					adapter.query(descriptor, query(), controller.signal),
				).rejects.not.toMatchObject({ exitCode: ExitCode.transient });
			});
		});

		describe("budgets", () => {
			it("refuses a limit above what the source allows", async () => {
				// Refused rather than clamped: a clamped limit answers a different
				// question and says nothing about having done so.
				const { adapter, descriptor } = create([at(1)]);

				await expect(
					adapter.query(
						descriptor,
						query({ limit: descriptor.budgets.maxRecords + 1 }),
					),
				).rejects.toMatchObject({ exitCode: ExitCode.usage });
			});

			it("refuses a range longer than the source allows", async () => {
				const { adapter, descriptor } = create([at(1)]);

				await expect(
					adapter.query(
						descriptor,
						query({
							range: {
								from: "2026-09-01T00:00:00.000Z",
								to: "2026-09-07T00:00:00.000Z",
							},
						}),
					),
				).rejects.toMatchObject({ exitCode: ExitCode.usage });
			});

			it("refuses rather than truncating when more records match than the limit", async () => {
				// The single most important rule in this file. A truncated result reads
				// as a complete one, and an operator concludes an error never happened.
				const { adapter, descriptor } = create([at(1), at(2), at(3)]);

				await expect(
					adapter.query(descriptor, query({ limit: 2 })),
				).rejects.toMatchObject({ exitCode: ExitCode.usage });
			});

			it("returns exactly the limit without complaining", async () => {
				const { adapter, descriptor } = create([at(1), at(2)]);

				const result = await adapter.query(descriptor, query({ limit: 2 }));

				expect(result.records).toHaveLength(2);
			});

			it("refuses a single record over the per-record size budget", async () => {
				const { adapter, descriptor } = create([
					at(1, { message: "x".repeat(MAX_RECORD_BYTES + 1) }),
				]);

				await expect(adapter.query(descriptor, query())).rejects.toMatchObject({
					exitCode: ExitCode.usage,
				});
			});

			it("refuses a result set over the total output budget", async () => {
				// Each record is well under the per-record cap; together they are not.
				const chunk = "x".repeat(200 * 1024);
				const many = Array.from({ length: 60 }, (_value, index) =>
					at(1, { recordId: `big-${index}`, message: chunk }),
				);
				const { adapter, descriptor } = create(many);

				await expect(adapter.query(descriptor, query())).rejects.toMatchObject({
					exitCode: ExitCode.usage,
				});
				expect(
					many.reduce(
						(total, r) => total + Buffer.byteLength(JSON.stringify(r)),
						0,
					),
				).toBeGreaterThan(MAX_TOTAL_OUTPUT_BYTES);
			});
		});

		describe("backend failure", () => {
			it("propagates a backend error rather than reporting an empty result", async () => {
				// An error rendered as "no records" is the worst possible outcome here:
				// it is indistinguishable from a healthy, quiet fleet.
				const created = create([at(1)]);
				const failure = Object.assign(new Error("backend exploded"), {
					exitCode: ExitCode.transient,
				});
				created.failWith?.(failure);

				await expect(
					created.adapter.query(created.descriptor, query()),
				).rejects.toThrow("backend exploded");
			});
		});
	});
}

/* ------------------------------------------------------ the fake satisfies it */

describeLogSourceAdapterContract("FakeLogSourceAdapter", (records) => {
	const adapter = new FakeLogSourceAdapter({ records });
	return {
		adapter,
		descriptor: fakeDescriptor(),
		failWith: (error) => adapter.setFailure(error),
	};
});
