import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SecretStore } from "../src/SecretStore.js";

describe("SecretStore", () => {
	const freshPath = () =>
		join(mkdtempSync(join(tmpdir(), "secrets-")), "user-secrets.json");

	it("returns empty bundle for unknown user / missing file", () => {
		expect(new SecretStore(freshPath()).get("a@example.com")).toEqual({});
	});

	it("sets, persists, and case-insensitively reads values with 0600 perms", () => {
		const path = freshPath();
		const store = new SecretStore(path);
		store.set("A@Example.com", "claudeOauthToken", "tok-1");
		expect(
			new SecretStore(path).get("a@example.com").CLAUDE_CODE_OAUTH_TOKEN,
		).toBe("tok-1");
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("deletes a key when set to undefined", () => {
		const path = freshPath();
		const store = new SecretStore(path);
		store.set("a@example.com", "githubPat", "pat");
		store.set("a@example.com", "githubPat", undefined);
		expect(store.get("a@example.com")).toEqual({});
	});

	it("refuses to overwrite a corrupt secrets file instead of wiping it", () => {
		const path = freshPath();
		const corruptContents = "{ not valid json ][";
		writeFileSync(path, corruptContents, { mode: 0o600 });

		const store = new SecretStore(path);
		expect(() =>
			store.set("a@example.com", "claudeOauthToken", "tok-1"),
		).toThrow();

		// The original (corrupt) bytes must still be on disk — not wiped to {}.
		expect(readFileSync(path, "utf-8")).toBe(corruptContents);
	});

	it("preserves other users' secrets when the file is valid JSON", () => {
		const path = freshPath();
		const store = new SecretStore(path);
		store.set("existing@example.com", "githubPat", "existing-pat");

		store.set("a@example.com", "claudeOauthToken", "tok-1");

		expect(store.get("existing@example.com").GIT_TOKEN).toBe("existing-pat");
		expect(store.get("a@example.com").CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-1");
	});

	it("forces 0600 on the final file even if a leftover .tmp file had looser perms", () => {
		const path = freshPath();
		const tmpPath = `${path}.tmp`;
		writeFileSync(tmpPath, "leftover", { mode: 0o644 });
		expect(statSync(tmpPath).mode & 0o777).toBe(0o644);

		const store = new SecretStore(path);
		store.set("a@example.com", "claudeOauthToken", "tok-1");

		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("migrates legacy named keys to env-var names on read", () => {
		const path = freshPath();
		writeFileSync(
			path,
			`${JSON.stringify({
				"a@example.com": {
					claudeOauthToken: "tok",
					githubPat: "pat",
					gitUserName: "Ann",
					gitUserEmail: "ann@x.com",
					dotfilesRepo: "https://example/dotfiles",
				},
			})}\n`,
			{ mode: 0o600 },
		);
		expect(new SecretStore(path).get("a@example.com")).toEqual({
			CLAUDE_CODE_OAUTH_TOKEN: "tok",
			GIT_TOKEN: "pat",
			GIT_USER_NAME: "Ann",
			GIT_USER_EMAIL: "ann@x.com",
			DOTFILES_REPO: "https://example/dotfiles",
		});
	});

	it("prefers a new env-var key over its legacy equivalent", () => {
		const path = freshPath();
		writeFileSync(
			path,
			`${JSON.stringify({
				"a@example.com": {
					claudeOauthToken: "legacy",
					CLAUDE_CODE_OAUTH_TOKEN: "new",
				},
			})}\n`,
			{ mode: 0o600 },
		);
		expect(new SecretStore(path).get("a@example.com")).toEqual({
			CLAUDE_CODE_OAUTH_TOKEN: "new",
		});
	});

	it("normalizes a legacy key on set so an update overwrites, not duplicates", () => {
		const path = freshPath();
		const store = new SecretStore(path);
		store.set("a@example.com", "githubPat", "pat-1"); // stored as GIT_TOKEN
		store.set("a@example.com", "githubPat", "pat-2"); // must overwrite GIT_TOKEN
		expect(store.get("a@example.com")).toEqual({ GIT_TOKEN: "pat-2" });
		// No legacy key ever persists on disk.
		const onDisk = JSON.parse(readFileSync(path, "utf-8"));
		expect(onDisk["a@example.com"]).toEqual({ GIT_TOKEN: "pat-2" });
	});

	it("normalizes a legacy key on unset", () => {
		const path = freshPath();
		const store = new SecretStore(path);
		store.set("a@example.com", "githubPat", "pat"); // GIT_TOKEN
		store.set("a@example.com", "githubPat", undefined); // must delete GIT_TOKEN
		expect(store.get("a@example.com")).toEqual({});
	});

	it("stores and reads back arbitrary env-var-named keys", () => {
		const path = freshPath();
		new SecretStore(path).set(
			"a@example.com",
			"LINEAR_API_TOKEN",
			"lin_api_123",
		);
		expect(new SecretStore(path).get("a@example.com").LINEAR_API_TOKEN).toBe(
			"lin_api_123",
		);
	});

	it("rejects reserved keys (including the container bootstrap dirs)", () => {
		const store = new SecretStore(freshPath());
		for (const key of [
			"CYRUS_ROUTER_URL",
			"PATH",
			"CYRUS_WORKSPACES_DIR",
			"NODE_OPTIONS",
		]) {
			expect(() => store.set("a@example.com", key, "x")).toThrow(
				/reserved env var/,
			);
		}
	});

	it("rejects a key that is not a valid env-var name", () => {
		const store = new SecretStore(freshPath());
		expect(() => store.set("a@example.com", "not a name", "x")).toThrow(
			/not a valid environment variable name/,
		);
		expect(() => store.set("a@example.com", "1BAD", "x")).toThrow(
			/not a valid environment variable name/,
		);
	});

	it("reports fully-authenticated status against a required set", () => {
		const store = new SecretStore(freshPath());
		store.set("a@example.com", "CLAUDE_CODE_OAUTH_TOKEN", "tok");
		expect(
			store.isFullyAuthenticated("a@example.com", [
				"CLAUDE_CODE_OAUTH_TOKEN",
				"GIT_TOKEN",
				"LINEAR_API_TOKEN",
			]),
		).toEqual({ ok: false, missing: ["GIT_TOKEN", "LINEAR_API_TOKEN"] });
	});

	it("stores and round-trips a key that is an Object.prototype member name, without throwing or coercing to a function", () => {
		const path = freshPath();
		const store = new SecretStore(path);
		store.set("a@example.com", "toString", "x");
		expect(store.get("a@example.com")).toEqual({ toString: "x" });
	});

	it("treats an Object.prototype member name as MISSING when required, not satisfied via prototype lookup", () => {
		const store = new SecretStore(freshPath());
		expect(
			store.isFullyAuthenticated("a@example.com", ["hasOwnProperty"]),
		).toEqual({ ok: false, missing: ["hasOwnProperty"] });
	});

	it.each([
		["a JSON array", "[]"],
		["a non-object user entry", `${JSON.stringify({ "a@x.com": 42 })}`],
		[
			"a non-string value",
			`${JSON.stringify({ "a@x.com": { GIT_TOKEN: 1 } })}`,
		],
	])("throws (never resets) on structurally-corrupt-but-valid JSON: %s", (_label, contents) => {
		const path = freshPath();
		writeFileSync(path, contents, { mode: 0o600 });
		const store = new SecretStore(path);
		expect(() => store.set("b@x.com", "GIT_TOKEN", "y")).toThrow();
		// Bytes untouched.
		expect(readFileSync(path, "utf-8")).toBe(contents);
	});
});
