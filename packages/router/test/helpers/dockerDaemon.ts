import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { ContainerExecutor } from "cyrus-router-executors";

let cachedDockerAvailable: boolean | undefined;

/**
 * Whether a usable daemon is reachable. Memoized and retried, deliberately:
 * every `describe.skipIf` in the opt-in suite calls this at collection time, and
 * a single transient failure to even *spawn* the probe (EAGAIN under vitest's
 * worker pool, seen in practice) silently skips the WHOLE suite — a result
 * indistinguishable, in the reporter, from "no daemon here". Only a probe that
 * actually ran and reported failure (`status !== null`, no spawn error) is
 * treated as a real "no daemon".
 */
export function dockerAvailable(): boolean {
	if (cachedDockerAvailable !== undefined) return cachedDockerAvailable;
	for (let attempt = 0; attempt < 3; attempt++) {
		const r = spawnSync("docker", ["info"], { stdio: "ignore" });
		if (r.status === 0) {
			cachedDockerAvailable = true;
			return true;
		}
		if (!r.error && r.status !== null) {
			cachedDockerAvailable = false;
			return false;
		}
	}
	cachedDockerAvailable = false;
	return false;
}

export function dedicatedDaemonOptIn(): boolean {
	return process.env.CYRUS_E2E_DEDICATED_DOCKER === "1";
}

export function runScopedIssueKey(base: string): string {
	return `${base}-${randomBytes(4).toString("hex")}`;
}

let cachedRouterHost: string | undefined;

/**
 * The host name/address a container must use to reach a RouterServer running in
 * this test process — i.e. what belongs in `routerUrlForContainers`.
 *
 * `host.docker.internal` is provided by Docker Desktop and colima, but NOT by
 * plain Docker Engine on Linux: there it resolves to nothing unless the
 * container was started with `--add-host=host.docker.internal:host-gateway`,
 * which `LocalDockerProvider` does not pass. A suite hardcoding that name
 * therefore boots containers that can never reach the router, and every
 * assertion that depends on the container actually connecting (worktree
 * creation, floor upload, bundle download) fails by timeout on Linux.
 *
 * So: probe the name from inside a throwaway container of `image`, and fall
 * back to the default bridge network's gateway address (172.17.0.1 in a stock
 * Linux install), which reaches the host from any container on that network.
 * Memoized — the probe costs a container start, and the answer is a property of
 * the daemon, not of the caller.
 */
export function routerHostForContainers(image: string): string {
	if (cachedRouterHost) return cachedRouterHost;
	const probe = spawnSync(
		"docker",
		[
			"run",
			"--rm",
			"--entrypoint",
			"sh",
			image,
			"-c",
			"getent hosts host.docker.internal",
		],
		{ encoding: "utf-8" },
	);
	if (probe.status === 0 && (probe.stdout ?? "").trim().length > 0) {
		cachedRouterHost = "host.docker.internal";
		return cachedRouterHost;
	}
	const gateway = spawnSync(
		"docker",
		[
			"network",
			"inspect",
			"bridge",
			"-f",
			"{{range .IPAM.Config}}{{.Gateway}}{{end}}",
		],
		{ encoding: "utf-8" },
	);
	const addr = (gateway.stdout ?? "").trim();
	if (!addr) {
		throw new Error(
			"cannot determine a container-reachable host address: host.docker.internal does not resolve and the bridge network reports no gateway",
		);
	}
	cachedRouterHost = addr;
	return cachedRouterHost;
}

export function removeContainerAndVolume(issueKeyOrName: string): void {
	// The provider names resources `cyrus-issue-<sanitized>`; callers pass the
	// exact container/volume name they created. Tolerate absence.
	for (const args of [
		["rm", "-f", issueKeyOrName],
		["volume", "rm", issueKeyOrName],
	]) {
		spawnSync("docker", args, { stdio: "ignore" });
	}
}

export function containerState(name: string): "running" | "stopped" | "absent" {
	const r = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", name], {
		encoding: "utf-8",
	});
	if (r.status !== 0) return "absent";
	return r.stdout.trim() === "true" ? "running" : "stopped";
}

/**
 * Wrap a real ContainerExecutor so its listManaged() (the input to orphan GC in
 * ContainerLifecycle.sweep) can only ever surface `allowedKeys`. This bounds the
 * blast radius of a sweep() in the idle-stop / stale-destroy tests to this run's
 * own containers, even on a shared daemon. The orphan-GC test uses the raw inner.
 */
export function scopedProvider(
	inner: ContainerExecutor,
	allowedKeys: Set<string>,
): ContainerExecutor {
	return {
		provider: inner.provider,
		ensureRunning: (ctx) => inner.ensureRunning(ctx),
		stop: (k) => inner.stop(k),
		destroy: (k) => inner.destroy(k),
		status: (k) => inner.status(k),
		async listManaged() {
			const all = await inner.listManaged();
			return all.filter((k) => allowedKeys.has(k));
		},
	};
}

/**
 * Wrap a real ContainerExecutor so callers can count how many times the router
 * asked it to boot a container. Used by the boot-serialization test: the number
 * of resulting containers cannot distinguish a working dedup from a broken one
 * (a second `docker run` with the same name just errors out on a name clash),
 * so the observable under test is the *call* count, exactly as
 * `containers-e2e.test.ts` scenario 5 does against its fake.
 *
 * `ensureRunningCalls` is pushed synchronously on entry — before the awaited
 * `docker run` — so a second boot arriving while the first is still in flight
 * is visible immediately.
 */
export function countingProvider(
	inner: ContainerExecutor,
): ContainerExecutor & {
	ensureRunningCalls: string[];
	resolvedCount: number;
} {
	const wrapper = {
		provider: inner.provider,
		ensureRunningCalls: [] as string[],
		resolvedCount: 0,
		async ensureRunning(
			ctx: Parameters<ContainerExecutor["ensureRunning"]>[0],
		) {
			wrapper.ensureRunningCalls.push(ctx.issueKey);
			await inner.ensureRunning(ctx);
			wrapper.resolvedCount++;
		},
		stop: (k: string) => inner.stop(k),
		destroy: (k: string) => inner.destroy(k),
		status: (k: string) => inner.status(k),
		listManaged: () => inner.listManaged(),
	};
	return wrapper;
}

export { execFileSync };
