#!/usr/bin/env bun

/**
 * F1 Router-Mode Server
 *
 * Boots a RouterRig (RouterServer + CLI issue tracker) alongside a token-gated
 * ControlServer for driving it via HTTP during F1 test drives / smoke tests.
 *
 * Usage:
 *   F1_ROUTER_CONTROL_TOKEN=secret F1_ROUTER_CONTROL_PORT=4600 bun run router-server.ts
 *
 * Set CYRUS_ROUTER_FAKE_EXECUTOR=1 to boot with a no-op docker executor instead
 * of the real container lifecycle (useful for control-plane-only smoke tests).
 */

import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ILogger } from "cyrus-core";
import type {
	ContainerExecutor,
	ContainerStatus,
	IssueExecutionContext,
} from "cyrus-router-executors";
import {
	type ControlServer,
	startControlServer,
} from "./src/router/ControlServer.js";
import { WORKSPACE } from "./src/router/fixtures.js";
import {
	createRouterRig,
	type RigRepositoryConfig,
	type RouterRig,
} from "./src/router/RouterRig.js";
import { bold, cyan, green, red, success, yellow } from "./src/utils/colors.js";

class NoopFakeExecutor implements ContainerExecutor {
	readonly provider = "docker";
	async ensureRunning(ctx: IssueExecutionContext): Promise<void> {
		ctx.mintDeviceToken();
	}
	async stop(): Promise<void> {}
	async destroy(): Promise<void> {}
	async status(): Promise<ContainerStatus> {
		return "absent";
	}
	async listManaged(): Promise<string[]> {
		return [];
	}
}

/**
 * Parses `F1_ROUTER_REPO` — `owner/repo[@baseBranch]` — into the rig's single
 * repository entry. Undefined leaves the rig's own `octocat/Hello-World`
 * default, which is fine for lifecycle drives but cannot be pushed to, so any
 * drive asserting that a session opens a pull request must set this.
 */
export function parseRepoOverride(
	raw: string | undefined,
	workspaceId: string,
): RigRepositoryConfig[] | undefined {
	const trimmed = (raw ?? "").trim();
	if (trimmed === "") return undefined;
	const at = trimmed.lastIndexOf("@");
	const slug = at > 0 ? trimmed.slice(0, at) : trimmed;
	const baseBranch = at > 0 ? trimmed.slice(at + 1) : "main";
	// `@` is excluded from the slug so a leading-`@` value fails here rather
	// than yielding an unclonable `githubSlug`, and an empty branch is rejected
	// so `owner/repo@` cannot boot containers pointed at a nonexistent base.
	if (!/^[^/\s@]+\/[^/\s@]+$/.test(slug) || baseBranch.trim() === "") {
		throw new Error(
			`F1_ROUTER_REPO must be owner/repo[@baseBranch], got "${trimmed}"`,
		);
	}
	return [
		{
			name: slug.split("/")[1] as string,
			githubSlug: slug,
			linearWorkspaceId: workspaceId,
			baseBranch,
		},
	];
}

/**
 * Parses a comma-separated env-var-name list (F1_ROUTER_REQUIRED_SECRET_KEYS)
 * into the rig's `requiredSecretKeys`; undefined when unset or blank.
 */
export function parseRequiredSecretKeys(
	raw: string | undefined,
): string[] | undefined {
	const keys = (raw ?? "")
		.split(",")
		.map((key) => key.trim())
		.filter(Boolean);
	return keys.length > 0 ? keys : undefined;
}

export async function startRouterServer(opts: {
	home?: string;
	controlToken?: string;
	controlPort?: number;
	fakeExecutor?: boolean;
	requiredSecretKeys?: string[];
	repositories?: RigRepositoryConfig[];
	logger?: Partial<ILogger>;
}): Promise<{ rig: RouterRig; control: ControlServer; stop(): Promise<void> }> {
	const home = opts.home ?? join(tmpdir(), `cyrus-f1-router-${Date.now()}`);
	for (const d of [home, join(home, "artifacts"), join(home, "state")]) {
		if (!existsSync(d)) mkdirSync(d, { recursive: true });
	}
	const artifactsDir = join(home, "artifacts");
	const rig = await createRouterRig({
		dbPath: join(home, "router.db"),
		secretsPath: join(home, "secrets.json"),
		artifactsDir,
		requiredSecretKeys: opts.requiredSecretKeys,
		...(opts.repositories ? { repositories: opts.repositories } : {}),
		logger: opts.logger,
		...(opts.fakeExecutor
			? {
					executors: new Map<string, ContainerExecutor>([
						["docker", new NoopFakeExecutor()],
					]),
				}
			: {}),
	});
	const control = await startControlServer({
		rig,
		token: opts.controlToken ?? "f1-router",
		port: opts.controlPort,
		artifactsDir,
	});
	return {
		rig,
		control,
		async stop() {
			await control.stop();
			await rig.stop();
		},
	};
}

// CLI entrypoint (only when run directly).
if (import.meta.main) {
	const controlToken = process.env.F1_ROUTER_CONTROL_TOKEN ?? "f1-router";
	const requiredSecretKeys = parseRequiredSecretKeys(
		process.env.F1_ROUTER_REQUIRED_SECRET_KEYS,
	);
	const repositories = parseRepoOverride(process.env.F1_ROUTER_REPO, WORKSPACE);
	const handle = await startRouterServer({
		controlToken,
		controlPort: process.env.F1_ROUTER_CONTROL_PORT
			? Number(process.env.F1_ROUTER_CONTROL_PORT)
			: undefined,
		fakeExecutor: process.env.CYRUS_ROUTER_FAKE_EXECUTOR === "1",
		requiredSecretKeys,
		...(repositories ? { repositories } : {}),
		// Console-backed so drive operators SEE router warnings and errors —
		// above all the boot gate's "<email> is not fully authenticated: missing
		// <KEYS>", which now surfaces at error level via "Container boot failed"
		// — instead of the rig's silent default logger swallowing them.
		logger: {
			info: (m) => console.log(`  ${cyan("[router]")} ${m}`),
			warn: (m) => console.warn(`  ${yellow("[router]")} ${m}`),
			error: (m, ...args) =>
				console.error(`  ${red("[router]")} ${m}`, ...args),
		},
	});
	console.log(bold(green("  🚦 F1 Router-Mode Server")));
	console.log(
		`  ${cyan("Router WS:")}   ws://0.0.0.0:${handle.rig.port} (binds all interfaces; containers reach it via host.docker.internal:${handle.rig.port})`,
	);
	console.log(
		`  ${cyan("Control:")}     ${handle.control.url}  ${success(`(token: ${controlToken})`)}`,
	);
	// Not a fixed list since NOR-364: the runner-dependent half is whatever
	// `requiredSecretKeysFor` returns for each user's own picker choice (a Codex
	// user needs no Claude token at all), so print only what is genuinely
	// global and name the runner-dependent part rather than misreporting it.
	console.log(
		`  ${cyan("Boot gate:")}   per-runner credential${
			requiredSecretKeys ? ` + ${requiredSecretKeys.join(", ")}` : ""
		} required per user`,
	);
	console.log(
		`  ${cyan("Repository:")}  ${repositories?.[0]?.githubSlug ?? "octocat/Hello-World"}@${repositories?.[0]?.baseBranch ?? "master"}`,
	);
	const shutdown = async () => {
		await handle.stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
