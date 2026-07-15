import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { ContainerExecutor } from "cyrus-router-executors";

export function dockerAvailable(): boolean {
	const r = spawnSync("docker", ["info"], { stdio: "ignore" });
	return r.status === 0;
}

export function dedicatedDaemonOptIn(): boolean {
	return process.env.CYRUS_E2E_DEDICATED_DOCKER === "1";
}

export function runScopedIssueKey(base: string): string {
	return `${base}-${randomBytes(4).toString("hex")}`;
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

export { execFileSync };
