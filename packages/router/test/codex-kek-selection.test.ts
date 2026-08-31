import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIIssueTrackerService } from "cyrus-core";
import { afterEach, describe, expect, it } from "vitest";
import { RouterServer } from "../src/RouterServer.js";
import { testLogger } from "./helpers/logger.js";

/**
 * Which key seals a stored Codex credential, and how loudly the router says so.
 *
 * The failure this guards is silent and delayed by days. `StateBackup` uploads
 * `router.db` alone, so on a host whose disk does not survive a restart the
 * database comes back and a local KEK does not: `openBundle` fails,
 * `CodexTokenStore.get` reports the credential as absent, and the user sees "no
 * account connected" — indistinguishable from never having connected one.
 */
function makeServer(opts: {
	dir: string;
	codex?: { keyId?: string; localKeyPath?: string };
	tableStoreKeyId?: string;
}) {
	const logger = testLogger();
	const server = new RouterServer({
		port: 0,
		// A real path, never ":memory:" — `dirname(":memory:")` is `"."`, so the
		// default local key would land in the package directory. That is not
		// hypothetical; it happened while wiring the F1 rig.
		dbPath: join(opts.dir, "router.db"),
		workspaces: { "ws-1": { linearToken: "t" } },
		webhook: { verificationMode: "direct", secret: "s" },
		trackerFactory: () => new CLIIssueTrackerService(),
		logger,
		containers: {
			image: "cyrus-worker:test",
			routerUrlForContainers: "ws://127.0.0.1:1/",
			repositories: [],
			artifactsDir: join(opts.dir, "artifacts"),
			repositoriesPath: join(opts.dir, "repositories.json"),
			...(opts.codex ? { codex: opts.codex } : {}),
			...(opts.tableStoreKeyId
				? {
						tableStore: {
							endpoint: "https://example.table.core.windows.net",
							keyId: opts.tableStoreKeyId,
						},
					}
				: {}),
		},
	});
	const warnings = (): string[] =>
		logger.warn.mock.calls.map((call) => String(call[0]));
	return { server, warnings, localKey: join(opts.dir, "codex-kek.key") };
}

// `assertKekVersion` requires exactly 32 lowercase hex characters — Key Vault
// request URLs are built from configuration alone, never from a stored row.
const VAULT_KEY =
	"https://kv-example.vault.azure.net/keys/setup-kek/0123456789abcdef0123456789abcdef";
const OTHER_VAULT_KEY =
	"https://kv-example.vault.azure.net/keys/setup-kek/fedcba9876543210fedcba9876543210";

describe("Codex KEK selection", () => {
	let dir: string;
	let started: RouterServer | undefined;

	afterEach(async () => {
		await started?.stop();
		started = undefined;
	});

	function tempDir(): string {
		dir = mkdtempSync(join(tmpdir(), "cyrus-codex-kek-sel-"));
		return dir;
	}

	it("uses containers.codex.keyId without needing the Table backend", () => {
		// The KEK and the router's Key Vault Crypto User role are provisioned by
		// `enableSetupSecretStore`; `tableStore` is rendered by the separate
		// `enableSetupTableBackend`. Reading the key only off `tableStore` made
		// using a ChatGPT subscription conditional on an unrelated migration.
		const { server, localKey, warnings } = makeServer({
			dir: tempDir(),
			codex: { keyId: VAULT_KEY },
		});
		started = server;
		expect(server.codexTokens).toBeDefined();
		expect(existsSync(localKey)).toBe(false);
		expect(warnings().join("\n")).not.toMatch(/local key/i);
	});

	it("still honours tableStore.keyId when codex.keyId is absent", () => {
		const { server, localKey } = makeServer({
			dir: tempDir(),
			codex: {},
			tableStoreKeyId: VAULT_KEY,
		});
		started = server;
		expect(existsSync(localKey)).toBe(false);
	});

	it("prefers codex.keyId over tableStore.keyId", () => {
		const { server, localKey } = makeServer({
			dir: tempDir(),
			codex: { keyId: VAULT_KEY },
			tableStoreKeyId: OTHER_VAULT_KEY,
		});
		started = server;
		expect(existsSync(localKey)).toBe(false);
	});

	it("falls back to a local key, and says so loudly enough to act on", () => {
		const { server, localKey, warnings } = makeServer({
			dir: tempDir(),
			codex: {},
		});
		started = server;
		expect(existsSync(localKey)).toBe(true);
		// Silence here is the bad outcome: the credential is sealed either way,
		// and only this line distinguishes a durable host from one where every
		// stored credential dies at the next restart while still reading as
		// connected. It must name the file and both remedies.
		const warning = warnings().find((line) => line.includes("codex-kek.key"));
		expect(warning).toBeDefined();
		expect(warning).toMatch(/containers\.codex\.keyId/);
		expect(warning).toMatch(/containers\.codex\.localKeyPath/);
	});

	it("builds no store at all when containers.codex is absent", () => {
		// The honest capability gap: no store means `/setup` offers no "Codex
		// account" section and a Codex user runs on OPENAI_API_KEY, rather than
		// sealing credentials with a key that will not survive.
		const { server, localKey } = makeServer({ dir: tempDir() });
		started = server;
		expect(server.codexTokens).toBeUndefined();
		expect(existsSync(localKey)).toBe(false);
	});
});
