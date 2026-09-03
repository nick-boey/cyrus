import type {
	AgentRunObservation,
	AgentRunsResponse,
} from "cyrus-operator-protocol";
import type { Application } from "../Application.js";
import { BaseCommand } from "./ICommand.js";

const POLL_MS = 5_000;
const HEARTBEAT_MS = 60_000;
const TERMINAL_STATES = new Set(["complete", "error", "stopped", "unknown"]);

interface RunsArgs {
	issueKey?: string;
	commentId?: string;
	after?: string;
	watch: boolean;
	json: boolean;
	timeoutMs?: number;
}

/** Queries the router connection created by `cyrus connect`. */
export class RunsCommand extends BaseCommand {
	constructor(
		app: Application,
		private readonly fetchFn: typeof fetch = fetch,
		private readonly now: () => number = Date.now,
		private readonly sleep: (ms: number) => Promise<void> = (ms) =>
			new Promise((resolve) => setTimeout(resolve, ms)),
	) {
		super(app);
	}

	async execute(argv: string[]): Promise<void> {
		const args = this.parseArgs(argv);
		if (args.watch && !args.issueKey && !args.commentId) {
			this.exitWithError(
				"`cyrus runs --watch` requires an issue key or --comment <id>",
			);
		}

		const config = this.app.config.load();
		if (!config.router?.url || !config.router.deviceToken) {
			this.exitWithError(
				"No router connection found. Run `cyrus connect <url> --code <code>` first.",
			);
		}
		const httpBase = deriveHttpUrl(config.router.url);
		if (!httpBase) {
			this.exitWithError(
				`Unsupported router URL scheme in ${config.router.url}; reconnect with \`cyrus connect\`.`,
			);
		}
		const url = new URL("/runs", `${httpBase}/`);
		if (args.issueKey) url.searchParams.set("issueKey", args.issueKey);
		if (args.commentId) url.searchParams.set("commentId", args.commentId);
		if (args.after) url.searchParams.set("since", args.after);

		const startedAt = this.now();
		let lastSignature: string | undefined;
		let lastPrintedAt = 0;
		while (true) {
			const response = await this.fetchRuns(url, config.router.deviceToken);
			const now = this.now();
			const signature = observationSignature(response.runs);
			if (
				lastSignature === undefined ||
				signature !== lastSignature ||
				now - lastPrintedAt >= HEARTBEAT_MS
			) {
				this.print(response, args.json);
				lastSignature = signature;
				lastPrintedAt = now;
			}

			if (!args.watch) return;
			const current =
				response.runs.find((run) => !TERMINAL_STATES.has(run.state)) ??
				response.runs[0];
			if (current && TERMINAL_STATES.has(current.state)) {
				if (current.state !== "complete") process.exitCode = 1;
				return;
			}
			if (args.timeoutMs !== undefined && now - startedAt >= args.timeoutMs) {
				this.logger.error("Timed out waiting for the matching run to finish.");
				process.exitCode = 1;
				return;
			}
			await this.sleep(POLL_MS);
		}
	}

	private async fetchRuns(
		url: URL,
		deviceToken: string,
	): Promise<AgentRunsResponse> {
		let response: Response;
		try {
			response = await this.fetchFn(url, {
				headers: { authorization: `Bearer ${deviceToken}` },
			});
		} catch (error) {
			this.exitWithError(
				`Failed to reach the connected router: ${(error as Error).message}`,
			);
		}
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			this.exitWithError(
				`Router run query failed (${response.status}): ${body || response.statusText}`,
			);
		}
		const body = (await response.json()) as Partial<AgentRunsResponse>;
		if (typeof body.observedAt !== "string" || !Array.isArray(body.runs)) {
			this.exitWithError("Router returned an invalid run response.");
		}
		return body as AgentRunsResponse;
	}

	private print(response: AgentRunsResponse, json: boolean): void {
		if (json) {
			this.logger.raw(JSON.stringify(response));
			return;
		}
		this.logger.raw(`Observed ${response.observedAt}`);
		if (response.runs.length === 0) {
			this.logger.raw("No matching runs.");
			return;
		}
		for (const run of response.runs) {
			const commentId = [...run.inputs]
				.reverse()
				.find((input) => input.commentId)?.commentId;
			this.logger.raw(
				`${run.issueKey}  ${run.state}  agent:${age(run.lastAgentActivityAt, response.observedAt)}  ` +
					`routed:${age(run.lastRoutedAt, response.observedAt)}  worker:${run.workerOnline ? "online" : "offline"}  ` +
					`sandbox:${run.sandboxState ?? "-"}  comment:${commentId ?? "-"}  run:${run.runId}`,
			);
		}
	}

	private parseArgs(argv: string[]): RunsArgs {
		const positional: string[] = [];
		let commentId: string | undefined;
		let after: string | undefined;
		let timeoutMs: number | undefined;
		let watch = false;
		let json = false;
		for (let i = 0; i < argv.length; i++) {
			const arg = argv[i];
			if (arg === "--comment" && argv[i + 1]) {
				commentId = argv[++i];
			} else if (arg === "--after" && argv[i + 1]) {
				after = argv[++i];
			} else if (arg === "--timeout" && argv[i + 1]) {
				const seconds = Number(argv[++i]);
				if (!Number.isFinite(seconds) || seconds <= 0) {
					this.exitWithError("--timeout must be a positive number of seconds");
				}
				timeoutMs = seconds * 1000;
			} else if (arg === "--watch") {
				watch = true;
			} else if (arg === "--json") {
				json = true;
			} else if (arg?.startsWith("-")) {
				this.exitWithError(`Unknown option: ${arg}`);
			} else if (arg) {
				positional.push(arg);
			}
		}
		if (positional.length > 1) {
			this.exitWithError("Usage: cyrus runs [issue] [options]");
		}
		if (after !== undefined && !Number.isFinite(Date.parse(after))) {
			this.exitWithError("--after must be an ISO timestamp");
		}
		if (timeoutMs !== undefined && !watch) {
			this.exitWithError("--timeout requires --watch");
		}
		return {
			issueKey: positional[0],
			commentId,
			after,
			watch,
			json,
			timeoutMs,
		};
	}
}

export function deriveHttpUrl(routerUrl: string): string | undefined {
	const trimmed = routerUrl.replace(/\/+$/, "");
	if (trimmed.startsWith("wss://")) return `https://${trimmed.slice(6)}`;
	if (trimmed.startsWith("ws://")) return `http://${trimmed.slice(5)}`;
	if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
		return trimmed;
	}
	return undefined;
}

function observationSignature(runs: AgentRunObservation[]): string {
	return JSON.stringify(
		runs.map((run) => ({
			runId: run.runId,
			state: run.state,
			lastRoutedAt: run.lastRoutedAt,
			lastAgentActivityAt: run.lastAgentActivityAt,
			endedAt: run.endedAt,
			workerOnline: run.workerOnline,
			sandboxState: run.sandboxState,
		})),
	);
}

function age(then: string | undefined, observedAt: string): string {
	if (!then) return "never";
	const seconds = Math.max(
		0,
		Math.floor((Date.parse(observedAt) - Date.parse(then)) / 1000),
	);
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
	return `${Math.floor(seconds / 86_400)}d`;
}
