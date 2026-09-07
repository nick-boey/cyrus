import {
	type AuthorizedWorkspaceV1,
	type LogLevelV1,
	type LogQueryV1,
	type LogRecordV1,
	type LogSourceDescriptorV1,
	logLevelV1Schema,
	logQueryV1Schema,
} from "cyrus-operator-protocol";
import type { Application } from "../Application.js";
import { ConnectionStore } from "../remote/ConnectionStore.js";
import {
	createCredentialProvider,
	type EntraCredentialCandidate,
} from "../remote/credentials.js";
import { redactSecrets, UsageError } from "../remote/errors.js";
import { exitCodeFor } from "../remote/exitCodes.js";
import { LogAdapterRegistry } from "../remote/logs/LogAdapterRegistry.js";
import type { LogSourceAdapter } from "../remote/logs/LogSourceAdapter.js";
import {
	OperatorHttpClient,
	requireCapability,
	selectWorkspace,
} from "../remote/OperatorHttpClient.js";
import {
	createOutputStreams,
	logsFollowEvent,
	logsQueryDocument,
	type OutputStreams,
	renderLogRecord,
} from "../remote/output.js";
import { BaseCommand } from "./ICommand.js";

/**
 * How far back a query looks when the operator names no range and the router
 * advertises no default. The descriptor's budget wins whenever it has one.
 */
const FALLBACK_LOOKBACK_SECONDS = 15 * 60;

/**
 * How much of the previous window each `follow` poll re-reads.
 *
 * A record is queryable only once Log Analytics has INGESTED it, which happens
 * tens of seconds after it was written. A poll that asked only for "since my
 * last poll" would therefore silently skip every record whose ingestion landed
 * after that window closed — and would do so most on a busy fleet, when it
 * matters most. The overlap is re-read on purpose and the duplicates are
 * suppressed by fingerprint.
 *
 * Grown at runtime when the backend reports worse lag than this, because a fixed
 * overlap is a guess and the honest number arrives with every result.
 */
const DEFAULT_FOLLOW_OVERLAP_MS = 90_000;

/** Ceiling on the adaptive overlap, so one outlier cannot widen every poll. */
const MAX_FOLLOW_OVERLAP_MS = 10 * 60_000;

/**
 * How many record fingerprints a `follow` remembers.
 *
 * Bounds memory on a follow that runs for hours. Sized well past what one
 * overlap window can contain, because a fingerprint evicted while its record is
 * still inside the overlap would be re-emitted as new.
 */
const FOLLOW_DEDUP_CAPACITY = 50_000;

export interface LogsCommandContext {
	connection?: string;
	workspace?: string;
}

export interface LogsCommandDeps {
	fetchFn?: typeof fetch;
	env?: NodeJS.ProcessEnv;
	entraChain?: EntraCredentialCandidate[];
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	output?: OutputStreams;
	/** Injected so command tests exercise the command, not a backend. */
	registry?: LogAdapterRegistry;
}

/**
 * Reads fleet logs from the router's advertised log source:
 *
 *   cyrus logs query  [filters] [--since 30m] [--json]
 *   cyrus logs follow [filters] [--interval 15] [--json]
 *
 * ── THE COMMAND KNOWS NO QUERY LANGUAGE ──
 * It asks the router WHERE the logs are (CYR-71's descriptor), compiles the
 * operator's flags into a normalized `LogQueryV1`, and hands both to an adapter.
 * No KQL, no table name, and no Azure column appears in this file — that is an
 * acceptance criterion, and it is what makes "an operator cannot inject a
 * query" a property of the design rather than of a validation routine.
 *
 * ── THE ROUTER IS ASKED FIRST, AND ONLY FOR THE DESCRIPTOR ──
 * Log records never travel back through the router. The router says where to
 * look; this process authenticates to the backend with LOCAL credentials and
 * reads it directly. Ordering matters and is asserted: the descriptor request
 * precedes any backend access, so an operator whose connection is misconfigured
 * gets a router error rather than an Azure one.
 *
 * ── `follow` IS NOT A LIVE STREAM AND NEVER CLAIMS TO BE ──
 * It polls a historical store whose contents lag reality. Every follow reports
 * the ingestion lag it observed, so what an operator is looking at is dated
 * rather than implied to be current. Anything that presented this as a live
 * router stream would be inviting someone to conclude, from a quiet screen, that
 * a fleet was quiet.
 */
export class LogsCommand extends BaseCommand {
	private readonly store: ConnectionStore;
	private readonly out: OutputStreams;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly registry: LogAdapterRegistry;

	constructor(
		app: Application,
		private readonly deps: LogsCommandDeps = {},
	) {
		super(app);
		this.store = new ConnectionStore(app.config);
		this.out = deps.output ?? createOutputStreams();
		this.now = deps.now ?? (() => Date.now());
		this.sleep =
			deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.registry =
			deps.registry ??
			new LogAdapterRegistry({
				...(deps.env ? { env: deps.env } : {}),
				...(deps.entraChain ? { entraChain: deps.entraChain } : {}),
			});
	}

	/**
	 * Commander entry point. Converts the remote-operator failure vocabulary into
	 * the exit categories ADR 0011 fixes, exactly as `RunsCommand` does — the two
	 * commands are read by the same orchestrator and must not disagree about what
	 * a code means.
	 */
	async execute(
		argv: string[],
		context: LogsCommandContext = {},
	): Promise<void> {
		try {
			await this.run(argv, context);
		} catch (error) {
			const code = exitCodeFor(error);
			// Anything without a category is an unexpected defect and propagates as
			// the crash it is. Flattening one into `6` would tell an operator to
			// retry a command that will never succeed.
			if (code === undefined) throw error;
			this.out.diagnostic(redactSecrets((error as Error).message));
			await this.out.flush();
			process.exit(code);
			return;
		}
	}

	/** The real work, throwing rather than exiting so tests can assert category. */
	async run(argv: string[], context: LogsCommandContext = {}): Promise<void> {
		const [subcommand, ...rest] = argv;
		switch (subcommand) {
			case "query":
				return this.query(rest, context);
			case "follow":
				return this.follow(rest, context);
			default:
				throw new UsageError(
					`Usage: cyrus logs <query|follow> [filters]${
						subcommand ? ` (got "${subcommand}")` : ""
					}`,
				);
		}
	}

	/* ----------------------------------------------------------------- query */

	/**
	 * One window of history, read once.
	 *
	 * Exits 0 whatever the records say. The command answers "what was logged",
	 * and a window full of errors is a successful answer to that question — an
	 * exit code that varied with the contents would make the read itself
	 * indistinguishable from a backend that could not be reached.
	 */
	private async query(
		argv: string[],
		context: LogsCommandContext,
	): Promise<void> {
		const options = parseLogsOptions(argv, {
			usage: "cyrus logs query [filters] [--since <duration>] [--json]",
			allowInterval: false,
		});
		const { adapter, descriptor, workspace } = await this.connect(
			options,
			context,
		);

		const range = this.resolveRange(descriptor, options);
		const query = this.buildQuery(options, workspace, range);
		const result = await this.ask(adapter, descriptor, query, options);
		this.reportSkipped(result.skipped);

		if (options.json) {
			this.out.data(
				JSON.stringify(
					logsQueryDocument({
						observedAt: new Date(this.now()).toISOString(),
						workspace,
						source: describeSource(descriptor),
						range,
						records: result.records,
						...(result.backendLatencyMs !== undefined
							? { backendLatencyMs: result.backendLatencyMs }
							: {}),
						...(result.maxIngestionLagMs !== undefined
							? { ingestionLagMs: result.maxIngestionLagMs }
							: {}),
					}),
				),
			);
			return;
		}

		if (result.records.length === 0) {
			this.out.data(
				`No log records between ${range.from} and ${range.to}${describeFilters(options)}.`,
			);
			return;
		}
		for (const record of result.records) {
			this.out.data(renderLogRecord(record));
		}
		this.reportLag(result.maxIngestionLagMs);
	}

	/* ---------------------------------------------------------------- follow */

	/**
	 * Repeated windows, overlapped and deduplicated, until timeout or Ctrl-C.
	 *
	 * Each poll re-reads the tail of the previous window because a record becomes
	 * queryable only once ingested, which is well after it was written. The
	 * duplicates that produces are suppressed by the record fingerprint, which is
	 * a pure function of the row's content — so the same line read twice is
	 * recognisably the same line, whatever order the backend returned its columns
	 * in.
	 */
	private async follow(
		argv: string[],
		context: LogsCommandContext,
	): Promise<void> {
		const options = parseLogsOptions(argv, {
			usage:
				"cyrus logs follow [filters] [--since <duration>] [--interval <seconds>] [--json]",
			allowInterval: true,
		});
		const { adapter, descriptor, workspace } = await this.connect(
			options,
			context,
		);

		const intervalMs = this.resolveFollowInterval(descriptor, options);
		const deadline =
			options.timeoutMs === undefined
				? undefined
				: this.now() + options.timeoutMs;
		const interrupt = this.installInterruptHandler();

		// The first poll covers the operator's requested lookback; every later one
		// resumes from the previous window's end, minus the overlap.
		const opening = this.resolveRange(descriptor, options);
		let from = opening.from;
		let overlapMs = DEFAULT_FOLLOW_OVERLAP_MS;
		const seen = new FingerprintWindow(FOLLOW_DEDUP_CAPACITY);

		this.out.diagnostic(
			`Following ${describeSource(descriptor)} every ${Math.round(intervalMs / 1000)}s. ` +
				"This is a historical store polled on a delay, not a live router stream; records appear once the backend has ingested them.",
		);

		try {
			while (true) {
				if (interrupt.requested) {
					this.emitFollowStop(options, "interrupted");
					return;
				}
				if (deadline !== undefined && this.now() >= deadline) {
					this.emitFollowStop(options, "timeout");
					return;
				}

				const to = new Date(this.now()).toISOString();
				// A clock that has not advanced past `from` — a very fast loop, or a
				// stubbed clock in a test — would produce a range the wire contract
				// refuses ("must move forward in time"). Waiting is the honest
				// response: there is nothing new to ask about yet.
				if (Date.parse(to) <= Date.parse(from)) {
					await this.sleep(intervalMs);
					continue;
				}

				const query = this.buildQuery(options, workspace, { from, to });
				const result = await this.ask(adapter, descriptor, query, options);
				this.reportSkipped(result.skipped);

				for (const record of result.records) {
					if (seen.has(record.recordId)) continue;
					seen.add(record.recordId);
					this.emitFollowRecord(options, record);
				}

				// Widened, never narrowed, and only by what the backend actually
				// reported. A lag spike that shrank the overlap on the next poll would
				// drop exactly the records the spike delayed.
				if (
					result.maxIngestionLagMs !== undefined &&
					result.maxIngestionLagMs > overlapMs
				) {
					overlapMs = Math.min(
						MAX_FOLLOW_OVERLAP_MS,
						Math.ceil(result.maxIngestionLagMs * 1.5),
					);
					this.out.diagnostic(
						`Observed ingestion lag of ${Math.round(result.maxIngestionLagMs / 1000)}s; ` +
							`widening the re-read window to ${Math.round(overlapMs / 1000)}s.`,
					);
				}

				from = new Date(Date.parse(to) - overlapMs).toISOString();
				await this.sleep(intervalMs);
			}
		} finally {
			interrupt.dispose();
		}
	}

	private emitFollowRecord(options: LogsOptions, record: LogRecordV1): void {
		if (options.json) {
			this.out.data(JSON.stringify(logsFollowEvent(record)));
			return;
		}
		this.out.data(renderLogRecord(record));
	}

	private emitFollowStop(
		options: LogsOptions,
		reason: "timeout" | "interrupted",
	): void {
		const observedAt = new Date(this.now()).toISOString();
		if (options.json) {
			this.out.data(
				JSON.stringify({
					schemaVersion: 1 as const,
					event: "stopped" as const,
					observedAt,
					reason,
				}),
			);
			return;
		}
		// A follow that dies mid-write leaves output a reader cannot distinguish
		// from a stream still in progress. Saying so is what makes "the operator
		// stopped this" observable.
		this.out.diagnostic(`${observedAt}  stopped  ${reason}`);
	}

	/* ---------------------------------------------------------------- shared */

	/**
	 * Resolves the connection, proves the router serves log queries, reads the
	 * descriptor, and picks the adapter.
	 *
	 * ── ORDER IS THE CONTRACT ──
	 * The descriptor is fetched BEFORE anything touches the backend, and the
	 * capability is checked before that. A router that does not serve a route
	 * answers 404, which is indistinguishable from a route that exists and found
	 * nothing; and an operator whose connection is wrong should learn that from
	 * the router rather than from an Azure error about a workspace they never
	 * named.
	 */
	private async connect(
		options: LogsOptions,
		context: LogsCommandContext,
	): Promise<{
		adapter: LogSourceAdapter;
		descriptor: LogSourceDescriptorV1;
		workspace: AuthorizedWorkspaceV1;
	}> {
		const record = this.store.select(options.connection ?? context.connection);
		const client = new OperatorHttpClient({
			baseUrl: record.connection.url,
			...(this.deps.fetchFn ? { fetchFn: this.deps.fetchFn } : {}),
			credentials: createCredentialProvider(record.connection, {
				...(this.deps.env ? { env: this.deps.env } : {}),
				...(this.deps.entraChain ? { entraChain: this.deps.entraChain } : {}),
			}),
		});

		const { context: operatorContext } = await client.context();
		requireCapability(operatorContext, "logs.query");

		const descriptor = operatorContext.logSource;
		if (!descriptor) {
			// The capability is granted but no source is configured. Distinguished
			// from a missing capability on purpose: one is a grant to ask an
			// administrator for, the other is a router configuration to add, and
			// telling an operator the wrong one sends them to the wrong person.
			throw new UsageError(
				"This router grants log queries but advertises no log source. " +
					"An administrator sets one with `observability.logSource` in the router config (see `cyrus router config`).",
			);
		}

		const workspace = selectWorkspace(
			operatorContext,
			options.workspace ?? context.workspace,
		);
		return {
			adapter: this.registry.resolve(descriptor),
			descriptor,
			workspace,
		};
	}

	/**
	 * Compiles the operator's flags into the normalized query, validated against
	 * the wire contract before it reaches an adapter.
	 *
	 * Parsed through `logQueryV1Schema` rather than merely constructed: the schema
	 * is STRICT, so this is where a filter that was added to the CLI and forgotten
	 * in the contract fails loudly instead of being silently dropped and widening
	 * a query the operator believed they had narrowed.
	 */
	private buildQuery(
		options: LogsOptions,
		workspace: AuthorizedWorkspaceV1,
		range: { from: string; to: string },
	): LogQueryV1 {
		const candidate = {
			schemaVersion: 1,
			range,
			// The selected workspace scopes every query, exactly as it scopes a run
			// listing. An operator authorized over two workspaces reads one at a
			// time, and a log line's workspace is a stored fact (CYR-72), so this is
			// a filter rather than a client-side hope.
			workspaceId: workspace.workspaceId,
			...defined("ownerUserId", options.owner),
			...defined("teamId", options.team),
			...defined("projectId", options.project),
			...defined("issueKey", options.issue),
			...defined("runId", options.run),
			...defined("sessionId", options.session),
			...defined("component", options.component),
			...defined("traceId", options.trace),
			...defined("text", options.text),
			...(options.levels ? { levels: options.levels } : {}),
			...(options.limit !== undefined ? { limit: options.limit } : {}),
		};

		const parsed = logQueryV1Schema.safeParse(candidate);
		if (!parsed.success) {
			throw new UsageError(
				`These filters do not form a valid log query: ${parsed.error.issues
					.slice(0, 5)
					.map((issue) =>
						issue.path.length
							? `${issue.path.map(String).join(".")}: ${issue.message}`
							: issue.message,
					)
					.join("; ")}`,
			);
		}
		return parsed.data;
	}

	/**
	 * Runs one adapter query, printing the generated backend query if asked.
	 *
	 * The print happens in a `finally` so that a query which FAILED is still
	 * shown. That is the case `--show-query` exists for: an operator debugging why
	 * a filter returned nothing needs the text that was sent, and a flag that
	 * printed only on success would go quiet exactly when it was needed.
	 */
	private async ask(
		adapter: LogSourceAdapter,
		descriptor: LogSourceDescriptorV1,
		query: LogQueryV1,
		options: LogsOptions,
	): Promise<Awaited<ReturnType<LogSourceAdapter["query"]>>> {
		try {
			return await adapter.query(descriptor, query);
		} finally {
			this.showQuery(options, adapter, query);
		}
	}

	/**
	 * The window to read, from `--since` or from `--from`/`--to`.
	 *
	 * The DEFAULT comes from the descriptor, not from a constant here: how far
	 * back a source can usefully be read is a property of its retention and cost,
	 * the router publishes it, and a client-side default would be wrong on every
	 * deployment that tuned it.
	 */
	private resolveRange(
		descriptor: LogSourceDescriptorV1,
		options: LogsOptions,
	): { from: string; to: string } {
		const to = options.to ?? new Date(this.now()).toISOString();
		if (options.from) {
			if (Date.parse(options.from) >= Date.parse(to)) {
				throw new UsageError(
					`--from (${options.from}) must be before --to (${to}).`,
				);
			}
			return { from: options.from, to };
		}
		const lookbackSeconds =
			options.sinceSeconds ??
			descriptor.budgets.defaultLookbackSeconds ??
			FALLBACK_LOOKBACK_SECONDS;
		return {
			from: new Date(Date.parse(to) - lookbackSeconds * 1000).toISOString(),
			to,
		};
	}

	/**
	 * The follow cadence, refusing anything faster than the source allows.
	 *
	 * REFUSED rather than clamped: an operator who asked for one-second polling
	 * and silently got fifteen would read the gaps as a quiet fleet. The floor is
	 * the source's own, because polling rate is what a log backend bills for.
	 */
	private resolveFollowInterval(
		descriptor: LogSourceDescriptorV1,
		options: LogsOptions,
	): number {
		const floor = descriptor.budgets.minFollowIntervalSeconds;
		if (options.intervalSeconds === undefined) return floor * 1000;
		if (options.intervalSeconds < floor) {
			throw new UsageError(
				`This log source allows a follow interval no faster than ${floor}s, and ${options.intervalSeconds}s was requested.`,
			);
		}
		return options.intervalSeconds * 1000;
	}

	/**
	 * Writes the generated query to STDERR when asked.
	 *
	 * stderr, always. stdout is the machine contract — an orchestrator pipes it
	 * straight into a parser — and one query on the wrong stream makes every
	 * document alongside it unparseable.
	 *
	 * Called both before and after the adapter runs because an adapter compiles
	 * its query internally: the pre-call shows a query that failed to compile at
	 * all, and the post-call shows the text that was actually sent.
	 */
	private showQuery(
		options: LogsOptions,
		adapter: LogSourceAdapter,
		query: LogQueryV1,
	): void {
		if (!options.showQuery) return;
		const compiled = (adapter as { lastQuery?: string }).lastQuery;
		const text = compiled ?? JSON.stringify(query);
		if (text === this.lastShownQuery) return;
		this.lastShownQuery = text;
		for (const line of text.split("\n")) this.out.diagnostic(line);
	}

	private lastShownQuery?: string;

	private reportSkipped(skipped: number | undefined): void {
		if (!skipped) return;
		this.out.diagnostic(
			`${skipped} line(s) in this window were not Cyrus log records and were not shown ` +
				"(a container's stdout also carries runtime output we did not write).",
		);
	}

	private reportLag(lagMs: number | undefined): void {
		if (lagMs === undefined) return;
		this.out.diagnostic(
			`Observed backend ingestion lag of up to ${Math.round(lagMs / 1000)}s; records written more recently than that may not be queryable yet.`,
		);
	}

	/**
	 * Turns Ctrl-C into a clean end of stream rather than a killed process.
	 *
	 * Identical in shape to `RunsCommand`'s, including the second-Ctrl-C escape:
	 * registering any SIGINT listener disables Node's own, so between here and the
	 * next loop check the process is uninterruptible — up to a full poll interval.
	 * An operator pressing Ctrl-C twice must never have to reach for `kill`.
	 */
	private installInterruptHandler(): { requested: boolean; dispose(): void } {
		const state = {
			requested: false,
			dispose(): void {
				process.off("SIGINT", onInterrupt);
			},
		};
		const onInterrupt = (): void => {
			if (state.requested) {
				state.dispose();
				process.kill(process.pid, "SIGINT");
				return;
			}
			state.requested = true;
		};
		process.on("SIGINT", onInterrupt);
		return state;
	}
}

/**
 * The fingerprints a `follow` has already emitted, bounded.
 *
 * Insertion-ordered eviction rather than true LRU: records arrive in time order,
 * so the oldest inserted is the oldest observed, and re-seeing a record does not
 * make it more likely to be seen again. A `Set` preserves insertion order, which
 * is all the ordering this needs.
 */
class FingerprintWindow {
	private readonly ids = new Set<string>();

	constructor(private readonly capacity: number) {}

	has(id: string): boolean {
		return this.ids.has(id);
	}

	add(id: string): void {
		this.ids.add(id);
		while (this.ids.size > this.capacity) {
			const oldest = this.ids.values().next().value;
			if (oldest === undefined) break;
			this.ids.delete(oldest);
		}
	}
}

/* ------------------------------------------------------------------ options */

interface LogsOptions {
	json: boolean;
	showQuery: boolean;
	connection?: string;
	workspace?: string;
	owner?: string;
	team?: string;
	project?: string;
	issue?: string;
	run?: string;
	session?: string;
	component?: string;
	trace?: string;
	text?: string;
	levels?: LogLevelV1[];
	limit?: number;
	sinceSeconds?: number;
	from?: string;
	to?: string;
	intervalSeconds?: number;
	timeoutMs?: number;
}

const VALUE_FLAGS = [
	["--connection", "connection"],
	["--workspace", "workspace"],
	["--owner", "owner"],
	["--team", "team"],
	["--project", "project"],
	["--issue", "issue"],
	["--run", "run"],
	["--session", "session"],
	["--component", "component"],
	["--trace", "trace"],
	["--text", "text"],
] as const satisfies ReadonlyArray<readonly [string, keyof LogsOptions]>;

/**
 * Parses the flags this command accepts, and REFUSES everything else.
 *
 * An unknown option is refused rather than ignored, for the same reason
 * `RunsCommand` refuses one: a flag that parses and does nothing reads as an
 * answered question, and the operator acts on a result that was never narrowed.
 */
function parseLogsOptions(
	argv: readonly string[],
	spec: { usage: string; allowInterval: boolean },
): LogsOptions {
	const options: LogsOptions = { json: false, showQuery: false };
	const positional: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		const valueFlag = VALUE_FLAGS.find(([flag]) => flag === arg);
		if (valueFlag) {
			const [flag, field] = valueFlag;
			options[field] = requireValue(argv[++i], flag) as never;
			continue;
		}
		switch (arg) {
			case "--json":
				options.json = true;
				break;
			case "--show-query":
				options.showQuery = true;
				break;
			case "--level": {
				const value = requireValue(argv[++i], "--level");
				const parsed = logLevelV1Schema.safeParse(value.toLowerCase());
				if (!parsed.success) {
					throw new UsageError(
						`--level must be one of ${logLevelV1Schema.options.join(", ")}, not "${value}".`,
					);
				}
				// Repeatable and accumulated. Keeping only the last occurrence — which
				// is what a naive parser does — would silently drop half of
				// `--level warn --level error`, narrowing a query the operator widened.
				options.levels = [...(options.levels ?? []), parsed.data];
				break;
			}
			case "--limit":
				options.limit = requirePositiveInt(argv[++i], "--limit");
				break;
			case "--since":
				options.sinceSeconds = parseDuration(
					requireValue(argv[++i], "--since"),
				);
				break;
			case "--from":
				options.from = requireInstant(argv[++i], "--from");
				break;
			case "--to":
				options.to = requireInstant(argv[++i], "--to");
				break;
			case "--interval":
				if (!spec.allowInterval) {
					throw new UsageError(
						`--interval applies to \`cyrus logs follow\`, not to a one-shot query. Usage: ${spec.usage}`,
					);
				}
				options.intervalSeconds = requirePositiveInt(argv[++i], "--interval");
				break;
			case "--timeout":
				if (!spec.allowInterval) {
					throw new UsageError(
						`--timeout applies to \`cyrus logs follow\`, not to a one-shot query. Usage: ${spec.usage}`,
					);
				}
				options.timeoutMs = requirePositiveInt(argv[++i], "--timeout") * 1000;
				break;
			default:
				if (arg.startsWith("-")) {
					throw new UsageError(`Unknown option: ${arg}. Usage: ${spec.usage}`);
				}
				positional.push(arg);
		}
	}

	if (positional.length > 0) {
		throw new UsageError(
			`Unexpected argument: ${positional[0]}. Usage: ${spec.usage}`,
		);
	}
	if (options.sinceSeconds !== undefined && options.from !== undefined) {
		// Both name the start of the window, and honouring one silently would make
		// the command answer a question the operator did not ask.
		throw new UsageError(
			"--since and --from both set the start of the window; use one.",
		);
	}
	return options;
}

/**
 * `30s`, `15m`, `2h`, `1d`, or a bare number of seconds.
 *
 * A bare number is seconds rather than milliseconds because every other duration
 * an operator types at this CLI (`--timeout`, `--interval`) is seconds, and a
 * unit that changed between flags is a mistake nobody catches until the query
 * returns the wrong window.
 */
export function parseDuration(value: string): number {
	const match = /^(\d+)(s|m|h|d)?$/.exec(value.trim());
	if (!match) {
		throw new UsageError(
			`--since must be a duration like 30s, 15m, 2h, or 1d, not "${value}".`,
		);
	}
	const amount = Number(match[1]);
	if (amount <= 0) {
		throw new UsageError(
			`--since must be a positive duration, not "${value}".`,
		);
	}
	const unit = match[2] ?? "s";
	const seconds = { s: 1, m: 60, h: 3600, d: 86400 }[unit] as number;
	return amount * seconds;
}

function requireValue(value: string | undefined, flag: string): string {
	if (value === undefined || value.length === 0 || value.startsWith("-")) {
		throw new UsageError(`${flag} requires a value.`);
	}
	return value;
}

function requirePositiveInt(value: string | undefined, flag: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new UsageError(`${flag} must be a positive whole number.`);
	}
	return parsed;
}

function requireInstant(value: string | undefined, flag: string): string {
	const text = requireValue(value, flag);
	const parsed = Date.parse(text);
	if (!Number.isFinite(parsed)) {
		throw new UsageError(
			`${flag} must be an ISO-8601 instant, e.g. 2026-09-07T00:00:00Z, not "${text}".`,
		);
	}
	// Normalized to UTC, because `logQueryV1Schema` refuses a numeric offset: the
	// range is compared lexicographically elsewhere, and `+10:00` sorts before
	// `Z` while denoting a later instant.
	return new Date(parsed).toISOString();
}

function defined<K extends string>(
	key: K,
	value: string | undefined,
): Record<K, string> | Record<string, never> {
	return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

function describeSource(descriptor: LogSourceDescriptorV1): string {
	return descriptor.displayName ?? descriptor.kind;
}

function describeFilters(options: LogsOptions): string {
	const parts: string[] = [];
	for (const [flag, field] of VALUE_FLAGS) {
		if (flag === "--connection" || flag === "--workspace") continue;
		const value = options[field];
		if (typeof value === "string") parts.push(`${flag} ${value}`);
	}
	if (options.levels) parts.push(`--level ${options.levels.join(",")}`);
	return parts.length === 0 ? "" : ` matching ${parts.join(" ")}`;
}
