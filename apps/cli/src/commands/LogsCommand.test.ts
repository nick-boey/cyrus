import type { EdgeConfig } from "cyrus-core";
import type {
	LogRecordV1,
	LogSourceDescriptorV1,
	OperatorContextV1,
} from "cyrus-operator-protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Application } from "../Application.js";
import { ExitCode } from "../remote/exitCodes.js";
import { FakeLogSourceAdapter } from "../remote/logs/FakeLogSourceAdapter.js";
import { descriptor, record } from "../remote/logs/fixtures/index.js";
import { LogAdapterRegistry } from "../remote/logs/LogAdapterRegistry.js";
import { createRecordingOutput } from "../remote/output.js";
import { LogsCommand } from "./LogsCommand.js";

const BASE_URL = "https://router.example.com";
const CONTEXT_PATH = "/api/v1/operator/context";
const NOW = "2026-09-07T00:15:00.000Z";

function fakeSource(
	overrides: Partial<LogSourceDescriptorV1> = {},
): LogSourceDescriptorV1 {
	const { azure: _azure, ...base } = descriptor() as LogSourceDescriptorV1 & {
		azure?: unknown;
	};
	return {
		...base,
		kind: "fake",
		displayName: "cyrus-router logs",
		...overrides,
	} as LogSourceDescriptorV1;
}

function context(
	overrides: Partial<OperatorContextV1> = {},
): OperatorContextV1 {
	return {
		schemaVersion: 1,
		principalId: "principal-1",
		authMethod: "local-operator-token",
		displayName: "Fleet operations",
		roles: ["fleet.read"],
		capabilities: ["runs.list", "logs.query"],
		authorizedWorkspaces: [{ workspaceId: "ws-1", name: "Northrop Digital" }],
		observedAt: NOW,
		logSource: fakeSource(),
		...overrides,
	} as OperatorContextV1;
}

function fakeApp() {
	const config = {
		repositories: [],
		operatorConnections: {
			prod: {
				url: BASE_URL,
				auth: { kind: "local", tokenEnv: "CYRUS_OPERATOR_TOKEN" },
			},
		},
	} as unknown as EdgeConfig;
	return {
		config: {
			load: () => structuredClone(config),
			save: () => {},
			getConfigPath: () => "/nonexistent/cyrus-logs-command/config.json",
		},
		logger: { raw: () => {}, error: () => {}, success: () => {} },
	} as unknown as Application;
}

/** Routes by path, and records the ORDER in which network calls happened. */
function router(
	body: unknown = context(),
	status = 200,
): { fetchFn: typeof fetch; calls: string[] } {
	const calls: string[] = [];
	const fetchFn = vi.fn(async (input: string | URL) => {
		const url = new URL(String(input));
		calls.push(url.pathname);
		if (url.pathname !== CONTEXT_PATH) {
			return new Response("", { status: 404 });
		}
		return new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof fetch;
	return { fetchFn, calls };
}

function build(
	options: {
		records?: LogRecordV1[];
		body?: unknown;
		status?: number;
		adapter?: FakeLogSourceAdapter;
		now?: () => number;
	} = {},
) {
	const { fetchFn, calls } = router(options.body ?? context(), options.status);
	const adapter =
		options.adapter ??
		new FakeLogSourceAdapter({ records: options.records ?? [] });
	const out = createRecordingOutput();
	const cmd = new LogsCommand(fakeApp(), {
		fetchFn,
		env: { CYRUS_OPERATOR_TOKEN: "cyop_deadbeefdeadbeef" },
		output: out,
		sleep: async () => {},
		now: options.now ?? (() => Date.parse(NOW)),
		registry: new LogAdapterRegistry({ factories: { fake: () => adapter } }),
	});
	return { cmd, out, adapter, calls };
}

async function exitCodeOf(
	cmd: LogsCommand,
	argv: string[],
	selection: { connection?: string; workspace?: string } = {},
): Promise<number> {
	const exit = vi.spyOn(process, "exit").mockImplementation(((
		code?: number,
	) => {
		throw new ExitSignal(code ?? 0);
	}) as never);
	try {
		await cmd.execute(argv, selection);
		return ExitCode.success;
	} catch (error) {
		if (error instanceof ExitSignal) return error.code;
		throw error;
	} finally {
		exit.mockRestore();
	}
}

class ExitSignal extends Error {
	constructor(readonly code: number) {
		super(`exit ${code}`);
	}
}

/** A record inside the default 15-minute window ending at NOW. */
function inWindow(overrides: Partial<LogRecordV1> = {}): LogRecordV1 {
	return record({ timestamp: "2026-09-07T00:05:00.000Z", ...overrides });
}

beforeEach(() => {
	process.exitCode = undefined;
});

describe("cyrus logs query", () => {
	it("reads the descriptor from the router before touching the backend", async () => {
		// The ordering is the contract. An operator whose connection is
		// misconfigured must learn that from the router, not from an Azure error
		// about a workspace they never named.
		const { cmd, calls, adapter } = build({ records: [inWindow()] });

		await cmd.run(["query"]);

		expect(calls).toEqual([CONTEXT_PATH]);
		expect(adapter.queries).toHaveLength(1);
	});

	it("does not send log records back through the router", async () => {
		// The whole architecture: the router describes the source, the client reads
		// it. Only the descriptor request is ever made.
		const { cmd, calls } = build({ records: [inWindow()] });

		await cmd.run(["query"]);

		expect(calls.filter((path) => path !== CONTEXT_PATH)).toEqual([]);
	});

	it("scopes the query to the selected workspace", async () => {
		const { cmd, adapter } = build({ records: [inWindow()] });

		await cmd.run(["query"]);

		expect(adapter.queries[0]?.workspaceId).toBe("ws-1");
	});

	it("defaults the lookback to what the descriptor advertises", async () => {
		// The default belongs to the SOURCE, not to this CLI: how far back a source
		// can usefully be read is a property of its retention and cost.
		const { cmd, adapter } = build();

		await cmd.run(["query"]);

		expect(adapter.queries[0]?.range).toEqual({
			from: "2026-09-07T00:00:00.000Z",
			to: NOW,
		});
	});

	it("honours --since", async () => {
		const { cmd, adapter } = build();

		await cmd.run(["query", "--since", "5m"]);

		expect(adapter.queries[0]?.range.from).toBe("2026-09-07T00:10:00.000Z");
	});

	it.each([
		["30s", "2026-09-07T00:14:30.000Z"],
		["5m", "2026-09-07T00:10:00.000Z"],
		["2h", "2026-09-06T22:15:00.000Z"],
		["1d", "2026-09-06T00:15:00.000Z"],
		["90", "2026-09-07T00:13:30.000Z"],
	])("parses the duration %s", async (since, from) => {
		const { cmd, adapter } = build();

		await cmd.run(["query", "--since", since]);

		expect(adapter.queries[0]?.range.from).toBe(from);
	});

	it("honours an explicit --from and --to", async () => {
		const { cmd, adapter } = build();

		await cmd.run([
			"query",
			"--from",
			"2026-09-06T00:00:00Z",
			"--to",
			"2026-09-06T01:00:00Z",
		]);

		expect(adapter.queries[0]?.range).toEqual({
			from: "2026-09-06T00:00:00.000Z",
			to: "2026-09-06T01:00:00.000Z",
		});
	});

	it("forwards every filter to the adapter", async () => {
		const { cmd, adapter } = build();

		await cmd.run([
			"query",
			"--owner",
			"user-1",
			"--team",
			"team-1",
			"--project",
			"project-1",
			"--issue",
			"NOR-402",
			"--run",
			"run-1",
			"--session",
			"session-1",
			"--component",
			"EventRouter",
			"--trace",
			"0af7651916cd43dd8448eb211c80319c",
			"--text",
			"timed out",
			"--level",
			"warn",
			"--level",
			"error",
			"--limit",
			"100",
		]);

		expect(adapter.queries[0]).toMatchObject({
			ownerUserId: "user-1",
			teamId: "team-1",
			projectId: "project-1",
			issueKey: "NOR-402",
			runId: "run-1",
			sessionId: "session-1",
			component: "EventRouter",
			traceId: "0af7651916cd43dd8448eb211c80319c",
			text: "timed out",
			// Accumulated, not last-wins: keeping only the last would silently drop
			// half of a two-level filter.
			levels: ["warn", "error"],
			limit: 100,
		});
	});

	describe("output streams", () => {
		it("writes one parseable JSON document to stdout and nothing else", async () => {
			// An orchestrator pipes stdout straight into a parser, so one stray line
			// makes the whole document unreadable.
			const { cmd, out } = build({ records: [inWindow()] });

			await cmd.run(["query", "--json"]);

			expect(out.data_).toHaveLength(1);
			const document = JSON.parse(out.data_[0] as string);
			expect(document).toMatchObject({
				schemaVersion: 1,
				workspace: { workspaceId: "ws-1" },
				source: "cyrus-router logs",
				range: { from: "2026-09-07T00:00:00.000Z", to: NOW },
			});
			expect(document.records).toHaveLength(1);
		});

		it("writes the generated query to stderr, never stdout", async () => {
			const { cmd, out } = build({ records: [inWindow()] });

			await cmd.run(["query", "--json", "--show-query"]);

			expect(out.data_).toHaveLength(1);
			expect(() => JSON.parse(out.data_[0] as string)).not.toThrow();
			expect(out.diagnostics.join("\n")).toContain("range");
		});

		it("shows the query even when the backend failed", async () => {
			// The case the flag exists for: an operator debugging why a filter
			// returned nothing needs the text that was sent.
			const adapter = new FakeLogSourceAdapter({
				failure: Object.assign(new Error("backend down"), {
					exitCode: ExitCode.transient,
				}),
			});
			const { cmd, out } = build({ adapter });

			await expect(cmd.run(["query", "--show-query"])).rejects.toThrow();
			expect(out.diagnostics.join("\n")).toContain("range");
		});

		it("says nothing about the query when --show-query is absent", async () => {
			const { cmd, out } = build({ records: [inWindow()] });

			await cmd.run(["query"]);

			expect(out.diagnostics).toEqual([]);
		});

		it("renders human lines by default", async () => {
			const { cmd, out } = build({
				records: [inWindow({ message: "routed NOR-402" })],
			});

			await cmd.run(["query"]);

			expect(out.data_[0]).toContain("routed NOR-402");
			expect(out.data_[0]).toContain("INFO");
			expect(out.data_[0]).toContain("[EventRouter]");
		});

		it("says so plainly when nothing matched", async () => {
			// An empty result and a failed one must not look the same.
			const { cmd, out } = build({ records: [] });

			await cmd.run(["query"]);

			expect(out.data_[0]).toContain("No log records");
		});

		it("reports rows that were not Cyrus records", async () => {
			// Reported so a surprisingly empty result is explainable rather than
			// mysterious.
			const adapter = new FakeLogSourceAdapter({});
			const original = adapter.query.bind(adapter);
			adapter.query = async (...args) => ({
				...(await original(...args)),
				skipped: 3,
			});
			const { cmd, out } = build({ adapter });

			await cmd.run(["query"]);

			expect(out.diagnostics.join("\n")).toContain("3 line(s)");
		});
	});

	describe("refusals", () => {
		it("refuses a router that does not grant log queries", async () => {
			const { cmd } = build({
				body: context({ capabilities: ["runs.list"], logSource: undefined }),
			});

			await expect(cmd.run(["query"])).rejects.toMatchObject({
				exitCode: ExitCode.usage,
			});
		});

		it("distinguishes a granted capability with no configured source", async () => {
			// Different remedies: one is a grant to ask an administrator for, the
			// other is a router configuration to add.
			const { cmd } = build({
				body: context({ logSource: undefined }),
			});

			await expect(cmd.run(["query"])).rejects.toThrow(
				/advertises no log source/,
			);
		});

		it("refuses an unknown option rather than ignoring it", async () => {
			// A flag that parses and does nothing reads as an answered question.
			const { cmd } = build();

			await expect(cmd.run(["query", "--stalled"])).rejects.toMatchObject({
				exitCode: ExitCode.usage,
			});
		});

		it("refuses a stray positional argument", async () => {
			const { cmd } = build();

			await expect(cmd.run(["query", "NOR-402"])).rejects.toThrow(
				/Unexpected argument/,
			);
		});

		it("refuses --since together with --from", async () => {
			// Both name the start of the window; honouring one silently would answer
			// a question the operator did not ask.
			const { cmd } = build();

			await expect(
				cmd.run(["query", "--since", "5m", "--from", "2026-09-06T00:00:00Z"]),
			).rejects.toThrow(/use one/);
		});

		it("refuses a --from that is not before --to", async () => {
			const { cmd } = build();

			await expect(
				cmd.run([
					"query",
					"--from",
					"2026-09-06T02:00:00Z",
					"--to",
					"2026-09-06T01:00:00Z",
				]),
			).rejects.toThrow(/must be before/);
		});

		it("refuses an unparseable duration", async () => {
			const { cmd } = build();

			await expect(cmd.run(["query", "--since", "soon"])).rejects.toThrow(
				/30s, 15m, 2h, or 1d/,
			);
		});

		it("refuses an unknown level, naming every valid one", async () => {
			const { cmd } = build();

			await expect(cmd.run(["query", "--level", "trace"])).rejects.toThrow(
				/debug, info, warn, error/,
			);
		});

		it("refuses a malformed trace id at the wire contract", async () => {
			// `logQueryV1Schema` is strict and this is where a bad value fails —
			// before it reaches an adapter and becomes a query that matches nothing.
			const { cmd } = build();

			await expect(
				cmd.run(["query", "--trace", "not-a-trace"]),
			).rejects.toMatchObject({ exitCode: ExitCode.usage });
		});

		it("refuses --interval on a one-shot query", async () => {
			const { cmd } = build();

			await expect(cmd.run(["query", "--interval", "30"])).rejects.toThrow(
				/logs follow/,
			);
		});

		it("refuses an unknown subcommand", async () => {
			const { cmd } = build();

			await expect(cmd.run(["tail"])).rejects.toThrow(/logs <query\|follow>/);
		});

		it("requires --workspace when the connection authorizes more than one", async () => {
			const { cmd } = build({
				body: context({
					authorizedWorkspaces: [
						{ workspaceId: "ws-1" },
						{ workspaceId: "ws-2" },
					],
				}),
			});

			await expect(cmd.run(["query"])).rejects.toThrow(/--workspace/);
		});
	});

	describe("exit codes", () => {
		it("exits 0 whatever the records say", async () => {
			// A window full of errors is a successful answer to "what was logged".
			const { cmd } = build({ records: [inWindow({ level: "error" })] });

			expect(await exitCodeOf(cmd, ["query"])).toBe(ExitCode.success);
		});

		it("exits 2 when a budget is exceeded rather than truncating", async () => {
			const { cmd, out } = build({
				records: [inWindow({ recordId: "a" }), inWindow({ recordId: "b" })],
			});

			expect(await exitCodeOf(cmd, ["query", "--limit", "1"])).toBe(
				ExitCode.usage,
			);
			expect(out.data_).toEqual([]);
		});

		it("exits 5 when the router refuses the credential", async () => {
			// Kept apart from transient: retrying an unauthorized request is pure
			// noise against the router.
			const { cmd } = build({ body: { error: "forbidden" }, status: 403 });

			expect(await exitCodeOf(cmd, ["query"])).toBe(ExitCode.auth);
		});

		it("exits 5 when the credential is missing entirely", async () => {
			const out = createRecordingOutput();
			const { fetchFn } = router();
			const cmd = new LogsCommand(fakeApp(), {
				fetchFn,
				env: {},
				output: out,
				now: () => Date.parse(NOW),
				registry: new LogAdapterRegistry({
					factories: { fake: () => new FakeLogSourceAdapter({}) },
				}),
			});

			expect(await exitCodeOf(cmd, ["query"])).toBe(ExitCode.auth);
		});

		it("exits 6 when the backend fails transiently", async () => {
			const adapter = new FakeLogSourceAdapter({
				failure: Object.assign(new Error("service unavailable"), {
					exitCode: ExitCode.transient,
				}),
			});
			const { cmd } = build({ adapter });

			expect(await exitCodeOf(cmd, ["query"])).toBe(ExitCode.transient);
		});

		it("exits 6 when the router cannot be reached", async () => {
			const fetchFn = vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch;
			const cmd = new LogsCommand(fakeApp(), {
				fetchFn,
				env: { CYRUS_OPERATOR_TOKEN: "cyop_deadbeefdeadbeef" },
				output: createRecordingOutput(),
				now: () => Date.parse(NOW),
			});

			expect(await exitCodeOf(cmd, ["query"])).toBe(ExitCode.transient);
		});

		it("writes the failure to stderr, leaving stdout empty and parseable", async () => {
			const { cmd, out } = build({ body: { error: "nope" }, status: 403 });

			await exitCodeOf(cmd, ["query", "--json"]);

			expect(out.data_).toEqual([]);
			expect(out.diagnostics.length).toBeGreaterThan(0);
		});

		it("redacts the operator token out of a failure message", async () => {
			const { cmd, out } = build({
				body: { error: "rejected token cyop_deadbeefdeadbeef" },
				status: 403,
			});

			await exitCodeOf(cmd, ["query"]);

			expect(out.diagnostics.join("\n")).not.toContain("cyop_deadbeefdeadbeef");
		});

		it("lets an unexpected defect crash rather than reporting it as retryable", async () => {
			// A bug reported as `6` tells an operator to retry a command that will
			// never succeed.
			const adapter = new FakeLogSourceAdapter({
				failure: new TypeError("undefined is not a function"),
			});
			const { cmd } = build({ adapter });

			await expect(exitCodeOf(cmd, ["query"])).rejects.toThrow(TypeError);
		});
	});
});

describe("cyrus logs follow", () => {
	/**
	 * A clock that advances one second per READ.
	 *
	 * `follow` reads the clock more than once per iteration (the deadline check,
	 * then the window's end), so the step has to be small relative to the timeouts
	 * below or the deadline is met before the first poll is even issued — which
	 * looks exactly like a follow that refused to poll.
	 */
	function tickingClock(startIso = NOW, stepMs = 1_000): () => number {
		let current = Date.parse(startIso);
		return () => {
			const value = current;
			current += stepMs;
			return value;
		};
	}

	it("polls repeatedly until its timeout", async () => {
		const adapter = new FakeLogSourceAdapter({});
		const { cmd } = build({ adapter, now: tickingClock() });

		await cmd.run(["follow", "--timeout", "180"]);

		expect(adapter.queries.length).toBeGreaterThan(1);
	});

	it("emits each record once across overlapping windows", async () => {
		// The overlap re-reads the tail of the previous window because a record is
		// queryable only once ingested. Without fingerprint deduplication every
		// record in the overlap would be printed on every poll.
		const adapter = new FakeLogSourceAdapter({
			records: [inWindow({ recordId: "only", message: "the one line" })],
		});
		const { cmd, out } = build({ adapter, now: tickingClock() });

		await cmd.run(["follow", "--timeout", "300", "--json"]);

		const emitted = out.data_
			.map(
				(line) => JSON.parse(line) as { event: string; record?: LogRecordV1 },
			)
			.filter((event) => event.event === "record");
		expect(emitted).toHaveLength(1);
		expect(emitted[0]?.record?.message).toBe("the one line");
	});

	it("re-reads an overlap rather than resuming exactly where it stopped", async () => {
		// A poll that asked only for "since my last poll" would silently skip every
		// record ingested after that window closed.
		const adapter = new FakeLogSourceAdapter({});
		const { cmd } = build({ adapter, now: tickingClock() });

		await cmd.run(["follow", "--timeout", "180"]);

		const [first, second] = adapter.queries;
		expect(second).toBeDefined();
		expect(Date.parse(second?.range.from as string)).toBeLessThan(
			Date.parse(first?.range.to as string),
		);
	});

	it("emits NDJSON, one record per line", async () => {
		const adapter = new FakeLogSourceAdapter({
			records: [
				inWindow({ recordId: "a", message: "a" }),
				inWindow({ recordId: "b", message: "b" }),
			],
		});
		const { cmd, out } = build({ adapter, now: tickingClock() });

		await cmd.run(["follow", "--timeout", "120", "--json"]);

		for (const line of out.data_) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
	});

	it("never presents itself as a live router stream", async () => {
		// Someone reading a quiet screen must not conclude the fleet is quiet.
		const { cmd, out } = build({ now: tickingClock() });

		await cmd.run(["follow", "--timeout", "60"]);

		expect(out.diagnostics.join("\n")).toContain("not a live router stream");
	});

	it("widens its overlap when the backend reports worse lag", async () => {
		const adapter = new FakeLogSourceAdapter({});
		const original = adapter.query.bind(adapter);
		adapter.query = async (...args) => ({
			...(await original(...args)),
			maxIngestionLagMs: 240_000,
		});
		const { cmd, out } = build({ adapter, now: tickingClock() });

		await cmd.run(["follow", "--timeout", "180"]);

		expect(out.diagnostics.join("\n")).toContain("widening the re-read window");
	});

	it("stops cleanly at its timeout, saying so", async () => {
		// A follow that ends without a marker is indistinguishable from one that
		// was killed mid-write.
		const { cmd, out } = build({ now: tickingClock() });

		await cmd.run(["follow", "--timeout", "60", "--json"]);

		const last = JSON.parse(out.data_.at(-1) as string);
		expect(last).toMatchObject({ event: "stopped", reason: "timeout" });
	});

	it("exits 0 after a clean stop", async () => {
		const { cmd } = build({ now: tickingClock() });

		expect(await exitCodeOf(cmd, ["follow", "--timeout", "60"])).toBe(
			ExitCode.success,
		);
	});

	it("refuses a poll interval faster than the source allows", async () => {
		// Refused rather than clamped: an operator who asked for one-second polling
		// and silently got fifteen would read the gaps as a quiet fleet.
		const { cmd } = build();

		await expect(
			cmd.run(["follow", "--interval", "1", "--timeout", "60"]),
		).rejects.toThrow(/no faster than 15s/);
	});

	it("defaults its interval to the source's floor", async () => {
		const sleep = vi.fn(async () => {});
		const out = createRecordingOutput();
		const { fetchFn } = router();
		const cmd = new LogsCommand(fakeApp(), {
			fetchFn,
			env: { CYRUS_OPERATOR_TOKEN: "cyop_deadbeefdeadbeef" },
			output: out,
			sleep,
			now: tickingClock(),
			registry: new LogAdapterRegistry({
				factories: { fake: () => new FakeLogSourceAdapter({}) },
			}),
		});

		await cmd.run(["follow", "--timeout", "120"]);

		expect(sleep).toHaveBeenCalledWith(15_000);
	});

	it("propagates a backend failure rather than polling through it", async () => {
		// A transient error rendered as "no new records" is indistinguishable from
		// a healthy, quiet fleet.
		const adapter = new FakeLogSourceAdapter({
			failure: Object.assign(new Error("service unavailable"), {
				exitCode: ExitCode.transient,
			}),
		});
		const { cmd } = build({ adapter, now: tickingClock() });

		expect(await exitCodeOf(cmd, ["follow", "--timeout", "60"])).toBe(
			ExitCode.transient,
		);
	});

	it("reads the descriptor once, not on every poll", async () => {
		const adapter = new FakeLogSourceAdapter({});
		const { cmd, calls } = build({ adapter, now: tickingClock() });

		await cmd.run(["follow", "--timeout", "300"]);

		expect(calls).toEqual([CONTEXT_PATH]);
		expect(adapter.queries.length).toBeGreaterThan(1);
	});
});
