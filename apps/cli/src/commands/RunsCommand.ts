import {
	type AuthorizedWorkspaceV1,
	isTerminalRunLifecycleState,
	type OperatorCapabilityV1,
	type RunObservationV1,
} from "cyrus-operator-protocol";
import type { Application } from "../Application.js";
import { ConnectionStore } from "../remote/ConnectionStore.js";
import {
	createCredentialProvider,
	type EntraCredentialCandidate,
} from "../remote/credentials.js";
import {
	OutcomeError,
	redactSecrets,
	StreamEpochChangedError,
	TimeoutError,
	TransientError,
	UsageError,
} from "../remote/errors.js";
import { exitCodeFor } from "../remote/exitCodes.js";
import {
	OperatorHttpClient,
	requireCapability,
	selectWorkspace,
} from "../remote/OperatorHttpClient.js";
import {
	createOutputStreams,
	type OutputStreams,
	type RunWaitDocument,
	renderRunsTable,
	renderWaitOutcome,
	renderWatchEventLines,
	runsListDocument,
	type WaitOutcome,
	type WatchEvent,
	waitDocument,
} from "../remote/output.js";
import {
	describeRunFilters,
	matchesLocalRunFilters,
	parseRunFilters,
	type RunFilters,
	toRunsQuery,
} from "../remote/runFilters.js";
import { BaseCommand } from "./ICommand.js";

/** How often a watch or a wait asks the change feed what happened. */
const DEFAULT_POLL_INTERVAL_MS = 2_000;

/**
 * A ceiling on pagination, so a router that keeps returning the same cursor
 * cannot spin a `list` forever. Reaching it is a router bug, not an operator
 * one, which is why it reports as transient rather than as usage.
 */
const MAX_LIST_PAGES = 1_000;

/** Options threaded down from the program's global fleet-selection flags. */
export interface RunsCommandContext {
	/** `--connection <name>`; falls back to the single stored connection. */
	connection?: string;
	/** `--workspace <id>`; required when a context authorizes more than one. */
	workspace?: string;
}

export interface RunsCommandDeps {
	fetchFn?: typeof fetch;
	env?: NodeJS.ProcessEnv;
	/** Injected so tests can drive the chain order without Azure present. */
	entraChain?: EntraCredentialCandidate[];
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	output?: OutputStreams;
	pollIntervalMs?: number;
}

/**
 * Observes agent runs on a remote router's fleet-operations API:
 *
 *   cyrus runs list  [filters] [--json]
 *   cyrus runs watch [filters] [--timeout <seconds>] [--json]
 *   cyrus runs wait  <runId>   [--timeout <seconds>] [--json]
 *
 * The three are deliberately distinct rather than one command with a mode flag.
 * `list` is a SNAPSHOT and succeeds whatever states it reports — an unhealthy
 * fleet is a successful read. `watch` is a STREAM of material changes and no run
 * outcome inside it can fail the command. Only `wait` has a condition of its
 * own, and only it can report a non-success outcome or a timeout. Collapsing
 * them, as the previous `runs [issue] --watch` did, meant the same invocation
 * meant three different things depending on the flags — and that its exit code
 * was unusable for any of them.
 *
 * Nothing here infers a verdict from elapsed time or silence. A run is
 * `waiting` only because a worker said so, and this command never converts "no
 * change for a while" into "stalled" (ADR 0012).
 */
export class RunsCommand extends BaseCommand {
	private readonly store: ConnectionStore;
	private readonly out: OutputStreams;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly pollIntervalMs: number;

	constructor(
		app: Application,
		private readonly deps: RunsCommandDeps = {},
	) {
		super(app);
		this.store = new ConnectionStore(app.config);
		this.out = deps.output ?? createOutputStreams();
		this.now = deps.now ?? (() => Date.now());
		this.sleep =
			deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	}

	/**
	 * Commander entry point. Converts the remote-operator failure vocabulary into
	 * the exit categories ADR 0011 fixes, so an orchestrating agent can branch on
	 * the code rather than parse the prose.
	 */
	async execute(
		argv: string[],
		context: RunsCommandContext = {},
	): Promise<void> {
		try {
			await this.run(argv, context);
		} catch (error) {
			const code = exitCodeFor(error);
			// Anything without a category is an unexpected defect. Flattening one
			// into `6` would tell an operator to retry a command that will never
			// succeed, so it propagates as the crash it is.
			if (code === undefined) throw error;
			this.out.diagnostic(redactSecrets((error as Error).message));
			process.exit(code);
			// `process.exit` does not return in production. The explicit return
			// matters anyway: a test that stubs it would otherwise fall through and
			// observe the opposite of what this branch does.
			return;
		}
	}

	/**
	 * The command's real work, throwing rather than exiting so tests can assert
	 * the failure category instead of trapping `process.exit`.
	 */
	async run(argv: string[], context: RunsCommandContext = {}): Promise<void> {
		const [subcommand, ...rest] = argv;
		switch (subcommand) {
			case "list":
				return this.list(rest, context);
			case "watch":
				return this.watch(rest, context);
			case "wait":
				return this.wait(rest, context);
			default:
				// Everything else is the pre-CYR-70 syntax. Reaching the shim by
				// FALLING THROUGH, rather than by sniffing for an issue-shaped
				// argument, is what makes `cyrus runs --json` and a bare `cyrus
				// runs` keep working — neither carries an issue key.
				return this.legacy(argv, context);
		}
	}

	/* ------------------------------------------------------------------ list */

	/**
	 * Every page of the current snapshot for ONE authorized workspace.
	 *
	 * Exits 0 whatever the runs report. The command answers "what is the fleet
	 * doing", and a fleet full of errored runs is a successful answer to that
	 * question — an exit code that varied with the contents would make the read
	 * itself indistinguishable from a router that could not be reached.
	 */
	private async list(
		argv: string[],
		context: RunsCommandContext,
	): Promise<void> {
		const { filters, rest } = parseRunFilters(argv);
		const options = parseCommandOptions(rest, {
			usage: "cyrus runs list [filters] [--json]",
			allowTimeout: false,
		});
		const { client, workspace } = await this.connect(
			filters,
			context,
			options,
			["runs.list"],
		);

		const { runs, observedAt } = await this.fetchAllRuns(
			client,
			filters,
			workspace,
		);
		if (options.json) {
			this.out.data(
				JSON.stringify(
					runsListDocument({ observedAt, workspace, filters, runs }),
				),
			);
			return;
		}
		for (const line of renderRunsTable(runs)) this.out.data(line);
	}

	/* ----------------------------------------------------------------- watch */

	/**
	 * The fleet's material changes, as they land, until timeout or interruption.
	 *
	 * Consumes the router's DURABLE change feed rather than diffing repeated
	 * snapshots, so a short `active`→`complete` transition between two polls is
	 * still delivered (ADR 0016). Run outcomes never fail this command: it
	 * reports what happened, and deciding what a terminal run means belongs to
	 * whoever reads the stream.
	 */
	private async watch(
		argv: string[],
		context: RunsCommandContext,
	): Promise<void> {
		const { filters, rest } = parseRunFilters(argv);
		const options = parseCommandOptions(rest, {
			usage: "cyrus runs watch [filters] [--timeout <seconds>] [--json]",
		});
		const { client, workspace } = await this.connect(
			filters,
			context,
			options,
			["runs.list", "runs.changes"],
		);

		const emit = (event: WatchEvent): void => {
			if (options.json) {
				this.out.data(JSON.stringify(event));
				return;
			}
			for (const line of renderWatchEventLines(event)) this.out.data(line);
		};
		const deadline =
			options.timeoutMs === undefined
				? undefined
				: this.now() + options.timeoutMs;
		const interrupt = this.installInterruptHandler();

		try {
			// Cursor FIRST, then the snapshot. Anything that happens between the
			// two lands in the feed and is replayed; the other order would drop it
			// silently, which is the one failure a watch must not have.
			let cursor = (await client.listChanges({ from: "latest" })).nextCursor;
			await this.emitSnapshot(client, filters, workspace, emit);

			while (true) {
				if (interrupt.requested) {
					emit(this.stopEvent("interrupted"));
					return;
				}
				if (deadline !== undefined && this.now() >= deadline) {
					emit(this.stopEvent("timeout"));
					return;
				}

				let page: Awaited<ReturnType<OperatorHttpClient["listChanges"]>>;
				try {
					page = await client.listChanges({ cursor });
				} catch (error) {
					if (!(error instanceof StreamEpochChangedError)) throw error;
					// The router restarted. Say so, take a fresh snapshot, and resume
					// from the new stream — never claim continuity across the gap.
					const fresh = await client.listChanges({ from: "latest" });
					emit({
						schemaVersion: 1,
						event: "resync",
						observedAt: fresh.observedAt,
						reason: "stream_epoch_changed",
						streamEpoch: fresh.streamEpoch,
					});
					await this.emitSnapshot(client, filters, workspace, emit);
					cursor = fresh.nextCursor;
					continue;
				}

				cursor = page.nextCursor;
				for (const change of page.changes) {
					// The feed is scoped to the principal's whole authority, which may
					// span workspaces; this invocation chose one.
					if (
						change.observation.routing.workspaceId !== workspace.workspaceId
					) {
						continue;
					}
					if (!matchesLocalRunFilters(change.observation, filters)) continue;
					emit({
						schemaVersion: 1,
						event: "change",
						observedAt: change.observedAt,
						changeId: change.changeId,
						cursor: change.cursor,
						runId: change.runId,
						kind: change.kind,
						observation: change.observation,
					});
				}
				await this.sleep(this.pollIntervalMs);
			}
		} finally {
			interrupt.dispose();
		}
	}

	/* ------------------------------------------------------------------ wait */

	/**
	 * Blocks until ONE run reaches a terminal state or reports that it is
	 * waiting on input.
	 *
	 * The two ways this ends are deliberately different exit categories, and the
	 * document says which: a worker-reported `waiting` is an OBSERVED outcome
	 * (exit 3, `observed: true`), while running out of time is this command's own
	 * condition going unmet (exit 4, `observed: false`). An orchestrator that
	 * cannot tell them apart retries a run that is asking it a question.
	 */
	private async wait(
		argv: string[],
		context: RunsCommandContext,
	): Promise<void> {
		const { filters, rest } = parseRunFilters(argv);
		const options = parseCommandOptions(rest, {
			usage: "cyrus runs wait <runId> [--timeout <seconds>] [--json]",
		});
		const runId = options.positional[0];
		if (!runId || options.positional.length > 1) {
			throw new UsageError(
				"Usage: cyrus runs wait <runId> [--timeout <seconds>] [--json]",
			);
		}
		const { client, workspace } = await this.connect(
			filters,
			context,
			options,
			["runs.list", "runs.changes"],
		);
		const query = { ...toRunsQuery(filters, workspace.workspaceId), runId };

		// Same ordering rule as `watch`: a resume point before the snapshot, so a
		// transition during the snapshot itself is replayed rather than lost.
		let cursor = (await client.listChanges({ from: "latest" })).nextCursor;
		let latest = await this.findRun(client, query, runId);
		const deadline =
			options.timeoutMs === undefined
				? undefined
				: this.now() + options.timeoutMs;

		while (true) {
			const outcome = observedWaitOutcome(latest);
			if (outcome) return this.finishWait(options.json, runId, outcome, latest);
			if (deadline !== undefined && this.now() >= deadline) {
				return this.finishWait(options.json, runId, "timeout", latest);
			}
			await this.sleep(this.pollIntervalMs);

			let page: Awaited<ReturnType<OperatorHttpClient["listChanges"]>>;
			try {
				page = await client.listChanges({ cursor });
			} catch (error) {
				if (!(error instanceof StreamEpochChangedError)) throw error;
				// A restart loses the feed's continuity, so re-read the run's current
				// state directly rather than assuming nothing happened.
				cursor = (await client.listChanges({ from: "latest" })).nextCursor;
				latest = await this.findRun(client, query, runId);
				continue;
			}
			cursor = page.nextCursor;
			for (const change of page.changes) {
				if (change.runId === runId) latest = change.observation;
			}
		}
	}

	/**
	 * Emits the wait's one document, then reports the category the outcome falls
	 * into by throwing — so the exit code is decided in exactly one place
	 * ({@link execute}) and can never disagree with what was printed.
	 */
	private finishWait(
		json: boolean,
		runId: string,
		outcome: WaitOutcome,
		run: RunObservationV1,
	): void {
		const document: RunWaitDocument = waitDocument({
			observedAt: new Date(this.now()).toISOString(),
			runId,
			outcome,
			run,
		});
		if (json) this.out.data(JSON.stringify(document));
		else for (const line of renderWaitOutcome(document)) this.out.data(line);

		if (outcome === "complete") return;
		if (outcome === "timeout") {
			throw new TimeoutError(
				`Run ${runId} had not reached a terminal or waiting outcome before this command's timeout. ` +
					`It was last observed as \`${run.lifecycle}\`; that is what this command saw, not a verdict about the run.`,
			);
		}
		throw new OutcomeError(
			outcome === "waiting"
				? `Run ${runId} is waiting on input its worker reported (${run.wait?.reason ?? "unknown reason"}). This is the run's own state, not a timeout.`
				: `Run ${runId} ended with a non-success outcome: ${outcome}.`,
		);
	}

	private async findRun(
		client: OperatorHttpClient,
		query: Record<string, string>,
		runId: string,
	): Promise<RunObservationV1> {
		const page = await client.listRuns(query);
		const run = page.runs.find((candidate) => candidate.runId === runId);
		if (!run) {
			// Not a wait condition that went unmet — there is nothing to wait for.
			// Terminal observations age out after 24 hours, so a run id that is
			// simply old lands here too, and the message has to cover both.
			throw new UsageError(
				`No run ${runId} is visible on this connection. It may be mistyped, belong to another workspace, ` +
					"or have aged out of the router's retention window. `cyrus runs list` shows what is visible.",
			);
		}
		return run;
	}

	/* ---------------------------------------------------------------- legacy */

	/**
	 * The pre-CYR-70 `cyrus runs [issue] [--watch]` syntax, kept for one release.
	 *
	 * Deprecation goes to STDERR and the data still goes to stdout, so a script
	 * piping this into a parser keeps working while its operator sees the notice.
	 * A hard parse failure would have broken every such script on upgrade with
	 * nothing to act on; this gives them the exact replacement command.
	 */
	private async legacy(
		argv: string[],
		context: RunsCommandContext,
	): Promise<void> {
		const legacy = parseLegacyArgs(argv);
		this.out.diagnostic(
			"`cyrus runs [issue] [--watch]` is deprecated and will be removed in a future release. " +
				(legacy.watch
					? "Use `cyrus runs wait <runId>` to wait on one run, or `cyrus runs watch` to follow the fleet."
					: "Use `cyrus runs list` instead."),
		);

		const filterArgv: string[] = [];
		if (legacy.issue) filterArgv.push("--issue", legacy.issue);
		if (legacy.comment) filterArgv.push("--comment", legacy.comment);
		if (legacy.after) filterArgv.push("--routed-after", legacy.after);

		if (!legacy.watch) {
			return this.list(
				[...filterArgv, ...(legacy.json ? ["--json"] : [])],
				context,
			);
		}

		// `--watch` used to mean "follow this one run to its end", which is now
		// `wait`. That needs a run id, so resolve one — and REFUSE rather than
		// pick when the filters match more than one, because picking would make
		// the exit code describe a run the operator never chose.
		const { filters } = parseRunFilters(filterArgv);
		const { client, workspace } = await this.connect(filters, context, {}, [
			"runs.list",
		]);
		const { runs } = await this.fetchAllRuns(client, filters, workspace);
		const live = runs.filter(
			(run) => !isTerminalRunLifecycleState(run.lifecycle),
		);
		if (live.length === 0) {
			throw new UsageError(
				`No non-terminal run matches ${describeRunFilters(filters)}. ` +
					"Use `cyrus runs list` to see the runs that did match, then `cyrus runs wait <runId>`.",
			);
		}
		if (live.length > 1) {
			throw new UsageError(
				`${describeRunFilters(filters)} matches ${live.length} non-terminal runs: ` +
					`${live.map((run) => `${run.runId} (${run.issueKey}, ${run.lifecycle})`).join(", ")}. ` +
					"Pick one with `cyrus runs wait <runId>`.",
			);
		}

		return this.wait(
			[
				(live[0] as RunObservationV1).runId,
				...(legacy.timeoutSeconds !== undefined
					? ["--timeout", legacy.timeoutSeconds]
					: []),
				...(legacy.json ? ["--json"] : []),
			],
			context,
		);
	}

	/* ----------------------------------------------------------------- shared */

	/**
	 * Resolves the stored connection, proves the router serves what this
	 * subcommand needs, and picks the one workspace to act on.
	 *
	 * The capability check happens BEFORE any run request, and that ordering is
	 * the point: a router that does not serve a route answers 404, which is
	 * indistinguishable from a route that exists and found nothing.
	 */
	private async connect(
		filters: RunFilters,
		context: RunsCommandContext,
		options: { connection?: string },
		capabilities: readonly OperatorCapabilityV1[],
	): Promise<{ client: OperatorHttpClient; workspace: AuthorizedWorkspaceV1 }> {
		const record = this.store.select(options.connection ?? context.connection);
		const client = new OperatorHttpClient({
			baseUrl: record.connection.url,
			fetchFn: this.deps.fetchFn,
			credentials: createCredentialProvider(record.connection, {
				env: this.deps.env,
				entraChain: this.deps.entraChain,
			}),
		});
		const { context: operatorContext } = await client.context();
		for (const capability of capabilities) {
			requireCapability(operatorContext, capability);
		}
		const workspace = selectWorkspace(
			operatorContext,
			filters.workspace ?? context.workspace,
		);
		return { client, workspace };
	}

	/**
	 * Every page of a run listing, with the client-side filters applied.
	 *
	 * All pages, always: `--comment` and `--routed-after` have no router-side
	 * parameter, so stopping early would return a page that had been narrowed
	 * after the router already decided what fits on it.
	 */
	private async fetchAllRuns(
		client: OperatorHttpClient,
		filters: RunFilters,
		workspace: AuthorizedWorkspaceV1,
	): Promise<{ runs: RunObservationV1[]; observedAt: string }> {
		const query = toRunsQuery(filters, workspace.workspaceId);
		const runs: RunObservationV1[] = [];
		const seen = new Set<string>();
		let cursor: string | undefined;
		let observedAt: string | undefined;

		for (let pages = 0; ; pages++) {
			const page = await client.listRuns(cursor ? { ...query, cursor } : query);
			// The FIRST page's instant: it is when this snapshot began, and a later
			// page's clock would date the listing after facts it does not contain.
			observedAt ??= page.observedAt;
			runs.push(
				...page.runs.filter((run) => matchesLocalRunFilters(run, filters)),
			);
			if (!page.nextCursor) break;
			if (seen.has(page.nextCursor) || pages + 1 >= MAX_LIST_PAGES) {
				throw new TransientError(
					"The router kept returning run pages without advancing its cursor; the listing was abandoned rather than looping.",
				);
			}
			seen.add(page.nextCursor);
			cursor = page.nextCursor;
		}
		return {
			runs,
			observedAt: observedAt ?? new Date(this.now()).toISOString(),
		};
	}

	private async emitSnapshot(
		client: OperatorHttpClient,
		filters: RunFilters,
		workspace: AuthorizedWorkspaceV1,
		emit: (event: WatchEvent) => void,
	): Promise<void> {
		const { runs, observedAt } = await this.fetchAllRuns(
			client,
			filters,
			workspace,
		);
		emit({
			schemaVersion: 1,
			event: "snapshot",
			observedAt,
			workspace,
			runs,
		});
	}

	private stopEvent(reason: "timeout" | "interrupted"): WatchEvent {
		return {
			schemaVersion: 1,
			event: "stopped",
			observedAt: new Date(this.now()).toISOString(),
			reason,
		};
	}

	/**
	 * Turns Ctrl-C into a clean end of stream rather than a killed process.
	 *
	 * A watch that dies mid-write leaves a truncated NDJSON line, which a reader
	 * cannot distinguish from a stream that is still going; the `stopped` event
	 * is what makes "the operator stopped this" observable.
	 */
	private installInterruptHandler(): {
		requested: boolean;
		dispose(): void;
	} {
		const state = {
			requested: false,
			dispose(): void {
				process.off("SIGINT", onInterrupt);
			},
		};
		const onInterrupt = (): void => {
			// A SECOND Ctrl-C restores the default kill. Registering any SIGINT
			// listener disables Node's own, so between here and the next loop check
			// the process is uninterruptible — up to a full request timeout if the
			// router has stopped answering. An operator pressing Ctrl-C twice must
			// never have to reach for `kill`.
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
 * The outcome a wait may report from a run's own state, or `undefined` while it
 * can still progress.
 *
 * `waiting` counts because a worker explicitly reported that the run cannot
 * progress without input — which is an answer, not an absence of one. `routed`
 * and `active` are the only states that keep the wait going.
 */
function observedWaitOutcome(run: RunObservationV1): WaitOutcome | undefined {
	if (run.lifecycle === "waiting") return "waiting";
	return isTerminalRunLifecycleState(run.lifecycle)
		? (run.lifecycle as WaitOutcome)
		: undefined;
}

interface CommandOptions {
	json: boolean;
	timeoutMs?: number;
	connection?: string;
	positional: string[];
}

/**
 * Parses what remains after {@link parseRunFilters} has taken the filters.
 *
 * An unknown option is REFUSED rather than ignored. Silently dropping one is
 * how `--stalled` — a flag this CLI deliberately does not have, because nothing
 * here infers a verdict from elapsed time — would return the whole fleet and
 * read as the answer to a much narrower question.
 */
function parseCommandOptions(
	argv: readonly string[],
	spec: { usage: string; allowTimeout?: boolean },
): CommandOptions {
	const options: CommandOptions = { json: false, positional: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === "--json") {
			options.json = true;
		} else if (arg === "--timeout") {
			if (spec.allowTimeout === false) {
				throw new UsageError(
					`--timeout does not apply to a snapshot. Usage: ${spec.usage}`,
				);
			}
			options.timeoutMs = parseTimeoutSeconds(argv[++i]);
		} else if (arg === "--connection") {
			const value = argv[++i];
			if (!value) throw new UsageError("--connection requires a value.");
			options.connection = value;
		} else if (arg.startsWith("-")) {
			throw new UsageError(`Unknown option: ${arg}. Usage: ${spec.usage}`);
		} else {
			options.positional.push(arg);
		}
	}
	return options;
}

function parseTimeoutSeconds(raw: string | undefined): number {
	const seconds = Number(raw);
	if (raw === undefined || !Number.isFinite(seconds) || seconds <= 0) {
		throw new UsageError("--timeout must be a positive number of seconds.");
	}
	return seconds * 1000;
}

interface LegacyArgs {
	issue?: string;
	comment?: string;
	after?: string;
	watch: boolean;
	json: boolean;
	timeoutSeconds?: string;
}

/** The exact flag set the pre-CYR-70 command accepted, and nothing more. */
function parseLegacyArgs(argv: readonly string[]): LegacyArgs {
	const legacy: LegacyArgs = { watch: false, json: false };
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === "--comment") {
			legacy.comment = requireValue(argv[++i], "--comment");
		} else if (arg === "--after") {
			legacy.after = requireValue(argv[++i], "--after");
		} else if (arg === "--timeout") {
			legacy.timeoutSeconds = requireValue(argv[++i], "--timeout");
		} else if (arg === "--watch") {
			legacy.watch = true;
		} else if (arg === "--json") {
			legacy.json = true;
		} else if (arg.startsWith("-")) {
			throw new UsageError(
				`Unknown option: ${arg}. Usage: cyrus runs <list|watch|wait> …`,
			);
		} else {
			positional.push(arg);
		}
	}
	if (positional.length > 1) {
		throw new UsageError("Usage: cyrus runs <list|watch|wait> …");
	}
	legacy.issue = positional[0];
	if (
		legacy.after !== undefined &&
		!Number.isFinite(Date.parse(legacy.after))
	) {
		throw new UsageError("--after must be an ISO-8601 instant.");
	}
	if (legacy.timeoutSeconds !== undefined && !legacy.watch) {
		// The old command refused this, and it must keep refusing it: without
		// `--watch` there is nothing to bound, so accepting it would silently drop
		// a flag the caller believed was doing something.
		throw new UsageError(
			"--timeout applies only with --watch. Use `cyrus runs wait <runId> --timeout <seconds>`.",
		);
	}
	return legacy;
}

function requireValue(value: string | undefined, flag: string): string {
	if (!value || value.startsWith("-")) {
		throw new UsageError(`${flag} requires a value.`);
	}
	return value;
}
