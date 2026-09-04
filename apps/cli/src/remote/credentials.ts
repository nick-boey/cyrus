import type { OperatorConnectionConfig } from "cyrus-core";
import { AuthorizationError, redactSecrets } from "./errors.js";

/**
 * How a remote-operator command obtains an `Authorization` header.
 *
 * The interface returns the header AND the `source` that produced it, because
 * "which credential answered" is the single most useful fact when a fleet
 * command is authorized in one shell and refused in another — an Azure CLI
 * login on a laptop and a workload identity in CI look identical from the
 * router's error alone. `source` is safe to print; the header never is.
 */
export interface OperatorCredentialProvider {
	getAuthorization(): Promise<{ header: string; source: string }>;
}

/**
 * The non-interactive Entra chain, in the order it is attempted.
 *
 * Order is federated-first: a workstation with an `az login` will also often
 * have stale `AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET` exports lying around, and
 * a CI runner has both a federated token and a managed identity. Whichever
 * comes first decides who the router sees, so the order is pinned here and
 * asserted by a test rather than left to whatever `DefaultAzureCredential`
 * happens to do this release.
 *
 * There is deliberately NO browser or device-code entry. A fleet command runs
 * unattended inside an orchestrating agent; a credential that can block on a
 * human turns a failed authentication into a hung session with no output, which
 * is strictly worse than an immediate refusal that names what to configure.
 */
export const ENTRA_CREDENTIAL_SOURCES = [
	"workload-identity",
	"managed-identity",
	"service-principal-env",
	"azure-cli",
] as const;
export type EntraCredentialSource = (typeof ENTRA_CREDENTIAL_SOURCES)[number];

/** The slice of `@azure/identity`'s `TokenCredential` this module needs. */
export interface AccessTokenSource {
	getToken(
		scopes: string | string[],
	): Promise<{ token: string } | null | undefined>;
}

/**
 * One link in the chain. `create` is lazy because constructing a credential can
 * itself throw when its environment is absent (`WorkloadIdentityCredential`
 * with no federated token file), and that is a link failing, not the chain.
 */
export interface EntraCredentialCandidate {
	source: EntraCredentialSource;
	create(): AccessTokenSource;
}

/**
 * The Entra scope for a router audience.
 *
 * Trailing slashes are stripped because an Application ID URI is commonly
 * pasted with one, and `api://cyrus-router//.default` is rejected by Entra with
 * an error that does not mention the extra slash.
 */
export function entraScopeFor(audience: string): string {
	return `${audience.replace(/\/+$/, "")}/.default`;
}

/**
 * Builds the default chain against `@azure/identity`.
 *
 * The import is dynamic so that `cyrus connection` with local auth — and every
 * non-remote command in the same binary — never pays to load the Azure SDK.
 */
export function createDefaultEntraChain(
	tenantId: string,
): EntraCredentialCandidate[] {
	return [
		{
			source: "workload-identity",
			create: () =>
				lazyAzureCredential("WorkloadIdentityCredential", { tenantId }),
		},
		{
			source: "managed-identity",
			create: () => lazyAzureCredential("ManagedIdentityCredential", undefined),
		},
		{
			source: "service-principal-env",
			create: () => lazyAzureCredential("EnvironmentCredential", undefined),
		},
		{
			source: "azure-cli",
			create: () => lazyAzureCredential("AzureCliCredential", { tenantId }),
		},
	];
}

/**
 * Defers both the `@azure/identity` import and the constructor call to the
 * first `getToken`, so a chain can be built (and its order asserted) without
 * touching the SDK or the ambient environment.
 */
function lazyAzureCredential(
	className:
		| "WorkloadIdentityCredential"
		| "ManagedIdentityCredential"
		| "EnvironmentCredential"
		| "AzureCliCredential",
	options: Record<string, unknown> | undefined,
): AccessTokenSource {
	return {
		async getToken(scopes) {
			const identity = await import("@azure/identity");
			const Credential = identity[className] as new (
				options?: Record<string, unknown>,
			) => AccessTokenSource;
			const credential = options ? new Credential(options) : new Credential();
			return credential.getToken(scopes);
		},
	};
}

/**
 * Reads a local operator token out of a named environment variable.
 *
 * Read at REQUEST time, never cached in the provider: an operator who rotates
 * `cyrus router operators create-token` and re-exports the variable expects the
 * next command to use the new token, and a long-running orchestrator holding
 * the old one would keep presenting a revoked credential.
 */
export class LocalTokenCredentialProvider
	implements OperatorCredentialProvider
{
	constructor(
		private readonly tokenEnv: string,
		private readonly env: NodeJS.ProcessEnv = process.env,
	) {}

	async getAuthorization(): Promise<{ header: string; source: string }> {
		const token = this.env[this.tokenEnv]?.trim();
		if (!token) {
			// Names the variable, never its value — an env var that is set to
			// something wrong is reported the same way as one that is unset,
			// because printing "what we found" here is printing the credential.
			throw new AuthorizationError(
				`Environment variable ${this.tokenEnv} is not set. ` +
					"Export the token from `cyrus router operators create-token` before running fleet commands.",
			);
		}
		return { header: `Bearer ${token}`, source: `env:${this.tokenEnv}` };
	}
}

/**
 * Acquires an Entra access token for the router's audience.
 *
 * A token is requested on EVERY call rather than cached here. Each
 * `@azure/identity` credential maintains its own expiry-aware cache, so the
 * repeat cost is near zero — while a cache of our own would have to reimplement
 * expiry, and a stale token surfaces as an unexplained 401 mid-workflow.
 *
 * The credential that succeeded IS remembered, so a chain whose first two links
 * fail does not re-probe them on every request; the full chain is retried if
 * the remembered one later stops working.
 */
export class EntraCredentialProvider implements OperatorCredentialProvider {
	private readonly chain: EntraCredentialCandidate[];
	private readonly scope: string;
	private preferred?: EntraCredentialCandidate;

	constructor(options: {
		tenantId: string;
		audience: string;
		chain?: EntraCredentialCandidate[];
	}) {
		this.chain = options.chain ?? createDefaultEntraChain(options.tenantId);
		this.scope = entraScopeFor(options.audience);
	}

	async getAuthorization(): Promise<{ header: string; source: string }> {
		const order = this.preferred
			? [this.preferred, ...this.chain.filter((c) => c !== this.preferred)]
			: this.chain;

		const failures: string[] = [];
		for (const candidate of order) {
			try {
				const result = await candidate.create().getToken(this.scope);
				const token = result?.token;
				if (!token) {
					failures.push(`${candidate.source}: no token returned`);
					continue;
				}
				this.preferred = candidate;
				return { header: `Bearer ${token}`, source: candidate.source };
			} catch (error) {
				failures.push(`${candidate.source}: ${describe(error)}`);
			}
		}

		this.preferred = undefined;
		throw new AuthorizationError(
			`Could not acquire an Entra token for ${this.scope}. Tried, in order: ` +
				`${failures.join("; ")}.`,
		);
	}
}

/** Builds the provider a stored connection's auth block calls for. */
export function createCredentialProvider(
	connection: OperatorConnectionConfig,
	options: {
		env?: NodeJS.ProcessEnv;
		entraChain?: EntraCredentialCandidate[];
	} = {},
): OperatorCredentialProvider {
	if (connection.auth.kind === "local") {
		return new LocalTokenCredentialProvider(
			connection.auth.tokenEnv,
			options.env ?? process.env,
		);
	}
	return new EntraCredentialProvider({
		tenantId: connection.auth.tenantId,
		audience: connection.auth.audience,
		chain: options.entraChain,
	});
}

function describe(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	// One line: an Azure credential failure can carry a multi-paragraph
	// remediation blob, and four of them concatenated is unreadable. Redacted
	// because a failing credential's message sometimes quotes the material it
	// was handed — a malformed federated assertion is still an assertion.
	return redactSecrets(message).split("\n")[0]?.trim() || "unavailable";
}
