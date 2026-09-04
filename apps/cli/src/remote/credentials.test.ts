import { describe, expect, it, vi } from "vitest";
import {
	createCredentialProvider,
	createDefaultEntraChain,
	ENTRA_CREDENTIAL_SOURCES,
	type EntraCredentialCandidate,
	EntraCredentialProvider,
	entraScopeFor,
	LocalTokenCredentialProvider,
} from "./credentials.js";
import { AuthorizationError, EXIT_AUTH } from "./errors.js";

/**
 * A credential chain link that records every scope it was asked for, so the
 * ORDER and the SCOPE can both be asserted without Azure being present.
 */
function candidate(
	source: (typeof ENTRA_CREDENTIAL_SOURCES)[number],
	behaviour:
		| { token: string }
		| { throws: string }
		| { returns: null }
		| { returnsEmpty: true },
): EntraCredentialCandidate & { calls: string[] } {
	const calls: string[] = [];
	return {
		source,
		calls,
		create: () => ({
			async getToken(scopes) {
				calls.push(String(scopes));
				if ("throws" in behaviour) throw new Error(behaviour.throws);
				if ("returns" in behaviour) return null;
				if ("returnsEmpty" in behaviour) return { token: "" };
				return { token: behaviour.token };
			},
		}),
	};
}

describe("LocalTokenCredentialProvider", () => {
	it("reads the named environment variable and reports its name as the source", async () => {
		const env = { CYRUS_OPERATOR_TOKEN: "cyop_abc123" };

		const result = await new LocalTokenCredentialProvider(
			"CYRUS_OPERATOR_TOKEN",
			env,
		).getAuthorization();

		expect(result).toEqual({
			header: "Bearer cyop_abc123",
			source: "env:CYRUS_OPERATOR_TOKEN",
		});
	});

	it("re-reads the variable on every request so a rotated token takes effect", async () => {
		// A long-running orchestrator that cached the first value would keep
		// presenting a revoked token after `cyrus router operators revoke`.
		const env: NodeJS.ProcessEnv = { TOKEN: "cyop_first" };
		const provider = new LocalTokenCredentialProvider("TOKEN", env);

		const before = await provider.getAuthorization();
		env.TOKEN = "cyop_second";
		const after = await provider.getAuthorization();

		expect(before.header).toBe("Bearer cyop_first");
		expect(after.header).toBe("Bearer cyop_second");
	});

	it("fails as an authorization error naming the variable when it is unset", async () => {
		const provider = new LocalTokenCredentialProvider("MISSING_TOKEN", {});

		const error = await provider.getAuthorization().catch((e) => e);

		expect(error).toBeInstanceOf(AuthorizationError);
		expect(error.exitCode).toBe(EXIT_AUTH);
		expect(error.message).toContain("MISSING_TOKEN");
	});

	it("treats a whitespace-only value as unset", async () => {
		const provider = new LocalTokenCredentialProvider("TOKEN", {
			TOKEN: "   \n",
		});

		await expect(provider.getAuthorization()).rejects.toBeInstanceOf(
			AuthorizationError,
		);
	});

	it("never puts the token value in an error message", async () => {
		// A value that is set but rejected downstream must not be echoed here;
		// the only safe thing to print about a credential is where it came from.
		const provider = new LocalTokenCredentialProvider("TOKEN", { TOKEN: "  " });

		const error = await provider.getAuthorization().catch((e) => e);

		expect(error.message).not.toContain("  ");
		expect(error.message).toContain("TOKEN");
	});
});

describe("EntraCredentialProvider", () => {
	it("tries the chain in exactly the documented order and reports the winner", async () => {
		const workload = candidate("workload-identity", {
			throws: "no federated token",
		});
		const managed = candidate("managed-identity", {
			throws: "no IMDS endpoint",
		});
		const servicePrincipal = candidate("service-principal-env", {
			token: "sp-token",
		});
		const cli = candidate("azure-cli", { token: "cli-token" });
		const attempted: string[] = [];
		const chain = [workload, managed, servicePrincipal, cli].map((c) => ({
			...c,
			create: () => {
				attempted.push(c.source);
				return c.create();
			},
		}));

		const result = await new EntraCredentialProvider({
			tenantId: "tenant-1",
			audience: "api://cyrus-router",
			chain,
		}).getAuthorization();

		expect(attempted).toEqual([
			"workload-identity",
			"managed-identity",
			"service-principal-env",
		]);
		expect(result).toEqual({
			header: "Bearer sp-token",
			source: "service-principal-env",
		});
	});

	it("requests the audience's /.default scope", async () => {
		const cli = candidate("azure-cli", { token: "t" });

		await new EntraCredentialProvider({
			tenantId: "tenant-1",
			audience: "api://cyrus-router",
			chain: [cli],
		}).getAuthorization();

		expect(cli.calls).toEqual(["api://cyrus-router/.default"]);
	});

	it("acquires a token on every request rather than caching one itself", async () => {
		// Each @azure/identity credential owns an expiry-aware cache; a cache of
		// ours would have to reimplement expiry, and a stale token surfaces as an
		// unexplained 401 mid-workflow.
		const cli = candidate("azure-cli", { token: "t" });
		const provider = new EntraCredentialProvider({
			tenantId: "tenant-1",
			audience: "api://cyrus-router",
			chain: [cli],
		});

		await provider.getAuthorization();
		await provider.getAuthorization();

		expect(cli.calls).toHaveLength(2);
	});

	it("remembers the credential that worked instead of re-probing failures", async () => {
		const workload = candidate("workload-identity", { throws: "unavailable" });
		const cli = candidate("azure-cli", { token: "t" });
		const provider = new EntraCredentialProvider({
			tenantId: "tenant-1",
			audience: "api://cyrus-router",
			chain: [workload, cli],
		});

		await provider.getAuthorization();
		await provider.getAuthorization();

		expect(workload.calls).toHaveLength(1);
		expect(cli.calls).toHaveLength(2);
	});

	it("treats a credential that returns no token as a failed link, not a success", async () => {
		const managed = candidate("managed-identity", { returns: null });
		const empty = candidate("service-principal-env", { returnsEmpty: true });
		const cli = candidate("azure-cli", { token: "t" });

		const result = await new EntraCredentialProvider({
			tenantId: "tenant-1",
			audience: "api://cyrus-router",
			chain: [managed, empty, cli],
		}).getAuthorization();

		expect(result.source).toBe("azure-cli");
	});

	it("reports every source it tried, and no token material, when all fail", async () => {
		const provider = new EntraCredentialProvider({
			tenantId: "tenant-1",
			audience: "api://cyrus-router",
			chain: [
				candidate("workload-identity", { throws: "no federated token file" }),
				candidate("azure-cli", {
					throws: "Please run 'az login'\nmore detail here",
				}),
			],
		});

		const error = await provider.getAuthorization().catch((e) => e);

		expect(error).toBeInstanceOf(AuthorizationError);
		expect(error.message).toContain("workload-identity");
		expect(error.message).toContain("azure-cli");
		expect(error.message).toContain("api://cyrus-router/.default");
		// Multi-paragraph Azure remediation blobs are collapsed to one line each.
		expect(error.message).not.toContain("more detail here");
	});

	it("redacts a token echoed by a failing credential's own message", async () => {
		const provider = new EntraCredentialProvider({
			tenantId: "tenant-1",
			audience: "api://cyrus-router",
			chain: [
				candidate("azure-cli", {
					throws: "rejected assertion eyJhbGciOi.eyJzdWIi.c2lnbmF0dXJl",
				}),
			],
		});

		const error = await provider.getAuthorization().catch((e) => e);

		expect(error.message).not.toContain("eyJhbGciOi");
		expect(error.message).toContain("[redacted]");
	});
});

describe("EntraCredentialProvider.rejectAndAdvance", () => {
	it("offers the next link after the router refuses one", async () => {
		// Minting a token and being allowed to use it are different questions.
		// Three of the four links produce app-only tokens the router refuses
		// outright, so without this the first credential the environment happens
		// to produce is final.
		const managed = candidate("managed-identity", { token: "app-only-token" });
		const cli = candidate("azure-cli", { token: "user-token" });
		const provider = new EntraCredentialProvider({
			tenantId: "tenant-1",
			audience: "api://cyrus-router",
			chain: [managed, cli],
		});

		const first = await provider.getAuthorization();
		expect(first.source).toBe("managed-identity");

		expect(provider.rejectAndAdvance("managed-identity")).toBe(true);
		const second = await provider.getAuthorization();

		expect(second).toEqual({
			header: "Bearer user-token",
			source: "azure-cli",
		});
	});

	it("reports that nothing remains once every link has been refused", async () => {
		const cli = candidate("azure-cli", { token: "t" });
		const provider = new EntraCredentialProvider({
			tenantId: "tenant-1",
			audience: "api://cyrus-router",
			chain: [cli],
		});

		await provider.getAuthorization();

		expect(provider.rejectAndAdvance("azure-cli")).toBe(false);
	});

	it("never re-presents a refused source, so the fallback cannot loop", async () => {
		const managed = candidate("managed-identity", { token: "a" });
		const cli = candidate("azure-cli", { token: "b" });
		const provider = new EntraCredentialProvider({
			tenantId: "tenant-1",
			audience: "api://cyrus-router",
			chain: [managed, cli],
		});

		await provider.getAuthorization();
		provider.rejectAndAdvance("managed-identity");
		await provider.getAuthorization();
		provider.rejectAndAdvance("azure-cli");

		const error = await provider.getAuthorization().catch((e) => e);
		expect(error).toBeInstanceOf(AuthorizationError);
		expect(error.message).toContain("Already refused by the router");
		// Each was acquired exactly once; neither was offered a second time.
		expect(managed.calls).toHaveLength(1);
		expect(cli.calls).toHaveLength(1);
	});
});

describe("EntraCredentialProvider acquisition timeout", () => {
	it("gives up on a stalled credential and moves to the next link", async () => {
		// ManagedIdentityCredential on a host that blackholes 169.254.169.254
		// stalls indefinitely. An orchestrating agent must get a refusal, not a
		// hang with no output — the same reason the chain excludes interactive
		// credentials.
		const stalled: EntraCredentialCandidate = {
			source: "managed-identity",
			create: () => ({ getToken: () => new Promise(() => {}) }),
		};
		const cli = candidate("azure-cli", { token: "t" });

		const result = await new EntraCredentialProvider({
			tenantId: "tenant-1",
			audience: "api://cyrus-router",
			chain: [stalled, cli],
			acquireTimeoutMs: 20,
		}).getAuthorization();

		expect(result.source).toBe("azure-cli");
	});

	it("does not hold the event loop open after a fast success", async () => {
		// A timer left armed after the race resolves keeps a one-shot CLI command
		// alive for the full timeout before it can exit.
		const cli = candidate("azure-cli", { token: "t" });
		const before = process.getActiveResourcesInfo?.().length ?? 0;

		await new EntraCredentialProvider({
			tenantId: "tenant-1",
			audience: "api://cyrus-router",
			chain: [cli],
			acquireTimeoutMs: 60_000,
		}).getAuthorization();

		const after = process.getActiveResourcesInfo?.().length ?? 0;
		expect(after).toBeLessThanOrEqual(before);
	});
});

describe("createDefaultEntraChain", () => {
	it("is exactly the four non-interactive sources, in order", () => {
		const chain = createDefaultEntraChain("tenant-1");

		expect(chain.map((candidate) => candidate.source)).toEqual([
			"workload-identity",
			"managed-identity",
			"service-principal-env",
			"azure-cli",
		]);
	});

	it("has no browser or device-code fallback", () => {
		// A fleet command runs unattended inside an orchestrating agent. A
		// credential that can block on a human turns a failed authentication into
		// a hung session with no output.
		const sources = createDefaultEntraChain("tenant-1").map((c) => c.source);

		expect(sources).not.toContain("interactive-browser");
		expect(sources).not.toContain("device-code");
		expect(sources).toEqual([...ENTRA_CREDENTIAL_SOURCES]);
	});

	it("does not construct an Azure credential until a token is requested", () => {
		// Building the chain must be free: `cyrus connection list` and every
		// local-auth command build one and never use it.
		expect(() => createDefaultEntraChain("tenant-1")).not.toThrow();
		expect(() =>
			createDefaultEntraChain("tenant-1").map((c) => c.create()),
		).not.toThrow();
	});
});

describe("entraScopeFor", () => {
	it("appends /.default and tolerates a pasted trailing slash", () => {
		expect(entraScopeFor("api://cyrus-router")).toBe(
			"api://cyrus-router/.default",
		);
		expect(entraScopeFor("api://cyrus-router/")).toBe(
			"api://cyrus-router/.default",
		);
	});
});

describe("createCredentialProvider", () => {
	it("builds a local provider bound to the configured environment", async () => {
		const provider = createCredentialProvider(
			{
				url: "https://router.example",
				auth: { kind: "local", tokenEnv: "TOKEN" },
			},
			{ env: { TOKEN: "cyop_x" } },
		);

		expect(await provider.getAuthorization()).toEqual({
			header: "Bearer cyop_x",
			source: "env:TOKEN",
		});
	});

	it("builds an Entra provider using the stored tenant and audience", async () => {
		const cli = candidate("azure-cli", { token: "t" });

		const provider = createCredentialProvider(
			{
				url: "https://router.example",
				auth: {
					kind: "entra",
					tenantId: "tenant-1",
					audience: "api://cyrus-router",
				},
			},
			{ entraChain: [cli] },
		);
		const result = await provider.getAuthorization();

		expect(result.source).toBe("azure-cli");
		expect(cli.calls).toEqual(["api://cyrus-router/.default"]);
	});

	it("does not read process.env for an Entra connection", async () => {
		// Purely a guard against the two branches drifting into each other; an
		// Entra connection has no token env var to read.
		const spy = vi.spyOn(process, "env", "get");
		createCredentialProvider(
			{
				url: "https://router.example",
				auth: {
					kind: "entra",
					tenantId: "tenant-1",
					audience: "api://cyrus-router",
				},
			},
			{ entraChain: [candidate("azure-cli", { token: "t" })] },
		);
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
});
