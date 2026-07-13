import { mkdtempSync, statSync } from "node:fs";
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
		expect(new SecretStore(path).get("a@example.com").claudeOauthToken).toBe(
			"tok-1",
		);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("deletes a key when set to undefined", () => {
		const path = freshPath();
		const store = new SecretStore(path);
		store.set("a@example.com", "githubPat", "pat");
		store.set("a@example.com", "githubPat", undefined);
		expect(store.get("a@example.com")).toEqual({});
	});
});
