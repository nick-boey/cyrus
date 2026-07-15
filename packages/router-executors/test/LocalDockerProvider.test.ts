import { describe, expect, it, vi } from "vitest";
import { LocalDockerProvider } from "../src/LocalDockerProvider.js";

function fakeExec(
	script: Record<string, { stdout?: string; exitCode?: number }>,
) {
	const calls: string[][] = [];
	const exec = async (cmd: string, args: string[]) => {
		calls.push([cmd, ...args]);
		// Two-token commands (e.g. "inspect -f", "volume create", "ps -a")
		// have a static second token, so keying on it is unambiguous. But
		// commands like ["stop", name] / ["start", name] carry a *dynamic*
		// second token (the container name) — keying on both would fold the
		// name into the lookup key and never match a script keyed by verb
		// alone. Prefer the two-token key when the script defines one;
		// otherwise fall back to the bare first token.
		const twoToken = args.slice(0, 2).join(" "); // e.g. "inspect -f", "run -d"
		const oneToken = args[0] ?? ""; // e.g. "stop", "start"
		const key = twoToken in script ? twoToken : oneToken;
		const hit = script[key] ?? {};
		return { stdout: hit.stdout ?? "", exitCode: hit.exitCode ?? 0 };
	};
	return { exec, calls };
}

const ctx = (issueKey = "CYPACK-1") => ({
	issueKey,
	env: { CYRUS_ROUTER_URL: "ws://host:1", CYRUS_ISSUE_KEY: issueKey },
	mintDeviceToken: () => "tok-123",
});

describe("LocalDockerProvider", () => {
	it("creates volume + container with env and token when absent", async () => {
		const { exec, calls } = fakeExec({ "inspect -f": { exitCode: 1 } });
		const p = new LocalDockerProvider({ image: "img:1", exec });
		await p.ensureRunning(ctx());
		const run = calls.find((c) => c[1] === "run");
		expect(calls.some((c) => c[1] === "volume" && c[2] === "create")).toBe(
			true,
		);
		expect(run).toContain("-e");
		expect(run?.join(" ")).toContain("CYRUS_DEVICE_TOKEN=tok-123");
		expect(run?.join(" ")).toContain("cyrus-issue-CYPACK-1:/workspaces");
	});

	it("starts a stopped container with a matching image without re-minting", async () => {
		const { exec, calls } = fakeExec({
			"inspect -f": { stdout: "false\timg:1\n" },
		});
		const p = new LocalDockerProvider({ image: "img:1", exec });
		let minted = 0;
		const mintDeviceToken = () => {
			minted++;
			return "t";
		};
		await p.ensureRunning({ ...ctx(), mintDeviceToken });
		expect(minted).toBe(0);
		expect(calls.some((c) => c[1] === "start")).toBe(true);
	});

	it("propagates a failure to start an existing stopped container (unlike stop, ensureRunning does not tolerate this)", async () => {
		const { exec } = fakeExec({
			"inspect -f": { stdout: "false\timg:1\n" },
			start: { exitCode: 1 },
		});
		const p = new LocalDockerProvider({ image: "img:1", exec });
		await expect(p.ensureRunning(ctx())).rejects.toThrow(/start/);
	});

	it("recreates (rm -f, then run) when the image is stale", async () => {
		const { exec, calls } = fakeExec({
			"inspect -f": { stdout: "false\timg:0\n" },
		});
		const p = new LocalDockerProvider({ image: "img:1", exec });
		await p.ensureRunning(ctx());
		expect(calls.some((c) => c[1] === "rm" && c.includes("-f"))).toBe(true);
		expect(calls.some((c) => c[1] === "run")).toBe(true);
	});

	it("warns and names the issue key when replacing a RUNNING container due to an image mismatch", async () => {
		const { exec } = fakeExec({
			"inspect -f": { stdout: "true\timg:0\n" }, // running, stale image
		});
		const warn = vi.fn();
		const p = new LocalDockerProvider({
			image: "img:1",
			exec,
			logger: { info: () => {}, warn },
		});
		await p.ensureRunning(ctx("CYPACK-9"));
		expect(warn).toHaveBeenCalledTimes(1);
		const message = warn.mock.calls[0]?.[0] as string;
		expect(message).toContain("CYPACK-9");
		expect(message).toContain("img:0");
		expect(message).toContain("img:1");
	});

	it("does NOT warn when replacing a STOPPED (not running) container due to an image mismatch", async () => {
		const { exec } = fakeExec({
			"inspect -f": { stdout: "false\timg:0\n" }, // stopped, stale image
		});
		const warn = vi.fn();
		const p = new LocalDockerProvider({
			image: "img:1",
			exec,
			logger: { info: () => {}, warn },
		});
		await p.ensureRunning(ctx());
		expect(warn).not.toHaveBeenCalled();
	});

	it("re-mints the device token when recreating a container with a stale image", async () => {
		const { exec } = fakeExec({
			"inspect -f": { stdout: "false\timg:0\n" },
		});
		const p = new LocalDockerProvider({ image: "img:1", exec });
		let minted = 0;
		const mintDeviceToken = () => {
			minted++;
			return "t";
		};
		await p.ensureRunning({ ...ctx(), mintDeviceToken });
		expect(minted).toBe(1);
	});

	it("is a no-op when running with the right image", async () => {
		const { exec, calls } = fakeExec({
			"inspect -f": { stdout: "true\timg:1\n" },
		});
		await new LocalDockerProvider({ image: "img:1", exec }).ensureRunning(
			ctx(),
		);
		expect(calls).toHaveLength(1); // just the inspect
	});

	it("mints the device token when creating a container from absent", async () => {
		const { exec } = fakeExec({ "inspect -f": { exitCode: 1 } });
		const p = new LocalDockerProvider({ image: "img:1", exec });
		let minted = 0;
		const mintDeviceToken = () => {
			minted++;
			return "t";
		};
		await p.ensureRunning({ ...ctx(), mintDeviceToken });
		expect(minted).toBe(1);
	});

	it("maps status and lists managed issue keys", async () => {
		const { exec } = fakeExec({
			"inspect -f": { stdout: "true\timg:1\n" },
			"ps -a": { stdout: "CYPACK-1\nCYPACK-2\n" },
		});
		const p = new LocalDockerProvider({ image: "img:1", exec });
		expect(await p.status("CYPACK-1")).toBe("running");
		expect(await p.listManaged()).toEqual(["CYPACK-1", "CYPACK-2"]);
	});

	it("maps status to absent and stopped", async () => {
		const absent = fakeExec({ "inspect -f": { exitCode: 1 } });
		const stopped = fakeExec({ "inspect -f": { stdout: "false\timg:1\n" } });
		expect(
			await new LocalDockerProvider({
				image: "img:1",
				exec: absent.exec,
			}).status("CYPACK-1"),
		).toBe("absent");
		expect(
			await new LocalDockerProvider({
				image: "img:1",
				exec: stopped.exec,
			}).status("CYPACK-1"),
		).toBe("stopped");
	});

	it("stop calls docker stop with a grace period longer than the flush cap, by container name, and ignores non-zero exit", async () => {
		const { exec, calls } = fakeExec({ stop: { exitCode: 1 } });
		await new LocalDockerProvider({ image: "img:1", exec }).stop("CYPACK-1");
		// -t must exceed WorkspaceSyncService's 20s stop-flush cap, or an
		// idle-stop can SIGKILL a container mid-flush and drop its last WIP
		// push. Docker's own default (10s, i.e. no -t) is NOT enough.
		expect(calls).toEqual([
			["docker", "stop", "-t", "30", "cyrus-issue-CYPACK-1"],
		]);
	});

	it("destroy removes container then volume, tolerating absence", async () => {
		const { exec, calls } = fakeExec({
			"rm -f": { exitCode: 1 },
			"volume rm": { exitCode: 1 },
		});
		await new LocalDockerProvider({ image: "img:1", exec }).destroy("CYPACK-1");
		expect(calls.map((c) => c[1])).toEqual(["rm", "volume"]);
	});

	it("destroy targets the sanitized container and volume names", async () => {
		const { exec, calls } = fakeExec({});
		await new LocalDockerProvider({ image: "img:1", exec }).destroy("CYPACK-1");
		expect(calls).toEqual([
			["docker", "rm", "-f", "cyrus-issue-CYPACK-1"],
			["docker", "volume", "rm", "cyrus-issue-CYPACK-1"],
		]);
	});

	it("sanitizes issue keys with disallowed characters in resource names", async () => {
		const { exec, calls } = fakeExec({ "inspect -f": { exitCode: 1 } });
		const p = new LocalDockerProvider({ image: "img:1", exec });
		await p.ensureRunning(ctx("team/CYPACK 1"));
		expect(
			calls.some(
				(c) => c[1] === "inspect" && c[4] === "cyrus-issue-team-CYPACK-1",
			),
		).toBe(true);
		const run = calls.find((c) => c[1] === "run");
		expect(run).toContain("cyrus-issue-team-CYPACK-1");
	});

	it("round-trips the raw (unsanitized) issue key through the label so listManaged() and orphan GC can match it back to the router's issue key", async () => {
		const dirtyKey = "team/CYPACK 1";
		const { exec, calls } = fakeExec({
			"inspect -f": { exitCode: 1 },
			"ps -a": { stdout: `${dirtyKey}\n` },
		});
		const p = new LocalDockerProvider({ image: "img:1", exec });
		await p.ensureRunning(ctx(dirtyKey));

		const run = calls.find((c) => c[1] === "run");
		// The label carries the raw key, NOT the sanitized resource name.
		expect(run).toContain(`cyrus.issue=${dirtyKey}`);
		expect(run).not.toContain("cyrus.issue=cyrus-issue-team-CYPACK-1");
		// But the container/volume name IS sanitized.
		expect(run).toContain("cyrus-issue-team-CYPACK-1");

		// listManaged() hands back the original, unsanitized key.
		expect(await p.listManaged()).toEqual([dirtyKey]);
	});

	it("stop and destroy sanitize the container/volume name for a dirty issue key", async () => {
		const dirtyKey = "team/CYPACK 1";

		const { exec: stopExec, calls: stopCalls } = fakeExec({});
		await new LocalDockerProvider({ image: "img:1", exec: stopExec }).stop(
			dirtyKey,
		);
		expect(stopCalls).toEqual([
			["docker", "stop", "-t", "30", "cyrus-issue-team-CYPACK-1"],
		]);

		const { exec: destroyExec, calls: destroyCalls } = fakeExec({});
		await new LocalDockerProvider({
			image: "img:1",
			exec: destroyExec,
		}).destroy(dirtyKey);
		expect(destroyCalls).toEqual([
			["docker", "rm", "-f", "cyrus-issue-team-CYPACK-1"],
			["docker", "volume", "rm", "cyrus-issue-team-CYPACK-1"],
		]);
	});

	it("applies memory limit and network flags to the run command when configured", async () => {
		const { exec, calls } = fakeExec({ "inspect -f": { exitCode: 1 } });
		const p = new LocalDockerProvider({
			image: "img:1",
			memoryLimit: "2g",
			network: "cyrus-net",
			exec,
		});
		await p.ensureRunning(ctx());
		const run = calls.find((c) => c[1] === "run");
		expect(run).toContain("--memory");
		expect(run).toContain("2g");
		expect(run).toContain("--network");
		expect(run).toContain("cyrus-net");
	});
});
