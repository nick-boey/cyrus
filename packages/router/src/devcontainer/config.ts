import { createHash } from "node:crypto";
import { DEVCONTAINER_PATHS, parseJsonc } from "cyrus-core";

export { DEVCONTAINER_PATHS, parseJsonc };

/**
 * Task 1 (NOR-309): reading a registered repository's devcontainer and turning
 * it into the key that decides whether an image has to be built.
 *
 * Everything here is a pure read plus a hash. Nothing in this module talks to a
 * registry, a builder, or Azure — deciding what the sandbox *is* costs one
 * GitHub API call and no sandbox, which is the whole reason the decision lives
 * on the router.
 */

/** The subset of the spec Cyrus honours. Everything else is ignored or rejected. */
export interface DevcontainerConfig {
	name?: string;
	image?: string;
	build?: {
		dockerfile?: string;
		context?: string;
		args?: Record<string, string>;
	};
	dockerFile?: string;
	features?: Record<string, unknown>;
	containerEnv?: Record<string, string>;
	postCreateCommand?: string | string[];
	dockerComposeFile?: string | string[];
	[key: string]: unknown;
}

export interface DevcontainerFile {
	/** Which of {@link DEVCONTAINER_PATHS} it was found at. */
	path: string;
	/** Verbatim file bytes as text. The cache key hashes THIS, not the parse. */
	raw: string;
	config: DevcontainerConfig;
}

/** Why a devcontainer file cannot be used. Surfaced verbatim to an operator. */
export type DevcontainerRejection = { reason: string };

/**
 * Rejects what we cannot honour, loudly, rather than half-working.
 *
 * Called at repository registration AND again before a build, because the file
 * can change between the two and only one of those moments has a human looking
 * at a form.
 */
export function validateDevcontainer(
	config: DevcontainerConfig,
): DevcontainerRejection | undefined {
	if (config.dockerComposeFile !== undefined) {
		return {
			reason:
				"This devcontainer uses `dockerComposeFile`, which Cyrus cannot run: a Compose devcontainer is several containers, and a Cyrus sandbox is one, with no Docker daemon inside it. Remove it, or use `image`/`build` instead.",
		};
	}
	const hasImage = typeof config.image === "string" && config.image.length > 0;
	const hasBuild =
		typeof config.dockerFile === "string" ||
		(typeof config.build === "object" &&
			config.build !== null &&
			typeof config.build.dockerfile === "string");
	if (!hasImage && !hasBuild) {
		return {
			reason:
				"This devcontainer declares neither `image` nor `build.dockerfile`, so there is nothing to build from.",
		};
	}
	if (hasImage && hasBuild) {
		return {
			reason:
				"This devcontainer declares both `image` and `build`, which the spec does not allow. Keep one.",
		};
	}
	return undefined;
}

/** Fields Cyrus reads. Everything else is silently ignored — see the plan. */
export const HONOURED_FIELDS = [
	"image",
	"build",
	"dockerFile",
	"features",
	"containerEnv",
	"postCreateCommand",
	"overrideFeatureInstallOrder",
] as const;

/** Fields a repository author may reasonably expect to work, that do not. */
export const IGNORED_FIELDS = [
	"mounts",
	"forwardPorts",
	"customizations",
	"onCreateCommand",
	"updateContentCommand",
	"postStartCommand",
	"postAttachCommand",
	"remoteUser",
	"containerUser",
] as const;

/** Ignored fields this file actually uses, for the operator-facing warning. */
export function ignoredFieldsIn(config: DevcontainerConfig): string[] {
	return IGNORED_FIELDS.filter((field) => config[field] !== undefined);
}

/**
 * What one built image is a function of.
 *
 * The worker feature's version is in here because the worker rides on top of
 * every repository image: bumping it must invalidate every cached build, or a
 * deployment would keep booting repositories on a worker it has since replaced.
 */
export interface CacheKeyInputs {
	/** Registered repository name — two repos with identical files still differ. */
	repositoryName: string;
	/** Verbatim devcontainer file bytes. */
	raw: string;
	/** Path it was found at: moving the same bytes is a different configuration. */
	path: string;
	/** Version of the `cyrus-worker` Feature the build will graft on. */
	workerFeatureVersion: string;
	/** The worker payload the feature installs, e.g. a tarball URL or a digest. */
	workerPayload: string;
}

/**
 * Content hash of everything the built image depends on.
 *
 * Length is not trimmed here — {@link diskNameFor} does the trimming, because
 * only it knows the 63-character label budget.
 */
export function devcontainerCacheKey(inputs: CacheKeyInputs): string {
	// A length-prefixed join, not a delimiter: no field can impersonate the
	// start of the next one, so two different inputs can never hash the same.
	const parts = [
		inputs.repositoryName,
		inputs.path,
		inputs.raw,
		inputs.workerFeatureVersion,
		inputs.workerPayload,
	];
	const canonical = parts.map((p) => `${p.length}:${p}`).join("");
	return createHash("sha256").update(canonical).digest("hex");
}

/**
 * ACA label values are capped at 63 characters, and the disk name IS the
 * `cyrus.disk` label value — while a registered repository name may itself be
 * up to 64. The name is therefore a derived digest rather than a readable
 * composition; full identity is recoverable from the `issue_disk_images` /
 * `repo_disk_images` rows, which is also what the GC reads.
 *
 * A short human prefix survives so `aca sandboxgroup disk list` is not a wall of
 * hex, but it is truncated hard and is NOT relied on for identity.
 */
export function diskNameFor(repositoryName: string, cacheKey: string): string {
	const slug = repositoryName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 20);
	const name = `cyrus-${slug || "repo"}-${cacheKey.slice(0, 32)}`;
	// 6 + 20 + 1 + 1 + 32 = 60 at the maximum, comfortably inside 63. Asserted
	// rather than assumed: a later edit to the prefix must fail here, not in ACA.
	if (name.length > 63) {
		throw new Error(`derived disk name exceeds 63 characters: ${name}`);
	}
	return name;
}

/** Everything {@link fetchDevcontainer} needs, injectable for tests. */
export interface DevcontainerFetchDeps {
	/** Router-level GitHub credential with read access to registered repositories. */
	token: string;
	/** Injectable for tests; defaults to global `fetch`. */
	fetchFn?: typeof fetch;
	apiBaseUrl?: string;
}

/**
 * Reads the repository's devcontainer file over the GitHub contents API.
 *
 * Re-read on every issue creation with no TTL: one API call against a build
 * that costs minutes is not worth a staleness window.
 *
 * Returns `undefined` when the repository declares no devcontainer — the
 * overwhelmingly common case, and the one that must stay cheap.
 */
export async function fetchDevcontainer(
	slug: string,
	ref: string,
	deps: DevcontainerFetchDeps,
): Promise<DevcontainerFile | undefined> {
	const doFetch = deps.fetchFn ?? fetch;
	const base = deps.apiBaseUrl ?? "https://api.github.com";
	for (const path of DEVCONTAINER_PATHS) {
		const url = `${base}/repos/${slug}/contents/${path}?ref=${encodeURIComponent(ref)}`;
		const res = await doFetch(url, {
			headers: {
				Authorization: `Bearer ${deps.token}`,
				Accept: "application/vnd.github.raw+json",
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": "cyrus-router",
			},
		});
		if (res.status === 404) continue;
		if (!res.ok) {
			throw new Error(
				`GitHub returned ${res.status} reading ${path} from ${slug}@${ref}`,
			);
		}
		const raw = await res.text();
		let config: DevcontainerConfig;
		try {
			const parsed = parseJsonc(raw);
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				Array.isArray(parsed)
			) {
				throw new Error("top-level value is not an object");
			}
			config = parsed as DevcontainerConfig;
		} catch (error) {
			throw new Error(
				`${slug}@${ref}:${path} is not valid devcontainer JSON: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		return { path, raw, config };
	}
	return undefined;
}
