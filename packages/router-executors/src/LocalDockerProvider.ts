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

	constructor(opts: {
		image: string;
		memoryLimit?: string;
		network?: string;
		exec?: ExecFn;
	}) {
		this.image = opts.image;
		this.memoryLimit = opts.memoryLimit;
		this.network = opts.network;
		this.exec = opts.exec ?? defaultExec;
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
		await this.exec("docker", ["stop", this.name(issueKey)]);
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
