import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:child_process so the module under test sees a controllable
// spawnSync. vi.mock is hoisted, so we use vi.hoisted to declare the mock
// handle before it is referenced inside the factory.
vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

import { CYRUS_EVENTS } from "cyrus-core";
import {
	checkLinuxSandboxRequirements,
	logSandboxRequirementFailures,
	resetSandboxRequirementsCacheForTesting,
	resolveSubprocessEnvScrub,
	SDK_SUBPROCESS_ENV_SCRUB_ENV,
	SUBPROCESS_ENV_SCRUB_ENV,
	SubprocessEnvScrubUnavailableError,
} from "../src/sandbox-requirements";

const spawnSyncMock = vi.mocked(spawnSync);

type SpawnSyncCall = {
	command: string;
	args: string[];
};

function okResult(stdout = "/usr/bin/example\n"): SpawnSyncReturns<string> {
	return {
		pid: 1,
		output: [null, stdout, ""],
		stdout,
		stderr: "",
		status: 0,
		signal: null,
	} as SpawnSyncReturns<string>;
}

function failResult(stderr: string, status = 1): SpawnSyncReturns<string> {
	return {
		pid: 1,
		output: [null, "", stderr],
		stdout: "",
		stderr,
		status,
		signal: null,
	} as SpawnSyncReturns<string>;
}

function matchCall(call: [string, string[]]): SpawnSyncCall {
	return { command: call[0], args: call[1] };
}

const ORIGINAL_PLATFORM = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", {
		value: platform,
		configurable: true,
	});
}

function createMockLogger() {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		event: vi.fn(),
		withContext: vi.fn(),
		getLevel: vi.fn(),
		setLevel: vi.fn(),
	};
}

/** The three `spawnSync` calls a fully-equipped Linux host answers. */
function mockSupportedLinuxHost(): void {
	spawnSyncMock
		.mockReturnValueOnce(okResult("/usr/bin/socat\n"))
		.mockReturnValueOnce(okResult("/usr/bin/bwrap\n"))
		.mockReturnValueOnce(okResult(""));
}

/** The two `spawnSync` calls a host with neither package answers. */
function mockUnequippedLinuxHost(): void {
	spawnSyncMock
		.mockReturnValueOnce(failResult("not found", 1)) // socat missing
		.mockReturnValueOnce(failResult("not found", 1)); // bwrap missing
}

describe("sandbox-requirements", () => {
	let mockLogger: ReturnType<typeof createMockLogger>;

	beforeEach(() => {
		resetSandboxRequirementsCacheForTesting();
		spawnSyncMock.mockReset();
		mockLogger = createMockLogger();
	});

	afterEach(() => {
		setPlatform(ORIGINAL_PLATFORM);
	});

	it("short-circuits to supported on non-Linux platforms without probing the host", () => {
		setPlatform("darwin");

		const result = checkLinuxSandboxRequirements();

		expect(result.supported).toBe(true);
		expect(result.platform).toBe("darwin");
		expect(result.failures).toEqual([]);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("reports success when socat and bubblewrap are both installed and the sandbox probe succeeds", () => {
		setPlatform("linux");

		// socat present, bwrap present, bwrap probe succeeds
		spawnSyncMock
			.mockReturnValueOnce(okResult("/usr/bin/socat\n"))
			.mockReturnValueOnce(okResult("/usr/bin/bwrap\n"))
			.mockReturnValueOnce(okResult(""));

		const result = checkLinuxSandboxRequirements();

		expect(result.supported).toBe(true);
		expect(result.failures).toEqual([]);

		const calls = spawnSyncMock.mock.calls.map((call) =>
			matchCall(call as [string, string[]]),
		);
		// First two calls probe PATH via `sh -c 'command -v <bin>'`
		expect(calls[0]).toEqual({
			command: "/bin/sh",
			args: ["-c", "command -v socat"],
		});
		expect(calls[1]).toEqual({
			command: "/bin/sh",
			args: ["-c", "command -v bwrap"],
		});
		// Third call runs the actual bwrap sandbox probe
		expect(calls[2]?.command).toBe("bwrap");
		expect(calls[2]?.args).toEqual([
			"--ro-bind",
			"/",
			"/",
			"--proc",
			"/proc",
			"--dev",
			"/dev",
			"--unshare-user",
			"--unshare-pid",
			"--unshare-net",
			"--",
			"true",
		]);
	});

	it("reports a socat failure with install guidance when socat is missing", () => {
		setPlatform("linux");

		spawnSyncMock
			.mockReturnValueOnce(failResult("not found", 1)) // socat missing
			.mockReturnValueOnce(okResult("/usr/bin/bwrap\n"))
			.mockReturnValueOnce(okResult(""));

		const result = checkLinuxSandboxRequirements();

		expect(result.supported).toBe(false);
		const socatFailure = result.failures.find((f) => f.check === "socat");
		expect(socatFailure).toBeDefined();
		expect(socatFailure?.message).toContain("socat");
		expect(socatFailure?.resolution).toContain("apt-get install");
	});

	it("reports a bubblewrap failure when bwrap is missing and skips the sandbox probe", () => {
		setPlatform("linux");

		spawnSyncMock
			.mockReturnValueOnce(okResult("/usr/bin/socat\n"))
			.mockReturnValueOnce(failResult("not found", 1)); // bwrap missing

		const result = checkLinuxSandboxRequirements();

		expect(result.supported).toBe(false);
		const bwrapFailure = result.failures.find((f) => f.check === "bubblewrap");
		expect(bwrapFailure).toBeDefined();
		expect(bwrapFailure?.message).toContain("bwrap");
		expect(bwrapFailure?.resolution).toContain("bubblewrap");

		// We should not have attempted to run the bwrap sandbox probe because
		// bwrap is not on PATH — doing so would just log a spurious ENOENT.
		expect(spawnSyncMock).toHaveBeenCalledTimes(2);
	});

	it("reports a bwrap-sandbox failure with kernel/AppArmor guidance when the probe fails", () => {
		setPlatform("linux");

		const stderr =
			"bwrap: setting up uid map: Permission denied\nanother line that should be ignored";
		spawnSyncMock
			.mockReturnValueOnce(okResult("/usr/bin/socat\n"))
			.mockReturnValueOnce(okResult("/usr/bin/bwrap\n"))
			.mockReturnValueOnce(failResult(stderr, 1));

		const result = checkLinuxSandboxRequirements();

		expect(result.supported).toBe(false);
		const probeFailure = result.failures.find(
			(f) => f.check === "bwrap-sandbox",
		);
		expect(probeFailure).toBeDefined();
		// Only the first stderr line should be surfaced in the short message
		expect(probeFailure?.message).toContain(
			"bwrap: setting up uid map: Permission denied",
		);
		expect(probeFailure?.message).not.toContain("another line");
		// Resolution mentions both kernel tuning and AppArmor profile paths
		expect(probeFailure?.resolution).toContain(
			"kernel.unprivileged_userns_clone",
		);
		expect(probeFailure?.resolution).toContain("/etc/apparmor.d/usr.bin.bwrap");
	});

	it("caches a supported result so repeated calls do not re-probe the host", () => {
		setPlatform("linux");

		mockSupportedLinuxHost();

		const first = checkLinuxSandboxRequirements();
		const second = checkLinuxSandboxRequirements();

		expect(first).toBe(second);
		// Three probes for the initial call, zero for the second
		expect(spawnSyncMock).toHaveBeenCalledTimes(3);
	});

	it("re-probes after a failure, so installing the missing packages takes effect without a restart", () => {
		setPlatform("linux");

		// First call: nothing installed.
		mockUnequippedLinuxHost();
		expect(checkLinuxSandboxRequirements().supported).toBe(false);
		expect(spawnSyncMock).toHaveBeenCalledTimes(2);

		// The operator now does exactly what the failure's resolution text told
		// them to do. Caching the negative would make this — and every session
		// after it, until the worker restarts — keep failing identically, which
		// on a long-lived sandbox means a destroy-and-re-prompt cycle to apply a
		// fix we ourselves asked for.
		mockSupportedLinuxHost();
		expect(checkLinuxSandboxRequirements().supported).toBe(true);
		expect(spawnSyncMock).toHaveBeenCalledTimes(5);
	});

	describe("logSandboxRequirementFailures", () => {
		it("does nothing when requirements are supported", () => {
			logSandboxRequirementFailures(
				{ supported: true, platform: "linux", failures: [] },
				mockLogger as any,
			);
			expect(mockLogger.warn).not.toHaveBeenCalled();
		});

		it("logs warn-level messages with each failure's resolution on the first call", () => {
			logSandboxRequirementFailures(
				{
					supported: false,
					platform: "linux",
					failures: [
						{
							check: "socat",
							message: "`socat` is not installed or not on PATH.",
							resolution: "Install socat.",
						},
					],
				},
				mockLogger as any,
			);

			// Should have: 1 header, 1 "sessions will continue" line, 1 per-failure detail
			expect(mockLogger.warn).toHaveBeenCalledTimes(3);
			expect(mockLogger.warn.mock.calls[0]?.[0]).toContain(
				"Linux sandbox requirements are not met",
			);
			// Names the switch the operator actually controls. The old wording
			// ("skipping CLAUDE_CODE_SUBPROCESS_ENV_SCRUB") implied the flag
			// would have been set if only the host were equipped, which was
			// never true and is what got NOR-412 filed as a security regression.
			expect(mockLogger.warn.mock.calls[0]?.[0]).toContain(
				SUBPROCESS_ENV_SCRUB_ENV,
			);
			expect(mockLogger.warn.mock.calls[2]?.[0]).toContain("[socat]");
			expect(mockLogger.warn.mock.calls[2]?.[0]).toContain("Install socat.");
		});

		it("is a no-op on subsequent calls within the same process", () => {
			const result = {
				supported: false,
				platform: "linux" as const,
				failures: [
					{
						check: "socat",
						message: "`socat` is not installed.",
						resolution: "Install socat.",
					},
				],
			};
			logSandboxRequirementFailures(result, mockLogger as any);
			logSandboxRequirementFailures(result, mockLogger as any);

			// Only the first call should have emitted warnings
			expect(mockLogger.warn).toHaveBeenCalledTimes(3);
		});
	});

	describe("resolveSubprocessEnvScrub", () => {
		function resolve(env: NodeJS.ProcessEnv) {
			return resolveSubprocessEnvScrub({ logger: mockLogger as any, env });
		}

		it("is disabled, and probes nothing, when the opt-in env var is unset", () => {
			setPlatform("linux");

			expect(resolve({}).enabled).toBe(false);

			// The host probe is the expensive part and its result is irrelevant
			// when we never intended to set the flag — running it is what
			// produced the misleading "requirements are not met" warning.
			expect(spawnSyncMock).not.toHaveBeenCalled();
			expect(mockLogger.warn).not.toHaveBeenCalled();
		});

		it.each(["", "0", "false", "off", "no"])(
			"treats %o as disabled",
			(value) => {
				setPlatform("linux");
				expect(resolve({ [SUBPROCESS_ENV_SCRUB_ENV]: value }).enabled).toBe(
					false,
				);
				expect(spawnSyncMock).not.toHaveBeenCalled();
			},
		);

		it.each(["1", "true", "TRUE", "on", "yes"])(
			"treats %o as requested",
			(value) => {
				setPlatform("linux");
				mockSupportedLinuxHost();

				expect(resolve({ [SUBPROCESS_ENV_SCRUB_ENV]: value }).enabled).toBe(
					true,
				);
			},
		);

		it("announces once, at info, that the scrub is off by default", () => {
			setPlatform("linux");

			resolve({});
			resolve({});

			expect(mockLogger.info).toHaveBeenCalledTimes(1);
			expect(mockLogger.info.mock.calls[0]?.[0]).toContain(
				SUBPROCESS_ENV_SCRUB_ENV,
			);
		});

		it("enables the scrub when requested and the host supports it", () => {
			setPlatform("linux");
			mockSupportedLinuxHost();

			expect(resolve({ [SUBPROCESS_ENV_SCRUB_ENV]: "1" }).enabled).toBe(true);
			expect(mockLogger.warn).not.toHaveBeenCalled();
		});

		it("refuses, rather than reporting the scrub active, on an unverified non-Linux host", () => {
			setPlatform("darwin");

			// `checkLinuxSandboxRequirements` reports every non-Linux host as
			// supported, which is right for a bubblewrap precheck and wrong as the
			// sole predicate for a credential control: it would return enabled
			// having probed nothing at all, on the one platform where the flag is
			// most likely to be a no-op and could never fail loudly.
			let error: SubprocessEnvScrubUnavailableError | undefined;
			try {
				resolve({ [SUBPROCESS_ENV_SCRUB_ENV]: "1" });
			} catch (caught) {
				error = caught as SubprocessEnvScrubUnavailableError;
			}

			expect(error).toBeInstanceOf(SubprocessEnvScrubUnavailableError);
			expect(error?.failures.map((f) => f.check)).toEqual(["platform"]);
			expect(error?.message).toContain("darwin");
			expect(spawnSyncMock).not.toHaveBeenCalled();
		});

		it("throws rather than silently degrading when requested but unsupported", () => {
			setPlatform("linux");
			mockUnequippedLinuxHost();

			expect(() => resolve({ [SUBPROCESS_ENV_SCRUB_ENV]: "1" })).toThrow(
				SubprocessEnvScrubUnavailableError,
			);
		});

		it("names every unmet requirement, and its resolution, in the thrown error", () => {
			setPlatform("linux");
			mockUnequippedLinuxHost();

			let error: SubprocessEnvScrubUnavailableError | undefined;
			try {
				resolve({ [SUBPROCESS_ENV_SCRUB_ENV]: "1" });
			} catch (caught) {
				error = caught as SubprocessEnvScrubUnavailableError;
			}

			expect(error).toBeInstanceOf(SubprocessEnvScrubUnavailableError);
			expect(error?.failures.map((f) => f.check)).toEqual([
				"socat",
				"bubblewrap",
			]);
			// The operator must be able to act on the failure from the message
			// alone — this is the only place the guidance appears on a path that
			// aborts the session.
			expect(error?.message).toContain(SUBPROCESS_ENV_SCRUB_ENV);
			expect(error?.message).toContain("[socat]");
			expect(error?.message).toContain("[bubblewrap]");
			expect(error?.message).toContain("apt-get install -y socat");
			expect(error?.message).toContain("apt-get install -y bubblewrap");
		});

		it("keeps throwing on every session, not just the first", () => {
			setPlatform("linux");
			mockUnequippedLinuxHost();

			const env = { [SUBPROCESS_ENV_SCRUB_ENV]: "1" };
			expect(() => resolve(env)).toThrow(SubprocessEnvScrubUnavailableError);
			// The once-per-process log latch must not be allowed to turn the
			// second session's hard failure into a silent one. Note the fresh
			// mocks: the negative is deliberately not cached, so this genuinely
			// re-probes rather than replaying a memoised verdict.
			mockUnequippedLinuxHost();
			expect(() => resolve(env)).toThrow(SubprocessEnvScrubUnavailableError);
		});

		it("stops throwing once the packages the error asked for are installed", () => {
			setPlatform("linux");
			const env = { [SUBPROCESS_ENV_SCRUB_ENV]: "1" };

			mockUnequippedLinuxHost();
			expect(() => resolve(env)).toThrow(SubprocessEnvScrubUnavailableError);

			// Same process, no restart — the operator ran the apt-get line the
			// error printed.
			mockSupportedLinuxHost();
			expect(resolve(env).enabled).toBe(true);
		});

		it("warns once when the SDK flag is set directly, since it is now overwritten", () => {
			setPlatform("linux");

			const env = { [SDK_SUBPROCESS_ENV_SCRUB_ENV]: "1" };
			expect(resolve(env).enabled).toBe(false);
			expect(resolve(env).enabled).toBe(false);

			// Silently dropping it looks exactly like the control working, which
			// is the failure mode this whole issue is about.
			expect(mockLogger.warn).toHaveBeenCalledTimes(1);
			const warning = mockLogger.warn.mock.calls[0]?.[0] as string;
			expect(warning).toContain(SDK_SUBPROCESS_ENV_SCRUB_ENV);
			expect(warning).toContain(SUBPROCESS_ENV_SCRUB_ENV);
		});

		it("does not warn about the SDK flag when it is not set", () => {
			setPlatform("linux");

			resolve({});

			expect(mockLogger.warn).not.toHaveBeenCalled();
		});

		it("emits a queryable posture event for every outcome", () => {
			setPlatform("linux");

			// Off by default.
			resolve({});
			expect(mockLogger.event).toHaveBeenCalledWith(
				CYRUS_EVENTS.sessionEnvScrubResolved,
				expect.objectContaining({
					"cyrus.requested": false,
					"cyrus.enabled": false,
				}),
			);

			// Requested and unavailable — the combination worth alerting on,
			// because it aborts every session on the host. A prose log line is not
			// something monitoring.bicep can key on, which was the original
			// complaint.
			mockLogger.event.mockClear();
			mockUnequippedLinuxHost();
			expect(() => resolve({ [SUBPROCESS_ENV_SCRUB_ENV]: "1" })).toThrow();
			expect(mockLogger.event).toHaveBeenCalledWith(
				CYRUS_EVENTS.sessionEnvScrubResolved,
				expect.objectContaining({
					"cyrus.requested": true,
					"cyrus.enabled": false,
					"cyrus.failures": "socat,bubblewrap",
				}),
			);

			// Requested and honoured.
			mockLogger.event.mockClear();
			mockSupportedLinuxHost();
			expect(resolve({ [SUBPROCESS_ENV_SCRUB_ENV]: "1" }).enabled).toBe(true);
			expect(mockLogger.event).toHaveBeenCalledWith(
				CYRUS_EVENTS.sessionEnvScrubResolved,
				expect.objectContaining({
					"cyrus.requested": true,
					"cyrus.enabled": true,
				}),
			);
		});
	});
});
