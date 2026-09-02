import type { ILogger } from "cyrus-core";
import {
	cyrusSpanAttributes,
	OTEL_TRACES_ENABLED_ENV,
	OTEL_TRACES_SAMPLE_RATIO_ENV,
	SpanKind,
	SpanStatusCode,
	withSpan,
} from "cyrus-otel-traces";
import type { ExecutorRegistry } from "cyrus-router-executors";
import type { CodexTokenStore } from "./CodexTokenStore.js";
import { containerBootFailedMessage } from "./messages.js";
import type {
	RegisteredRepository,
	RepositoryRegistry,
} from "./RepositoryRegistry.js";
import type { RouterStore } from "./RouterStore.js";
import {
	emitSandboxEvent,
	SANDBOX_EVENTS,
	type SandboxDestroyReason,
} from "./SandboxTelemetry.js";
import {
	isReservedEnvKey,
	requiredSecretKeysFor,
	type SecretStoreBackend,
} from "./SecretStore.js";
import { resolveExecutor } from "./setup/bootstrap.js";
import {
	CODEX_AUTH_JSON_ENV,
	CodexRefreshError,
	renderCodexAuthFile,
} from "./setup/codexAuth.js";
import {
	defaultRunnerEnv,
	resolveDefaultRunner,
} from "./setup/runnerDefaults.js";
import { ROUTER_SPANS, routerTracer } from "./telemetry/tracing.js";

/**
 * A device/webhook-supplied issue key flows into filesystem paths, Docker
 * object names, and artifact URLs (see `RouterStore.createContainerDevice`
 * and `registerArtifactsRoute`'s `ISSUE_KEY_RE`). `RouterStore` itself does
 * NOT validate the key, so this service is the one gate standing between an
 * arbitrary Linear webhook and a malformed key reaching the store or a
 * container provider.
 */
const ISSUE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * How long a concurrent caller will join an already-running boot attempt before
 * treating it as stale and starting its own.
 *
 * Sized well above a legitimate cold boot (a first `docker run` that has to
 * pull the image can take minutes, and the ACA provider additionally waits up
 * to `resumeConnectTimeoutMs` for a resumed worker to rejoin the router), so
 * this never fires in normal operation — it exists purely so a provider call
 * that hangs cannot permanently disable booting for a device.
 */
const BOOT_JOIN_TIMEOUT_MS = 10 * 60_000;

/**
 * How many times one `bootStart` will wait on someone else's attempt before
 * insisting on its own. Two is enough to absorb the realistic case (join an
 * attempt, find it left the container stopped, join the replacement someone
 * else started in the meantime) while bounding the work.
 */
const MAX_BOOT_JOINS = 2;

/** An in-progress `bootInner`, with the wall-clock time it started. */
interface InFlightBoot {
	promise: Promise<void>;
	startedMs: number;
}

/**
 * Thrown by {@link ContainerTargetService.ensureDevice} specifically when
 * `issueKey` fails {@link ISSUE_KEY_RE}. Kept distinct from other
 * `ensureDevice` failures (e.g. a store error) so {@link EventRouter} can
 * tell an enrolled container-executor user that THIS issue's identifier is
 * the problem, rather than falling back to the generic "you're not
 * enrolled" message, which would point them at the wrong fix.
 */
export class InvalidIssueKeyError extends Error {
	constructor(public readonly issueKey: string) {
		super(
			`refusing to create a container device for invalid issue key ${JSON.stringify(issueKey)}`,
		);
		this.name = "InvalidIssueKeyError";
	}
}

export interface ContainerRoutingDeps {
	store: RouterStore;
	secrets: SecretStoreBackend;
	executors: ExecutorRegistry; // Map<providerName, ContainerExecutor>
	/**
	 * The live repository registry. Read per boot rather than captured at
	 * construction, so a repository added in the setup UI is visible to the very
	 * next container without restarting the router.
	 */
	registry: RepositoryRegistry;
	/**
	 * Resolves the disk an issue is pinned to (NOR-309). Optional: without it
	 * every container boots the deployment's default worker image, which is what
	 * every deployment did before per-repository images existed.
	 */
	devcontainers?: { diskForIssue(issueKey: string): string | undefined };
	containersConfig: {
		routerUrlForContainers: string;
		/**
		 * Extra env-var names a user MUST have stored before any container
		 * boots for them. The Claude token is always required on top of these
		 * (see buildEnv). Defaults to none when omitted.
		 */
		requiredSecretKeys?: string[];
		/**
		 * Provider every user routes to unless their `executor_json` says
		 * otherwise. Only an explicit `{"type":"default"}` inherits it — a NULL
		 * or absent value keeps its historical meaning of "physical device".
		 * See {@link resolveExecutor}.
		 */
		defaultExecutor?: string;
		/**
		 * When set, the provider EVERY user routes to, regardless of their stored
		 * `executor_json`. `RouterServer` sets this to `"aca"` exactly when an ACA
		 * provider is registered — see {@link resolveExecutor} for why that
		 * inverts the usual degradation direction on purpose.
		 */
		forcedExecutor?: string;
	};
	/**
	 * Per-user Codex subscription credentials (ADR 0005). Absent on deployments
	 * with no Codex support configured, in which case a Codex user falls back to
	 * `OPENAI_API_KEY` from their own bundle.
	 */
	codexTokens?: CodexTokenStore;
	postActivity: (
		workspaceId: string,
		agentSessionId: string,
		body: string,
	) => Promise<void>;
	logger: ILogger;
	/** Injectable clock for the in-flight boot staleness window (tests). */
	now?: () => number;
}

/**
 * Resolves and boots the per-issue ephemeral container device for
 * container-executor users, and holds the (issueKey -> executor) mapping
 * used by {@link EventRouter} to know when a target is a container rather
 * than a physical device.
 */
export class ContainerTargetService {
	/** Issues we've already posted a boot-failure notice for (once until a boot succeeds). */
	private readonly bootFailedNotified = new Set<string>();

	constructor(private readonly deps: ContainerRoutingDeps) {}

	private now(): number {
		return this.deps.now ? this.deps.now() : Date.now();
	}

	/**
	 * Provider name from `users.executor_json`, or undefined for physical-device
	 * users. See {@link resolveExecutor} for the full resolution table.
	 *
	 * The load-bearing rule: a NULL/absent value keeps its historical meaning of
	 * "physical device" and is **never** captured by `defaultExecutor`. Only an
	 * explicit `{"type":"default"}` inherits. NULL is already ambiguous today
	 * between "deliberately set to device" and "never configured", and nothing
	 * can recover that intent after the fact — so inheriting on NULL would
	 * silently move every device user onto cloud sandboxes. Every ambiguous or
	 * corrupt value likewise degrades to physical device rather than up to a
	 * sandbox.
	 */
	executorFor(userId: number): string | undefined {
		return resolveExecutor(
			this.deps.store.getUserExecutor(userId),
			this.deps.containersConfig.defaultExecutor,
			{
				warn: (msg) => this.deps.logger.warn(`${msg} (user ${userId})`),
			},
			this.deps.containersConfig.forcedExecutor,
		);
	}

	/**
	 * The user's per-user runner/model default, or `undefined` when they have
	 * not chosen one (which leaves the in-sandbox fallback chain untouched).
	 */
	private defaultRunnerFor(userId: number) {
		return resolveDefaultRunner(this.deps.store.getUserDefaultRunner(userId), {
			warn: (msg) => this.deps.logger.warn(`${msg} (user ${userId})`),
		});
	}

	/**
	 * Get-or-create the issue's container device row. Destroys + replaces the
	 * row when the stored provider no longer matches the user's executor.
	 *
	 * Throws (rather than silently proceeding) when `issueKey` fails
	 * {@link ISSUE_KEY_RE} or the user has no container executor configured —
	 * callers (EventRouter) must treat either as "cannot route", not create a
	 * broken device.
	 */
	ensureDevice(
		user: { userId: number; email: string },
		issueKey: string,
	): { deviceId: number } {
		if (!ISSUE_KEY_RE.test(issueKey)) {
			throw new InvalidIssueKeyError(issueKey);
		}
		const provider = this.executorFor(user.userId);
		if (!provider) {
			throw new Error(`user ${user.userId} has no container executor`);
		}
		let existing = this.deps.store.getContainerDeviceForIssue(issueKey);
		if (existing && existing.provider !== provider) {
			// Capture before the `existing = undefined` below — `old?.destroy`'s
			// `.catch()` callback runs later (after this function has returned),
			// so it must not read these off a `let` that's about to be reassigned.
			const staleProvider = existing.provider;
			const staleDeviceId = existing.deviceId;
			const old = this.deps.executors.get(staleProvider);
			if (old) {
				emitSandboxEvent(
					this.deps.logger,
					SANDBOX_EVENTS.destroyed,
					{ issueKey, deviceId: staleDeviceId, provider: staleProvider },
					{ reason: "provider_switch" satisfies SandboxDestroyReason },
				);
				void old.destroy(issueKey).catch((err: unknown) => {
					this.deps.logger.error(
						`Destroy of the stale ${staleProvider} container for ${issueKey} failed; it may keep running and accruing cost`,
						err,
					);
				});
			} else {
				// The operator removed/renamed this provider (e.g. migrating
				// docker -> fly) while a container still exists under it.
				// Nothing will ever destroy() it or its volume now that we're
				// deleting the device row below — make that leak visible instead
				// of letting the old `old?.destroy(...)` optional chain swallow
				// it silently (Finding 5).
				this.deps.logger.warn(
					`no executor registered for provider '${staleProvider}'; its container (and volume) for issue ${issueKey} will not be destroyed and may leak`,
				);
			}
			this.deps.store.deleteContainerDevice(staleDeviceId);
			existing = undefined;
		}
		if (existing) return { deviceId: existing.deviceId };
		const created = this.deps.store.createContainerDevice(
			user.userId,
			issueKey,
			provider,
		);
		return { deviceId: created.deviceId };
	}

	isContainerDevice(deviceId: number): boolean {
		return this.deps.store.getDeviceInfo(deviceId)?.kind === "container";
	}

	/**
	 * Is the issue's container actually up right now? Used only on the
	 * join-an-in-flight-boot path, to decide whether someone else's finished
	 * attempt satisfied this caller. A provider that cannot answer is treated as
	 * not-running: booting again is idempotent and self-logging, whereas
	 * wrongly assuming "running" silently drops the boot.
	 */
	private async isRunning(
		provider: string,
		issueKey: string,
	): Promise<boolean> {
		const executor = this.deps.executors.get(provider);
		if (!executor) return false;
		try {
			return (await executor.status(issueKey)) === "running";
		} catch (err) {
			this.deps.logger.warn(
				`Could not read container status for ${issueKey} after joining an in-flight boot`,
				err,
			);
			return false;
		}
	}

	/**
	 * In-flight boot attempts keyed by DEVICE ID (not issue key — see below).
	 * Linear's `created` (delegation) and `prompted` (first user message)
	 * webhooks for the same issue routinely arrive seconds apart, both while
	 * the container is still cold-booting (a first `docker run` pulls the
	 * image and can take minutes). Without this, two concurrent `boot()`
	 * calls each drive their own `ensureRunning`, and both observe `status:
	 * "absent"` and both mint a fresh device token (via
	 * `mintDeviceToken`/`rotateContainerDeviceToken`) before either `docker
	 * run` lands — the second rotation invalidates the token the first,
	 * successfully started, container was launched with, so it can never
	 * authenticate and its queued events never drain. A `boot()` for a
	 * device already in this map joins the existing attempt instead of
	 * starting a second one. Cleared once the attempt settles (success or
	 * failure) so a later retry can boot again.
	 *
	 * Keyed by device id rather than issue key: `ensureDevice` destroys and
	 * replaces a device row (new device id, same issue key) when a user's
	 * executor provider changes. If this map were keyed by issue key, a
	 * `boot()` for the NEW device — routed while the OLD device's boot is
	 * still in-flight (a real window: cold boots take minutes) — would join
	 * the stale attempt for the destroyed device instead of starting a real
	 * boot for the new provider, and the new container would never actually
	 * start. Keying by device id keeps the same-device dedup (both webhooks
	 * still resolve to the same device id when no switch happened) while
	 * making an executor switch's new device id always start a fresh attempt.
	 *
	 * Entries carry the time the attempt started, because joining is only safe
	 * while the attempt is plausibly still alive. `ensureRunning` is
	 * provider-implemented network I/O, and one that never settles would
	 * otherwise wedge this slot forever: every later `boot()` — and, worse,
	 * every `bootForTeardown()` — would join a dead promise and return
	 * immediately, so the container could never be woken again and only the
	 * teardown grace deadline would reclaim it. Past
	 * {@link BOOT_JOIN_TIMEOUT_MS} the entry is treated as stale and a fresh
	 * attempt is started; see {@link bootStart}.
	 */
	private readonly inFlightBoots = new Map<number, InFlightBoot>();

	/**
	 * Fire-and-forget boot, serialized per issue via {@link inFlightBoots}. On
	 * `ensureRunning` rejection, posts a container-boot-failed activity (once
	 * per issue until a boot succeeds).
	 *
	 * Never leaves an unhandled rejection: `bootStart`/`bootInner` are written
	 * so nothing inside them should reject, but the `.catch()` here is
	 * belt-and-suspenders — a detached promise with no rejection handler
	 * crashes the whole router process (Node >= 15 defaults to
	 * `--unhandled-rejections=throw`), which would stop routing webhooks for
	 * every teammate, not just the one whose container failed to boot.
	 */
	boot(
		deviceId: number,
		notify: { workspaceId: string; sessionId: string },
	): void {
		void this.bootStart(deviceId, notify).catch((err: unknown) => {
			this.deps.logger.error(
				`Container boot for device ${deviceId} threw unexpectedly`,
				err,
			);
		});
	}

	/**
	 * Wakes a container solely to process a terminal webhook. It shares the
	 * normal device-scoped in-flight boot and env/token construction, but has no
	 * agent session on which to post a Linear activity if booting fails.
	 */
	bootForTeardown(deviceId: number): void {
		void this.bootStart(deviceId).catch((err: unknown) => {
			this.deps.logger.error(
				`Terminal-teardown boot for device ${deviceId} threw unexpectedly`,
				err,
			);
		});
	}

	/**
	 * Resolves the device's issue key and either joins an in-flight boot for
	 * that issue or starts a new one. Defensive: resolving the device is in
	 * its own try/catch (not just the one inside {@link bootInner}) so a
	 * store error (e.g. SQLITE_BUSY) degrades to a logged warning instead of
	 * rejecting — this call happens outside `bootInner`'s try, so nothing
	 * else covers it.
	 */
	private async bootStart(
		deviceId: number,
		notify?: { workspaceId: string; sessionId: string },
	): Promise<void> {
		let device: ReturnType<RouterStore["getDeviceInfo"]>;
		try {
			device = this.deps.store.getDeviceInfo(deviceId);
		} catch (err) {
			this.deps.logger.error(
				`Failed to load device ${deviceId} info while booting`,
				err,
			);
			return;
		}
		if (device?.kind !== "container" || !device.issueKey || !device.provider) {
			return;
		}
		const issueKey = device.issueKey;
		const provider = device.provider;
		const userId = device.userId;

		// Join a concurrent attempt rather than driving a second
		// ensureRunning/mintDeviceToken — but only as a dedup of overlapping
		// work, never as evidence that the container ended up running. Bounded
		// so a pathological interleaving of settle-and-restart can't spin.
		for (let join = 0; join < MAX_BOOT_JOINS; join++) {
			const inFlight = this.inFlightBoots.get(deviceId);
			if (!inFlight) break;

			if (this.now() - inFlight.startedMs >= BOOT_JOIN_TIMEOUT_MS) {
				// The provider's `ensureRunning` has outlived any plausible cold
				// boot and may never settle. Waiting on it would block this caller
				// forever. Abandon the join; the orphaned promise still settles on
				// its own eventually (bootInner logs its own outcome) and the
				// identity check below stops it clobbering our slot.
				this.deps.logger.warn(
					`container boot for device ${deviceId} (${issueKey}) has been in flight for over ${BOOT_JOIN_TIMEOUT_MS}ms; abandoning the join and starting a fresh attempt`,
				);
				if (this.inFlightBoots.get(deviceId) === inFlight) {
					this.inFlightBoots.delete(deviceId);
				}
				break;
			}

			// bootInner is written never to reject, but a detached rejection here
			// would take out the whole router, so guard it anyway.
			await inFlight.promise.catch(() => {});

			// CRITICAL: the attempt we just joined began BEFORE we asked for a
			// boot, so its completion says nothing about the state we care about.
			// It may have failed, or — the case that bit us live — the idle sweep
			// may have parked the container while that attempt was still starting
			// it. Returning here on the strength of someone else's finished boot
			// silently skips the boot this caller asked for. For a
			// terminal-teardown wake that is fatal: nothing else will start the
			// container, the queued terminal webhook is never delivered, and the
			// grace deadline becomes the only thing that reclaims it. So confirm
			// the container is actually running, and fall through to boot it for
			// real if it isn't.
			if (await this.isRunning(provider, issueKey)) return;
		}

		const attempt = this.bootInner(
			deviceId,
			userId,
			provider,
			issueKey,
			notify,
		);
		const entry: InFlightBoot = { promise: attempt, startedMs: this.now() };
		this.inFlightBoots.set(deviceId, entry);
		try {
			await attempt;
		} finally {
			if (this.inFlightBoots.get(deviceId) === entry) {
				this.inFlightBoots.delete(deviceId);
			}
		}
	}

	/**
	 * Actually boots one issue's container. Written so it never rejects:
	 * every failure — a missing executor, an `ensureRunning` rejection, or
	 * even a failure to post the resulting activity (e.g. a Linear 5xx) — is
	 * caught and logged rather than thrown, since this always runs detached
	 * from a caller that could otherwise catch it.
	 */
	private bootInner(
		deviceId: number,
		userId: number,
		provider: string,
		issueKey: string,
		notify?: { workspaceId: string; sessionId: string },
	): Promise<void> {
		// The single most valuable span in the router: a cold ACA boot is ~60s
		// and an image pull can be minutes, so "why did this take four minutes"
		// is usually answered here. Note it never records an ERROR status —
		// `bootInnerTraced` catches everything by contract (see the doc above),
		// so the failure shows up as the `cyrus.boot_failed` attribute rather
		// than as a thrown exception `withSpan` could see.
		return withSpan(
			routerTracer(),
			ROUTER_SPANS.sandboxBoot,
			{
				kind: SpanKind.CLIENT,
				attributes: cyrusSpanAttributes({
					issue_key: issueKey,
					device_id: deviceId,
					provider,
				}),
			},
			async (span) => {
				const failure = await this.bootInnerTraced(
					deviceId,
					userId,
					provider,
					issueKey,
					notify,
				);
				span.setAttribute("cyrus.boot_failed", failure !== undefined);
				if (failure !== undefined) {
					span.setStatus({ code: SpanStatusCode.ERROR, message: failure });
				}
			},
		);
	}

	/**
	 * @returns the failure message when the boot failed, `undefined` on success.
	 * Reported by return value rather than by throwing because this function's
	 * whole contract is that it never rejects.
	 */
	private async bootInnerTraced(
		deviceId: number,
		userId: number,
		provider: string,
		issueKey: string,
		notify?: { workspaceId: string; sessionId: string },
	): Promise<string | undefined> {
		const executor = this.deps.executors.get(provider);
		try {
			if (!executor) {
				throw new Error(`no executor configured for provider '${provider}'`);
			}
			const env = await this.buildEnv(userId, issueKey, notify?.workspaceId);
			// Both edges of the boot are logged deliberately. `ensureRunning`
			// can take minutes (image pull, sandbox create), and for ACA it
			// returning successfully only means the INFRASTRUCTURE came up — the
			// worker process still has to dial back over WSS. Without a start
			// line and a completion line, "provider never got called",
			// "provider is still working" and "provider finished but the worker
			// never connected" all look identical from the router's console.
			this.deps.logger.info(
				`booting ${provider} container for ${issueKey} (device ${deviceId})`,
			);
			emitSandboxEvent(this.deps.logger, SANDBOX_EVENTS.bootStarted, {
				issueKey,
				deviceId,
				provider,
			});
			// A pure store read, deliberately: a build must never be started from
			// the boot path. An issue with no pin — including a terminal-teardown
			// wake, which boots for an issue that may have none — gets
			// `undefined` and the deployment's default disk.
			const disk = this.deps.devcontainers?.diskForIssue(issueKey);
			if (disk) {
				this.deps.logger.info(
					`${issueKey} is pinned to workspace image ${disk}`,
				);
			}
			await executor.ensureRunning({
				issueKey,
				env,
				...(disk ? { disk } : {}),
				mintDeviceToken: () =>
					this.deps.store.rotateContainerDeviceToken(deviceId),
				// ACA provider's snapshot-lineage check (B5/D3): the live device
				// row id guards against restoring an explicit snapshot whose
				// baked-in device token no longer matches this row. Docker/Fly
				// ignore this field.
				deviceId: String(deviceId),
			});
			this.deps.logger.info(
				`${provider} container for ${issueKey} (device ${deviceId}) reported running; waiting for the worker to connect`,
			);
			// Starts the continuous-uptime clock, and only on the tick that
			// actually transitioned this container to running — `ensureRunning`
			// covers both a cold boot and a resume, and returns immediately for a
			// container that was already up. `markDeviceRunning` is set-if-null
			// for exactly that reason, so `resumed` here distinguishes a real
			// transition from a no-op re-route.
			const transitioned = this.deps.store.markDeviceRunning(
				deviceId,
				this.now(),
			);
			emitSandboxEvent(
				this.deps.logger,
				SANDBOX_EVENTS.running,
				{ issueKey, deviceId, provider },
				{ transitioned },
			);
			this.bootFailedNotified.delete(issueKey);
			return undefined;
		} catch (err) {
			this.deps.logger.error(`Container boot failed for ${issueKey}`, err);
			emitSandboxEvent(
				this.deps.logger,
				SANDBOX_EVENTS.bootFailed,
				{ issueKey, deviceId, provider },
				{ reason: err instanceof Error ? err.message : String(err) },
			);
			if (notify && !this.bootFailedNotified.has(issueKey)) {
				this.bootFailedNotified.add(issueKey);
				try {
					await this.deps.postActivity(
						notify.workspaceId,
						notify.sessionId,
						containerBootFailedMessage(
							issueKey,
							err instanceof Error ? err.message : String(err),
						),
					);
				} catch (postErr) {
					// A Linear 5xx/network error here must not escape as a
					// rejection (Finding 1) — the boot failure itself is
					// already logged above; losing the user-facing notice is
					// an acceptable degradation, an unhandled rejection
					// crashing the router is not.
					this.deps.logger.warn(
						`Failed to post the boot-failure activity for ${issueKey}`,
						postErr,
					);
				}
			}
			return err instanceof Error ? err.message : String(err);
		}
	}

	private async buildEnv(
		userId: number,
		issueKey: string,
		/**
		 * The Linear workspace this issue belongs to, when known. Set on every
		 * normal `boot()` call (it comes from `deliverOrNotify`'s `notify`);
		 * absent on a `bootForTeardown()` wake, which has no agent session to
		 * derive it from. Only used to scope {@link reposForIssue}'s fallback —
		 * see that method's doc comment.
		 */
		workspaceId?: string,
	): Promise<Record<string, string>> {
		const email = this.emailFor(userId);
		const selection = this.defaultRunnerFor(userId);
		// Which credentials a container needs is a function of WHICH RUNNER it is
		// going to start. Hard-requiring the Claude token unconditionally meant a
		// user whose default is Codex could not boot a container at all, which
		// made "select Codex as your default" a lie for anyone without an
		// Anthropic subscription. `requiredSecretKeysFor` is the single expression
		// the `/setup` readiness banner uses too, so the page and this gate cannot
		// disagree.
		const requiredKeys = requiredSecretKeysFor(
			selection?.runner,
			this.deps.containersConfig.requiredSecretKeys,
		);
		const { ok, missing } = await this.deps.secrets.isFullyAuthenticated(
			email,
			requiredKeys,
		);
		if (!ok) {
			throw new Error(
				`${email} is not fully authenticated for containers: missing ${missing.join(", ")}. Set them with: cyrus router secrets set ${email} <KEY> <value>`,
			);
		}

		const env: Record<string, string> = {
			CYRUS_ROUTER_URL: this.deps.containersConfig.routerUrlForContainers,
			CYRUS_ISSUE_KEY: issueKey,
			CYRUS_REPOS_JSON: JSON.stringify(
				await this.reposForIssue(issueKey, workspaceId),
			),
			// Propagate the router's own tracing switches into the sandbox, so a
			// worker's spans exist exactly when the router's do. Deriving them from
			// the router's live env rather than from config is deliberate: these
			// travel together, and a deployment where one side traces and the other
			// does not produces the half-collected traces that
			// `docs/adr/0004-parent-based-head-sampling-for-traces.md` exists to
			// prevent.
			//
			// No Application Insights connection string is passed, and must not be.
			// The worker exports through the router over WSS (see
			// `RouterSpanForwarder`); giving a sandbox a direct ingestion credential
			// would need a wider egress allowlist and would put that credential in
			// every sandbox.
			...traceEnv(),
			// The per-user picker (NOR-364). Emitted before the user's own bundle
			// is spread, but the reserved-key skip below means a hand-typed
			// variable can never shadow it either way.
			...defaultRunnerEnv(selection),
		};
		// Spread the user's map, skipping reserved keys. `set` already rejects
		// them; this is belt-and-braces against a hand-edited secrets file.
		const bundle = await this.deps.secrets.get(email);
		for (const [key, value] of Object.entries(bundle)) {
			if (isReservedEnvKey(key)) {
				this.deps.logger.warn(
					`skipping reserved env key "${key}" found in ${email}'s stored secrets`,
				);
				continue;
			}
			env[key] = value;
		}

		if (selection?.runner === "codex") {
			await this.attachCodexCredential(userId, email, env);
		}
		return env;
	}

	/**
	 * Mints the short-lived Codex credential a container boots with, or fails
	 * the boot with a message naming the remedy.
	 *
	 * Three outcomes, and the difference between them is the whole point:
	 *
	 * - **A connected account** — inject `CODEX_AUTH_JSON`, refreshing first if
	 *   the stored access token is inside its five-minute window. The container
	 *   therefore never refreshes on its own, which is what dissolves the
	 *   rotation race between one user's concurrent issues (ADR 0005).
	 * - **No connected account, but `OPENAI_API_KEY` in the bundle** — let it
	 *   run on metered billing. That path stays supported precisely because the
	 *   subscription path relies on an unofficial OAuth client that OpenAI could
	 *   gate.
	 * - **Neither, or a credential that no longer refreshes** — fail the boot.
	 *
	 * It deliberately does **not** fall back to Claude. Silently running a
	 * different runner than the user chose erodes trust in the whole picker, and
	 * the user would have no way to tell it had happened.
	 */
	private async attachCodexCredential(
		userId: number,
		email: string,
		env: Record<string, string>,
	): Promise<void> {
		const hasApiKey = Boolean(env.OPENAI_API_KEY);
		const tokens = this.deps.codexTokens;
		if (tokens) {
			try {
				const credential = await tokens.mint(userId);
				if (credential) {
					env[CODEX_AUTH_JSON_ENV] = renderCodexAuthFile(credential);
					return;
				}
			} catch (error) {
				if (error instanceof CodexRefreshError) {
					if (hasApiKey) {
						this.deps.logger.warn(
							`Codex credential refresh failed for ${email}; falling back to OPENAI_API_KEY: ${error.message}`,
						);
						return;
					}
					throw new Error(
						`Your Codex account could not be refreshed. ${error.message}\n\n${error.remedy}`,
					);
				}
				throw error;
			}
		}

		if (hasApiKey) return;
		// Two different messages, because the remedy is different and the wrong
		// one is worse than none. Without a token store there IS no "Codex
		// account" section on `/setup` — it is rendered only when the store
		// exists — so telling the user to go and use it sends them looking for a
		// control that is not on their page, on a deployment where connecting a
		// subscription is not possible at all.
		throw new Error(
			tokens
				? `${email} has Codex selected as their default runner but no Codex credential. Connect a ChatGPT subscription in the "Codex account" section of /setup (run \`codex login --device-auth\` on your own machine and paste the resulting auth.json), or add OPENAI_API_KEY as a variable to use metered billing instead.`
				: `${email} has Codex selected as their default runner, but this router is not configured for ChatGPT-subscription credentials, so there is no way to connect one here. Add OPENAI_API_KEY as a variable to run Codex on metered billing, or ask the router's operator to configure containers.codex.`,
		);
	}

	/**
	 * The repositories THIS issue's sandbox should clone.
	 *
	 * The router decided this before the container existed and persisted it, so
	 * a container destroyed and recreated clones the same repository rather than
	 * silently switching. A missing decision — the router restarted and lost
	 * SQLite between Blob backups — degrades to the configured default rather
	 * than to "clone everything", which is what the pre-registry code did and
	 * what made a multi-repository deployment unusable.
	 *
	 * The fallback default is scoped to `workspaceId` when it's known (mirrors
	 * `RepositoryResolver.resolve`'s own workspace filter): a router serving
	 * multiple Linear workspaces must not fall back to some OTHER workspace's
	 * default just because it sorts first in the registry. `workspaceId` is
	 * unavailable only on a `bootForTeardown()` wake with no decision at all —
	 * a narrow, already-degraded corner (see {@link buildEnv}) — where the
	 * fallback widens back out to the whole registry rather than cloning
	 * nothing.
	 */
	private async reposForIssue(
		issueKey: string,
		workspaceId?: string,
	): Promise<RegisteredRepository[]> {
		let repositories: RegisteredRepository[];
		try {
			({ repositories } = await this.deps.registry.list());
		} catch (error) {
			// Mirrors `RepositoryResolver.resolve`'s identical catch: the
			// Table-backed production registry throws on a transient 5xx, an
			// auth failure, or exhausted retries — this is reachable, not
			// hypothetical, and before the registry existed `containersConfig
			// .repositories` was a static in-memory array that could never fail
			// this way. Reported with wording distinguishable from "the registry
			// is empty" below, so an operator sees "retry" rather than "go add a
			// repository" for what is usually a transient condition.
			this.deps.logger.error(
				`Could not read the repository registry while building the boot env for ${issueKey}`,
				error,
			);
			throw new Error(
				`The repository registry could not be read, so there is nothing to clone for ${issueKey} yet. This is usually transient — the boot will succeed once the registry is reachable again.`,
			);
		}
		const byName = new Map(repositories.map((repo) => [repo.name, repo]));
		const decision = this.deps.store.getIssueRepositories(issueKey);

		let chosen: RegisteredRepository[];
		// Distinguishes "no decision was ever stored" from "a decision existed
		// but every repository it named has since been deregistered" — both
		// degrade to the same fallback, but they are different operational
		// states and the log line said the former even when it was the latter.
		let decidedRepositoriesAllDeregistered = false;
		if (decision) {
			const missing: string[] = [];
			chosen = [];
			for (const name of decision.repoNames) {
				const repo = byName.get(name);
				if (repo) chosen.push(repo);
				else missing.push(name);
			}
			if (missing.length > 0) {
				this.deps.logger.warn(
					`Issue ${issueKey} was routed to [${missing.join(", ")}], which ${
						missing.length === 1 ? "is" : "are"
					} no longer registered; booting without ${missing.length === 1 ? "it" : "them"}`,
				);
			}
			// A `#branch` override from a description tag is applied here rather
			// than stored on the registry entry, which is shared by every issue.
			chosen = chosen.map((repo) => {
				const override = decision.baseBranchOverrides[repo.name];
				return override ? { ...repo, baseBranch: override } : repo;
			});
			decidedRepositoriesAllDeregistered =
				chosen.length === 0 && decision.repoNames.length > 0;
		} else {
			chosen = [];
		}

		if (chosen.length > 0) return chosen;

		const inWorkspace = workspaceId
			? repositories.filter((repo) => repo.linearWorkspaceId === workspaceId)
			: repositories;
		const fallback =
			inWorkspace.find((repo) => repo.isDefault === true) ?? inWorkspace[0];
		if (!fallback) {
			throw new Error(
				`No repositories are registered${
					workspaceId ? ` for Linear workspace ${workspaceId}` : ""
				}, so there is nothing to clone for ${issueKey}. Add one at /setup/repositories.`,
			);
		}
		this.deps.logger.warn(
			decidedRepositoriesAllDeregistered
				? `Every repository issue ${issueKey} was routed to has since been deregistered; falling back to ${fallback.name}`
				: `No stored repository decision for ${issueKey}; falling back to ${fallback.name}`,
		);
		return [fallback];
	}

	private emailFor(userId: number): string {
		const email = this.deps.store.getUserEmail(userId);
		if (!email) throw new Error(`unknown user ${userId}`);
		return email;
	}
}

/**
 * The tracing environment a sandbox worker inherits from the router.
 *
 * Read from `process.env` at boot time rather than captured at startup so a
 * router restarted with tracing newly enabled starts producing traced sandboxes
 * immediately, without the value being baked into a long-lived object.
 *
 * Only forwards what is set. An absent `CYRUS_OTEL_TRACES_ENABLED` leaves the
 * worker's env byte-identical to what it was before this phase, which is what
 * keeps this change inert for every deployment that has not opted in.
 */
function traceEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of [
		OTEL_TRACES_ENABLED_ENV,
		OTEL_TRACES_SAMPLE_RATIO_ENV,
		// Not a tracing switch, but the sandbox's `deployment.environment.name`
		// has to match the router's or the two halves of a trace land in
		// different environments in the backend.
		"CYRUS_OTEL_DEPLOYMENT_ENV",
	]) {
		const value = process.env[key]?.trim();
		if (value) env[key] = value;
	}
	return env;
}
