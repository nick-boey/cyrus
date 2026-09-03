import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexBackend } from "../src/backend/types.js";
import { CodexRunner } from "../src/CodexRunner.js";

class SpyBackend extends EventEmitter implements CodexBackend {
	supportsSteer = true;
	open = vi.fn(async () => ({ threadId: "t" }));
	runTurn = vi.fn(async () => {});
	steer = vi.fn(async () => {});
	isTurnActive() {
		return false;
	}
	async interrupt() {}
	close = vi.fn(async () => {});
}

/** Swap in a backend we can assert was never opened. */
function withBackend(runner: CodexRunner, backend: CodexBackend): void {
	(runner as unknown as { createBackend: () => CodexBackend }).createBackend =
		() => backend;
}

describe("CodexRunner credential preflight", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("reports a missing credential as an error result instead of a 401", async () => {
		// CYR-79: a container booted for another runner has no Codex credential,
		// and an issue-level `[agent=codex]` used to reach OpenAI anyway — the
		// user's only signal being `401 Unauthorized: Missing bearer or basic
		// authentication in header` against `/v1/responses`.
		vi.stubEnv("OPENAI_API_KEY", "");
		const dir = mkdtempSync(join(tmpdir(), "codex-runner-credentials-"));
		const runner = new CodexRunner({
			workingDirectory: dir,
			cyrusHome: dir,
			codexHome: join(dir, "codex-home"),
		});
		const backend = new SpyBackend();
		withBackend(runner, backend);

		const completed = new Promise<unknown[]>((resolve) => {
			runner.on("complete", (messages) => resolve(messages));
		});
		await runner.startStreaming("do the thing");
		const messages = (await completed) as Array<{
			type: string;
			subtype?: string;
			errors?: string[];
		}>;

		// Never reached the network: the whole point is that the request is not
		// made unauthenticated.
		expect(backend.open).not.toHaveBeenCalled();
		expect(backend.runTurn).not.toHaveBeenCalled();

		const result = messages.find((message) => message.type === "result");
		expect(result?.subtype).toBe("error_during_execution");
		const reported = result?.errors?.join("\n") ?? "";
		expect(reported).toMatch(/codex login --device-auth/);
		expect(reported).toMatch(/OPENAI_API_KEY/);
		expect(runner.isRunning()).toBe(false);
	});

	it("starts normally when OPENAI_API_KEY is present", async () => {
		vi.stubEnv("OPENAI_API_KEY", "sk-test");
		const dir = mkdtempSync(join(tmpdir(), "codex-runner-credentials-"));
		const runner = new CodexRunner({
			workingDirectory: dir,
			cyrusHome: dir,
			codexHome: join(dir, "codex-home"),
		});
		const backend = new SpyBackend();
		withBackend(runner, backend);

		await runner.startStreaming("do the thing");
		expect(backend.open).toHaveBeenCalled();
		expect(backend.runTurn).toHaveBeenCalled();
	});
});
