/**
 * ACA Sandboxes data-plane token audience.
 *
 * The audience looks like it points at the unrelated "dynamic sessions"
 * product line — that is correct and intentional. The Container Apps
 * Sandboxes data plane is a successor to Azure Dynamic Sessions, and the
 * Entra resource URI kept the dynamicsessions.io lineage. Requesting
 * a token for `https://management.azure.com/.default` (the control-plane
 * audience) yields a 401 from the data plane, not a 403.
 *
 * @see docs/superpowers/specs/2026-07-25-aca-sandboxes-spike-findings.md (S2)
 */
export const ACA_TOKEN_AUDIENCE = "https://dynamicsessions.io/.default";

/**
 * Build a lazily-initialized Entra token provider for the ACA Sandboxes
 * data plane.
 *
 * `@azure/identity` is imported INSIDE the returned closure so that:
 *  - module load of consumers stays synchronous, and
 *  - non-Azure deployments never initialize `@azure/identity`.
 *
 * The returned function caches the bearer token and refreshes ~5 min
 * before its expiry so a hot router loop never blocks on Entra.
 */
export function createDefaultTokenProvider(opts?: {
	credentialOptions?: Record<string, unknown>;
}): () => Promise<string> {
	let cachedToken: string | null = null;
	let cachedExpiresAt = 0;
	// Lazily constructed on first use; reused across refreshes.
	// `any` is fine here — the SDK shape is consumed in a tiny surface and
	// we want this package to compile without `@azure/identity` installed.
	let credential: any = null;

	return async () => {
		const now = Date.now();
		const refreshBufferMs = 5 * 60 * 1000;
		if (cachedToken && now < cachedExpiresAt - refreshBufferMs) {
			return cachedToken;
		}
		if (!credential) {
			// The dynamic import keeps module load synchronous and avoids
			// initializing Azure credential discovery outside ACA deployments.
			const mod: any = await import("@azure/identity");
			const Ctor = mod.DefaultAzureCredential;
			credential = new Ctor(opts?.credentialOptions);
		}
		const token = await credential.getToken(ACA_TOKEN_AUDIENCE);
		cachedToken = token?.token ?? null;
		if (!cachedToken) {
			throw new Error("DefaultAzureCredential returned no access token");
		}
		cachedExpiresAt = token?.expiresOnTimestamp ?? Date.now() + 60 * 60 * 1000;
		return cachedToken;
	};
}
