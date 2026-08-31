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
		const existing = await this.listByIssue(ctx.issueKey);
		const valid = existing
			.filter((sandbox) => (sandbox.labels?.[LABEL_DISK] ?? "") === this.disk)
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
				: await this.pickLineageSnapshot(ctx.issueKey, deviceId);
		if (snap) {
			await this.client.createSandbox({
				snapshotId: snap.id,
				lifecycle: this.lifecyclePolicy(),
				labels: this.labels(ctx.issueKey, deviceId),
			});
			// No re-mint: env/token inherited (spike S3b), AND the device-id
			// label matches the live row (lineage filter above).
		} else {
			const disk = await this.ensureDisk();
			// Token rotation invalidates every prior memory snapshot, including
			// same-device snapshots. Remove them durably before minting.
			await this.deleteIssueSnapshots(ctx.issueKey);
			const deviceToken = ctx.mintDeviceToken();
			await this.client.createSandbox({
				...(disk.id ? { diskImageId: disk.id } : { diskImageName: this.disk }),
				environment: { ...ctx.env, CYRUS_DEVICE_TOKEN: deviceToken },
				resources: this.resources(),
				lifecycle: this.lifecyclePolicy(),
				labels: this.labels(ctx.issueKey, deviceId),
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
	): Promise<AcaSnapshot | undefined> {
		const snaps = await this.client.listSnapshots({
			[LABEL_MANAGED]: "true",
			[LABEL_ISSUE]: issueKey,
			[LABEL_DEVICE_ID]: deviceId,
		});
		const matching = snaps.filter(
			(s) => (s.labels?.[LABEL_DISK] ?? "") === this.disk,
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
	private async ensureDisk(): Promise<AcaDiskImage> {
		const existing = await this.client.listDiskImages();
		const registered = existing.find(
			(d) => d.name === this.disk || d.labels?.name === this.disk,
		);
		if (registered) return registered;
		try {
			return await this.client.createDiskImage(this.disk, this.image);
		} catch (err: unknown) {
			// A concurrent caller may have won the registration race. Confirm that
			// before continuing; otherwise preserve the real registry/auth failure.
			const afterFailure = await this.client.listDiskImages();
			const concurrent = afterFailure.find(
				(d) => d.name === this.disk || d.labels?.name === this.disk,
			);
			if (concurrent) {
				this.logger.warn(
					`ensureDisk: createDiskImage(${this.disk}) failed, but the disk now exists: ${String(err)}`,
				);
				return concurrent;
			}
			throw err;
		}
	}
}
