import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { RoutableRepository } from "cyrus-core";
import { SetupConflictError } from "./TableSecretStore.js";

/**
 * One repository registered against the router's Linear workspace.
 *
 * The router's own persistence shape, deliberately narrower than
 * `RepositoryConfig`: the router knows a GitHub slug, not a filesystem path,
 * because the path only exists once a sandbox has cloned it.
 */
export interface RegisteredRepository {
	/** Also the sandbox directory name and the RepositoryConfig id. */
	name: string;
	/** "owner/repo". */
	githubSlug: string;
	linearWorkspaceId: string;
	baseBranch?: string;
	teamKeys?: string[];
	projectKeys?: string[];
	routingLabels?: string[];
	/** Selected when no higher-priority routing method matches. */
	isDefault?: boolean;
}

/** A read of the registry plus the version a conditional write must quote. */
export interface RegistrySnapshot {
	repositories: RegisteredRepository[];
	/** Opaque. `"0"` on the file backend when no registry exists yet. */
	version?: string;
}

/**
 * Durable storage for the global repository registry.
 *
 * `put` is conditional: passing the `version` from a prior `list` makes the
 * write fail with {@link SetupConflictError} if anything changed in between,
 * which turns two concurrent setup-UI edits into a visible conflict rather than
 * a silent overwrite. `undefined` is an unconditional write, reserved for
 * first-run seeding.
 */
export interface RepositoryRegistry {
	list(): Promise<RegistrySnapshot>;
	put(
		repositories: RegisteredRepository[],
		version?: string,
	): Promise<{ version: string }>;
}

/**
 * Names flow into `$WORKSPACES/repos/<name>` inside a sandbox and into the
 * `RepositoryConfig.id`, so this is the same class of gate `ISSUE_KEY_RE`
 * applies in `ContainerTargets.ts` — it is what stops `..` or a slash reaching
 * a path join.
 */
export const REPOSITORY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** "owner/repo" — exactly one slash, no traversal on either side. */
export const GITHUB_SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** Throws with user-facing copy when an entry cannot be stored. */
export function validateRegisteredRepository(repo: RegisteredRepository): void {
	if (!REPOSITORY_NAME_RE.test(repo.name)) {
		throw new Error(
			`Repository name ${JSON.stringify(repo.name)} is not valid. Use letters, digits, dots, dashes, or underscores, starting with a letter or digit (max 64 characters).`,
		);
	}
	if (!GITHUB_SLUG_RE.test(repo.githubSlug)) {
		throw new Error(
			`GitHub slug ${JSON.stringify(repo.githubSlug)} must be in owner/repo form.`,
		);
	}
	if (repo.linearWorkspaceId.trim() === "") {
		throw new Error("Linear workspace id is required.");
	}
}

/**
 * Adapts a registry entry onto the matcher's `RoutableRepository`, carrying the
 * original alongside so a match maps straight back without a lookup.
 *
 * The GitHub URL is synthesised because `[repo=…]` tags are matched by URL path
 * suffix — see `matchRepositories`. Without it, a tag naming the slug's repo
 * half would only match via the name, which is usually but not always the same.
 */
export function toRoutable(
	repo: RegisteredRepository,
): RoutableRepository & { source: RegisteredRepository } {
	return {
		id: repo.name,
		name: repo.name,
		githubUrl: `https://github.com/${repo.githubSlug}`,
		...(repo.teamKeys ? { teamKeys: repo.teamKeys } : {}),
		...(repo.projectKeys ? { projectKeys: repo.projectKeys } : {}),
		...(repo.routingLabels ? { routingLabels: repo.routingLabels } : {}),
		...(repo.isDefault !== undefined ? { isDefault: repo.isDefault } : {}),
		source: repo,
	};
}

/** On-disk shape. `version` is a monotonic counter rendered as a string. */
interface RegistryFile {
	version: string;
	repositories: RegisteredRepository[];
}

/**
 * File-backed registry for local and Docker development, mirroring how
 * `secretsPath` already defaults beside the router database: mode 0600 and an
 * atomic tmp+rename, matching `FileSecretStore`.
 *
 * A corrupt file reads as empty rather than throwing — a registry that cannot
 * be parsed must not stop the router from starting, and the next write heals it.
 */
export class FileRepositoryRegistry implements RepositoryRegistry {
	constructor(private readonly path: string) {}

	private read(): RegistryFile {
		if (!existsSync(this.path)) return { version: "0", repositories: [] };
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as unknown;
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				!Array.isArray((parsed as RegistryFile).repositories)
			) {
				return { version: "0", repositories: [] };
			}
			const file = parsed as RegistryFile;
			return {
				version: typeof file.version === "string" ? file.version : "0",
				repositories: file.repositories,
			};
		} catch {
			return { version: "0", repositories: [] };
		}
	}

	async list(): Promise<RegistrySnapshot> {
		const file = this.read();
		return { repositories: file.repositories, version: file.version };
	}

	async put(
		repositories: RegisteredRepository[],
		version?: string,
	): Promise<{ version: string }> {
		// Validate the whole batch before touching disk, so a bad entry never
		// leaves the registry half-written.
		for (const repo of repositories) validateRegisteredRepository(repo);

		const current = this.read();
		if (version !== undefined && version !== current.version) {
			throw new SetupConflictError(
				`the repository registry changed since it was read (expected version ${version}, found ${current.version})`,
			);
		}

		const next: RegistryFile = {
			version: String(Number(current.version) + 1),
			repositories,
		};
		mkdirSync(dirname(this.path), { recursive: true });
		const tmpPath = `${this.path}.tmp`;
		writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, {
			mode: 0o600,
		});
		// `mode` on writeFileSync only applies on creation; force 0600 in case a
		// crash-leftover `.tmp` had looser perms.
		chmodSync(tmpPath, 0o600);
		renameSync(tmpPath, this.path);
		return { version: next.version };
	}
}
