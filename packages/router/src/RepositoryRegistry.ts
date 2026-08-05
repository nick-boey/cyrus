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
import { TableRepositoryRegistry } from "./TableRepositoryRegistry.js";
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
 * `put` is always conditional, never an unconditional overwrite. Passing the
 * `version` from a prior `list` makes the write fail with
 * {@link SetupConflictError} if anything changed in between, which turns two
 * concurrent setup-UI edits into a visible conflict rather than a silent
 * overwrite. Passing `undefined` is a *first* write: it succeeds only when no
 * registry exists yet, and fails with {@link SetupConflictError} the same way
 * if one is already stored — so seeding can never silently clobber a registry
 * a concurrent writer already created.
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
			// Every entry must be a well-formed RegisteredRepository, not just an
			// array — a syntactically valid file with e.g. a numeric `name` would
			// otherwise reach `toRoutable`/`matchRepositories` and throw at
			// runtime. This is the same class of corruption as unparseable JSON,
			// so it gets the same "reads as empty" treatment, per the class doc.
			for (const repo of file.repositories) {
				try {
					validateRegisteredRepository(repo);
				} catch {
					return { version: "0", repositories: [] };
				}
			}
			// A non-numeric version (tampered or legacy file) must not silently
			// pin the registry at "NaN" on the next write.
			const version =
				typeof file.version === "string" &&
				Number.isFinite(Number(file.version))
					? file.version
					: "0";
			return { version, repositories: file.repositories };
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

		// An unversioned write is a *first* write, mirroring the Table backend's
		// Insert-Entity POST: it must fail, not silently overwrite, when a
		// registry is already on disk — checked against the file's existence
		// rather than `current.version`, since a corrupt file also reads back as
		// version "0" and is still a registry someone else created.
		if (version === undefined && existsSync(this.path)) {
			throw new SetupConflictError(
				"the repository registry already exists; pass its version to overwrite it",
			);
		}

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

/**
 * Chooses the registry backend, mirroring how `SecretStoreBackend` already
 * picks between Table and file. The Table backend needs no Key Vault key —
 * unlike the secret store, the registry is plaintext.
 */
export function createRepositoryRegistry(options: {
	tableStore?: { endpoint: string; tableName?: string };
	filePath: string;
}): RepositoryRegistry {
	if (options.tableStore) {
		return new TableRepositoryRegistry({
			tableEndpoint: options.tableStore.endpoint,
			...(options.tableStore.tableName
				? { tableName: options.tableStore.tableName }
				: {}),
		});
	}
	return new FileRepositoryRegistry(options.filePath);
}

/**
 * Writes `configured` into the registry the first time it is empty, and never
 * again.
 *
 * Seed-once rather than merge is deliberate. `containers.repositories` reaches
 * the router as the `CYRUS_ROUTER_CONTAINERS_JSON` environment variable, so a
 * merge would let a redeploy silently overwrite edits made in the setup UI —
 * exactly the surprise this design exists to remove. The log line on the
 * already-seeded path is what tells an operator editing that variable and
 * seeing nothing happen why it had no effect.
 *
 * An invalid configured entry is warned about and the whole seed is skipped:
 * partially seeding would leave a registry that neither matches the config nor
 * anything a human chose.
 */
export async function seedRepositoryRegistry(
	registry: RepositoryRegistry,
	configured: readonly RegisteredRepository[],
	logger: { info(msg: string): void; warn(msg: string): void },
): Promise<{ seeded: boolean; count: number }> {
	const snapshot = await registry.list();
	if (snapshot.repositories.length > 0) {
		logger.info(
			`Repository registry already holds ${snapshot.repositories.length} repositor${
				snapshot.repositories.length === 1 ? "y" : "ies"
			}; the stored registry is authoritative and containers.repositories in router-config.json is ignored. Edit repositories at /setup/repositories.`,
		);
		return { seeded: false, count: snapshot.repositories.length };
	}
	if (configured.length === 0) return { seeded: false, count: 0 };

	for (const repo of configured) {
		try {
			validateRegisteredRepository(repo);
		} catch (error) {
			logger.warn(
				`Not seeding the repository registry: ${(error as Error).message} Fix containers.repositories in router-config.json, or add repositories at /setup/repositories.`,
			);
			return { seeded: false, count: 0 };
		}
	}

	await registry.put([...configured], snapshot.version);
	logger.info(
		`Seeded the repository registry with ${configured.length} repositor${
			configured.length === 1 ? "y" : "ies"
		} from containers.repositories. The stored registry is authoritative from now on.`,
	);
	return { seeded: true, count: configured.length };
}
