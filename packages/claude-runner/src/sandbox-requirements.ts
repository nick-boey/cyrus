import { spawnSync } from "node:child_process";
import { CYRUS_EVENTS, cyrusAttributes, type ILogger } from "cyrus-core";

/**
 * A single failed sandbox requirement, with user-facing guidance
 * for how to fix the underlying issue.
 */
export interface SandboxRequirementFailure {
	/** Short identifier for the failed check (e.g., "socat", "bubblewrap", "bwrap-sandbox"). */
	check: string;
	/** Human-readable description of what failed. */
	message: string;
	/** Multi-line instructions explaining how to resolve the failure. */
	resolution: string;
}

/** Result of running the Linux sandbox requirements check. */
export interface SandboxRequirementsResult {
	/**
	 * True when the host platform is supported and sandbox mode is safe to enable.
	 * Non-Linux platforms (macOS, Windows) always return `supported: true` because
	 * the Claude Code SDK does not require bubblewrap on those systems.
	 */
	supported: boolean;
	/** Platform the check ran against — useful for diagnostics and testing. */
	platform: NodeJS.Platform;
	/** All failed checks (empty when `supported` is true). */
	failures: SandboxRequirementFailure[];
}

/**
 * Env var that opts a host into subprocess env scrubbing.
 *
 * Deliberately a Cyrus-side switch rather than passing
 * `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` straight through: the SDK flag is a
 * best-effort hint that does nothing on a host without bubblewrap, and the
 * whole point of {@link resolveSubprocessEnvScrub} is that asking for the
 * control and not getting it must be an error rather than a shrug.
 *
 * Accepts `1` / `true` / `on` / `yes` (case-insensitive) — the same set
 * `isOtelTracingEnabled` accepts, so the CYRUS_* switches parse alike. Anything
 * else, including unset, leaves the scrub off.
 *
 * Read from the WORKER's own `process.env`, not from a repository `.env`. It
 * describes the host's capability, which no single repository is in a position
 * to assert; setting it in a repository `.env` has no effect.
 */
export const SUBPROCESS_ENV_SCRUB_ENV = "CYRUS_SUBPROCESS_ENV_SCRUB";

/**
 * The SDK-side flag {@link SUBPROCESS_ENV_SCRUB_ENV} governs.
 *
 * Named here only so we can notice it being set directly and say so: every
 * caller overwrites it from {@link resolveSubprocessEnvScrub}'s verdict, so a
 * value set by hand — in the worker's env, a repository `.env`, or a stored
 * secret bundle — is silently discarded. Silently is the part worth fixing;
 * someone who set this to re-enable the control after CYPACK-1108 would
 * otherwise have no way to learn it stopped being the switch.
 */
export const SDK_SUBPROCESS_ENV_SCRUB_ENV = "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB";

/**
 * Thrown when a host asks for subprocess env scrubbing it cannot support.
 *
 * This is fatal on purpose. A security control that degrades to off with a
 * `warn` is off again the next time a dependency goes missing, and nothing
 * alerts on it — which is exactly how the worker image shipped for months
 * without `socat` or `bubblewrap` and nobody noticed (NOR-412).
 */
export class SubprocessEnvScrubUnavailableError extends Error {
	readonly failures: SandboxRequirementFailure[];

	constructor(failures: SandboxRequirementFailure[]) {
		super(
			[
				`${SUBPROCESS_ENV_SCRUB_ENV} is set, but this host cannot support subprocess env scrubbing:`,
				...failures.map(
					(failure) =>
						`  [${failure.check}] ${failure.message}\n${indent(failure.resolution, 6)}`,
				),
				`Resolve the above, or unset ${SUBPROCESS_ENV_SCRUB_ENV} to run without the scrub.`,
			].join("\n"),
		);
		this.name = "SubprocessEnvScrubUnavailableError";
		this.failures = failures;
	}
}

// Memoize the check at the module level so we only probe the system once per
// process, and we only log guidance to the user on the first probe.
//
// ONLY a supported result is cached. A negative is a statement about packages
// that are missing right now, and the error we raise off the back of it tells
// the operator to go install them — so caching it means the very next session
// after a successful `apt-get install` fails identically, and every session
// after that, until the worker restarts. On a long-lived ACA sandbox that turns
// a self-service fix into a `router containers destroy` and re-prompt, with
// nothing saying so. Re-probing costs two or three `spawnSync` calls and only
// happens on the opt-in-and-currently-broken path, which is already fatal.
let cachedResult: SandboxRequirementsResult | undefined;
let hasLoggedFailures = false;
let hasLoggedScrubDisabled = false;
let hasLoggedSdkFlagIgnored = false;

/**
 * Verify that the host Linux system has the packages and kernel/AppArmor
 * configuration required by the Claude Code SDK sandbox runtime.
 *
 * Setting `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` in the SDK's child process env
 * causes the SDK to run tooling under a bubblewrap-backed sandbox on Linux.
 * If the host is missing `socat`, `bubblewrap`, or cannot create an
 * unprivileged user namespace, those tool invocations will fail at runtime.
 *
 * This check returns a structured result so the caller can decide whether to
 * set the env var, and prints resolution guidance to stdout on the first
 * failed check so users running locally can self-diagnose.
 *
 * The result is cached per process; tests can use
 * {@link resetSandboxRequirementsCacheForTesting} to reset it.
 */
export function checkLinuxSandboxRequirements(): SandboxRequirementsResult {
	if (cachedResult !== undefined) {
		return cachedResult;
	}

	const platform = process.platform;

	// Only Linux hosts need the bubblewrap-based runtime checks. On macOS and
	// Windows the SDK uses platform-native sandboxing (or no sandbox at all),
	// so there is nothing to verify here.
	if (platform !== "linux") {
		cachedResult = { supported: true, platform, failures: [] };
		return cachedResult;
	}

	const failures: SandboxRequirementFailure[] = [];

	if (!isCommandAvailable("socat")) {
		failures.push({
			check: "socat",
			message: "`socat` is not installed or not on PATH.",
			resolution: [
				"Install socat using your package manager:",
				"  Debian/Ubuntu:  sudo apt-get install -y socat",
				"  Fedora/RHEL:    sudo dnf install -y socat",
				"  Alpine:         sudo apk add socat",
			].join("\n"),
		});
	}

	const bwrapAvailable = isCommandAvailable("bwrap");
	if (!bwrapAvailable) {
		failures.push({
			check: "bubblewrap",
			message: "`bwrap` (bubblewrap) is not installed or not on PATH.",
			resolution: [
				"Install bubblewrap using your package manager:",
				"  Debian/Ubuntu:  sudo apt-get install -y bubblewrap",
				"  Fedora/RHEL:    sudo dnf install -y bubblewrap",
				"  Alpine:         sudo apk add bubblewrap",
			].join("\n"),
		});
	} else {
		const sandboxProbe = runBwrapSandboxProbe();
		if (!sandboxProbe.ok) {
			failures.push({
				check: "bwrap-sandbox",
				message: `bubblewrap cannot create an unprivileged user namespace: ${sandboxProbe.reason}`,
				resolution: buildBwrapSandboxResolution(),
			});
		}
	}

	const result: SandboxRequirementsResult = {
		supported: failures.length === 0,
		platform,
		failures,
	};
	// Deliberately not caching a failure — see the note on `cachedResult`.
	if (result.supported) {
		cachedResult = result;
	}
	return result;
}

/**
 * Decide whether this session should set `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`.
 *
 * Three outcomes, and the asymmetry between them is the point:
 *
 * - **Not requested** (the default, preserving CYPACK-1108): returns disabled
 *   *without probing the host at all*. The requirements of a control we never
 *   intended to enable are not interesting, and probing for them is what
 *   produced nine sandboxes' worth of "requirements are not met — skipping"
 *   warnings for a flag no code path would have set anyway (NOR-412).
 * - **Requested and supported**: returns enabled.
 * - **Requested and unsupported**: throws
 *   {@link SubprocessEnvScrubUnavailableError}. Aborting the session is the
 *   alert that the warn-and-continue path never was.
 *
 * Every outcome also emits {@link CYRUS_EVENTS.sessionEnvScrubResolved}. The
 * complaint NOR-412 was filed about is that a security control was off and the
 * only trace was a prose log line, which nothing can alert on; a posture that is
 * not queryable would reproduce it.
 */
export function resolveSubprocessEnvScrub(options: {
	logger: ILogger;
	env?: NodeJS.ProcessEnv;
}): { enabled: boolean } {
	const env = options.env ?? process.env;
	const requested = isTruthyEnvValue(env[SUBPROCESS_ENV_SCRUB_ENV]);

	if (!requested) {
		if (!hasLoggedScrubDisabled) {
			hasLoggedScrubDisabled = true;
			options.logger.info(
				`Subprocess env scrubbing is off; set ${SUBPROCESS_ENV_SCRUB_ENV}=1 to require it.`,
			);
		}
		// Setting the SDK flag by hand used to be how this was turned on. It is
		// not any more — every call site overwrites it from this verdict — so say
		// so rather than dropping it on the floor, which would look identical to
		// the control working.
		if (
			!hasLoggedSdkFlagIgnored &&
			isTruthyEnvValue(env[SDK_SUBPROCESS_ENV_SCRUB_ENV])
		) {
			hasLoggedSdkFlagIgnored = true;
			options.logger.warn(
				`${SDK_SUBPROCESS_ENV_SCRUB_ENV} is set but will be ignored — it is ` +
					`overwritten per session from ${SUBPROCESS_ENV_SCRUB_ENV}. Set ` +
					`${SUBPROCESS_ENV_SCRUB_ENV}=1 instead to require subprocess env scrubbing.`,
			);
		}
		emitScrubPosture(options.logger, {
			requested: false,
			enabled: false,
			platform: process.platform,
		});
		return { enabled: false };
	}

	const requirements = checkSubprocessEnvScrubRequirements();
	if (!requirements.supported) {
		// Log the guidance as well as throwing. The log is once per process
		// (`hasLoggedFailures`), so it is the FIRST failing session that gets a
		// WARN block; every session after it is covered by the throw, whose
		// message carries the same per-failure resolutions. The throw is the
		// load-bearing half — never let this call become the only signal.
		logSandboxRequirementFailures(requirements, options.logger);
		emitScrubPosture(options.logger, {
			requested: true,
			enabled: false,
			platform: requirements.platform,
			failures: requirements.failures.map((failure) => failure.check).join(","),
		});
		throw new SubprocessEnvScrubUnavailableError(requirements.failures);
	}

	emitScrubPosture(options.logger, {
		requested: true,
		enabled: true,
		platform: requirements.platform,
	});
	return { enabled: true };
}

/**
 * The requirements of the scrub *as a control we are about to rely on*, which
 * is a stricter question than {@link checkLinuxSandboxRequirements} answers.
 *
 * That function reports every non-Linux host as supported, and correctly so for
 * what it was built for: it is a bubblewrap precheck, and there is no bubblewrap
 * to check for on macOS or Windows. But "we found nothing to object to" is not
 * "the control is in place", and using it as the sole predicate meant
 * `CYRUS_SUBPROCESS_ENV_SCRUB=1` on a Mac returned enabled having probed
 * precisely nothing. Nothing in this repository or in the SDK's typings
 * establishes that the flag does anything off Linux — it is absent from
 * `sdk.d.ts` entirely — so the one platform where the control is most likely to
 * be a silent no-op was also the one where it could never fail loudly. That is
 * the failure NOR-412 is about, reintroduced on the other half of the platform
 * matrix.
 *
 * Refuse instead, and say why. When the scrub is observed working on another
 * platform, add it here.
 */
function checkSubprocessEnvScrubRequirements(): SandboxRequirementsResult {
	const platform = process.platform;
	if (platform !== "linux") {
		return {
			supported: false,
			platform,
			failures: [
				{
					check: "platform",
					message: `subprocess env scrubbing has only been verified on Linux; this host is ${platform}.`,
					resolution: [
						`The bubblewrap-backed scrub ${SDK_SUBPROCESS_ENV_SCRUB_ENV} selects is a`,
						"Linux mechanism, and the flag is undocumented in the Claude Agent SDK's",
						"typings, so we cannot assert it does anything here. Rather than report a",
						"credential control as active without checking anything, this is refused.",
						"",
						`Unset ${SUBPROCESS_ENV_SCRUB_ENV} to run without it.`,
					].join("\n"),
				},
			],
		};
	}
	return checkLinuxSandboxRequirements();
}

function emitScrubPosture(
	logger: ILogger,
	attributes: {
		requested: boolean;
		enabled: boolean;
		platform: NodeJS.Platform;
		failures?: string;
	},
): void {
	logger.event(
		CYRUS_EVENTS.sessionEnvScrubResolved,
		cyrusAttributes({
			requested: attributes.requested,
			enabled: attributes.enabled,
			platform: attributes.platform,
			...(attributes.failures !== undefined && {
				failures: attributes.failures,
			}),
		}),
	);
}

/**
 * Log requirement failures as WARN-level messages via the dedicated logger.
 * The warnings are emitted at most once per process; subsequent calls are
 * no-ops regardless of which logger instance is passed.
 */
export function logSandboxRequirementFailures(
	result: SandboxRequirementsResult,
	logger: ILogger,
): void {
	if (result.supported || hasLoggedFailures) {
		return;
	}
	hasLoggedFailures = true;

	logger.warn(
		`Linux sandbox requirements are not met — ${SUBPROCESS_ENV_SCRUB_ENV} cannot be honored.`,
	);
	logger.warn(
		"Subprocess env scrubbing is unavailable on this host until these are resolved:",
	);

	for (const failure of result.failures) {
		logger.warn(
			`  [${failure.check}] ${failure.message}\n${indent(failure.resolution, 6)}`,
		);
	}
}

/**
 * Reset the cached requirements result and the "already logged" flags.
 * Intended for use in unit tests only.
 */
export function resetSandboxRequirementsCacheForTesting(): void {
	cachedResult = undefined;
	hasLoggedFailures = false;
	hasLoggedScrubDisabled = false;
	hasLoggedSdkFlagIgnored = false;
}

function indent(text: string, spaces: number): string {
	const pad = " ".repeat(spaces);
	return text
		.split("\n")
		.map((line) => `${pad}${line}`)
		.join("\n");
}

function isTruthyEnvValue(value: string | undefined): boolean {
	if (value === undefined) {
		return false;
	}
	return ["1", "true", "on", "yes"].includes(value.trim().toLowerCase());
}

function isCommandAvailable(command: string): boolean {
	// `command -v` is a POSIX builtin, so we invoke it through /bin/sh to avoid
	// depending on `which` being installed (it is not present on some minimal
	// container images). `spawnSync` with an argv array avoids shell-injection
	// risk even though `command` is a fixed string.
	const probe = spawnSync("/bin/sh", ["-c", `command -v ${command}`], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return probe.status === 0 && (probe.stdout?.trim().length ?? 0) > 0;
}

interface BwrapProbeResult {
	ok: boolean;
	reason: string;
}

function runBwrapSandboxProbe(): BwrapProbeResult {
	// Mirror the command from the CYPACK-1091 spec but execute `true` instead
	// of `ip addr`. We only care whether bwrap can construct the namespace; we
	// do not need to observe the network state inside it, and `ip` may not be
	// installed on every host.
	const probe = spawnSync(
		"bwrap",
		[
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
		],
		{
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10_000,
		},
	);

	if (probe.error) {
		return { ok: false, reason: probe.error.message };
	}
	if (probe.status === 0) {
		return { ok: true, reason: "" };
	}

	const stderr = probe.stderr?.trim();
	const firstStderrLine =
		stderr && stderr.length > 0 ? stderr.split("\n")[0] : undefined;
	const reason =
		firstStderrLine ?? `bwrap exited with status ${probe.status ?? "unknown"}`;
	return { ok: false, reason };
}

function buildBwrapSandboxResolution(): string {
	return [
		"1. Ensure unprivileged user namespaces are enabled:",
		"     sysctl kernel.unprivileged_userns_clone   # should print 1",
		"     sudo sysctl -w kernel.unprivileged_userns_clone=1",
		"",
		"2. On AppArmor-enabled hosts (e.g. Ubuntu 24.04+), install an",
		"   unconfined profile for bwrap:",
		"",
		"     sudo tee /etc/apparmor.d/usr.bin.bwrap >/dev/null <<'EOF'",
		"     abi <abi/4.0>,",
		"     include <tunables/global>",
		"",
		"     /usr/bin/bwrap flags=(unconfined) {",
		"       userns,",
		"       network,",
		"     }",
		"     EOF",
		"     sudo apparmor_parser -r /etc/apparmor.d/usr.bin.bwrap",
		"",
		"   (network is not required today but will be once network sandboxing lands.)",
	].join("\n");
}
