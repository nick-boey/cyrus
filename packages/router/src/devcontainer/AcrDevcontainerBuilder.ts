import type { ILogger } from "cyrus-core";
import type { DevcontainerConfig, DevcontainerFile } from "./config.js";

/**
 * Task 3 (NOR-309): building a repository's devcontainer, in ACR and nowhere
 * else.
 *
 * ADR 0007 is the reason this is not a local `docker build`: a registered
 * repository is trusted, but the *builder* is what we constrain. The build runs
 * a repository-authored Dockerfile and repository-chosen Features with
 * unrestricted egress — so it runs on disposable ACR agent compute, under an
 * identity scoped to push to one registry path, and never on the router host.
 *
 * The same ADR is why {@link buildLogTail} exists and why the full log never
 * does: the run id is the load-bearing part of a failure report, because it is
 * what makes `az acr task logs --run-id` possible for an operator who is
 * allowed to see it.
 */

/** ARM's own vocabulary for a run's terminal state. */
export type AcrRunStatus =
	| "Queued"
	| "Started"
	| "Running"
	| "Succeeded"
	| "Failed"
	| "Canceled"
	| "Error"
	| "Timeout";

const TERMINAL: ReadonlySet<string> = new Set([
	"Succeeded",
	"Failed",
	"Canceled",
	"Error",
	"Timeout",
]);

/**
 * Per-request deadline for ARM and log-blob reads.
 *
 * Matches `AcaSandboxClient`'s `DEFAULT_REQUEST_TIMEOUT_MS`, and for the same
 * reason: `fetch` has none of its own. Every call here is a control-plane
 * request that either answers in seconds or is not going to — the minutes-long
 * work happens on the ACR agent, which `waitForRun` polls for.
 */
const ARM_REQUEST_TIMEOUT_MS = 120_000;

export interface AcrBuilderConfig {
	subscriptionId: string;
	resourceGroup: string;
	/** Registry name, e.g. "cyrusacr" — not the login server. */
	registry: string;
	/** Login server, e.g. "cyrusacr.azurecr.io". */
	loginServer: string;
	/**
	 * Repository path images are pushed under, e.g. "cyrus/devcontainers".
	 * The build identity is scoped to exactly this path (ADR 0007).
	 */
	imageRepository?: string;
	/** ARM api-version for the ContainerRegistry runs API. */
	apiVersion?: string;
	/** Agent vCPU. ACR Basic includes limited task compute — see the runbook. */
	agentCpu?: number;
	/** Seconds. ACR's own ceiling is 6 hours; the default here is 90 minutes. */
	timeoutSeconds?: number;
	/** Poll interval while a run is in flight. */
	pollMs?: number;
	/** Image the build step runs in: needs a docker CLI, node, and git. */
	builderImage?: string;
	/** `@devcontainers/cli` version, pinned so a build is reproducible. */
	devcontainerCliVersion?: string;
}

export interface DevcontainerBuildRequest {
	repositoryName: string;
	githubSlug: string;
	ref: string;
	/** The file as found, verbatim — used for its path, not re-read. */
	file: DevcontainerFile;
	/** The tag the built image is pushed as. */
	tag: string;
	/** OCI reference of the `cyrus-worker` Feature, e.g. "ghcr.io/…/cyrus-worker:0.1.0". */
	workerFeatureRef: string;
	/** Options passed to the worker feature — chiefly the payload `tarball`. */
	workerFeatureOptions: Record<string, string>;
	/** Non-root user the finalize stage drops to. */
	workerUser: string;
}

export interface DevcontainerBuildResult {
	/** Always present, success or failure: this is what an operator chases. */
	runId: string;
	status: AcrRunStatus;
	/** Fully-qualified pushed image, only on success. */
	image?: string;
	/** Bounded, never the full log. See {@link buildLogTail}. */
	logTail?: string;
}

/** Injectable ARM transport, so tests never touch Azure. */
export type ArmRequestFn = (
	method: string,
	url: string,
	body?: unknown,
) => Promise<{ status: number; json: unknown; text: string }>;

/**
 * The two instructions `devcontainer build` structurally cannot emit.
 *
 * A Feature contributes RUN layers only; the CLI's generated Dockerfile ends
 * with `USER $_DEV_CONTAINERS_IMAGE_USER` bound to the BASE image's user (never
 * `containerUser`), and it emits no ENTRYPOINT at all. `containerUser` /
 * `remoteUser` become a `devcontainer.metadata` LABEL that only the devcontainer
 * CLI reads when it execs in — ACA does not read it, and boots the image's own
 * OCI entrypoint as the image's own user.
 *
 * This stage is UNIFORM: it does not vary with the shape of the repository's
 * base, which is why it is not the "bespoke grafting logic against every shape a
 * base can take" that ADR 0006 rejects. It grafts onto the built image, not into
 * the repository's Dockerfile.
 *
 * The assertion is the highest-value line in it. Without it a missing worker
 * feature produces an image that builds happily and then presents as a sandbox
 * stuck `Running` with no worker attached — per the ACA invariants in CLAUDE.md,
 * the single hardest symptom to trace back to its cause.
 */
export function finalizeDockerfile(
	workerUser: string,
	containerEnv?: Record<string, string>,
): string {
	// `containerEnv` is honoured HERE for the same reason `USER`/`ENTRYPOINT`
	// are: `devcontainer build` records it as a `devcontainer.metadata` label
	// that only the devcontainer CLI reads when it execs in. ACA boots the
	// image's own OCI config and reads no such label, so a field we document as
	// "Used" would otherwise be silently dropped — exactly the failure mode ADR
	// 0006 calls worse than not supporting the field at all.
	const env = Object.entries(containerEnv ?? {})
		// A key that is not a shell identifier cannot be an `ENV` name; emitting
		// it would break the build with a Dockerfile parse error rather than
		// naming the offending key. Repository content is trusted (ADR 0007), so
		// this is a legibility guard, not a security boundary.
		.filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
		.map(([key, value]) => {
			// `${containerEnv:PATH}` is the spec's way of extending a variable the
			// base image already set, and PATH extension is what almost every real
			// `containerEnv` does. Docker's own `$VAR` expansion is the equivalent,
			// so translate rather than emitting a literal that lands in the
			// environment verbatim.
			const expanded = String(value).replace(
				/\$\{containerEnv:([A-Za-z_][A-Za-z0-9_]*)\}/g,
				"${$1}",
			);
			return `ENV ${key}=${JSON.stringify(expanded)}`;
		})
		.join("\n");
	return `ARG BUILT_IMAGE
FROM \${BUILT_IMAGE}
${env}${env ? "\n" : ""}RUN set -eu; \\
	if [ ! -x /entrypoint.sh ]; then \\
		echo "cyrus-worker feature did not install an executable /entrypoint.sh" >&2; \\
		exit 1; \\
	fi; \\
	if ! id -u "${workerUser}" >/dev/null 2>&1; then \\
		echo "worker user '${workerUser}' does not exist in the built image" >&2; \\
		exit 1; \\
	fi
USER ${workerUser}
ENTRYPOINT ["/entrypoint.sh"]
`;
}

/**
 * The repository's devcontainer with the worker feature grafted on.
 *
 * Two things are load-bearing and neither is cosmetic:
 *
 * - The worker feature is FIRST in `overrideFeatureInstallOrder`. It creates the
 *   worker user, and the published `rust`, `node` and `github-cli` features all
 *   resolve `USERNAME="${USERNAME:-"${_REMOTE_USER:-automatic}"}"` and then
 *   silently fall back to `USERNAME=root` when `id -u` fails. A toolchain
 *   feature running first therefore produces a root-owned `CARGO_HOME` — every
 *   `cargo build` failing at runtime, in an image that built without a warning.
 * - The repository's own feature options win on a key collision, because the
 *   repository is trusted (ADR 0007) and this is its environment. Only the
 *   worker feature's own entry is ours.
 *
 * `containerUser`/`remoteUser` are set so the features' `_REMOTE_USER` resolves
 * to the worker user even though the CLI will not act on them itself.
 */
export function composeDevcontainer(
	config: DevcontainerConfig,
	req: DevcontainerBuildRequest,
): DevcontainerConfig {
	const existingOrder = Array.isArray(config.overrideFeatureInstallOrder)
		? (config.overrideFeatureInstallOrder as string[]).filter(
				(id) => id !== req.workerFeatureRef,
			)
		: [];
	return {
		...config,
		features: {
			[req.workerFeatureRef]: req.workerFeatureOptions,
			...(config.features ?? {}),
		},
		overrideFeatureInstallOrder: [req.workerFeatureRef, ...existingOrder],
		containerUser: req.workerUser,
		remoteUser: req.workerUser,
	};
}

/**
 * The build script the ACR agent runs.
 *
 * Everything that needs judgement — parsing JSONC, merging features, ordering
 * them — has already happened on the router and arrives here as finished JSON.
 * What is left is clone, overwrite one file, build, finalize, push.
 *
 * The manifest shape is the one thing here that is easy to get silently wrong.
 * A recent buildx attaches provenance/SBOM attestations by default, which makes
 * the result an OCI image INDEX — and the ACA disk importer cannot consume one
 * (`scripts/deploy-worker-image.sh` gates on the media type for exactly that
 * reason). Three defences, in order of how much they can be trusted:
 *
 * 1. `DOCKER_BUILDKIT=0` in the ENVIRONMENT. `devcontainer build --buildkit
 *    never` is NOT sufficient on its own: measured on Docker 29.7.2, the CLI
 *    shells out to plain `docker build` and the flag only decides which flags
 *    IT passes, so the daemon picks BuildKit anyway and attaches attestations.
 *    Exporting the variable is what actually selects the classic builder.
 * 2. `BUILDX_NO_DEFAULT_ATTESTATIONS=1`, for the case where the daemon routes
 *    `docker build` through buildx regardless.
 * 3. An assertion on the PUSHED manifest. Every mechanism above is a property
 *    of the daemon rather than of anything we can pass, so the build fails here
 *    — where the run id and the log are — rather than hours later at a disk
 *    import that reports a media type and nothing about where it came from.
 */
export function buildScript(opts: {
	slug: string;
	ref: string;
	configPath: string;
	image: string;
	cliVersion: string;
}): string {
	return `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export DOCKER_BUILDKIT=0
export BUILDX_NO_DEFAULT_ATTESTATIONS=1
command -v git >/dev/null || (apk add --no-cache git nodejs npm bash || (apt-get update && apt-get install -y git nodejs npm))
command -v node >/dev/null || (apk add --no-cache nodejs npm || (apt-get update && apt-get install -y nodejs npm))
npm install -g @devcontainers/cli@${opts.cliVersion}

# The token reaches git through a header, never through the URL: a URL-embedded
# credential lands in the remote's config, in \`git remote -v\`, and in any error
# text the build prints.
git init -q repo
cd repo
git config --local http.https://github.com/.extraheader \\
	"AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)"
git fetch --depth 1 -q https://github.com/${opts.slug}.git "${opts.ref}"
git checkout -q FETCH_HEAD
git config --local --unset http.https://github.com/.extraheader

# The composed config is written to the SAME path the file was found at, so
# every relative path inside it (build.dockerfile, build.context, local feature
# folders) still resolves exactly as the repository author wrote it.
mkdir -p "$(dirname "${opts.configPath}")"
printf '%s' "$COMPOSED_DEVCONTAINER" | base64 -d > "${opts.configPath}"
printf '%s' "$FINALIZE_DOCKERFILE" | base64 -d > /tmp/Dockerfile.finalize

devcontainer build \\
	--workspace-folder . \\
	--config "${opts.configPath}" \\
	--image-name cyrus-devcontainer-built:local \\
	--buildkit never

docker build \\
	--build-arg BUILT_IMAGE=cyrus-devcontainer-built:local \\
	-f /tmp/Dockerfile.finalize \\
	-t "${opts.image}" \\
	/tmp

docker push "${opts.image}"

# The ACA disk importer accepts only a Docker v2 manifest. Fail HERE, where the
# run id and the log are, rather than at a disk import hours later that reports
# a media type and nothing about where it came from.
media_type="$(docker manifest inspect -v "${opts.image}" \\
	| sed -n 's/.*"mediaType": "\\(application\\/vnd[^"]*\\)".*/\\1/p' | head -1)"
echo "pushed manifest media type: \${media_type}"
case "\${media_type}" in
	*index*|*manifest.list*)
		echo "the pushed manifest is an image INDEX, which the ACA disk importer cannot consume" >&2
		exit 1
		;;
esac
`;
}

/** ACR task YAML wrapping {@link buildScript} in one `cmd` step. */
export function taskYaml(opts: {
	builderImage: string;
	script: string;
}): string {
	// A `cmd` step accepts docker-run parameters, and acr-builder mounts
	// /var/run/docker.sock into its own steps — which is what lets a step shell
	// out to `devcontainer build` at all. `az acr build` cannot do this: it
	// builds a single Dockerfile, and this needs the CLI.
	const b64 = Buffer.from(opts.script, "utf8").toString("base64");
	return `version: v1.1.0
steps:
  - cmd: ${opts.builderImage}
    entryPoint: /bin/sh
    args: ["-c", "echo ${b64} | base64 -d > /tmp/build.sh && sh /tmp/build.sh"]
    env:
      - GH_TOKEN={{.Values.ghToken}}
      - COMPOSED_DEVCONTAINER={{.Values.composed}}
      - FINALIZE_DOCKERFILE={{.Values.finalize}}
    timeout: {{.Values.stepTimeout}}
`;
}

/**
 * Keeps a failure report useful without relaying repository-controlled output
 * wholesale. That build ran with unrestricted egress over content the
 * repository author chose; the full log is for `az acr task logs`, behind
 * Azure's own authorization, not for a Linear comment.
 */
export function buildLogTail(log: string, maxChars = 2000): string {
	const trimmed = log.trimEnd();
	if (trimmed.length <= maxChars) return trimmed;
	return `…(truncated)\n${trimmed.slice(-maxChars)}`;
}

export class AcrDevcontainerBuilder {
	private readonly apiVersion: string;
	private readonly pollMs: number;
	private readonly timeoutSeconds: number;
	private readonly builderImage: string;
	private readonly cliVersion: string;
	private readonly imageRepository: string;

	constructor(
		private readonly cfg: AcrBuilderConfig,
		private readonly arm: ArmRequestFn,
		private readonly logger: ILogger,
		private readonly sleepFn: (ms: number) => Promise<void> = (ms) =>
			new Promise((r) => setTimeout(r, ms)),
	) {
		this.apiVersion = cfg.apiVersion ?? "2019-06-01-preview";
		this.pollMs = cfg.pollMs ?? 15_000;
		this.timeoutSeconds = cfg.timeoutSeconds ?? 5_400;
		this.builderImage = cfg.builderImage ?? "docker:27-cli";
		this.cliVersion = cfg.devcontainerCliVersion ?? "0.89.0";
		this.imageRepository = cfg.imageRepository ?? "cyrus/devcontainers";
	}

	/** Fully-qualified image reference a build with this tag will push to. */
	imageRef(tag: string): string {
		return `${this.cfg.loginServer}/${this.imageRepository}:${tag}`;
	}

	private get registryUrl(): string {
		return `https://management.azure.com/subscriptions/${this.cfg.subscriptionId}/resourceGroups/${this.cfg.resourceGroup}/providers/Microsoft.ContainerRegistry/registries/${this.cfg.registry}`;
	}

	async build(
		req: DevcontainerBuildRequest,
		ghToken: string,
	): Promise<DevcontainerBuildResult> {
		const image = this.imageRef(req.tag);
		const composed = composeDevcontainer(req.file.config, req);
		const script = buildScript({
			slug: req.githubSlug,
			ref: req.ref,
			configPath: req.file.path,
			image,
			cliVersion: this.cliVersion,
		});
		const body = {
			type: "EncodedTaskRunRequest",
			encodedTaskContent: Buffer.from(
				taskYaml({ builderImage: this.builderImage, script }),
				"utf8",
			).toString("base64"),
			platform: { os: "Linux", architecture: "amd64" },
			agentConfiguration: { cpu: this.cfg.agentCpu ?? 2 },
			timeout: this.timeoutSeconds,
			values: [
				{ name: "ghToken", value: ghToken, isSecret: true },
				{
					name: "composed",
					value: Buffer.from(
						JSON.stringify(composed, null, 2),
						"utf8",
					).toString("base64"),
					isSecret: false,
				},
				{
					name: "finalize",
					value: Buffer.from(
						finalizeDockerfile(req.workerUser, req.file.config.containerEnv),
						"utf8",
					).toString("base64"),
					isSecret: false,
				},
				{
					name: "stepTimeout",
					value: String(this.timeoutSeconds),
					isSecret: false,
				},
			],
		};

		const scheduled = await this.arm(
			"POST",
			`${this.registryUrl}/scheduleRun?api-version=${this.apiVersion}`,
			body,
		);
		if (scheduled.status < 200 || scheduled.status >= 300) {
			throw new Error(
				`ACR scheduleRun returned HTTP ${scheduled.status}: ${buildLogTail(scheduled.text, 500)}`,
			);
		}
		const runId = (scheduled.json as { name?: string } | null)?.name;
		if (!runId) {
			throw new Error("ACR scheduleRun returned no run id");
		}
		this.logger.info(
			`Started ACR run ${runId} to build ${req.repositoryName}'s devcontainer as ${image}`,
		);

		const status = await this.waitForRun(runId);
		if (status === "Succeeded") return { runId, status, image };
		return { runId, status, logTail: await this.tailLog(runId) };
	}

	private async waitForRun(runId: string): Promise<AcrRunStatus> {
		const deadline = Date.now() + (this.timeoutSeconds + 300) * 1000;
		let last = "Queued";
		while (Date.now() < deadline) {
			const res = await this.arm(
				"GET",
				`${this.registryUrl}/runs/${runId}?api-version=${this.apiVersion}`,
			);
			const status =
				(res.json as { properties?: { status?: string } } | null)?.properties
					?.status ?? last;
			last = status;
			if (TERMINAL.has(status)) return status as AcrRunStatus;
			await this.sleepFn(this.pollMs);
		}
		return "Timeout";
	}

	/**
	 * Best-effort. A failure to read the log must never mask the build failure
	 * it was being read to explain — the run id in the result is what an
	 * operator actually needs, and it is already in hand by this point.
	 */
	private async tailLog(runId: string): Promise<string | undefined> {
		try {
			const sas = await this.arm(
				"POST",
				`${this.registryUrl}/runs/${runId}/listLogSasUrl?api-version=${this.apiVersion}`,
			);
			const url = (sas.json as { logLink?: string } | null)?.logLink;
			if (!url) return undefined;
			const res = await fetch(url, {
				signal: AbortSignal.timeout(ARM_REQUEST_TIMEOUT_MS),
			});
			if (!res.ok) return undefined;
			return buildLogTail(await res.text());
		} catch (error) {
			this.logger.warn(`Could not read the log for ACR run ${runId}`, error);
			return undefined;
		}
	}
}

/**
 * Lazily-initialised ARM token minter.
 *
 * `@azure/identity` is imported inside the closure so a non-Azure deployment
 * never initialises Azure credential discovery, matching what the ACA data-plane
 * provider already does. Note the audience: `management.azure.com`, NOT the
 * `dynamicsessions.io` the sandbox data plane uses — swapping them yields a 401
 * that reads like a permissions problem.
 */
export function createArmTokenProvider(): () => Promise<string> {
	let credential: {
		getToken(scope: string): Promise<{ token: string } | null>;
	} | null = null;
	let cached: { token: string; expiresAt: number } | null = null;
	return async () => {
		if (cached && Date.now() < cached.expiresAt) return cached.token;
		if (!credential) {
			const mod = await import("@azure/identity");
			credential = new mod.DefaultAzureCredential();
		}
		const token = await credential.getToken(
			"https://management.azure.com/.default",
		);
		if (!token?.token) {
			throw new Error("DefaultAzureCredential returned no ARM token");
		}
		// Deliberately short: this path runs a handful of times per build, so a
		// re-mint costs nothing next to getting the expiry arithmetic wrong.
		cached = { token: token.token, expiresAt: Date.now() + 30 * 60 * 1000 };
		return token.token;
	};
}

/** ARM transport backed by {@link createArmTokenProvider}, used outside tests. */
export function createArmRequestFn(
	logger: ILogger,
	getToken: () => Promise<string> = createArmTokenProvider(),
): ArmRequestFn {
	return async (method, url, body) => {
		const res = await fetch(url, {
			method,
			headers: {
				Authorization: `Bearer ${await getToken()}`,
				"Content-Type": "application/json",
			},
			// Node's `fetch` has no default deadline, and `waitForRun`'s own
			// deadline only fires BETWEEN polls — so one hung ARM call holds a
			// build slot (and the webhooks held behind it) open indefinitely.
			// Same reasoning as `AcaSandboxClient`'s `requestTimeoutMs`.
			signal: AbortSignal.timeout(ARM_REQUEST_TIMEOUT_MS),
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const text = await res.text();
		let json: unknown = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			logger.warn(`ARM ${method} ${url} returned a non-JSON body`);
		}
		return { status: res.status, json, text };
	};
}
