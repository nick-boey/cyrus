import type { ILogger } from "cyrus-core";
import type { AcaSandboxClient } from "cyrus-router-executors";
import type { RegisteredRepository } from "../RepositoryRegistry.js";
import type { RouterStore } from "../RouterStore.js";
import type { AcrDevcontainerBuilder } from "./AcrDevcontainerBuilder.js";
import type { DevcontainerFile } from "./config.js";
import {
	devcontainerCacheKey,
	diskNameFor,
	fetchDevcontainer,
	ignoredFieldsIn,
	validateDevcontainer,
} from "./config.js";

/**
 * Tasks 4, 6 and 7 (NOR-309): turning "this repository declares an environment"
 * into a disk an ACA sandbox can boot from, and cleaning up after itself.
 *
 * The three tasks live together because they are three views of one table. The
 * cache row is what a build produces, what a boot pins to, and what the GC
 * counts references against; splitting them would mean three services agreeing
 * on the same invariants by convention.
 */

/** Per-request deadline for the ACR token exchange; `fetch` supplies none. */
const REGISTRY_REQUEST_TIMEOUT_MS = 30_000;

export type EnsureOutcome =
	/** No devcontainer, or the feature is off: boot the default worker image. */
	| { kind: "default" }
	/** A disk is registered and the issue is pinned to it. */
	| { kind: "ready"; diskName: string; repositoryName: string }
	/** A build is running. The caller must hold the webhook. */
	| { kind: "building"; cacheKey: string; repositoryName: string }
	/** Nothing usable. The caller falls back to the default image and says so. */
	| { kind: "failed"; reason: string; runId?: string };

export interface DevcontainerImageServiceDeps {
	store: RouterStore;
	logger: ILogger;
	builder: AcrDevcontainerBuilder;
	/** ACA data-plane client, for registering and deleting disk images. */
	aca: AcaSandboxClient;
	/**
	 * Mints an ARM access token. Exchanged for an ACR refresh token so the ACA
	 * importer can pull from a private registry with `adminUserEnabled: false`.
	 */
	getArmToken: () => Promise<string>;
	/** Router-level GitHub credential with read access to registered repositories. */
	githubToken: string;
	/** The deployment's default disk — the other half of the staleness split. */
	deploymentDisk: string;
	/** OCI ref of the `cyrus-worker` Feature, e.g. "ghcr.io/…/cyrus-worker:0.1.0". */
	workerFeatureRef: string;
	/** Worker feature version, part of every cache key. */
	workerFeatureVersion: string;
	/** URL of the worker payload tarball the feature extracts. */
	workerPayloadTarball: string;
	/** Non-root user the finalize stage drops to. Default "cyrus". */
	workerUser?: string;
	/** ACR login server, for the pull credential exchange. */
	registryLoginServer: string;
	now?: () => number;
	/** Deadline for the synchronous ACA disk import. Default 900s. */
	diskReadyTimeoutMs?: number;
	diskReadyPollMs?: number;
}

/** ACR's OAuth2 exchange always uses this sentinel as the username. */
const ACR_TOKEN_USERNAME = "00000000-0000-0000-0000-000000000000";

export class DevcontainerImageService {
	private readonly workerUser: string;
	/**
	 * Builds THIS process started.
	 *
	 * Deliberately narrower than the `building` cache row, which is durable and
	 * shared: this set is what {@link recoverInterruptedBuilds} uses to tell a
	 * row its own process is still working on from one abandoned by a restart.
	 */
	private readonly inFlight = new Set<string>();

	constructor(private readonly deps: DevcontainerImageServiceDeps) {
		this.workerUser = deps.workerUser ?? "cyrus";
	}

	/**
	 * Clears builds that were in flight when the process died, and releases the
	 * webhooks held on them. Call once at startup, after
	 * {@link setOnBuildFinished}.
	 *
	 * A `building` row is only ever cleared by `runBuild`'s `finally`, and the
	 * webhooks held behind it only by the in-process completion callback — both
	 * of which die with the process. `claimDevcontainerBuild` re-claims only a
	 * `failed` row, so without this a router restart mid-build leaves the row
	 * `building` forever and every issue on that repository stalls on
	 * "Building image…" with nothing left alive to release it. The router is
	 * single-replica and restarts on every deploy, so this is the ordinary case,
	 * not an edge one.
	 *
	 * The row is DELETED rather than failed: an interrupted build says nothing
	 * about whether the devcontainer builds, and a `failed` row would send every
	 * issue to the default worker image until someone edited the repository. The
	 * replay re-enters `ensureForIssue`, finds no row, and schedules the build
	 * again.
	 */
	recoverInterruptedBuilds(): void {
		for (const row of this.deps.store.listDevcontainerImages()) {
			if (row.state !== "building") continue;
			if (this.inFlight.has(row.cacheKey)) continue;
			this.deps.store.deleteDevcontainerImage(row.cacheKey);
			this.deps.logger.warn(
				`Devcontainer image build for ${row.repositoryName} did not survive a router restart; rescheduling it and releasing anything held on it`,
			);
			this.onBuildFinished?.(row.cacheKey);
		}
	}

	/**
	 * Registers the build-completion callback after construction.
	 *
	 * `EventRouter` needs this service to exist before it can be built, and this
	 * service needs the router to release the webhooks it held — so one of the
	 * two edges has to be wired up late, and this is the cheaper one.
	 */
	setOnBuildFinished(fn: (cacheKey: string) => void): void {
		this.onBuildFinished = fn;
	}

	private onBuildFinished?: (cacheKey: string) => void;

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}

	/**
	 * What disk the issue's container should boot from, as a pure store read.
	 *
	 * Deliberately synchronous and side-effect-free: it runs on the boot path,
	 * including a terminal-teardown wake, where creating a pin (let alone
	 * starting a build) would be wrong. An issue with no pin boots the default,
	 * which is also what every issue did before this existed.
	 */
	diskForIssue(issueKey: string): string | undefined {
		const pin = this.deps.store.getIssueDiskImage(issueKey);
		if (!pin) return undefined;
		// A pin made under a superseded deployment image is not a pin any more:
		// the worker feature baked into that disk has been replaced. Reporting
		// it here would boot the old environment forever; reporting `undefined`
		// falls back to the deployment's current disk, which is the same
		// behaviour a repository with no devcontainer already gets.
		if (pin.deploymentDisk !== this.deps.deploymentDisk) return undefined;
		return pin.diskName;
	}

	/**
	 * Decides — and if necessary starts building — the image for an issue.
	 *
	 * Called on the router before anything boots, so a build's minutes are paid
	 * once, visibly, with the webhook held, rather than inside a sandbox that
	 * has already been created.
	 */
	async ensureForIssue(
		issueKey: string,
		repo: RegisteredRepository,
	): Promise<EnsureOutcome> {
		const existingPin = this.deps.store.getIssueDiskImage(issueKey);
		if (
			existingPin &&
			existingPin.deploymentDisk === this.deps.deploymentDisk
		) {
			// Decided once. A devcontainer edit after this point applies to
			// containers created after it — never retroactively to this one,
			// whose sandbox and snapshots would otherwise be destroyed by the
			// `cyrus.disk` mismatch rule.
			return {
				kind: "ready",
				diskName: existingPin.diskName,
				repositoryName: existingPin.repositoryName,
			};
		}

		let resolved:
			| { cacheKey: string; diskName: string; file: DevcontainerFile }
			| undefined;
		try {
			resolved = await this.resolve(repo);
		} catch (error) {
			return {
				kind: "failed",
				reason: error instanceof Error ? error.message : String(error),
			};
		}
		if (!resolved) return { kind: "default" };

		const { cacheKey, diskName, file } = resolved;
		const cached = this.deps.store.getDevcontainerImage(cacheKey);
		if (cached?.state === "ready") {
			this.pin(issueKey, repo.name, cacheKey, diskName, cached.imageRef);
			return { kind: "ready", diskName, repositoryName: repo.name };
		}
		if (cached?.state === "failed") {
			return {
				kind: "failed",
				reason: cached.error ?? "the image build failed",
				runId: cached.runId,
			};
		}
		if (cached?.state === "building") {
			return { kind: "building", cacheKey, repositoryName: repo.name };
		}

		this.startBuild({ repo, cacheKey, diskName, file });
		return { kind: "building", cacheKey, repositoryName: repo.name };
	}

	/**
	 * Warms a repository's image at registration time.
	 *
	 * Fire-and-forget by contract: registration must never block on a build, and
	 * must never fail because one did. The failure is not invisible — it lands
	 * on the cache row, which `/setup/repositories` renders — because a
	 * fire-and-forget build's failures are otherwise invisible by construction,
	 * and the person who needs to know is an operator on a web page.
	 */
	warmBuild(repo: RegisteredRepository): void {
		void (async () => {
			try {
				const resolved = await this.resolve(repo);
				if (!resolved) return;
				const cached = this.deps.store.getDevcontainerImage(resolved.cacheKey);
				if (cached && cached.state !== "failed") return;
				this.startBuild({ repo, ...resolved });
			} catch (error) {
				this.deps.logger.warn(
					`Warm devcontainer build for ${repo.name} could not start`,
					error,
				);
			}
		})();
	}

	/**
	 * Why this repository's devcontainer cannot be honoured, if it cannot.
	 *
	 * Registration asks two different things of us and they need two different
	 * answers. The BUILD is fire-and-forget — it takes minutes and "must never
	 * block or fail registration". The VALIDATION is the opposite: a
	 * `dockerComposeFile` devcontainer "must fail loudly at registration rather
	 * than half-work", and inside {@link warmBuild} it can only ever become a
	 * log line nobody reads. This is one GitHub API call, which is what the plan
	 * budgets for deciding what a sandbox is.
	 *
	 * A read that FAILS is not a rejection. GitHub being unreachable says
	 * nothing about the repository's devcontainer, and refusing the registration
	 * over it would make an outage look like a bad configuration.
	 */
	async rejectionFor(repo: RegisteredRepository): Promise<string | undefined> {
		try {
			const file = await fetchDevcontainer(
				repo.githubSlug,
				repo.baseBranch ?? "HEAD",
				{ token: this.deps.githubToken },
			);
			if (!file) return undefined;
			return validateDevcontainer(file.config)?.reason;
		} catch (error) {
			this.deps.logger.warn(
				`Could not read ${repo.name}'s devcontainer while registering it`,
				error,
			);
			return undefined;
		}
	}

	/** The cache row an operator sees on `/setup/repositories`, if any. */
	statusFor(repositoryName: string) {
		return this.deps.store
			.listDevcontainerImages()
			.find((row) => row.repositoryName === repositoryName);
	}

	/**
	 * Reads the repository's devcontainer and derives its cache key.
	 *
	 * `undefined` means "no devcontainer" — the overwhelmingly common case, and
	 * one API call. A devcontainer we cannot honour throws, so the caller
	 * reports it rather than silently booting a default that is not what the
	 * repository asked for.
	 */
	private async resolve(
		repo: RegisteredRepository,
	): Promise<
		{ cacheKey: string; diskName: string; file: DevcontainerFile } | undefined
	> {
		const ref = repo.baseBranch ?? "HEAD";
		const file = await fetchDevcontainer(repo.githubSlug, ref, {
			token: this.deps.githubToken,
		});
		if (!file) return undefined;
		const rejection = validateDevcontainer(file.config);
		if (rejection) throw new Error(rejection.reason);
		const ignored = ignoredFieldsIn(file.config);
		if (ignored.length > 0) {
			this.deps.logger.info(
				`${repo.name}'s devcontainer sets ${ignored.join(", ")}, which Cyrus ignores`,
			);
		}
		const cacheKey = devcontainerCacheKey({
			repositoryName: repo.name,
			raw: file.raw,
			path: file.path,
			workerFeatureVersion: this.deps.workerFeatureVersion,
			workerPayload: this.deps.workerPayloadTarball,
			...(file.dockerfile ? { dockerfile: file.dockerfile } : {}),
		});
		return { cacheKey, diskName: diskNameFor(repo.name, cacheKey), file };
	}

	private pin(
		issueKey: string,
		repositoryName: string,
		cacheKey: string,
		diskName: string,
		imageRef: string,
	): void {
		this.deps.store.setIssueDiskImage(
			{
				issueKey,
				repositoryName,
				cacheKey,
				diskName,
				imageRef,
				deploymentDisk: this.deps.deploymentDisk,
			},
			this.now(),
		);
	}

	private startBuild(args: {
		repo: RegisteredRepository;
		cacheKey: string;
		diskName: string;
		file: DevcontainerFile;
	}): void {
		const { repo, cacheKey, diskName, file } = args;
		const imageRef = this.deps.builder.imageRef(cacheKey.slice(0, 32));
		// Single-flight across the whole deployment, not just this process: the
		// claim is an INSERT that only one writer wins. A build is minutes of
		// ACR agent compute, and a second one would push the same tag from a
		// second checkout of the same ref.
		const claimed = this.deps.store.claimDevcontainerBuild(
			{ cacheKey, repositoryName: repo.name, diskName, imageRef },
			this.now(),
		);
		if (!claimed || this.inFlight.has(cacheKey)) return;
		this.inFlight.add(cacheKey);
		void this.runBuild({ repo, cacheKey, diskName, imageRef, file }).finally(
			() => {
				this.inFlight.delete(cacheKey);
				this.onBuildFinished?.(cacheKey);
			},
		);
	}

	private async runBuild(args: {
		repo: RegisteredRepository;
		cacheKey: string;
		diskName: string;
		imageRef: string;
		file: DevcontainerFile;
	}): Promise<void> {
		const { repo, cacheKey, diskName, file } = args;
		try {
			const result = await this.deps.builder.build(
				{
					repositoryName: repo.name,
					githubSlug: repo.githubSlug,
					ref: repo.baseBranch ?? "HEAD",
					file,
					tag: cacheKey.slice(0, 32),
					workerFeatureRef: this.deps.workerFeatureRef,
					workerFeatureOptions: { tarball: this.deps.workerPayloadTarball },
					workerUser: this.workerUser,
				},
				this.deps.githubToken,
			);
			if (result.status !== "Succeeded" || !result.image) {
				this.deps.store.finishDevcontainerBuild(
					cacheKey,
					{
						state: "failed",
						runId: result.runId,
						// The run id is the load-bearing part (ADR 0007): it is what
						// makes `az acr task logs --run-id` possible for someone who
						// is allowed to see a log that ran with unrestricted egress
						// over repository-controlled content. The tail is a hint.
						error: `ACR run ${result.runId} finished ${result.status}${
							result.logTail ? `\n${result.logTail}` : ""
						}`,
					},
					this.now(),
				);
				return;
			}
			await this.registerDisk(diskName, result.image);
			this.deps.store.finishDevcontainerBuild(
				cacheKey,
				{ state: "ready", runId: result.runId },
				this.now(),
			);
			this.deps.logger.info(
				`Devcontainer image for ${repo.name} is ready as disk ${diskName}`,
			);
		} catch (error) {
			this.deps.store.finishDevcontainerBuild(
				cacheKey,
				{
					state: "failed",
					error: error instanceof Error ? error.message : String(error),
				},
				this.now(),
			);
			this.deps.logger.error(
				`Devcontainer build for ${repo.name} failed`,
				error,
			);
		}
	}

	/**
	 * Registers the pushed image as an ACA disk and waits for it to be usable.
	 *
	 * Gating on `Ready` rather than on the PUT's status code is not caution: the
	 * import is synchronous, scales with image size, and a 2xx says only that
	 * the request was accepted. A disk marked ready in our table but still
	 * importing in Azure produces a create that fails at boot, minutes after the
	 * build reported success.
	 */
	private async registerDisk(diskName: string, image: string): Promise<void> {
		const existing = findDiskImage(
			await this.deps.aca.listDiskImages(),
			diskName,
		);
		if (!existing) {
			await this.deps.aca.createDiskImage(diskName, image, {
				registryCredentials: {
					username: ACR_TOKEN_USERNAME,
					token: await this.acrPullToken(),
				},
			});
		}
		await this.deps.aca.waitForDiskImageReady(diskName, {
			timeoutMs: this.deps.diskReadyTimeoutMs ?? 900_000,
			pollMs: this.deps.diskReadyPollMs ?? 10_000,
		});
	}

	/**
	 * Exchanges the router's ARM token for an ACR refresh token — the same
	 * exchange `az acr login --expose-token` performs.
	 *
	 * The tenant comes out of the ARM token's own `tid` claim rather than
	 * config: it is not a secret, it is already implied by the credential we
	 * hold, and a separately-configured value can only ever disagree with it.
	 */
	private async acrPullToken(): Promise<string> {
		const armToken = await this.deps.getArmToken();
		const res = await fetch(
			`https://${this.deps.registryLoginServer}/oauth2/exchange`,
			{
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "access_token",
					service: this.deps.registryLoginServer,
					tenant: tenantFromJwt(armToken),
					access_token: armToken,
				}).toString(),
				// `fetch` has no default deadline; without one a hung registry
				// holds the build — and every webhook held behind it — open.
				signal: AbortSignal.timeout(REGISTRY_REQUEST_TIMEOUT_MS),
			},
		);
		if (!res.ok) {
			throw new Error(
				`ACR token exchange failed with HTTP ${res.status} for ${this.deps.registryLoginServer}`,
			);
		}
		const body = (await res.json()) as { refresh_token?: string };
		if (!body.refresh_token) {
			throw new Error("ACR token exchange returned no refresh_token");
		}
		return body.refresh_token;
	}

	/**
	 * Task 6: deletes disk images and cache rows that nothing references.
	 *
	 * Four floors, and none of them is optional:
	 *  - a disk any live issue is pinned to, whether or not its container is up;
	 *  - a disk any snapshot was taken from, since a snapshot restores the image
	 *    lineage it came from and would resurrect a deleted one;
	 *  - the newest ready image per repository, so the next issue on that
	 *    repository does not have to rebuild what we just deleted;
	 *  - and the deployment's own default disk, always.
	 *
	 * Runs on a slow cadence, well away from the 60s lifecycle sweep, which is
	 * non-reentrant by contract.
	 */
	async collectGarbage(): Promise<void> {
		const keep = new Set<string>([this.deps.deploymentDisk]);
		for (const key of this.deps.store.referencedDevcontainerCacheKeys()) {
			const row = this.deps.store.getDevcontainerImage(key);
			if (row) keep.add(row.diskName);
		}
		try {
			for (const snapshot of await this.deps.aca.listSnapshots({
				"cyrus.managed": "true",
			})) {
				const disk = snapshot.labels?.["cyrus.disk"];
				if (disk) keep.add(disk);
			}
		} catch (error) {
			// A snapshot listing we could not read is not evidence that nothing
			// references these disks. Skipping the whole sweep costs one slow
			// cycle; guessing costs a resurrected sandbox that cannot restore.
			this.deps.logger.warn(
				"Skipping devcontainer disk GC: the snapshot listing could not be read",
				error,
			);
			return;
		}
		const newestPerRepository = new Map<string, string>();
		for (const row of this.deps.store.listDevcontainerImages()) {
			if (row.state !== "ready") continue;
			// `listDevcontainerImages` is ordered newest-first, so the first
			// ready row seen for a repository is the one to keep.
			if (!newestPerRepository.has(row.repositoryName)) {
				newestPerRepository.set(row.repositoryName, row.diskName);
				keep.add(row.diskName);
			}
		}

		// Listed ONCE, outside the loop: this is an ARM call, and a sweep over a
		// deployment's worth of rows made one per row.
		const registeredDisks = await this.deps.aca.listDiskImages();
		for (const row of this.deps.store.listDevcontainerImages()) {
			if (row.state === "building") continue;
			if (keep.has(row.diskName)) continue;
			const registered = findDiskImage(registeredDisks, row.diskName);
			if (registered?.id) {
				await this.deps.aca.deleteDiskImage(registered.id).catch((error) => {
					this.deps.logger.warn(
						`could not delete disk image ${row.diskName}`,
						error,
					);
				});
			}
			this.deps.store.deleteDevcontainerImage(row.cacheKey);
			this.deps.logger.info(
				`Collected unreferenced devcontainer image ${row.diskName} for ${row.repositoryName}`,
			);
		}
	}
}

/**
 * A registered disk by name.
 *
 * Both fields are checked because ACA assigns its own GUID as `name` and keeps
 * the name we asked for in `labels.name` — so which one matches depends on how
 * the disk was registered, and neither alone is reliable.
 */
function findDiskImage<T extends { name?: string; labels?: { name?: string } }>(
	disks: readonly T[],
	name: string,
): T | undefined {
	return disks.find((d) => d.name === name || d.labels?.name === name);
}

/**
 * The `tid` claim of a JWT, without verifying it.
 *
 * Verification would be pointless here: the token was just minted by
 * `@azure/identity` for this process, and the only thing read out of it is a
 * routing value that ACR will itself reject if wrong.
 */
function tenantFromJwt(token: string): string {
	const payload = token.split(".")[1];
	if (!payload) throw new Error("ARM token is not a JWT");
	const claims = JSON.parse(
		Buffer.from(payload, "base64url").toString("utf8"),
	) as { tid?: string };
	if (!claims.tid) throw new Error("ARM token carries no tenant claim");
	return claims.tid;
}
