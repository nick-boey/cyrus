import type {
	AuthorizedWorkspaceV1,
	OperatorCapabilityV1,
	RecoveryOperationV1,
	RecoveryPhaseTransitionV1,
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
	TimeoutError,
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
	type RecoveryDocument,
	type RecoveryEvent,
	type RecoveryOutcome,
	recoveryDocument,
	recoveryResultEvent,
	redactRecoveryPhaseTransition,
	renderRecoveryOutcome,
	renderRecoveryPhase,
} from "../remote/output.js";
import {
	DEFAULT_RECOVERY_POLL_INTERVAL_MS,
	DEFAULT_RECOVERY_TIMEOUT_MS,
	emitNewPhases,
	followRecoveryOperation,
	generateIdempotencyKey,
	resolveRecoveryTarget,
} from "../remote/recovery.js";
import { BaseCommand } from "./ICommand.js";

/** Options threaded down from the program's global fleet-selection flags. */
export interface RecoverCommandContext {
	/** `--connection <name>`; falls back to the single stored connection. */
	connection?: string;
	/** `--workspace <id>`; required when a context authorizes more than one. */
	workspace?: string;
}

export interface RecoverCommandDeps {
	fetchFn?: typeof fetch;
	env?: NodeJS.ProcessEnv;
	/** Injected so tests can drive the chain order without Azure present. */
	entraChain?: EntraCredentialCandidate[];
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	output?: OutputStreams;
	pollIntervalMs?: number;
	/** Injected so a test can pin the generated idempotency key. */
	newIdempotencyKey?: () => string;
}

/**
 * Asks a remote router to reconcile ONE agent run whose ownership, worker, and
 * executor evidence no longer agree:
 *
 *   cyrus recover <runId> [--expected-revision <n>] [--idempotency-key <key>] [--no-wait]
 *   cyrus recover --issue <issueKey> …
 *   cyrus recover status <operationId> [--wait]
 *
 * ── ONE SEMANTIC INTENT, AND NO STEPS ──
 * The command says "reconcile this run safely" and nothing else. Which internal
 * steps that involves — starting the executor, requesting session
 * reconciliation, letting durable frames replay, releasing stale affinity and
 * the issue lock — is the router's to decide and this command's only to REPORT.
 * There is deliberately no flag that selects one, no `--force`, and no reachable
 * unlock, container destroy, or Linear client: recovery's whole safety argument
 * is the ORDER of the router's guards, and a CLI that could skip to a step would
 * be a way around them.
 *
 * ── A STALE OBSERVATION NEVER MUTATES ANYTHING ──
 * Every request quotes the revision it was decided from. Without
 * `--expected-revision` the command reads a fresh observation immediately before
 * posting, so the evidence and the decision are as close together as a client
 * can make them; with it, the caller's own reading is quoted verbatim. Either
 * way the router refuses if the run moved, and that refusal is exit 3 rather
 * than a silent overwrite.
 *
 * ── IT WAITS, BUT LOSING PATIENCE IS NOT AN OUTCOME ──
 * Recovery is asynchronous by contract: the router persists an operation and
 * answers `202`. This command follows it and reports every phase, but a wait
 * that runs out is exit 4 and `outcome: "timeout"` — never a refusal — because
 * the recovery is still running on the router, and `recover status` resumes it.
 *
 * ── IT NEVER POSTS TO LINEAR ──
 * Recovery correctness does not depend on anything being published, and a skill
 * may summarize a completed operation afterwards. Nothing here holds a Linear
 * client.
 */
export class RecoverCommand extends BaseCommand {
	private readonly store: ConnectionStore;
	private readonly out: OutputStreams;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly pollIntervalMs: number;
	private readonly newIdempotencyKey: () => string;

	constructor(
		app: Application,
		private readonly deps: RecoverCommandDeps = {},
	) {
		super(app);
		this.store = new ConnectionStore(app.config);
		this.out = deps.output ?? createOutputStreams();
		this.now = deps.now ?? (() => Date.now());
		this.sleep =
			deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.pollIntervalMs =
			deps.pollIntervalMs ?? DEFAULT_RECOVERY_POLL_INTERVAL_MS;
		this.newIdempotencyKey =
			deps.newIdempotencyKey ?? (() => generateIdempotencyKey());
	}

	/**
	 * Commander entry point. Converts the remote-operator failure vocabulary into
	 * the exit categories ADR 0011 fixes, exactly as `RunsCommand` and
	 * `LogsCommand` do — the three are read by the same orchestrator and must not
	 * disagree about what a code means.
	 */
	async execute(
		argv: string[],
		context: RecoverCommandContext = {},
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
			// The document is printed BEFORE the category is thrown, so by here
			// stdout may hold a payload `process.exit` would otherwise discard.
			await this.out.flush();
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
	async run(
		argv: string[],
		context: RecoverCommandContext = {},
	): Promise<void> {
		return argv[0] === "status"
			? this.status(argv.slice(1), context)
			: this.recover(argv, context);
	}

	/* --------------------------------------------------------------- recover */

	private async recover(
		argv: string[],
		context: RecoverCommandContext,
	): Promise<void> {
		const options = parseOptions(argv, {
			usage: RECOVER_USAGE,
			allow: [
				"issue",
				"expectedRevision",
				"idempotencyKey",
				"noWait",
				"timeout",
			],
			positionals: 1,
		});
		const runId = options.positional[0];
		if (runId === undefined && options.issue === undefined) {
			throw new UsageError(`Usage: ${RECOVER_USAGE}`);
		}

		// The target must be resolvable before anything can be requested, so an
		// ambiguous issue key or an unreadable run id costs nothing and changes
		// nothing. A listing is needed only when a revision has to be read.
		const needsListing =
			options.expectedRevision === undefined || !!options.issue;
		const { client, workspace } = await this.connect(
			context,
			options,
			["recoveries.request", ...(needsListing ? (["runs.list"] as const) : [])],
			needsListing,
		);
		const target = await resolveRecoveryTarget(client, {
			// `needsListing` decides both the scope and whether a listing happens,
			// so a workspace is present exactly when one will be queried.
			workspaceId: workspace?.workspaceId,
			...(runId !== undefined ? { runId } : {}),
			...(options.issue !== undefined ? { issue: options.issue } : {}),
			...(options.expectedRevision !== undefined
				? { expectedRevision: options.expectedRevision }
				: {}),
		});

		// Generated unless the caller supplied one. An explicit key is what lets an
		// orchestrator retry across a process restart and JOIN its own operation
		// rather than starting a competing one; a generated key is reported in the
		// output so the same retry is possible after the fact.
		const idempotencyKey = options.idempotencyKey ?? this.newIdempotencyKey();
		const { operation, joined } = await client.requestRecovery({
			schemaVersion: 1,
			runId: target.runId,
			expectedRevision: target.expectedRevision,
			idempotencyKey,
		});

		const report = this.reporter(options);
		report.accepted(operation, joined);

		if (options.noWait) {
			// Returning after the acceptance is the point of the flag, but the
			// operation we are already holding may have finished — a joined key can
			// return one that refused minutes ago. Reporting success for a refusal
			// in our own hand would be a lie, so a terminal answer is reported as
			// what it is and only an in-flight one is `pending`.
			emitNewPhases(operation, 0, (transition) =>
				report.phase(operation, transition),
			);
			return this.finish(report, joined, operation, false);
		}

		const { operation: final, timedOut } = await followRecoveryOperation(
			client,
			{
				operation,
				onPhase: (transition) => report.phase(operation, transition),
				now: this.now,
				sleep: this.sleep,
				intervalMs: this.pollIntervalMs,
				timeoutMs: options.timeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS,
			},
		);
		return this.finish(report, joined, final, timedOut);
	}

	/* ---------------------------------------------------------------- status */

	/**
	 * Reads one persisted operation, optionally resuming the follow.
	 *
	 * The one-shot form is a READ and succeeds whatever the operation says —
	 * `complete: false` is how a caller tells "still running" from "recovered",
	 * because both are successful reads. `--wait` is what turns it back into a
	 * wait with a verdict, and is the documented way to pick up after
	 * `--no-wait` or a timeout.
	 */
	private async status(
		argv: string[],
		context: RecoverCommandContext,
	): Promise<void> {
		const options = parseOptions(argv, {
			usage: STATUS_USAGE,
			allow: ["wait", "timeout"],
			positionals: 1,
		});
		const operationId = options.positional[0];
		if (!operationId) throw new UsageError(`Usage: ${STATUS_USAGE}`);

		// Unscoped: an operation id is globally unique, the route takes no
		// workspace, and the router authorizes the read against the caller's own
		// authority. See `connect`.
		const { client } = await this.connect(
			context,
			options,
			["recoveries.request"],
			false,
		);
		const operation = await client.getRecovery(operationId);
		const report = this.reporter(options);

		if (!options.wait) {
			emitNewPhases(operation, 0, (transition) =>
				report.phase(operation, transition),
			);
			return this.finish(report, false, operation, false);
		}

		const { operation: final, timedOut } = await followRecoveryOperation(
			client,
			{
				operation,
				onPhase: (transition) => report.phase(operation, transition),
				now: this.now,
				sleep: this.sleep,
				intervalMs: this.pollIntervalMs,
				timeoutMs: options.timeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS,
			},
		);
		return this.finish(report, false, final, timedOut);
	}

	/* ---------------------------------------------------------------- shared */

	/**
	 * Emits the one document, then reports the category the outcome falls into by
	 * throwing — so the exit code is decided in exactly one place
	 * ({@link execute}) and can never disagree with what was printed.
	 */
	private finish(
		report: RecoveryReporter,
		joined: boolean,
		operation: RecoveryOperationV1,
		timedOut: boolean,
	): void {
		const outcome = outcomeOf(operation, timedOut);
		const document = recoveryDocument({
			observedAt: new Date(this.now()).toISOString(),
			joined,
			outcome,
			operation,
		});
		report.result(document);

		if (outcome === "recovered" || outcome === "pending") return;
		if (outcome === "timeout") {
			throw new TimeoutError(
				`Recovery operation ${document.operationId} for run ${document.runId} had not finished before this command's timeout; ` +
					`it was last seen at \`${operation.phase}\`. The recovery is still running on the router — ` +
					`resume with \`cyrus recover status ${document.operationId} --wait\`.`,
			);
		}
		throw new OutcomeError(describeNonSuccess(document));
	}

	/**
	 * The ONE place an event becomes bytes, so the output mode is decided once.
	 *
	 * The three modes make genuinely different promises and each is honoured
	 * here: `--json` writes exactly one document, so nothing intermediate may
	 * reach stdout and the phase history travels inside that document instead;
	 * `--ndjson` writes one object per line and must therefore write ALL of them,
	 * including the opening `accepted` that carries the operation id before any
	 * phase is known; and the human form renders progress as it lands, which is
	 * the only mode where a phase is worth a line of its own.
	 *
	 * Everything here goes to `data` (stdout). Diagnostics belong to
	 * {@link execute}, which is the only writer of the other stream.
	 */
	private reporter(options: RecoverOptions): RecoveryReporter {
		const ndjson = (event: RecoveryEvent): void => {
			if (options.ndjson) this.out.data(JSON.stringify(event));
		};
		return {
			accepted: (operation, joined) => {
				ndjson({
					schemaVersion: 1,
					event: "accepted",
					observedAt: operation.requestedAt,
					operationId: operation.operationId,
					runId: operation.runId,
					idempotencyKey: operation.idempotencyKey,
					expectedRevision: operation.expectedRevision,
					joined,
				});
				if (options.json || options.ndjson) return;
				this.out.data(
					`Recovery ${operation.operationId} ${joined ? "joined" : "accepted"} for run ${operation.runId} ` +
						`at revision ${operation.expectedRevision} (idempotency key ${operation.idempotencyKey}).`,
				);
			},
			phase: (operation, transition) => {
				// Redacted HERE, not only in the final document: a phase is emitted
				// as it lands, straight off the operation the router just returned,
				// so this event never passes through `recoveryDocument`. `detail` is
				// router-composed free text and carries whatever a failing call put
				// in an exception message.
				const safe = redactRecoveryPhaseTransition(transition);
				ndjson({
					schemaVersion: 1,
					event: "phase",
					observedAt: safe.enteredAt,
					operationId: operation.operationId,
					phase: safe.phase,
					...(safe.detail !== undefined ? { detail: safe.detail } : {}),
				});
				if (options.json || options.ndjson) return;
				this.out.data(renderRecoveryPhase(safe));
			},
			result: (document) => {
				if (options.ndjson) {
					this.out.data(JSON.stringify(recoveryResultEvent(document)));
					return;
				}
				if (options.json) {
					this.out.data(JSON.stringify(document));
					return;
				}
				for (const line of renderRecoveryOutcome(document)) this.out.data(line);
			},
		};
	}

	/**
	 * Resolves the stored connection, proves the router serves what this command
	 * needs, and picks the one workspace to act on.
	 *
	 * The capability check happens BEFORE any request — including the read that
	 * resolves the target — and that ordering is the point twice over: a router
	 * that does not serve a route answers 404, which is indistinguishable from a
	 * route that exists and found nothing; and a router that will refuse the
	 * mutation should say so before this command starts reading evidence for it.
	 */
	private async connect(
		context: RecoverCommandContext,
		options: RecoverOptions,
		capabilities: readonly OperatorCapabilityV1[],
		/**
		 * Whether this invocation will actually SCOPE anything to a workspace.
		 *
		 * `selectWorkspace` refuses when a connection authorizes more than one and
		 * none was named, which is right for a query that has to be scoped and
		 * wrong for one that never is: `recover status <operationId>` reads a
		 * globally unique id off a route that takes no workspace, and
		 * `recover <runId> --expected-revision <n>` makes no query at all. Demanding
		 * `--workspace` there would block an orchestrator resuming an operation id
		 * that `--no-wait` handed it, to narrow a request that has nothing to
		 * narrow.
		 *
		 * An explicitly NAMED workspace is still validated either way — silently
		 * ignoring a misspelled one would be its own trap.
		 */
		scoped: boolean,
	): Promise<{
		client: OperatorHttpClient;
		workspace: AuthorizedWorkspaceV1 | undefined;
	}> {
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
		const requested = options.workspace ?? context.workspace;
		const workspace =
			scoped || requested !== undefined
				? selectWorkspace(operatorContext, requested)
				: undefined;
		return { client, workspace };
	}
}

/**
 * The three things this command reports, independent of how they are rendered.
 *
 * Named as a type rather than left as three closures so that adding a fourth
 * kind of output has to be a decision made for every mode at once — the failure
 * this replaces was a phase that printed under one mode and vanished under
 * another.
 */
interface RecoveryReporter {
	accepted(operation: RecoveryOperationV1, joined: boolean): void;
	phase(
		operation: RecoveryOperationV1,
		transition: RecoveryPhaseTransitionV1,
	): void;
	result(document: RecoveryDocument): void;
}

const RECOVER_USAGE =
	"cyrus recover <runId> | cyrus recover --issue <issueKey> [--expected-revision <n>] [--idempotency-key <key>] [--no-wait] [--timeout <seconds>] [--json|--ndjson]";
const STATUS_USAGE =
	"cyrus recover status <operationId> [--wait] [--timeout <seconds>] [--json|--ndjson]";

/**
 * How this invocation ended, in the vocabulary the document publishes.
 *
 * `timeout` outranks the operation's phase because it describes THIS COMMAND —
 * a recovery that is still `reconciling` when we stop watching has not refused
 * anything, and reporting its phase as the answer would tell an orchestrator a
 * decision was made when none was.
 */
function outcomeOf(
	operation: RecoveryOperationV1,
	timedOut: boolean,
): RecoveryOutcome {
	if (timedOut) return "timeout";
	switch (operation.phase) {
		case "recovered":
		case "needs_input":
		case "refused":
		case "failed":
			return operation.phase;
		default:
			return "pending";
	}
}

/** The prose for a non-success terminal outcome, as one actionable sentence. */
function describeNonSuccess(document: RecoveryDocument): string {
	const operation = document.operation;
	switch (document.outcome) {
		case "needs_input":
			return (
				`Run ${document.runId} needs input: recovery cannot manufacture the answer it is waiting for. ` +
				`Answer it in Linear, then the run resumes on its own (operation ${document.operationId}).`
			);
		case "refused":
			return (
				`The router refused to recover run ${document.runId}: ${operation.refusalReason ?? "no reason given"}. ` +
				"This is a decision it made deliberately, not an error " +
				`(operation ${document.operationId}).`
			);
		default:
			return (
				`Recovery of run ${document.runId} failed: ${operation.failure?.message ?? "no detail given"} ` +
				`(operation ${document.operationId}).`
			);
	}
}

interface RecoverOptions {
	json: boolean;
	ndjson: boolean;
	noWait: boolean;
	wait: boolean;
	issue?: string;
	expectedRevision?: number;
	idempotencyKey?: string;
	timeoutMs?: number;
	connection?: string;
	workspace?: string;
	positional: string[];
}

/**
 * Parses this command's own options.
 *
 * An unknown option is REFUSED rather than ignored, and on a command whose one
 * job is a guarded mutation that matters more than it does elsewhere: a
 * `--force` that parsed and did nothing would read to its author as a force
 * that was applied. A flag valid on the other form is refused for the same
 * reason — `--no-wait` on `status` has nothing to not-wait for.
 */
function parseOptions(
	argv: readonly string[],
	spec: {
		usage: string;
		allow: ReadonlyArray<
			| "issue"
			| "expectedRevision"
			| "idempotencyKey"
			| "noWait"
			| "wait"
			| "timeout"
		>;
		positionals: number;
	},
): RecoverOptions {
	const options: RecoverOptions = {
		json: false,
		ndjson: false,
		noWait: false,
		wait: false,
		positional: [],
	};
	const permits = (name: (typeof spec.allow)[number]): boolean =>
		spec.allow.includes(name);
	const refuse = (flag: string): never => {
		throw new UsageError(`${flag} does not apply here. Usage: ${spec.usage}`);
	};
	// An EMPTY value is refused, not treated as absent, and on this command that
	// is a safety property rather than tidiness. `--expected-revision ""` — what
	// `--expected-revision "$REV"` produces when `REV` is unset — would otherwise
	// drop the flag and let the command read a revision of its own, silently
	// turning the caller's conditional request into one conditional on whatever
	// is true now. `--idempotency-key ""` would mint a fresh key and start a
	// COMPETING operation where the caller meant to join their own.
	const value = (raw: string | undefined, flag: string): string => {
		if (raw === undefined || raw.length === 0 || raw.startsWith("-")) {
			throw new UsageError(`${flag} requires a value.`);
		}
		return raw;
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		switch (arg) {
			case "--json":
				options.json = true;
				break;
			case "--ndjson":
				options.ndjson = true;
				break;
			case "--no-wait":
				if (!permits("noWait")) refuse(arg);
				options.noWait = true;
				break;
			case "--wait":
				if (!permits("wait")) refuse(arg);
				options.wait = true;
				break;
			case "--issue":
				if (!permits("issue")) refuse(arg);
				options.issue = value(argv[++i], arg);
				break;
			case "--expected-revision": {
				if (!permits("expectedRevision")) refuse(arg);
				const raw = value(argv[++i], arg);
				const revision = Number(raw);
				// The wire contract's revision is a non-negative integer, and a
				// malformed one must fail HERE: sent as `NaN` it would serialize to
				// `null`, the router's strict parse would reject the whole request,
				// and the operator would read a schema error about a field they
				// typed correctly-looking.
				if (!Number.isInteger(revision) || revision < 0) {
					throw new UsageError(
						`--expected-revision must be a non-negative integer, not "${raw}". It is the \`revision\` of the run observation you read.`,
					);
				}
				options.expectedRevision = revision;
				break;
			}
			case "--idempotency-key":
				if (!permits("idempotencyKey")) refuse(arg);
				options.idempotencyKey = value(argv[++i], arg);
				break;
			case "--timeout": {
				if (!permits("timeout")) refuse(arg);
				const raw = value(argv[++i], arg);
				const seconds = Number(raw);
				if (!Number.isFinite(seconds) || seconds <= 0) {
					throw new UsageError(
						"--timeout must be a positive number of seconds.",
					);
				}
				options.timeoutMs = seconds * 1000;
				break;
			}
			case "--connection":
				options.connection = value(argv[++i], arg);
				break;
			case "--workspace":
				options.workspace = value(argv[++i], arg);
				break;
			default:
				if (arg.startsWith("-")) {
					throw new UsageError(`Unknown option: ${arg}. Usage: ${spec.usage}`);
				}
				options.positional.push(arg);
		}
	}

	if (options.json && options.ndjson) {
		// Both would write to stdout, and the two contracts contradict each other:
		// one document versus a stream of events. Refusing beats picking, because a
		// caller that asked for both has a parser expecting one of them.
		throw new UsageError(
			"--json and --ndjson cannot be combined: --json emits one document, --ndjson emits one event per line.",
		);
	}
	// The same rule as an unknown option, applied to a combination: a `--timeout`
	// beside `--no-wait` bounds a wait that never happens, and one on a `status`
	// that is not following bounds a single request. Both parse and do nothing,
	// which reads to whoever typed them as a bound that was applied.
	if (
		options.timeoutMs !== undefined &&
		(options.noWait || (spec.allow.includes("wait") && !options.wait))
	) {
		throw new UsageError(
			options.noWait
				? "--timeout does not apply with --no-wait: there is no wait to bound."
				: "--timeout applies only with --wait. `cyrus recover status <operationId>` reads the operation once.",
		);
	}
	if (options.positional.length > spec.positionals) {
		throw new UsageError(
			`Unexpected argument: ${options.positional[spec.positionals]}. Usage: ${spec.usage}`,
		);
	}
	return options;
}
