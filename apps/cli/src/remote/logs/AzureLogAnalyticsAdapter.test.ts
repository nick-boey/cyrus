import type { LogQueryV1, LogRecordV1 } from "cyrus-operator-protocol";
import { describe, expect, it, vi } from "vitest";
import { ExitCode } from "../exitCodes.js";
import {
	AzureLogAnalyticsAdapter,
	createChainedTokenCredential,
	type LogsQueryClientLike,
	type LogsQueryResultLike,
	logAnalyticsAudience,
} from "./AzureLogAnalyticsAdapter.js";
import {
	consoleRow,
	descriptor,
	fakeDescriptor,
	query,
} from "./fixtures/index.js";
import { describeLogSourceAdapterContract } from "./LogSourceAdapter.contract.test.js";
import { compareLogRecords, matchesLogQuery } from "./LogSourceAdapter.js";

/**
 * A stub `LogsQueryClient` returning the one table our own `project` produces.
 *
 * Shaped from the SDK's real declarations (`LogsQueryResult`, `LogsTable`)
 * rather than from what the adapter happens to read, so a mapping that only
 * works against a convenient stub fails here.
 */
function successTable(
	rows: Array<{ timeGenerated: string | Date; record: unknown }>,
): LogsQueryResultLike {
	return {
		status: "Success",
		tables: [
			{
				name: "PrimaryResult",
				columnDescriptors: [{ name: "TimeGenerated" }, { name: "record" }],
				rows: rows.map((row) => [row.timeGenerated, row.record]),
			},
		],
	};
}

function stubClient(
	result: LogsQueryResultLike | (() => Promise<LogsQueryResultLike>),
): { client: LogsQueryClientLike; calls: unknown[][] } {
	const calls: unknown[][] = [];
	const client: LogsQueryClientLike = {
		queryWorkspace: async (workspaceId, kql, timespan, options) => {
			calls.push([workspaceId, kql, timespan, options]);
			return typeof result === "function" ? result() : result;
		},
	};
	return { client, calls };
}

function adapterOver(
	result: LogsQueryResultLike | (() => Promise<LogsQueryResultLike>),
): {
	adapter: AzureLogAnalyticsAdapter;
	calls: unknown[][];
} {
	const { client, calls } = stubClient(result);
	return {
		adapter: new AzureLogAnalyticsAdapter({
			createClient: async () => client,
			env: {},
		}),
		calls,
	};
}

describe("AzureLogAnalyticsAdapter", () => {
	it("addresses the query to the workspace the router advertised", async () => {
		const { adapter, calls } = adapterOver(successTable([]));

		await adapter.query(descriptor(), query());

		expect(calls[0]?.[0]).toBe(descriptor().azure?.workspaceId);
	});

	it("sends the compiled KQL and the WIDENED scan window as the timespan", async () => {
		// The timespan bounds `TimeGenerated` — the same column the query text
		// bounds — and the service enforces it. Sending the operator's narrower
		// window here would re-impose the ingestion-time cut that widening the scan
		// exists to remove, and would do it invisibly: the printed query would
		// still look right.
		const { adapter, calls } = adapterOver(successTable([]));

		await adapter.query(descriptor(), query());

		expect(calls[0]?.[1]).toContain("ContainerAppConsoleLogs_CL");
		expect(calls[0]?.[2]).toEqual({
			startTime: new Date("2026-09-06T23:45:00.000Z"),
			endTime: new Date("2026-09-07T00:30:00.000Z"),
		});
	});

	it("bounds the window the operator asked for inside the query text", async () => {
		// The narrowing that the timespan deliberately no longer does.
		const { adapter, calls } = adapterOver(successTable([]));

		await adapter.query(descriptor(), query());

		expect(calls[0]?.[1]).toContain(
			'| where cyrus_at >= datetime("2026-09-07T00:00:00.000Z") and cyrus_at < datetime("2026-09-07T00:15:00.000Z")',
		);
	});

	it("exposes the query it sent, for --show-query", async () => {
		const { adapter } = adapterOver(successTable([]));

		await adapter.query(descriptor(), query());

		expect(adapter.lastQuery).toContain("| extend p = parse_json(Log_s)");
	});

	it("records the query even when the backend fails, so a failure is debuggable", async () => {
		const { adapter } = adapterOver(async () => {
			throw new Error("boom");
		});

		await expect(adapter.query(descriptor(), query())).rejects.toThrow();
		expect(adapter.lastQuery).toContain("ContainerAppConsoleLogs_CL");
	});

	it("normalizes the returned rows into log records", async () => {
		const { adapter } = adapterOver(
			successTable([
				{ timeGenerated: "2026-09-07T00:05:42.000Z", record: consoleRow() },
			]),
		);

		const result = await adapter.query(descriptor(), query());

		expect(result.records[0]).toMatchObject({
			issueKey: "NOR-402",
			runId: "run-1",
			component: "EventRouter",
			level: "info",
		});
	});

	it("reports the ingestion lag it observed", async () => {
		const { adapter } = adapterOver(
			successTable([
				{ timeGenerated: "2026-09-07T00:05:42.000Z", record: consoleRow() },
			]),
		);

		const result = await adapter.query(descriptor(), query());

		expect(result.maxIngestionLagMs).toBe(42_000);
	});

	it("reports how many rows were not Cyrus records", async () => {
		const { adapter } = adapterOver(
			successTable([
				{ timeGenerated: "2026-09-07T00:05:00.000Z", record: "startup banner" },
				{ timeGenerated: "2026-09-07T00:05:42.000Z", record: consoleRow() },
			]),
		);

		const result = await adapter.query(descriptor(), query());

		expect(result.records).toHaveLength(1);
		expect(result.skipped).toBe(1);
	});

	it("locates columns by name, not position", async () => {
		// A positional read would break silently — as records with no timestamp —
		// the first time the projection gained a column.
		const { adapter } = adapterOver({
			status: "Success",
			tables: [
				{
					columnDescriptors: [
						{ name: "SomethingElse" },
						{ name: "record" },
						{ name: "TimeGenerated" },
					],
					rows: [["ignored", consoleRow(), "2026-09-07T00:05:42.000Z"]],
				},
			],
		});

		const result = await adapter.query(descriptor(), query());

		expect(result.records[0]?.issueKey).toBe("NOR-402");
		expect(result.maxIngestionLagMs).toBe(42_000);
	});

	it("reports a table missing the projected column rather than returning nothing", async () => {
		const { adapter } = adapterOver({
			status: "Success",
			tables: [{ columnDescriptors: [{ name: "Other" }], rows: [["x"]] }],
		});

		await expect(adapter.query(descriptor(), query())).rejects.toMatchObject({
			exitCode: ExitCode.transient,
		});
	});

	it("returns nothing for an empty result", async () => {
		const { adapter } = adapterOver({ status: "Success", tables: [] });

		expect((await adapter.query(descriptor(), query())).records).toEqual([]);
	});

	describe("partial and failed results", () => {
		it("fails a PARTIAL result rather than emitting the rows it did get", async () => {
			// Those rows look exactly like a complete answer. Rendering them is the
			// same defect as truncating one.
			const { adapter } = adapterOver({
				status: "PartialFailure",
				partialError: { message: "query exceeded the memory limit" },
			});

			await expect(adapter.query(descriptor(), query())).rejects.toMatchObject({
				exitCode: ExitCode.transient,
			});
		});

		it("names the backend's own reason for a partial result", async () => {
			const { adapter } = adapterOver({
				status: "PartialFailure",
				partialError: { message: "query exceeded the memory limit" },
			});

			await expect(adapter.query(descriptor(), query())).rejects.toThrow(
				/memory limit/,
			);
		});

		it("fails any status that is not Success", async () => {
			const { adapter } = adapterOver({ status: "Failure" });

			await expect(adapter.query(descriptor(), query())).rejects.toMatchObject({
				exitCode: ExitCode.transient,
			});
		});
	});

	describe("failure categories", () => {
		it.each([401, 403])(
			"reports %d as an authorization failure, not a transient one",
			async (statusCode) => {
				// Retrying an unauthorized query is pure noise against a billed
				// endpoint, and an orchestrator that cannot tell them apart does it.
				const { adapter } = adapterOver(async () => {
					throw Object.assign(new Error("Forbidden"), { statusCode });
				});

				await expect(
					adapter.query(descriptor(), query()),
				).rejects.toMatchObject({ exitCode: ExitCode.auth });
			},
		);

		it("suggests the grant that is usually missing", async () => {
			const { adapter } = adapterOver(async () => {
				throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
			});

			await expect(adapter.query(descriptor(), query())).rejects.toThrow(
				/Log Analytics Reader/,
			);
		});

		it("reports an unknown workspace as a configuration problem", async () => {
			const { adapter } = adapterOver(async () => {
				throw Object.assign(new Error("Not found"), { statusCode: 404 });
			});

			await expect(adapter.query(descriptor(), query())).rejects.toMatchObject({
				exitCode: ExitCode.usage,
			});
		});

		it("reports a network failure as transient", async () => {
			const { adapter } = adapterOver(async () => {
				throw new Error("ECONNRESET");
			});

			await expect(adapter.query(descriptor(), query())).rejects.toMatchObject({
				exitCode: ExitCode.transient,
			});
		});

		it("reports an abort as this process's own decision", async () => {
			const { adapter } = adapterOver(async () => {
				throw Object.assign(new Error("aborted"), { name: "AbortError" });
			});

			await expect(adapter.query(descriptor(), query())).rejects.toMatchObject({
				exitCode: ExitCode.usage,
			});
		});
	});

	it("refuses a descriptor for another backend rather than querying Azure with it", async () => {
		const { adapter, calls } = adapterOver(successTable([]));

		await expect(
			adapter.query(fakeDescriptor(), query()),
		).rejects.toMatchObject({ exitCode: ExitCode.usage });
		expect(calls).toHaveLength(0);
	});

	it("checks request-side budgets before making a billed query", async () => {
		const { adapter, calls } = adapterOver(successTable([]));

		await expect(
			adapter.query(descriptor(), query({ limit: 10_000 })),
		).rejects.toMatchObject({ exitCode: ExitCode.usage });
		expect(calls).toHaveLength(0);
	});

	it("does not report a stale query for one that was never sent", async () => {
		// `--show-query` reads `lastQuery` after the call. A request-side budget
		// failure generates no query, so leaving the previous poll's KQL here
		// would print it as if it were this one — misleading exactly when the flag
		// is being used to diagnose.
		const { adapter } = adapterOver(successTable([]));

		await adapter.query(descriptor(), query());
		expect(adapter.lastQuery).toBeDefined();

		await expect(
			adapter.query(descriptor(), query({ limit: 10_000 })),
		).rejects.toThrow();
		expect(adapter.lastQuery).toBeUndefined();
	});

	it("refuses a result the backend capped even when the extra row is unreadable", async () => {
		// The query takes `limit + 1` ROWS. If the extra one is a row the
		// normalizer skips, the record count falls back to `limit` and a
		// record-count budget sees a full-but-not-capped answer.
		const { adapter } = adapterOver(
			successTable([
				{ timeGenerated: "2026-09-07T00:05:42.000Z", record: consoleRow() },
				{ timeGenerated: "2026-09-07T00:05:43.000Z", record: "startup banner" },
			]),
		);

		await expect(
			adapter.query(descriptor(), query({ limit: 1 })),
		).rejects.toMatchObject({ exitCode: ExitCode.usage });
	});

	it("stops waiting when the signal fires mid-query", async () => {
		// The SDK discards the abort signal it accepts, so without this a `follow`
		// interrupted during a slow poll blocks until that poll returns.
		const controller = new AbortController();
		const { adapter } = adapterOver(
			() => new Promise<LogsQueryResultLike>(() => undefined),
		);

		const pending = adapter.query(descriptor(), query(), controller.signal);
		controller.abort();

		await expect(pending).rejects.toMatchObject({ exitCode: ExitCode.usage });
	});

	it("reports an abandoned wait as this process's decision, not the backend's", async () => {
		const controller = new AbortController();
		const { adapter } = adapterOver(
			() => new Promise<LogsQueryResultLike>(() => undefined),
		);

		const pending = adapter.query(descriptor(), query(), controller.signal);
		controller.abort();

		await expect(pending).rejects.not.toMatchObject({
			exitCode: ExitCode.transient,
		});
	});

	it("removes a known environment secret before returning records", async () => {
		// Redaction runs through the seam's shared finalizer, so it is a property
		// of the interface rather than of this adapter's normalizer.
		const { client } = stubClient(
			successTable([
				{
					timeGenerated: "2026-09-07T00:05:42.000Z",
					record: consoleRow({ message: "pushing with ghp_realtoken123456" }),
				},
			]),
		);
		const adapter = new AzureLogAnalyticsAdapter({
			createClient: async () => client,
			env: { GITHUB_TOKEN: "ghp_realtoken123456" },
		});

		const result = await adapter.query(descriptor(), query());

		expect(result.records[0]?.message).not.toContain("ghp_realtoken123456");
		expect(result.records[0]?.redacted).toBe(true);
	});

	it("reuses one client across queries, so a follow does not re-authenticate each poll", async () => {
		const { client } = stubClient(successTable([]));
		const createClient = vi.fn(async () => client);
		const adapter = new AzureLogAnalyticsAdapter({ createClient, env: {} });

		await adapter.query(descriptor(), query());
		await adapter.query(descriptor(), query());

		expect(createClient).toHaveBeenCalledTimes(1);
	});
});

describe("logAnalyticsAudience", () => {
	it.each([
		[undefined, "https://api.loganalytics.io"],
		["AzurePublicCloud", "https://api.loganalytics.io"],
		["AzureUSGovernment", "https://api.loganalytics.us"],
		["AzureChinaCloud", "https://api.loganalytics.azure.cn"],
	])("maps %s to its query endpoint", (cloud, expected) => {
		// A sovereign-cloud workspace queried with the public audience fails with a
		// 401 that says nothing about clouds, and the operator cannot guess.
		expect(logAnalyticsAudience(cloud as never)).toBe(expected);
	});
});

describe("createChainedTokenCredential", () => {
	const scope = "https://api.loganalytics.io/.default";

	it("returns the first token the chain produces", async () => {
		const credential = createChainedTokenCredential(
			[
				{
					source: "workload-identity",
					create: () => ({ getToken: async () => null }),
				},
				{
					source: "azure-cli",
					create: () => ({
						getToken: async () => ({
							token: "t2",
							expiresOnTimestamp: 123,
						}),
					}),
				},
			] as never,
			scope,
		);

		await expect(credential.getToken(scope)).resolves.toEqual({
			token: "t2",
			expiresOnTimestamp: 123,
		});
	});

	it("preserves the credential's own expiry rather than synthesising one", async () => {
		// The SDK's bearer policy caches on it. A fabricated expiry either re-mints
		// on every request or keeps presenting an expired token.
		const credential = createChainedTokenCredential(
			[
				{
					source: "azure-cli",
					create: () => ({
						getToken: async () => ({
							token: "t",
							expiresOnTimestamp: 1_800_000,
						}),
					}),
				},
			] as never,
			scope,
		);

		expect((await credential.getToken(scope))?.expiresOnTimestamp).toBe(
			1_800_000,
		);
	});

	it("treats a credential with no expiry as expiring immediately", async () => {
		const credential = createChainedTokenCredential(
			[
				{
					source: "azure-cli",
					create: () => ({ getToken: async () => ({ token: "t" }) }),
				},
			] as never,
			scope,
		);

		expect((await credential.getToken(scope))?.expiresOnTimestamp).toBe(0);
	});

	it("continues past a link that throws", async () => {
		const credential = createChainedTokenCredential(
			[
				{
					source: "managed-identity",
					create: () => ({
						getToken: async () => {
							throw new Error("no IMDS endpoint");
						},
					}),
				},
				{
					source: "azure-cli",
					create: () => ({
						getToken: async () => ({ token: "t", expiresOnTimestamp: 1 }),
					}),
				},
			] as never,
			scope,
		);

		expect((await credential.getToken(scope))?.token).toBe("t");
	});

	it("names every link it tried when the whole chain fails", async () => {
		const credential = createChainedTokenCredential(
			[
				{
					source: "managed-identity",
					create: () => ({
						getToken: async () => {
							throw new Error("no IMDS endpoint");
						},
					}),
				},
				{
					source: "azure-cli",
					create: () => ({ getToken: async () => null }),
				},
			] as never,
			scope,
		);

		await expect(credential.getToken(scope)).rejects.toThrow(
			/managed-identity.*azure-cli/s,
		);
	});

	it("reports an exhausted chain as an authorization failure", async () => {
		const credential = createChainedTokenCredential([], scope);

		await expect(credential.getToken(scope)).rejects.toMatchObject({
			exitCode: ExitCode.auth,
		});
	});

	it("prefers the link that worked last time", async () => {
		const first = vi.fn(async () => {
			throw new Error("unavailable");
		});
		const second = vi.fn(async () => ({ token: "t", expiresOnTimestamp: 1 }));
		const credential = createChainedTokenCredential(
			[
				{ source: "managed-identity", create: () => ({ getToken: first }) },
				{ source: "azure-cli", create: () => ({ getToken: second }) },
			] as never,
			scope,
		);

		await credential.getToken(scope);
		await credential.getToken(scope);

		// One probe of the failing link, not two: a chain that re-probed a dead
		// endpoint on every poll would add its timeout to every `follow` tick.
		expect(first).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(2);
	});
});

/* --------------------------------------- the Azure adapter satisfies the contract */

/**
 * Drives the shared contract suite against the Azure adapter over a stub
 * client that answers with whatever records the case seeded.
 *
 * The stub returns the seeded records as CONSOLE ROWS, so the contract runs
 * through the real KQL compiler and the real normalizer rather than around
 * them.
 *
 * The stub cannot execute KQL, so it stands in for the service by applying the
 * seam's own reference semantics — the same `matchesLogQuery` the fake adapter
 * uses. That is deliberately NOT proof that the compiled KQL means the same
 * thing; `compileAzureKql.test.ts` pins the query text for that. What this
 * proves is everything AROUND the query: budgets, ordering, cancellation, error
 * mapping, and that the adapter passes the operator's filters down at all rather
 * than dropping them.
 */
describeLogSourceAdapterContract("AzureLogAnalyticsAdapter", (records) => {
	let failure: Error | undefined;
	let lastRequest: LogQueryV1 | undefined;
	const client: LogsQueryClientLike = {
		queryWorkspace: async (_workspaceId, _kql, timespan) => {
			if (failure) throw failure;
			const request = lastRequest;
			// The stub stands in for the service by applying the seam's own reference
			// semantics on the EMISSION clock — which is what the compiled KQL now
			// filters and orders on. It is deliberately not proof that the KQL means
			// the same thing (`compileAzureKql.test.ts` pins the text for that); what
			// it proves is that the adapter passes the filters down at all, and that
			// budgets, ordering, cancellation and error mapping behave.
			const matched = request
				? records.filter((candidate) => matchesLogQuery(candidate, request))
				: records;
			// The service applies `timespan` to the INGESTION column, so the stub
			// does too — against each record's own simulated ingestion time, not its
			// emission time. That distinction is the point: with a per-record lag,
			// an adapter that filtered or ordered on ingestion fails the contract's
			// range and order cases here instead of passing on scaffolding.
			const inRange = matched.filter((candidate) => {
				const ingestedAt = Date.parse(ingestionTimeOf(candidate));
				return (
					ingestedAt >= timespan.startTime.getTime() &&
					ingestedAt < timespan.endTime.getTime()
				);
			});
			return successTable(
				[...inRange].sort(compareLogRecords).map(toConsoleRow),
			);
		},
	};
	const adapter = new AzureLogAnalyticsAdapter({
		createClient: async () => client,
		env: {},
	});
	return {
		adapter: {
			kind: adapter.kind,
			query: (source, request, signal) => {
				lastRequest = request;
				return adapter.query(source, request, signal);
			},
		},
		descriptor: descriptor(),
		failWith: (error) => {
			failure = error;
		},
	};
});

/**
 * A per-record ingestion time, later than emission by an amount that VARIES.
 *
 * Constant lag — or none at all, as the first version of this stub had — makes
 * ingestion order and emission order the same sequence, so a compiler that
 * filtered and ordered on `TimeGenerated` passed every ordering and range case
 * in the contract while producing out-of-order, silently-truncated output
 * against the real service. The variation is what makes those cases mean
 * something.
 */
function ingestionTimeOf(record: LogRecordV1): string {
	const lagMs =
		30_000 +
		(record.message.length % 7) * 20_000 * (record.level === "error" ? 2 : 1);
	return new Date(Date.parse(record.timestamp) + lagMs).toISOString();
}

/** Renders a normalized record back into the console row it came from. */
function toConsoleRow(record: LogRecordV1): {
	timeGenerated: string;
	record: unknown;
} {
	return {
		// The row's INGESTION time, deliberately not its emission time — the two
		// are different clocks and conflating them here is what made an earlier
		// version of this stub unable to see an adapter reading the wrong one.
		timeGenerated: ingestionTimeOf(record),
		record: {
			timestamp: record.timestamp,
			level: record.level,
			component: record.component,
			message: record.message,
			"cyrus.workspace_id": record.workspaceId ?? null,
			"cyrus.owner_id": record.ownerUserId ?? null,
			"cyrus.issue_key": record.issueKey ?? null,
			"cyrus.run_id": record.runId ?? null,
			"cyrus.session_id": record.sessionId ?? null,
			...(record.traceId ? { trace_id: record.traceId } : {}),
			...(record.attributes ?? {}),
		},
	};
}
