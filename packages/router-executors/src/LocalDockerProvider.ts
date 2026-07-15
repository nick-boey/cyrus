import { execFile } from "node:child_process";
import type {
	ContainerExecutor,
	ContainerStatus,
	IssueExecutionContext,
} from "./types.js";

export type ExecFn = (
	cmd: string,
	args: string[],
) => Promise<{ stdout: string; stderr?: string; exitCode: number }>;

/**
 * A container's first `docker run` triggers a pull of the worker image,
 * which can easily take several minutes. Keep the exec timeout generous
 * enough to cover that, rather than a value tuned for steady-state calls.
 */
const DEFAULT_EXEC_TIMEOUT_MS = 600_000;

/**
 * Grace period passed to `docker stop -t <seconds>` before Docker escalates
 * to SIGKILL. Docker's own default is 10s — shorter than
 * `WorkspaceSyncService`'s 20s stop-flush cap (`DEFAULT_STOP_FLUSH_TIMEOUT_MS`
 * in `packages/edge-worker/src/WorkspaceSyncService.ts`), and `EdgeWorker.stop()`
 * runs that flush LAST, right before the process would otherwise exit. An
 * idle-stop landing mid-flush with the default 10s grace would SIGKILL the
 * container out from under its own final git-push, discarding whatever WIP
 * the floor was mid-way through persisting. 30s comfortably covers the 20s
 * flush cap plus headroom for the SIGTERM handler itself to start unwinding.
 */
const DOCKER_STOP_TIMEOUT_SECONDS = 30;

const defaultExec: ExecFn = (cmd, args) =>
	new Promise((resolve) => {
		execFile(
			cmd,
			args,
			{ timeout: DEFAULT_EXEC_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
			(err, stdout, stderr) => {
				resolve({
					stdout: stdout?.toString() ?? "",
					stderr: stderr?.toString() ?? "",
					exitCode: err ? ((err as { code?: number }).code ?? 1) : 0,
				});
			},
		);
	});

function sanitizeKey(issueKey: string): string {
	return issueKey.replace(/[^A-Za-z0-9_.-]/g, "-");
}

export class LocalDockerProvider implements ContainerExecutor {
	readonly provider = "docker";
	private readonly image: string;
	private readonly memoryLimit: string | undefined;
	private readonly network: string | undefined;
	private readonly exec: ExecFn;
	private readonly logger: { info(msg: string): void; warn(msg: string): void };

	constructor(opts: {
		image: string;
		memoryLimit?: string;
		network?: string;
		exec?: ExecFn;
		logger?: { info(msg: string): void; warn(msg: string): void };
	}) {
		this.image = opts.image;
		this.memoryLimit = opts.memoryLimit;
		this.network = opts.network;
		this.exec = opts.exec ?? defaultExec;
		this.logger = opts.logger ?? { info: () => {}, warn: () => {} };
	}

	private name(issueKey: string): string {
		return `cyrus-issue-${sanitizeKey(issueKey)}`;
	}

	private async inspect(
		issueKey: string,
	): Promise<{ status: ContainerStatus; image?: string }> {
		const { stdout, exitCode } = await this.exec("docker", [
			"inspect",
			"-f",
			"{{.State.Running}}\t{{.Config.Image}}",
			this.name(issueKey),
		]);
		if (exitCode !== 0) return { status: "absent" };
		const [running, image] = stdout.trim().split("\t");
		return { status: running === "true" ? "running" : "stopped", image };
	}

	async status(issueKey: string): Promise<ContainerStatus> {
		return (await this.inspect(issueKey)).status;
	}

	async ensureRunning(ctx: IssueExecutionContext): Promise<void> {
		const name = this.name(ctx.issueKey);
		const found = await this.inspect(ctx.issueKey);
		if (found.status !== "absent" && found.image === this.image) {
			if (found.status === "stopped") {
				await this.mustSucceed("docker", ["start", name]);
			}
			return;
		}
		if (found.status !== "absent") {
			if (found.status === "running") {
				// `ContainerLifecycle`'s idle/stale sweep never destroys a
				// container with active session affinity — this codepath has no
				// equivalent guard. Bumping `containers.image` while a session is
				// mid-run silently kills it the next time this issue is routed;
				// at minimum, name the issue key and the image mismatch so an
				// operator can tell why a session died instead of it looking
				// like an unrelated crash.
				this.logger.warn(
					`Replacing RUNNING container for issue ${ctx.issueKey}: image changed from ${found.image ?? "unknown"} to ${this.image}. Any session currently active inside it is being killed now.`,
				);
			}
			await this.exec("docker", ["rm", "-f", name]); // volume survives
		}
		await this.mustSucceed("docker", ["volume", "create", name]);
		const args = [
			"run",
			"-d",
			"--name",
			name,
			"--label",
			`cyrus.issue=${ctx.issueKey}`,
		];
		if (this.memoryLimit) args.push("--memory", this.memoryLimit);
		if (this.network) args.push("--network", this.network);
		args.push("-v", `${name}:/workspaces`);
		for (const [key, value] of Object.entries(ctx.env)) {
			args.push("-e", `${key}=${value}`);
		}
		args.push("-e", `CYRUS_DEVICE_TOKEN=${ctx.mintDeviceToken()}`);
		args.push(this.image);
		await this.mustSucceed("docker", args);
	}

	async stop(issueKey: string): Promise<void> {
		// -t: see DOCKER_STOP_TIMEOUT_SECONDS above — gives WorkspaceSyncService's
		// stop-time flush room to finish before Docker SIGKILLs the container.
		await this.exec("docker", [
			"stop",
			"-t",
			String(DOCKER_STOP_TIMEOUT_SECONDS),
			this.name(issueKey),
		]);
	}

	async destroy(issueKey: string): Promise<void> {
		await this.exec("docker", ["rm", "-f", this.name(issueKey)]);
		await this.exec("docker", ["volume", "rm", this.name(issueKey)]);
	}

	async listManaged(): Promise<string[]> {
		const { stdout } = await this.exec("docker", [
			"ps",
			"-a",
			"--filter",
			"label=cyrus.issue",
			"--format",
			'{{.Label "cyrus.issue"}}',
		]);
		return stdout
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean);
	}

	private async mustSucceed(cmd: string, args: string[]): Promise<void> {
		const { exitCode, stdout, stderr } = await this.exec(cmd, args);
		if (exitCode !== 0) {
			const detail = [stderr, stdout].filter(Boolean).join(" | ").trim();
			throw new Error(
				`${cmd} ${args[0]} ${args[1] ?? ""} failed (${exitCode}): ${detail}`.trim(),
			);
		}
	}
}
