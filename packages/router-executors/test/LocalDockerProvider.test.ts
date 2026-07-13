import { describe, expect, it } from "vitest";
import { LocalDockerProvider } from "../src/LocalDockerProvider.js";

function fakeExec(
	script: Record<string, { stdout?: string; exitCode?: number }>,
) {
	const calls: string[][] = [];
	const exec = async (cmd: string, args: string[]) => {
		calls.push([cmd, ...args]);
		const key = args.slice(0, 2).join(" "); // e.g. "inspect -f", "run -d"
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

	it("recreates (rm -f, then run) when the image is stale", async () => {
		const { exec, calls } = fakeExec({
			"inspect -f": { stdout: "false\timg:0\n" },
		});
		const p = new LocalDockerProvider({ image: "img:1", exec });
		await p.ensureRunning(ctx());
		expect(calls.some((c) => c[1] === "rm" && c.includes("-f"))).toBe(true);
		expect(calls.some((c) => c[1] === "run")).toBe(true);
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

	it("stop calls docker stop by container name and ignores non-zero exit", async () => {
		const { exec, calls } = fakeExec({ stop: { exitCode: 1 } });
		await new LocalDockerProvider({ image: "img:1", exec }).stop("CYPACK-1");
		expect(calls).toEqual([["docker", "stop", "cyrus-issue-CYPACK-1"]]);
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
