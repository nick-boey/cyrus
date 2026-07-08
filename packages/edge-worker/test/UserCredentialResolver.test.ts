import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ILogger } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserCredentialResolver } from "../src/UserCredentialResolver.js";

function makeLogger() {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	} as unknown as ILogger;
}

describe("UserCredentialResolver", () => {
	let dir: string;
	let logger: ILogger;

	beforeEach(() => {
		logger = makeLogger();
		dir = mkdtempSync(join(tmpdir(), "cyrus-user-creds-"));
		writeFileSync(
			join(dir, ".env"),
			[
				"CLAUDE_CODE_OAUTH_TOKEN=claude-token-alice",
				"GH_TOKEN=gh-token-alice",
				"GITHUB_TOKEN=gh-token-alice",
				"UNRELATED_VAR=should-not-leak",
			].join("\n"),
		);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const aliceEntry = (overrides: Record<string, unknown> = {}) => ({
		linearUser: { email: "Alice@Org.com" },
		credentialsDir: dir,
		gitAuthor: { name: "Alice Example", email: "alice@org.com" },
		...overrides,
	});

	it("is disabled when no users are configured", () => {
		const r = new UserCredentialResolver(undefined, undefined, logger);
		expect(r.isEnabled()).toBe(false);
		expect(r.resolve({ email: "alice@org.com" })).toBeNull();
	});

	it("matches by email case-insensitively and builds the env bundle", () => {
		const r = new UserCredentialResolver([aliceEntry()], undefined, logger);
		const profile = r.resolve({ id: "usr_1", email: "alice@ORG.com" });
		expect(profile).not.toBeNull();
		expect(profile!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("claude-token-alice");
		expect(profile!.env.GH_TOKEN).toBe("gh-token-alice");
		expect(profile!.env.GITHUB_TOKEN).toBe("gh-token-alice");
		expect(profile!.env.UNRELATED_VAR).toBeUndefined();
	});

	it("matches by explicit id", () => {
		const r = new UserCredentialResolver(
			[aliceEntry({ linearUser: { id: "usr_1" } })],
			undefined,
			logger,
		);
		expect(r.resolve({ id: "usr_1" })).not.toBeNull();
		expect(r.resolve({ id: "usr_2" })).toBeNull();
	});

	it("returns null for an unregistered creator or missing creator", () => {
		const r = new UserCredentialResolver([aliceEntry()], undefined, logger);
		expect(r.resolve({ email: "bob@org.com" })).toBeNull();
		expect(r.resolve(undefined)).toBeNull();
	});

	it("returns null (treat as unregistered) when the .env file is missing", () => {
		const emptyDir = mkdtempSync(join(tmpdir(), "cyrus-user-empty-"));
		const r = new UserCredentialResolver(
			[aliceEntry({ credentialsDir: emptyDir })],
			undefined,
			logger,
		);
		expect(r.resolve({ email: "alice@org.com" })).toBeNull();
		rmSync(emptyDir, { recursive: true, force: true });
	});

	it("sets CODEX_HOME and CLAUDE_CONFIG_DIR only when the dirs exist", () => {
		const r = new UserCredentialResolver([aliceEntry()], undefined, logger);
		expect(
			r.resolve({ email: "alice@org.com" })!.env.CODEX_HOME,
		).toBeUndefined();

		mkdirSync(join(dir, "codex"));
		mkdirSync(join(dir, "claude"));
		const profile = r.resolve({ email: "alice@org.com" })!;
		expect(profile.env.CODEX_HOME).toBe(join(dir, "codex"));
		expect(profile.env.CLAUDE_CONFIG_DIR).toBe(join(dir, "claude"));
	});

	it("injects the user's git author identity in user mode (default)", () => {
		const r = new UserCredentialResolver([aliceEntry()], undefined, logger);
		const env = r.resolve({ email: "alice@org.com" })!.env;
		expect(env.GIT_AUTHOR_NAME).toBe("Alice Example");
		expect(env.GIT_AUTHOR_EMAIL).toBe("alice@org.com");
		expect(env.GIT_COMMITTER_NAME).toBe("Alice Example");
		expect(env.GIT_COMMITTER_EMAIL).toBe("alice@org.com");
	});

	it("omits git author env in user mode when the entry has no gitAuthor", () => {
		const r = new UserCredentialResolver(
			[aliceEntry({ gitAuthor: undefined })],
			undefined,
			logger,
		);
		expect(
			r.resolve({ email: "alice@org.com" })!.env.GIT_AUTHOR_NAME,
		).toBeUndefined();
	});

	it("injects the shared identity in shared mode", () => {
		const r = new UserCredentialResolver(
			[aliceEntry()],
			{
				mode: "shared",
				shared: { name: "Cyrus Agent", email: "cyrus@org.com" },
			},
			logger,
		);
		const env = r.resolve({ email: "alice@org.com" })!.env;
		expect(env.GIT_AUTHOR_NAME).toBe("Cyrus Agent");
		expect(env.GIT_COMMITTER_EMAIL).toBe("cyrus@org.com");
	});

	it("omits git author env in shared mode without a shared author", () => {
		const r = new UserCredentialResolver(
			[aliceEntry()],
			{ mode: "shared" },
			logger,
		);
		expect(
			r.resolve({ email: "alice@org.com" })!.env.GIT_AUTHOR_NAME,
		).toBeUndefined();
	});

	it("warns when multiple registry entries match the same creator", () => {
		const r = new UserCredentialResolver(
			[aliceEntry(), aliceEntry({ linearUser: { id: "usr_1" } })],
			undefined,
			logger,
		);
		const profile = r.resolve({ id: "usr_1", email: "alice@org.com" });
		expect(profile).not.toBeNull();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("Multiple user credential entries match"),
		);
	});

	it("setConfig replaces the registry", () => {
		const r = new UserCredentialResolver(undefined, undefined, logger);
		expect(r.isEnabled()).toBe(false);
		r.setConfig([aliceEntry()], undefined);
		expect(r.isEnabled()).toBe(true);
	});
});
