import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertCodexCredentialAvailable,
	CodexCredentialError,
} from "../src/config/codexCredentials.js";

function freshCodexHome(): string {
	return mkdtempSync(join(tmpdir(), "codex-credentials-"));
}

function writeAuth(codexHome: string, contents: string): string {
	writeFileSync(join(codexHome, "auth.json"), contents);
	return codexHome;
}

/**
 * CYR-79. Without this preflight the user sees OpenAI's transport-level
 * rejection — `401 Unauthorized: Missing bearer or basic authentication in
 * header` against `/v1/responses` — which names neither the cause nor a remedy.
 */
describe("assertCodexCredentialAvailable", () => {
	it("accepts an OPENAI_API_KEY from the session env", () => {
		expect(
			assertCodexCredentialAvailable({
				codexHome: freshCodexHome(),
				env: { OPENAI_API_KEY: "sk-test" },
			}),
		).toBe("api-key");
	});

	it("accepts the subscription tokens the router writes", () => {
		const codexHome = writeAuth(
			freshCodexHome(),
			JSON.stringify({
				OPENAI_API_KEY: null,
				tokens: { access_token: "at", refresh_token: "rt" },
			}),
		);
		expect(assertCodexCredentialAvailable({ codexHome, env: {} })).toBe(
			"chatgpt-subscription",
		);
	});

	it("accepts a refresh token alone, which Codex can still mint from", () => {
		const codexHome = writeAuth(
			freshCodexHome(),
			JSON.stringify({ tokens: { refresh_token: "rt" } }),
		);
		expect(assertCodexCredentialAvailable({ codexHome, env: {} })).toBe(
			"chatgpt-subscription",
		);
	});

	it("accepts an api-key-mode auth.json", () => {
		const codexHome = writeAuth(
			freshCodexHome(),
			JSON.stringify({ OPENAI_API_KEY: "sk-test" }),
		);
		expect(assertCodexCredentialAvailable({ codexHome, env: {} })).toBe(
			"api-key",
		);
	});

	it("names both remedies when there is no credential at all", () => {
		// The exact CYR-79 shape: a container booted for another runner, an issue
		// that selected Codex anyway, and nothing on disk to authenticate with.
		const codexHome = freshCodexHome();
		let error: unknown;
		try {
			assertCodexCredentialAvailable({ codexHome, env: {} });
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(CodexCredentialError);
		const message = (error as Error).message;
		expect(message).toMatch(/does not exist/);
		expect(message).toMatch(/codex login --device-auth/);
		expect(message).toMatch(/OPENAI_API_KEY/);
	});

	it("rejects a credential file that is not JSON", () => {
		const codexHome = writeAuth(freshCodexHome(), "not json at all");
		expect(() =>
			assertCodexCredentialAvailable({ codexHome, env: {} }),
		).toThrow(/not valid JSON/);
	});

	it("rejects a credential file carrying neither key nor tokens", () => {
		const codexHome = writeAuth(
			freshCodexHome(),
			JSON.stringify({ OPENAI_API_KEY: null, tokens: {} }),
		);
		expect(() =>
			assertCodexCredentialAvailable({ codexHome, env: {} }),
		).toThrow(/neither an OpenAI API key nor ChatGPT subscription tokens/);
	});

	it("does not treat an expired-looking access token as fatal", () => {
		// Codex refreshes from the token beside it, and the router already failed
		// the boot for a credential it could not refresh. Failing here would kill
		// sessions that were about to work.
		const codexHome = writeAuth(
			freshCodexHome(),
			JSON.stringify({
				tokens: { access_token: "at", refresh_token: "rt" },
				last_refresh: "1970-01-01T00:00:00Z",
			}),
		);
		expect(assertCodexCredentialAvailable({ codexHome, env: {} })).toBe(
			"chatgpt-subscription",
		);
	});
});
