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
import type {
	ContainerExecutor,
	ContainerStatus,
	IssueExecutionContext,
} from "cyrus-router-executors";
import {
	type ControlServer,
	startControlServer,
} from "./src/router/ControlServer.js";
import { createRouterRig, type RouterRig } from "./src/router/RouterRig.js";
import { bold, cyan, green, success } from "./src/utils/colors.js";

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

export async function startRouterServer(opts: {
	home?: string;
	controlToken?: string;
	controlPort?: number;
	fakeExecutor?: boolean;
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
	const handle = await startRouterServer({
		controlToken,
		controlPort: process.env.F1_ROUTER_CONTROL_PORT
			? Number(process.env.F1_ROUTER_CONTROL_PORT)
			: undefined,
		fakeExecutor: process.env.CYRUS_ROUTER_FAKE_EXECUTOR === "1",
	});
	console.log(bold(green("  🚦 F1 Router-Mode Server")));
	console.log(`  ${cyan("Router WS:")}   ws://127.0.0.1:${handle.rig.port}`);
	console.log(
		`  ${cyan("Control:")}     ${handle.control.url}  ${success(`(token: ${controlToken})`)}`,
	);
	const shutdown = async () => {
		await handle.stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
