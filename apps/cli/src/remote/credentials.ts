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

	/**
	 * Discards the credential just returned and reports whether another one
	 * exists, so a caller that was REFUSED (401/403) can try the next link
	 * rather than treating the chain as exhausted.
	 *
	 * Minting a token successfully and being authorized to use it are different
	 * questions, and only the router can answer the second. Without this, the
	 * first credential the environment happens to produce is final: an
	 * unattended host holding an ungranted managed identity alongside a granted
	 * service principal dead-ends on a 403 that no grant can fix — three of the
	 * four Entra links produce APP-ONLY tokens, which the router refuses outright
	 * (`OperatorAuthorizer.authenticateEntra` rejects `idtyp === "app"`), so on
	 * a router that emits that claim only `azure-cli` can ever succeed. Falling
	 * through makes that self-healing instead of a support ticket.
	 *
	 * Optional: a provider with exactly one credential returns `false` (or omits
	 * the method), and the caller reports the refusal as final.
	 */
	rejectAndAdvance?(source: string): boolean;
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

/**
 * Ceiling on ONE credential acquisition. Node's `fetch` has no default timeout
 * and neither does an IMDS probe on a host that silently drops the packets.
 */
const DEFAULT_ACQUIRE_TIMEOUT_MS = 15_000;

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
 *
 * A link the ROUTER refused is remembered too, via {@link rejectAndAdvance} —
 * minting a token and being allowed to use it are different questions, and only
 * the router can answer the second.
 */
export class EntraCredentialProvider implements OperatorCredentialProvider {
	private readonly chain: EntraCredentialCandidate[];
	private readonly scope: string;
	private readonly acquireTimeoutMs: number;
	private preferred?: EntraCredentialCandidate;
	/** Sources the router refused this run; skipped rather than re-presented. */
	private readonly rejected = new Set<string>();

	constructor(options: {
		tenantId: string;
		audience: string;
		chain?: EntraCredentialCandidate[];
		acquireTimeoutMs?: number;
	}) {
		this.chain = options.chain ?? createDefaultEntraChain(options.tenantId);
		this.scope = entraScopeFor(options.audience);
		this.acquireTimeoutMs =
			options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
	}

	async getAuthorization(): Promise<{ header: string; source: string }> {
		const available = this.chain.filter(
			(candidate) => !this.rejected.has(candidate.source),
		);
		const order =
			this.preferred && available.includes(this.preferred)
				? [this.preferred, ...available.filter((c) => c !== this.preferred)]
				: available;

		const failures: string[] = [];
		for (const candidate of order) {
			try {
				const result = await this.acquire(candidate);
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
		const refused = [...this.rejected];
		throw new AuthorizationError(
			`Could not acquire an Entra token for ${this.scope}. Tried, in order: ` +
				`${failures.join("; ") || "no credential sources remained"}.` +
				(refused.length > 0
					? ` Already refused by the router: ${refused.join(", ")}.`
					: ""),
		);
	}

	/**
	 * Marks a source as refused and reports whether an untried one remains.
	 *
	 * Rejection is per-source rather than per-token: re-presenting a credential
	 * the router has already refused cannot start working within one command, and
	 * retrying it is how a bounded fallback becomes a loop.
	 */
	rejectAndAdvance(source: string): boolean {
		this.rejected.add(source);
		if (this.preferred?.source === source) this.preferred = undefined;
		return this.chain.some((candidate) => !this.rejected.has(candidate.source));
	}

	/**
	 * Bounds one credential acquisition.
	 *
	 * `ManagedIdentityCredential` on a host that blackholes 169.254.169.254 can
	 * stall far past the HTTP deadline `OperatorHttpClient` applies, which would
	 * defeat the whole reason this chain excludes interactive credentials: an
	 * orchestrating agent must get a refusal, not a hang with no output. The
	 * timeout is per LINK, so a stalled probe costs one link rather than the run.
	 */
	private async acquire(
		candidate: EntraCredentialCandidate,
	): Promise<{ token: string } | null | undefined> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				candidate.create().getToken(this.scope),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(
						() =>
							reject(
								new Error(
									`timed out after ${this.acquireTimeoutMs}ms (no response from the credential endpoint)`,
								),
							),
						this.acquireTimeoutMs,
					);
				}),
			]);
		} finally {
			// Without this the timer keeps the event loop alive after a fast
			// success, and a one-shot CLI command hangs for the full timeout
			// before exiting.
			if (timer) clearTimeout(timer);
		}
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
