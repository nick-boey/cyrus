import type {
	ContainerExecutor,
	ContainerStatus,
	IssueExecutionContext,
	ManagedContainerState,
} from "../types.js";
import type {
	AcaDiskImage,
	AcaEgressPolicy,
	AcaLifecyclePolicy,
	AcaSandbox,
	AcaSandboxClient,
	AcaSnapshot,
} from "./AcaSandboxClient.js";

/**
 * Default egress host allowlist (plan D7). Deny-by-default with `Full`
 * traffic inspection. Sized for real polyglot workloads the worker image
 * ships: package managers (npm/yarn/pip/go/rust/ruby/maven/nuget), the
 * code hosts (GitHub/GitHub raw/usercontent), and the SaaS APIs Cyrus
 * talks to (Anthropic API + OAuth refresh, Linear HTTP + MCP).
 *
 * The router's own host is appended at construction time from
 * {@link AcaSandboxesProviderOpts.routerUrlForContainers} so container→router
 * WSS works under `Full` inspection (spike S4 confirmed WSS rides through
 * Full inspection; no `Partial` fallback needed). When the router URL is
 * absent (tests without a router), no router host is added.
 *
 * V1 limitation, documented: `Full` inspection blocks non-HTTP TCP/UDP, so
 * `git@…:` / `git+ssh://` (e.g. SSH submodule URLs) is unsupported — use
 * HTTPS submodule URLs.
 */
const DEFAULT_EGRESS_HOSTS: { pattern: string; action: "Allow" | "Deny" }[] = [
	{ pattern: "*.github.com", action: "Allow" },
	{ pattern: "api.github.com", action: "Allow" },
	{ pattern: "*.githubusercontent.com", action: "Allow" },
	{ pattern: "api.anthropic.com", action: "Allow" },
	{ pattern: "console.anthropic.com", action: "Allow" },
	// Codex, in both auth modes, and unconditionally — see ADR 0005.
	//
	// `chatgpt.com` is the one that matters and the one that is easy to miss:
	// under ChatGPT-subscription auth, inference goes to
	// `chatgpt.com/backend-api/codex/responses` and `api.openai.com` is never
	// touched, so allowlisting only the latter produces the worst failure shape
	// available — authentication succeeds and every request fails. It needs
	// WebSocket upgrades to ride through `Full` inspection, as the router's own
	// host already does (spike S4). `auth.openai.com` carries refresh and
	// revocation; `api.openai.com` is the metered `OPENAI_API_KEY` fallback.
	//
	// All three go in regardless of which mode a given user runs, because egress
	// is applied at sandbox-CREATE time only and has no update API: an
	// unnecessary entry costs nothing, while a missing one costs a fleet-wide
	// destroy-and-recreate.
	{ pattern: "chatgpt.com", action: "Allow" },
	{ pattern: "auth.openai.com", action: "Allow" },
	{ pattern: "api.openai.com", action: "Allow" },
	{ pattern: "mcp.linear.app", action: "Allow" },
	{ pattern: "api.linear.app", action: "Allow" },
	{ pattern: "*.linear.app", action: "Allow" },
	{ pattern: "login.microsoftonline.com", action: "Allow" },
	{ pattern: "management.azure.com", action: "Allow" },
	{ pattern: "api.loganalytics.io", action: "Allow" },
	{ pattern: "api.loganalytics.azure.com", action: "Allow" },
	// Application Insights' own data plane, which `az monitor app-insights
	// query` reads — a different host from the Log Analytics pair above, and
	// not covered by either. The extension that provides that command is baked
	// into the worker image, so this is the half of the pair that has to be
	// solved here rather than in the Dockerfile.
	//
	// Everything from here down is mirrored in TRUSTED_DOMAINS (cyrus-core).
	// The two are NOT belt-and-braces on one sandbox: THIS list is what an ACA
	// sandbox is created with, always, while TRUSTED_DOMAINS applies only where
	// an operator sets `sandbox.networkPolicy.preset: "trusted"` — nothing in
	// the router or CLI sets it. So an entry here is what makes an ACA sandbox
	// work, and the mirror is what stops the preset from being the thing that
	// blocks it. Both, for it to work everywhere.
	{ pattern: "api.applicationinsights.io", action: "Allow" },
	{ pattern: "api.applicationinsights.azure.com", action: "Allow" },
	// Microsoft Artifact Registry, which is where `br/public:` resolves to:
	// the alias expands to `mcr.microsoft.com/bicep/`, so a template
	// referencing any Azure Verified Module fails during MODULE RESTORE —
	// before a single line is compiled, and with a `BCP192 … Status: 403
	// (Forbidden)` that names the registry rather than the sandbox. Baking the
	// Bicep CLI into the image does not help with this half: the compiler is
	// present and still cannot reach its own module registry. `*.data.` is the
	// blob CDN the manifest redirects layer pulls to.
	{ pattern: "mcr.microsoft.com", action: "Allow" },
	{ pattern: "*.data.mcr.microsoft.com", action: "Allow" },
	// Azure CLI's extension machinery. `az extension add` resolves its index
	// through `https://aka.ms/azure-cli-extension-index-v1`, which redirects to
	// the sync blob, and then pulls each wheel from the CLI's own storage
	// account. Without all three, adding ANY extension a session turns out to
	// need fails with `Unable to get extension index. Server returned status
	// code 403` — an error that reads as an upstream outage rather than as
	// egress (CYR-88). `aka.ms` is a shared Microsoft shortener and is also
	// what Bicep's own installer and version check use; the worker image sets
	// `AZURE_BICEP_USE_BINARY_FROM_PATH` so `az bicep` never needs it, but a
	// repo invoking the installer directly still does.
	{ pattern: "aka.ms", action: "Allow" },
	{ pattern: "go.microsoft.com", action: "Allow" },
	{ pattern: "azcliextensionsync.blob.core.windows.net", action: "Allow" },
	{ pattern: "azcliprod.blob.core.windows.net", action: "Allow" },
	// PowerShell Gallery. Pester is baked into the worker image precisely
	// because this endpoint set is a moving target — Microsoft retired the
	// `psg-prod-*.azureedge.net` hosts its own firewall guidance named for
	// years — so treat these as enabling a repo to install its OWN modules,
	// not as the thing that makes a Pester suite runnable. The symptom when
	// they are missing is `Get-PackageSource: Unable to find repository
	// 'PSGallery'`, which names no host at all. `cdn.oneget.org` is where the
	// NuGet package provider bootstraps from, and PowerShellGet fetches it
	// before it fetches anything else.
	{ pattern: "*.powershellgallery.com", action: "Allow" },
	{ pattern: "www.powershellgallery.com", action: "Allow" },
	{ pattern: "cdn.powershellgallery.com", action: "Allow" },
	{ pattern: "cdn.oneget.org", action: "Allow" },
	{ pattern: "registry.npmjs.org", action: "Allow" },
	{ pattern: "*.npmjs.org", action: "Allow" },
	{ pattern: "registry.yarnpkg.com", action: "Allow" },
	{ pattern: "pypi.org", action: "Allow" },
	{ pattern: "files.pythonhosted.org", action: "Allow" },
	{ pattern: "proxy.golang.org", action: "Allow" },
	{ pattern: "sum.golang.org", action: "Allow" },
	{ pattern: "crates.io", action: "Allow" },
	// Cargo's sparse registry protocol (the default since Rust 1.70) reads the
	// index from index.crates.io, not crates.io — without it every `cargo
	// build`/`cargo test` in a sandbox fails before it downloads a single
	// crate. static.rust-lang.org is what rustup fetches toolchains from, which
	// a repo pinning a version in rust-toolchain.toml needs.
	{ pattern: "index.crates.io", action: "Allow" },
	{ pattern: "static.crates.io", action: "Allow" },
	{ pattern: "static.rust-lang.org", action: "Allow" },
	{ pattern: "rubygems.org", action: "Allow" },
	{ pattern: "repo.maven.apache.org", action: "Allow" },
	{ pattern: "repo1.maven.org", action: "Allow" },
	{ pattern: "api.nuget.org", action: "Allow" },
	{ pattern: "*.nuget.org", action: "Allow" },
	// The Argos visual-testing CLI baked into the worker image. `argos upload`
	// authenticates and uploads against api.argos-ci.com; without this entry
	// `ARGOS_TOKEN` is set and every call is denied, which reads as an auth
	// failure rather than an egress one.
	{ pattern: "api.argos-ci.com", action: "Allow" },
	// Playwright's browser CDN. The worker image bakes one Chromium revision,
	// but the revision Playwright will actually launch is decided by the
	// REPOSITORY's `playwright-core` pin — every version ships its own
	// `browsers.json`, and Playwright ignores a browser directory whose revision
	// does not match rather than falling back to it. So a repo pinning a
	// different Playwright than the image sees the baked browser as dead weight
	// and asks for a `playwright install`. Without these entries that download
	// is denied and the repo's Playwright-backed suites cannot run at all
	// (CYR-87); with them the mismatch degrades to a one-time fetch into the
	// shared `/ms-playwright`.
	//
	// Five hosts, because Playwright has used two different mirror sets and two
	// different code paths, and which one applies is the REPOSITORY's choice:
	//   - >=1.50 ships `cdn.playwright.dev` and
	//     `playwright.download.prss.microsoft.com` as `PLAYWRIGHT_CDN_MIRRORS`.
	//     Neither covers for the other: on x64 the Chromium builds resolve
	//     through the Chrome-for-Testing path, whose only mirror override is
	//     `cdn.playwright.dev`, while ffmpeg and the arm64 Chromium builds fall
	//     through the mirror list and can land on either.
	//   - <=1.49 knows only the three `*.azureedge.net` mirrors. They still
	//     resolve (re-fronted by Azure Front Door), so a repo on an older pin
	//     gets served rather than being left on the original CYR-87 failure.
	// Cyrus applies egress at sandbox-CREATE time and implements no update
	// call, so a missing entry costs a destroy-and-recreate of every affected
	// sandbox while a redundant one costs nothing. (ACA itself does expose
	// `POST /sandboxes/{id}/egresspolicy`, verified against a live sandbox in
	// the 2026-07-25 spike — `AcaSandboxClient` just does not call it yet.)
	{ pattern: "cdn.playwright.dev", action: "Allow" },
	{ pattern: "playwright.download.prss.microsoft.com", action: "Allow" },
	{ pattern: "playwright.azureedge.net", action: "Allow" },
	{ pattern: "playwright-akamai.azureedge.net", action: "Allow" },
	{ pattern: "playwright-verizon.azureedge.net", action: "Allow" },
];

/** Normalised label keys the provider stamps on every managed resource. */
const LABEL_MANAGED = "cyrus.managed";
const LABEL_ISSUE = "cyrus.issue";
const LABEL_DISK = "cyrus.disk";
const LABEL_DEVICE_ID = "cyrus.device-id";

export interface AcaSnapshotGcItem {
	id: string;
	issueKey: string;
	deviceId: string;
	createdAtUtc?: string;
}

/** Label values are capped at 63 chars (Kubernetes-style) per spike S5. */
const LABEL_VALUE_MAX = 63;

function validateLabelValue(name: string, value: string): void {
	if (value.length > LABEL_VALUE_MAX) {
		throw new Error(
			`ACA label ${name} must be at most ${LABEL_VALUE_MAX} characters (received ${value.length})`,
		);
	}
}

/**
 * Provider-internal per-issue mutex (plan M1). Two concurrent
 * `ensureRunning` calls for the same issue — e.g. a delegation webhook and
 * a first-prompt webhook arriving seconds apart — must NEVER drive two
 * parallel creates (the second would mint a fresh device token and
 * invalidate the first sandbox's baked-in token). The whole `ensureRunning`
 * body, plus the post-create snapshot pruning, runs inside `lock()`.
 */
export interface AcaSandboxesProviderOptions {
	/** Injectable client; real deployments pass an `AcaSandboxClient`, tests pass a typed fake. */
	client: AcaSandboxClient;
	/** Worker container image, e.g. `ghcr.io/org/cyrus-worker:0.2.66`. */
	image: string;
	/**
	 * Pre-registered group disk image NAME. This is the staleness key: a
	 * sandbox whose `cyrus.disk` label doesn't match this has been left
	 * behind by an image bump and is replaced. Operators should
	 * pre-register the disk image (spike S1); {@link ensureDisk} is a
	 * best-effort fallback for the first boot.
	 */
	disk: string;
	/** Default `"4000m"` (4 vCPU — the XL tier). */
	cpu?: string;
	/** Default `"8192Mi"` (8 GiB — the XL tier). */
	memory?: string;
	/**
	 * ACA-side auto-suspend interval in seconds. Default `0` = DISABLED
	 * (plan N5): ACA's auto-suspend has no session-affinity gate and would
	 * freeze a live session mid-task. The router's affinity-aware
	 * `idleStopMs` remains the sole idle controller.
	 */
	autoSuspendSeconds?: number;
	/** Custom egress policy; when omitted, the D7 deny-by-default allowlist is used. */
	egress?: AcaEgressPolicy;
	/** Retention for EXPLICIT labeled snapshots (default 2 newest per issue). */
	keepSnapshots?: number;
	/**
	 * The router's public URL reachable FROM inside a sandbox, e.g.
	 * `wss://router.example.com`. Used ONLY to derive the router hostname
	 * appended to the default egress allowlist so WSS works — it is NOT
	 * injected into sandbox env (that's the caller's job via `ctx.env`).
	 */
	routerUrlForContainers?: string;
	logger?: { info(msg: string): void; warn(msg: string): void };
	/** Injectable clock for "newest snapshot" selection (tests). */
	now?: () => number;
	/** Injectable sleep, used to pace the post-resume connectivity poll (tests). */
	sleepFn?: (ms: number) => Promise<void>;
	/** Router WSS state for F1 worker-process liveness reconciliation. */
	deviceConnectivity?: (deviceId: string) => {
		connected: boolean;
		disconnectedSinceMs: number;
	};
	/** Recreate ACA Running sandboxes disconnected longer than this grace period. */
	disconnectedRecreateMs?: number;
	/**
	 * How long a resumed sandbox is given to re-establish its router WSS session
	 * before it is treated as a dead worker and replaced (default 90s).
	 *
	 * A memory resume takes ~1s of infrastructure time; the worker then has to
	 * notice its frozen socket is stale (its wall-clock liveness watchdog fires
	 * within two router heartbeats — 60s on the default cadence) and redial. The
	 * default therefore sits just above that worst case. Set to `0` to skip
	 * verification entirely and keep the older behavior of trusting ACA's
	 * infrastructure state.
	 */
	resumeConnectTimeoutMs?: number;
	/** Poll cadence while waiting for a resumed worker to reconnect (default 2s). */
	resumeConnectPollMs?: number;
}

/**
 * Azure Container Apps (ACA) Sandboxes executor — one cloud sandbox per
 * Linear issue, suspend/resume for warm state, deny-by-default egress,
 * snapshots for the cold fast-path (lineage-checked, plan B5/D3).
 *
 * See `docs/superpowers/plans/2026-07-25-container-executors-azure-aca-sandboxes.md`
 * (Task 5) and the spike findings doc for the decisions encoded here.
 */
export class AcaSandboxesProvider implements ContainerExecutor {
	readonly provider = "aca";

	private readonly client: AcaSandboxClient;
	private readonly image: string;
	private readonly disk: string;
	private readonly cpu: string;
	private readonly memory: string;
	private readonly autoSuspendSeconds: number;
	private readonly keepSnapshots: number;
	private readonly egressPolicy: AcaEgressPolicy;
	private readonly logger: { info(msg: string): void; warn(msg: string): void };
	private readonly now: () => number;
	private readonly deviceConnectivity?: AcaSandboxesProviderOptions["deviceConnectivity"];
	private readonly disconnectedRecreateMs: number;
	private readonly resumeConnectTimeoutMs: number;
	private readonly resumeConnectPollMs: number;
	private readonly sleep: (ms: number) => Promise<void>;
	/** Provider-internal per-issue mutex (M1). */
	private readonly locks = new Map<string, Promise<void>>();

	constructor(opts: AcaSandboxesProviderOptions) {
		this.client = opts.client;
		this.image = opts.image;
		this.disk = opts.disk;
		validateLabelValue(LABEL_DISK, this.disk);
		this.cpu = opts.cpu ?? "4000m";
		this.memory = opts.memory ?? "8192Mi";
		this.autoSuspendSeconds = opts.autoSuspendSeconds ?? 0;
		this.keepSnapshots = opts.keepSnapshots ?? 2;
		const defaultEgress = this.buildDefaultEgress(opts.routerUrlForContainers);
		this.egressPolicy = opts.egress
			? {
					...opts.egress,
					hostRules: opts.egress.hostRules ?? defaultEgress.hostRules,
				}
			: defaultEgress;
		this.logger = opts.logger ?? { info: () => {}, warn: () => {} };
		this.now = opts.now ?? (() => Date.now());
		this.deviceConnectivity = opts.deviceConnectivity;
		this.disconnectedRecreateMs = opts.disconnectedRecreateMs ?? 120_000;
		this.resumeConnectTimeoutMs = opts.resumeConnectTimeoutMs ?? 90_000;
		this.resumeConnectPollMs = opts.resumeConnectPollMs ?? 2_000;
		this.sleep =
			opts.sleepFn ??
			((ms) =>
				new Promise((resolve) => {
					setTimeout(resolve, ms).unref?.();
				}));
	}

	/**
	 * Per-sandbox resources passed to `createSandbox`. Kept simple so future
	 * tier config is a small edit; defaults are the XL tier (4 vCPU / 8 GiB).
	 */
	private resources(): Record<string, string> {
		return { cpu: this.cpu, memory: this.memory };
	}

	/**
	 * Baseline lifecycle policy: auto-suspend DISABLED (N5/F2). F2 is
	 * load-bearing — `create-from-snapshot` silently RESETS the lifecycle
	 * policy to ACA's 300s default, so we must set it on EVERY create path,
	 * including snapshot restores.
	 */
	private lifecyclePolicy(): AcaLifecyclePolicy {
		return {
			autoSuspendPolicy: {
				enabled: this.autoSuspendSeconds > 0,
				interval: this.autoSuspendSeconds,
				mode: "Memory",
			},
		};
	}

	/**
	 * D7 default egress allowlist. Deny-by-default + `Full` inspection.
	 * Appends the router host (parsed from `routerUrlForContainers`) so
	 * container→router WSS works; omitted when the router URL is absent.
	 */
	private buildDefaultEgress(routerUrl?: string): AcaEgressPolicy {
		const hostRules = [...DEFAULT_EGRESS_HOSTS];
		if (routerUrl) {
			const host = this.hostFromUrl(routerUrl);
			if (host) {
				hostRules.push({ pattern: host, action: "Allow" });
			}
		}
		return { defaultAction: "Deny", trafficInspection: "Full", hostRules };
	}

	private hostFromUrl(url: string): string | undefined {
		try {
			return new URL(url).hostname || undefined;
		} catch {
			return undefined;
		}
	}

	/** Build the per-issue label set stamped on every managed resource. */
	private labels(
		issueKey: string,
		deviceId: string | undefined,
		disk = this.disk,
	): Record<string, string> {
		validateLabelValue(LABEL_ISSUE, issueKey);
		if (deviceId !== undefined) validateLabelValue(LABEL_DEVICE_ID, deviceId);
		validateLabelValue(LABEL_DISK, disk);
		const labels: Record<string, string> = {
			[LABEL_MANAGED]: "true",
			[LABEL_ISSUE]: issueKey,
			[LABEL_DISK]: disk,
		};
		if (deviceId !== undefined) {
			labels[LABEL_DEVICE_ID] = deviceId;
		}
		return labels;
	}

	/**
	 * Serialise a body of work keyed by issueKey. A second `ensureRunning`
	 * for the same issue joins the in-flight attempt rather than starting a
	 * parallel create (M1).
	 */
	private async lock<T>(issueKey: string, fn: () => Promise<T>): Promise<T> {
		const existing = this.locks.get(issueKey) ?? Promise.resolve();
		let release!: () => void;
		const mine = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = existing.then(() => mine);
		this.locks.set(issueKey, tail);
		await existing;
		try {
			return await fn();
		} finally {
			release();
			if (this.locks.get(issueKey) === tail) {
				this.locks.delete(issueKey);
			}
		}
	}

	/**
	 * Idempotent: ensure the issue's sandbox is running. Encodes every
	 * state-transition documented in the plan (D3 Suspended→resume, stale
	 * disk→replace, absent→lineage-checked create-from-snapshot else
	 * create-from-image) plus post-create snapshot pruning, all inside the
	 * per-issue mutex.
	 *
	 * ACA `Running` is infrastructure state only. When the router supplies
	 * device connectivity, a worker that remains WSS-disconnected beyond the
	 * configured grace is replaced; connected and transiently disconnected
	 * workers are retained. The same rule applies to a resume: `resumeSandbox`
	 * returning is not evidence that the worker process rejoined the router, so
	 * connectivity is confirmed before the resume is reported as success (see
	 * {@link waitForWorkerConnectivity}).
	 */
	async ensureRunning(ctx: IssueExecutionContext): Promise<void> {
		this.validateIssueContext(ctx.issueKey, ctx.deviceId);
		await this.lock(ctx.issueKey, () => this.ensureRunningLocked(ctx));
	}

	private async ensureRunningLocked(ctx: IssueExecutionContext): Promise<void> {
		const deviceId = ctx.deviceId;
		const disk = this.diskFor(ctx);
		const existing = await this.listByIssue(ctx.issueKey);
		const valid = existing
			.filter((sandbox) => (sandbox.labels?.[LABEL_DISK] ?? "") === disk)
			.sort(
				(a, b) =>
					this.sandboxRank(a) - this.sandboxRank(b) || a.id.localeCompare(b.id),
			);
		const retained = valid[0];
		if (existing.length > 0) {
			const replaceAll =
				!retained ||
				(retained.state === "Running" &&
					this.shouldRecreateDisconnected(deviceId));
			if (replaceAll) {
				await this.replaceSandboxes(ctx.issueKey, existing);
			} else {
				const current = retained;
				if (!current) return;
				await this.deleteSandboxes(
					existing.filter((sandbox) => sandbox.id !== current.id),
					ctx.issueKey,
				);
				if (this.isTransitional(current.state)) return;
				if (current.state === "Running") return;
				if (current.state !== "Stopped" && current.state !== "Suspended") {
					return;
				}
				// Memory-mode resume inherits env/token from the frozen state.
				await this.client.resumeSandbox(current.id);
				// A memory suspend freezes the worker's timers and leaves it
				// holding a socket the router already terminated, so `Resumed`
				// does not imply "back on the router". Confirm the device is
				// actually online before reporting success; a worker that never
				// rejoins is replaced HERE rather than leaving queued work
				// stranded until a later prompt crosses disconnectedRecreateMs.
				if (await this.waitForWorkerConnectivity(ctx.issueKey, deviceId)) {
					return;
				}
				await this.replaceSandboxes(ctx.issueKey, [current]);
			}
		}
		// Absent, or after a stale/unreachable replacement. Lineage check (B5)
		// first.
		const snap =
			deviceId === undefined
				? undefined
				: await this.pickLineageSnapshot(ctx.issueKey, deviceId, disk);
		if (snap) {
			await this.client.createSandbox({
				snapshotId: snap.id,
				lifecycle: this.lifecyclePolicy(),
				labels: this.labels(ctx.issueKey, deviceId, disk),
				// Same reason `lifecyclePolicy()` is passed here: F2 established
				// that create-from-snapshot does not carry the policy over, and
				// egress is a security control rather than a cost one, so the
				// failure is worse in both directions — a restored sandbox
				// either keeps a stale allowlist (and silently never receives a
				// newly-added host, e.g. the Playwright CDN) or falls back to
				// ACA's default, which is not Deny.
				egressPolicy: this.egressPolicy,
			});
			// No re-mint: env/token inherited (spike S3b), AND the device-id
			// label matches the live row (lineage filter above).
		} else {
			const registered = await this.ensureDisk(disk);
			// Token rotation invalidates every prior memory snapshot, including
			// same-device snapshots. Remove them durably before minting.
			await this.deleteIssueSnapshots(ctx.issueKey);
			const deviceToken = ctx.mintDeviceToken();
			await this.client.createSandbox({
				...(registered.id
					? { diskImageId: registered.id }
					: { diskImageName: disk }),
				environment: { ...ctx.env, CYRUS_DEVICE_TOKEN: deviceToken },
				resources: this.resources(),
				lifecycle: this.lifecyclePolicy(),
				labels: this.labels(ctx.issueKey, deviceId, disk),
				egressPolicy: this.egressPolicy,
			});
		}
		// N1: prune EXPLICIT labeled snapshots only after a CREATE path
		// (not plain stop/resume). Serialized inside this lock.
		await this.pruneSnapshots(ctx.issueKey);
	}

	private sandboxRank(sandbox: AcaSandbox): number {
		if (sandbox.state === "Running") return 0;
		if (sandbox.state === "Stopped" || sandbox.state === "Suspended") return 1;
		if (this.isTransitional(sandbox.state)) return 2;
		return 3;
	}

	/** Transitional ACA sandbox states (spike S2). */
	private isTransitional(state: string): boolean {
		return (
			state === "Resuming" ||
			state === "Stopping" ||
			state === "Creating" ||
			state === "Deleting"
		);
	}

	/** ONE filtered `listSandboxes` call per issue (M1). */
	private async listByIssue(issueKey: string): Promise<AcaSandbox[]> {
		return this.client.listSandboxes({
			[LABEL_MANAGED]: "true",
			[LABEL_ISSUE]: issueKey,
		});
	}

	/**
	 * Delete a stale sandbox and its explicit labeled snapshots. Snapshots
	 * always restore the image lineage they were taken from, so a stale
	 * image needs its snapshots gone too — otherwise create-from-snapshot
	 * would resurrect the old image. Any deletion failure aborts replacement.
	 */
	private async replaceSandboxes(
		issueKey: string,
		existing: AcaSandbox[],
	): Promise<void> {
		// Delete snapshots first. If that fails, retaining the running sandbox
		// prevents a later retry from restoring the very snapshot we rejected.
		await this.deleteIssueSnapshots(issueKey);
		await this.deleteSandboxes(existing, issueKey);
	}

	private async deleteSandboxes(
		sandboxes: AcaSandbox[],
		issueKey: string,
	): Promise<void> {
		const errors: unknown[] = [];
		for (const sandbox of sandboxes) {
			await this.client.deleteSandbox(sandbox.id).catch((error: unknown) => {
				errors.push(error);
			});
		}
		if (errors.length > 0) {
			throw new AggregateError(
				errors,
				`failed to delete ACA sandboxes for ${issueKey}: ${errors.map(String).join("; ")}`,
			);
		}
	}

	/**
	 * Poll the router's device/WSS state until the resumed worker is online, or
	 * until {@link resumeConnectTimeoutMs} elapses.
	 *
	 * Returns `true` (i.e. "trust the resume") when there is nothing to verify
	 * against — no router connectivity callback, no device id, or verification
	 * explicitly disabled — so a provider constructed without the router seam
	 * behaves exactly as before.
	 */
	private async waitForWorkerConnectivity(
		issueKey: string,
		deviceId: string | undefined,
	): Promise<boolean> {
		if (
			!deviceId ||
			!this.deviceConnectivity ||
			this.resumeConnectTimeoutMs <= 0
		) {
			return true;
		}
		const startedMs = this.now();
		const deadline = startedMs + this.resumeConnectTimeoutMs;
		for (;;) {
			if (this.deviceConnectivity(deviceId).connected) {
				this.logger.info(
					`Resumed ACA sandbox for ${issueKey} reconnected to the router after ${this.now() - startedMs}ms`,
				);
				return true;
			}
			if (this.now() >= deadline) {
				this.logger.warn(
					`Resumed ACA sandbox for ${issueKey} reached ACA Running but device ${deviceId} never reconnected to the router within ${this.resumeConnectTimeoutMs}ms; replacing the sandbox`,
				);
				return false;
			}
			await this.sleep(this.resumeConnectPollMs);
		}
	}

	private shouldRecreateDisconnected(deviceId: string | undefined): boolean {
		if (!deviceId || !this.deviceConnectivity) return false;
		const state = this.deviceConnectivity(deviceId);
		return (
			!state.connected &&
			this.now() - state.disconnectedSinceMs >= this.disconnectedRecreateMs
		);
	}

	private validateIssueContext(issueKey: string, deviceId?: string): void {
		validateLabelValue(LABEL_ISSUE, issueKey);
		if (deviceId !== undefined) validateLabelValue(LABEL_DEVICE_ID, deviceId);
	}

	/**
	 * Lineage check (B5): newest explicit snapshot labeled for this issue
	 * whose `cyrus.device-id` matches the live device row AND whose
	 * `cyrus.disk` label matches the current disk image. Returns
	 * `undefined` when none matches — caller then creates-from-image and
	 * re-mints. Only called when `ctx.deviceId` is defined (F2 guard).
	 */
	private async pickLineageSnapshot(
		issueKey: string,
		deviceId: string,
		disk: string,
	): Promise<AcaSnapshot | undefined> {
		const snaps = await this.client.listSnapshots({
			[LABEL_MANAGED]: "true",
			[LABEL_ISSUE]: issueKey,
			[LABEL_DEVICE_ID]: deviceId,
		});
		const matching = snaps.filter(
			(s) => (s.labels?.[LABEL_DISK] ?? "") === disk,
		);
		if (matching.length === 0) return undefined;
		// Newest by createdAtUtc; a missing createdAtUtc falls back to `now`
		// (treated as most-recent so a server that omits the field doesn't
		// get starved by the prune).
		matching.sort((a, b) => {
			const ta = a.createdAtUtc ? Date.parse(a.createdAtUtc) : this.now();
			const tb = b.createdAtUtc ? Date.parse(b.createdAtUtc) : this.now();
			return (
				(Number.isNaN(tb) ? this.now() : tb) -
				(Number.isNaN(ta) ? this.now() : ta)
			);
		});
		return matching[0];
	}

	/**
	 * Prune this issue's explicit labeled snapshots to {@link keepSnapshots}
	 * newest (plan). Serialized inside `ensureRunning`'s per-issue lock so a
	 * concurrent `ensureRunning` can never race a prune.
	 */
	private async pruneSnapshots(issueKey: string): Promise<void> {
		const snaps = await this.client.listSnapshots({
			[LABEL_MANAGED]: "true",
			[LABEL_ISSUE]: issueKey,
		});
		const explicit = snaps.filter((s) => this.explicitSnapshotLabels(s));
		if (explicit.length <= this.keepSnapshots) return;
		const sorted = [...explicit].sort((a, b) => {
			const ta = a.createdAtUtc ? Date.parse(a.createdAtUtc) : this.now();
			const tb = b.createdAtUtc ? Date.parse(b.createdAtUtc) : this.now();
			return (
				(Number.isNaN(tb) ? this.now() : tb) -
				(Number.isNaN(ta) ? this.now() : ta)
			);
		});
		const excess = sorted.slice(this.keepSnapshots);
		for (const s of excess) {
			await this.client.deleteSnapshot(s.id).catch((err: unknown) => {
				this.logger.warn(
					`failed to prune snapshot ${s.id} for ${issueKey}: ${String(err)}`,
				);
			});
		}
	}

	private explicitSnapshotLabels(
		snapshot: AcaSnapshot,
	): { issueKey: string; deviceId: string } | undefined {
		const labels = snapshot.labels;
		if (
			labels?.[LABEL_MANAGED] !== "true" ||
			!labels[LABEL_ISSUE] ||
			!labels[LABEL_DEVICE_ID] ||
			!labels[LABEL_DISK]
		) {
			return undefined;
		}
		return {
			issueKey: labels[LABEL_ISSUE],
			deviceId: labels[LABEL_DEVICE_ID],
		};
	}

	/** Plan deletion of explicit Cyrus snapshots with no live row or sandbox. */
	async planOrphanSnapshots(
		activeIssueKeys: string[],
	): Promise<AcaSnapshotGcItem[]> {
		const [snapshots, sandboxes] = await Promise.all([
			this.client.listSnapshots({ [LABEL_MANAGED]: "true" }),
			this.client.listSandboxes(),
		]);
		const protectedIssues = new Set(activeIssueKeys);
		const liveSandboxIds = new Set(sandboxes.map((sandbox) => sandbox.id));
		const inUseSnapshotIds = new Set<string>();
		for (const sandbox of sandboxes) {
			const issueKey = sandbox.labels?.[LABEL_ISSUE];
			if (issueKey) protectedIssues.add(issueKey);
			const snapshotId = sandbox.sourcesRef?.snapshot?.id;
			if (typeof snapshotId === "string") inUseSnapshotIds.add(snapshotId);
		}

		return snapshots.flatMap((snapshot) => {
			const labels = this.explicitSnapshotLabels(snapshot);
			if (!labels || protectedIssues.has(labels.issueKey)) return [];
			if (snapshot.sandboxId && liveSandboxIds.has(snapshot.sandboxId))
				return [];
			if (inUseSnapshotIds.has(snapshot.id)) return [];
			return [
				{
					id: snapshot.id,
					issueKey: labels.issueKey,
					deviceId: labels.deviceId,
					createdAtUtc: snapshot.createdAtUtc,
				},
			];
		});
	}

	/** Delete the snapshots returned by {@link planOrphanSnapshots}. */
	async gcOrphanSnapshots(
		activeIssueKeys: string[],
		printedPlan?: AcaSnapshotGcItem[],
	): Promise<AcaSnapshotGcItem[]> {
		const currentPlan = await this.planOrphanSnapshots(activeIssueKeys);
		const printedIds = printedPlan
			? new Set(printedPlan.map((snapshot) => snapshot.id))
			: undefined;
		// Revalidate immediately before deletion, while never deleting a row the
		// CLI did not print in its plan.
		const plan = printedIds
			? currentPlan.filter((snapshot) => printedIds.has(snapshot.id))
			: currentPlan;
		const deleted: AcaSnapshotGcItem[] = [];
		for (const snapshot of plan) {
			await this.lock(snapshot.issueKey, async () => {
				// A boot may have restored this snapshot after the global plan was
				// built. Revalidate under the same issue lock used by create/stop.
				const stillOrphan = (
					await this.planOrphanSnapshots(activeIssueKeys)
				).some((candidate) => candidate.id === snapshot.id);
				if (!stillOrphan) return;
				await this.client.deleteSnapshot(snapshot.id);
				deleted.push(snapshot);
			});
		}
		return deleted;
	}

	/** Delete every explicit labeled snapshot for an issue. Best-effort, M1. */
	private async deleteIssueSnapshots(issueKey: string): Promise<void> {
		const snaps = await this.client.listSnapshots({
			[LABEL_MANAGED]: "true",
			[LABEL_ISSUE]: issueKey,
		});
		const errors: unknown[] = [];
		for (const s of snaps) {
			await this.client.deleteSnapshot(s.id).catch((error: unknown) => {
				errors.push(error);
			});
		}
		if (errors.length > 0) {
			throw new AggregateError(
				errors,
				`failed to delete ACA snapshots for ${issueKey}`,
			);
		}
	}

	/**
	 * `stop` = memory-mode suspend (F1/S3: no SIGTERM, processes freeze
	 * mid-flight, resume restores them intact). No-op unless currently
	 * `Running` (a transitional or already-stopped sandbox is left alone —
	 * the next `ensureRunning` sweep will resume if needed).
	 */
	async stop(issueKey: string): Promise<void> {
		this.validateIssueContext(issueKey);
		await this.lock(issueKey, async () => {
			const running = (await this.listByIssue(issueKey)).filter(
				(sandbox) => sandbox.state === "Running",
			);
			const errors: unknown[] = [];
			for (const sandbox of running) {
				const deviceId = sandbox.labels?.[LABEL_DEVICE_ID];
				const disk = sandbox.labels?.[LABEL_DISK];
				// The snapshot is a COLD-path optimisation, never a precondition of
				// the suspend: a Suspended sandbox resumes from its own frozen
				// memory, and `ensureRunning` reaches for a snapshot only when the
				// sandbox is ABSENT. Letting a snapshot failure abort the suspend is
				// therefore trading a slower restore for an unbounded bill — and it
				// did: an 18.4 GB snapshot measured 3m52s against the client's 120s
				// request deadline, so `stop()` threw before ever suspending and the
				// 4 vCPU sandbox stayed Running while every 60s sweep tick re-failed
				// the same way (WAG-10 / WAG-14, 2026-08-06). Park it regardless.
				if (deviceId && disk) {
					await this.client
						.createSnapshot(sandbox.id, this.labels(issueKey, deviceId, disk))
						.catch((error: unknown) => {
							this.logger.warn(
								`could not snapshot ACA sandbox ${sandbox.id} for ${issueKey}; suspending without one (a later cold start rebuilds from the artifact bundle): ${String(error)}`,
							);
						});
				} else {
					this.logger.warn(
						`ACA sandbox ${sandbox.id} for ${issueKey} is missing its ${!deviceId ? LABEL_DEVICE_ID : LABEL_DISK} label; suspending without a snapshot`,
					);
				}
				await this.client.stopSandbox(sandbox.id).catch((error: unknown) => {
					errors.push(error);
				});
			}
			await this.pruneSnapshots(issueKey);
			if (errors.length > 0) {
				if (errors.length === 1) throw errors[0];
				throw new AggregateError(
					errors,
					`failed to stop ACA sandboxes for ${issueKey}`,
				);
			}
		});
	}

	/**
	 * Destroy the issue's sandbox AND all its explicit labeled snapshots
	 * (plan D9 + Task 6). Every deletion is attempted; partial failures are
	 * aggregated so the router retains the device row as its retry handle.
	 */
	async destroy(issueKey: string): Promise<void> {
		this.validateIssueContext(issueKey);
		await this.lock(issueKey, async () => {
			const errors: unknown[] = [];
			const sandboxes = await this.listByIssue(issueKey);
			for (const sandbox of sandboxes) {
				await this.client.deleteSandbox(sandbox.id).catch((error: unknown) => {
					errors.push(error);
				});
			}
			await this.deleteIssueSnapshots(issueKey).catch((error: unknown) => {
				errors.push(...this.errorsFrom(error));
			});
			if (errors.length > 0) {
				throw new AggregateError(
					errors,
					`failed to destroy ACA resources for ${issueKey}`,
				);
			}
		});
	}

	private errorsFrom(error: unknown): unknown[] {
		return error instanceof AggregateError ? [...error.errors] : [error];
	}

	/**
	 * This reports ACA infrastructure state. Worker-process liveness is
	 * reconciled in ensureRunning using the router-provided WSS callback.
	 */
	async status(issueKey: string): Promise<ContainerStatus> {
		this.validateIssueContext(issueKey);
		const sandboxes = await this.listByIssue(issueKey);
		if (sandboxes.length === 0) return "absent";
		return sandboxes.some((sandbox) => sandbox.state === "Running")
			? "running"
			: "stopped";
	}

	/**
	 * Issue keys of every managed sandbox. Exactly ONE `listSandboxes` call
	 * (M1) — no snapshot listing piggybacked on the 60s sweep path; orphan
	 * snapshots are reclaimed via {@link destroy}, post-create pruning, and
	 * Task 7's `gc-snapshots`.
	 */
	async listManaged(): Promise<string[]> {
		const list = await this.client.listSandboxes({ [LABEL_MANAGED]: "true" });
		return [
			...new Set(
				list
					.map((s) => s.labels?.[LABEL_ISSUE] ?? "")
					.filter((k) => k.length > 0),
			),
		];
	}

	/**
	 * Every managed sandbox's issue key AND state from the SAME single
	 * label-filtered `listSandboxes` call {@link listManaged} makes.
	 *
	 * This is what lets the 60s lifecycle sweep emit a per-sandbox gauge for a
	 * fleet of N sandboxes at a cost of one ARM request per tick instead of N.
	 *
	 * An issue with several sandboxes (mid-replacement, or a stale-disk sandbox
	 * awaiting deletion) collapses to one row ranked exactly the way
	 * {@link ensureRunningLocked} ranks them, so the gauge reports the sandbox
	 * the router would actually retain. As in {@link status}, `Running` here is
	 * INFRASTRUCTURE state — the caller must combine it with device
	 * connectivity before concluding the worker is alive.
	 */
	async listStates(): Promise<ManagedContainerState[]> {
		const list = await this.client.listSandboxes({ [LABEL_MANAGED]: "true" });
		const byIssue = new Map<string, AcaSandbox[]>();
		for (const sandbox of list) {
			const issueKey = sandbox.labels?.[LABEL_ISSUE];
			if (!issueKey) continue;
			const group = byIssue.get(issueKey);
			if (group) group.push(sandbox);
			else byIssue.set(issueKey, [sandbox]);
		}
		return [...byIssue].map(([issueKey, group]) => {
			// Same ordering `ensureRunningLocked` uses to pick which sandbox it
			// retains, so the gauge reports the one the router considers current.
			const [current] = group.sort(
				(a, b) =>
					this.sandboxRank(a) - this.sandboxRank(b) || a.id.localeCompare(b.id),
			);
			const state = current?.state ?? "";
			return {
				issueKey,
				status:
					state === "Running" ? ("running" as const) : ("stopped" as const),
				providerState: state,
			};
		});
	}

	/**
	 * Best-effort ensure the disk image is registered. Idempotent: a
	 * concurrent registration returns an "already exists" error which we
	 * log and continue (spike S2's DELETE is naturally idempotent; here we
	 * accept the same posture for `PUT /diskimages`).
	 *
	 * Operators SHOULD pre-register the disk image (S1); this is a
	 * failsafe for first-boot in dev.
	 */
	private async ensureDisk(name: string): Promise<AcaDiskImage> {
		const existing = await this.client.listDiskImages();
		const registered = existing.find(
			(d) => d.name === name || d.labels?.name === name,
		);
		if (registered) return registered;
		if (name !== this.disk) {
			// A per-repository disk is registered by the router's devcontainer
			// pipeline, which knows the image ref it built and the registry
			// credential to pull it with. This failsafe knows neither, so
			// inventing a registration here would import the DEPLOYMENT's image
			// under a repository's disk name — a sandbox that boots the wrong
			// environment and reports success.
			throw new Error(
				`disk image '${name}' is not registered; the devcontainer build that owns it has not completed`,
			);
		}
		try {
			return await this.client.createDiskImage(name, this.image);
		} catch (err: unknown) {
			// A concurrent caller may have won the registration race. Confirm that
			// before continuing; otherwise preserve the real registry/auth failure.
			const afterFailure = await this.client.listDiskImages();
			const concurrent = afterFailure.find(
				(d) => d.name === name || d.labels?.name === name,
			);
			if (concurrent) {
				this.logger.warn(
					`ensureDisk: createDiskImage(${name}) failed, but the disk now exists: ${String(err)}`,
				);
				return concurrent;
			}
			throw err;
		}
	}

	/**
	 * The disk this issue boots from: its pin when it has one, the deployment's
	 * default otherwise.
	 *
	 * Validated here rather than at the label call site so an over-long
	 * repository-derived name fails the boot with a message naming the label,
	 * instead of reaching ACA as a rejected create.
	 */
	private diskFor(ctx: IssueExecutionContext): string {
		const disk = ctx.disk ?? this.disk;
		validateLabelValue(LABEL_DISK, disk);
		return disk;
	}
}
