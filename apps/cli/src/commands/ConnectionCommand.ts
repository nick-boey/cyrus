import type { OperatorConnectionConfig } from "cyrus-core";
import type {
	OperatorContextV1,
	PublicRouterMetadataV1,
} from "cyrus-operator-protocol";
import type { Application } from "../Application.js";
import {
	ConnectionStore,
	normalizeConnectionUrl,
	type OperatorConnectionRecord,
} from "../remote/ConnectionStore.js";
import {
	createCredentialProvider,
	type EntraCredentialCandidate,
} from "../remote/credentials.js";
import {
	isRemoteOperatorError,
	redactSecrets,
	UsageError,
} from "../remote/errors.js";
import {
	negotiateApiVersion,
	OperatorHttpClient,
	requireAuthMethod,
	selectWorkspace,
} from "../remote/OperatorHttpClient.js";
import { BaseCommand } from "./ICommand.js";

/** Options threaded down from the program's global flags. */
export interface ConnectionCommandContext {
	/** `--connection <name>`; falls back to the single stored connection. */
	connection?: string;
	/** `--workspace <id>`; required when a context authorizes more than one. */
	workspace?: string;
}

export interface ConnectionCommandDeps {
	fetchFn?: typeof fetch;
	env?: NodeJS.ProcessEnv;
	/** Injected so tests can drive the chain order without Azure present. */
	entraChain?: EntraCredentialCandidate[];
}

/**
 * Manages named connections to remote routers' Fleet Operations APIs:
 *
 *   cyrus connection add <name> <url> --auth entra
 *   cyrus connection add <name> <url> --auth local --token-env <ENV_NAME>
 *   cyrus connection list
 *   cyrus connection show [name]
 *   cyrus connection remove <name>
 *
 * Distinct from `cyrus connect`, which enrolls THIS DEVICE to receive its own
 * work and is unchanged. A connection here grants no authority: the router
 * authorizes every read and every mutation (ADR 0009).
 */
export class ConnectionCommand extends BaseCommand {
	private readonly store: ConnectionStore;

	constructor(
		app: Application,
		private readonly deps: ConnectionCommandDeps = {},
	) {
		super(app);
		this.store = new ConnectionStore(app.config);
	}

	/**
	 * Commander entry point. Converts the remote-operator failure vocabulary
	 * into the process exit codes ADR 0011 fixes, so an orchestrating agent can
	 * branch on the code rather than parse the prose.
	 */
	async execute(
		argv: string[],
		context: ConnectionCommandContext = {},
	): Promise<void> {
		try {
			await this.run(argv, context);
		} catch (error) {
			if (isRemoteOperatorError(error)) {
				// Redacted again at the boundary: an error built from a router
				// response body has already been summarized, but a `cause` chain
				// or a future call site may not have been.
				this.logger.error(redactSecrets(error.message));
				process.exit(error.exitCode);
				// `process.exit` does not return in production. The explicit return
				// matters anyway: a test that stubs it would otherwise fall through
				// to the rethrow below and observe the opposite of what this branch
				// does, so the assertion would be measuring the stub.
				return;
			}
			throw error;
		}
	}

	/**
	 * The command's real work, throwing rather than exiting so tests can assert
	 * the failure category instead of trapping `process.exit`.
	 */
	async run(
		argv: string[],
		context: ConnectionCommandContext = {},
	): Promise<void> {
		const [subcommand, ...rest] = argv;
		switch (subcommand) {
			case "add":
				return this.add(rest);
			case "list":
				return this.list();
			case "show":
				return this.show(rest[0] ?? context.connection, context.workspace);
			case "remove":
				return this.remove(rest[0]);
			default:
				throw new UsageError(
					"Usage: cyrus connection <add <name> <url> --auth <entra|local> [--token-env <ENV>]|list|show [name]|remove <name>>",
				);
		}
	}

	/**
	 * Verifies a connection against the live router BEFORE storing it.
	 *
	 * Discovery supplies the Entra tenant and audience, so an operator never
	 * hand-copies them out of a deployment (ADR 0010) — and a value that was
	 * never typed cannot be typed wrong. Then the credential is actually
	 * exercised against `/operator/context`, because a connection that stores
	 * cleanly and fails on first use is indistinguishable, to the operator, from
	 * a fleet that is down.
	 */
	private async add(args: string[]): Promise<void> {
		const { name, url, auth, tokenEnv } = parseAddArgs(args);

		// Both cheap checks run before any network call: a typo'd name or URL
		// should not depend on a router being reachable to be reported.
		const normalizedUrl = normalizeConnectionUrl(url);
		if (this.store.has(name)) {
			throw new UsageError(
				`A connection named "${name}" already exists. ` +
					`Remove it first with \`cyrus connection remove ${name}\`, or choose another name.`,
			);
		}

		const metadata = await new OperatorHttpClient({
			baseUrl: normalizedUrl,
			fetchFn: this.deps.fetchFn,
		}).discover();
		negotiateApiVersion(metadata);

		const connection = this.buildConnection(
			normalizedUrl,
			auth,
			tokenEnv,
			metadata,
		);

		const { context, authSource } = await new OperatorHttpClient({
			baseUrl: normalizedUrl,
			fetchFn: this.deps.fetchFn,
			credentials: createCredentialProvider(connection, {
				env: this.deps.env,
				entraChain: this.deps.entraChain,
			}),
		}).context();

		this.store.add(name, connection);

		this.logSuccess(
			`Connection "${name}" verified against ${describeRouter(metadata)} and saved.`,
		);
		this.logger.raw(
			`Authenticated as ${context.principalId} via ${authSource}`,
		);
		this.logger.raw(`Roles: ${context.roles.join(", ")}`);
		this.logger.raw(
			`Workspaces: ${context.authorizedWorkspaces
				.map(formatWorkspace)
				.join(", ")}`,
		);
	}

	/**
	 * Chooses the auth block to store, refusing anything the router will not
	 * accept. Both branches derive every value from discovery or from the
	 * operator's own environment; neither writes a credential.
	 */
	private buildConnection(
		url: string,
		auth: "entra" | "local",
		tokenEnv: string | undefined,
		metadata: PublicRouterMetadataV1,
	): OperatorConnectionConfig {
		if (auth === "entra") {
			requireAuthMethod(metadata, "entra");
			const entra = metadata.authentication.entra;
			if (!entra) {
				// The discovery schema already couples the method to the metadata,
				// so this is unreachable through a valid document — but a narrow
				// type here beats a non-null assertion that would silently store
				// `undefined` if that coupling were ever relaxed.
				throw new UsageError(
					`Router ${metadata.routerId} offers Entra authentication but published no tenant or audience.`,
				);
			}
			return {
				url,
				auth: {
					kind: "entra",
					tenantId: entra.tenantId,
					audience: entra.audience,
				},
			};
		}

		requireAuthMethod(metadata, "local-operator-token");
		if (!tokenEnv) {
			throw new UsageError(
				"`--auth local` requires --token-env <ENV_NAME>, naming the environment variable that holds the operator token.",
			);
		}
		return { url, auth: { kind: "local", tokenEnv } };
	}

	/**
	 * Lists stored connections without touching the network — this is what an
	 * operator runs to find out what `--connection` accepts, and it must work
	 * when every router is unreachable.
	 */
	private list(): void {
		const records = this.store.list();
		if (records.length === 0) {
			this.logger.raw(
				"No router connections configured. Add one with `cyrus connection add <name> <url> --auth entra`.",
			);
			return;
		}
		for (const record of records) {
			this.logger.raw(
				`${record.name}\t${record.connection.url}\t${describeAuth(record)}`,
			);
		}
		if (records.length === 1) {
			this.logger.raw(
				"\nOne connection configured; fleet commands use it without --connection.",
			);
		} else {
			this.logger.raw(
				"\nMultiple connections configured; fleet commands require --connection <name>.",
			);
		}
	}

	/**
	 * Reports what a connection actually grants, as the router reports it.
	 *
	 * Everything here comes from the live context document rather than from
	 * config.json: what was authorized at `connection add` is not what is
	 * authorized now, and a grant that has been revoked is the thing an operator
	 * most needs this command to show them.
	 */
	private async show(
		name: string | undefined,
		workspace: string | undefined,
	): Promise<void> {
		const record = this.store.select(name);
		const client = new OperatorHttpClient({
			baseUrl: record.connection.url,
			fetchFn: this.deps.fetchFn,
			credentials: createCredentialProvider(record.connection, {
				env: this.deps.env,
				entraChain: this.deps.entraChain,
			}),
		});

		const metadata = await client.discover();
		const apiVersion = negotiateApiVersion(metadata);
		const { context, authSource } = await client.context();

		this.logger.raw(`Connection:      ${record.name}`);
		this.logger.raw(`Router:          ${describeRouter(metadata)}`);
		this.logger.raw(`URL:             ${record.connection.url}`);
		this.logger.raw(`Operator API:    ${apiVersion}`);
		// The auth block holds no secret by construction, so it is printed whole
		// — `tokenEnv` is a variable NAME. Its VALUE is never read here.
		this.logger.raw(
			`Auth:            ${describeAuth(record)} (source: ${authSource})`,
		);
		this.logger.raw(`Principal:       ${context.principalId}`);
		this.logger.raw(`Roles:           ${context.roles.join(", ")}`);
		this.logger.raw(
			`Capabilities:    ${context.capabilities.join(", ") || "none"}`,
		);
		this.logger.raw(
			`Workspaces:      ${context.authorizedWorkspaces.map(formatWorkspace).join(", ")}`,
		);
		this.logger.raw(`Log source:      ${describeLogSource(context)}`);
		this.logger.raw(`Operator skill:  ${describeSkill(context)}`);

		if (workspace !== undefined) {
			// Resolved through the same rule the fleet commands use, so an
			// ambiguous or unauthorized `--workspace` is reported here rather
			// than first surfacing inside a recovery.
			const selected = selectWorkspace(context, workspace);
			this.logger.raw(`Selected:        ${formatWorkspace(selected)}`);
		}
	}

	private remove(name: string | undefined): void {
		if (!name) {
			throw new UsageError("Usage: cyrus connection remove <name>");
		}
		this.store.remove(name);
		this.logSuccess(`Removed connection "${name}".`);
	}
}

function parseAddArgs(args: string[]): {
	name: string;
	url: string;
	auth: "entra" | "local";
	tokenEnv?: string;
} {
	const positional: string[] = [];
	let auth: string | undefined;
	let tokenEnv: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg) continue;
		if (arg === "--auth" && args[i + 1]) {
			auth = args[++i];
		} else if (arg === "--token-env" && args[i + 1]) {
			tokenEnv = args[++i];
		} else if (arg.startsWith("-")) {
			throw new UsageError(`Unknown option: ${arg}`);
		} else {
			positional.push(arg);
		}
	}

	const [name, url, ...extra] = positional;
	if (!name || !url || extra.length > 0) {
		throw new UsageError(
			"Usage: cyrus connection add <name> <url> --auth <entra|local> [--token-env <ENV_NAME>]",
		);
	}
	if (auth !== "entra" && auth !== "local") {
		throw new UsageError(
			`--auth must be "entra" or "local"${auth ? `, not "${auth}"` : ""}.`,
		);
	}
	if (auth === "entra" && tokenEnv) {
		// Refused rather than ignored: storing an entra connection while the
		// operator believes a token env var is in play is a silent divergence
		// that only shows up as an unexplained 401 much later.
		throw new UsageError(
			"--token-env applies only to `--auth local`; an Entra connection acquires its own token.",
		);
	}
	if (auth === "local" && !tokenEnv) {
		throw new UsageError(
			"`--auth local` requires --token-env <ENV_NAME>, naming the environment variable that holds the operator token.",
		);
	}
	return { name, url, auth, tokenEnv };
}

function describeRouter(metadata: PublicRouterMetadataV1): string {
	return metadata.routerName
		? `${metadata.routerName} (${metadata.routerId})`
		: metadata.routerId;
}

function describeAuth(record: OperatorConnectionRecord): string {
	const auth = record.connection.auth;
	return auth.kind === "entra"
		? `entra tenant=${auth.tenantId} audience=${auth.audience}`
		: `local token-env=${auth.tokenEnv}`;
}

function formatWorkspace(workspace: {
	workspaceId: string;
	name?: string;
}): string {
	return workspace.name
		? `${workspace.name} (${workspace.workspaceId})`
		: workspace.workspaceId;
}

function describeLogSource(context: OperatorContextV1): string {
	const source = context.logSource;
	if (!source) return "none (this connection cannot query logs)";
	const label = source.displayName ? ` "${source.displayName}"` : "";
	return `${source.kind}${label}`;
}

function describeSkill(context: OperatorContextV1): string {
	const skill = context.skill;
	if (!skill) return "none advertised";
	// The checksum is printed because it is what the CLI verifies the published
	// skill against — advertising is not trust (ADR 0010), and an operator
	// comparing it by eye is doing the same check for the same reason.
	return `${skill.name} ${skill.version} (${skill.checksum})`;
}
