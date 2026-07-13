import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBundle, restoreBundle } from "../src/bundle.js";
import { sanitizeCwdForClaudeProjects } from "../src/paths.js";

function makeState(
	issueKey: string,
	workspacePath: string,
	claudeSessionId: string,
) {
	return {
		agentSessions: {
			"linear-sess-1": {
				issue: { identifier: issueKey, id: "uuid-1", title: "t" },
				workspace: { path: workspacePath, isGitWorktree: true },
				claudeSessionId,
			},
		},
		agentSessionEntries: { "linear-sess-1": [] },
	} as never;
}

describe("buildBundle/restoreBundle round trip", () => {
	it("restores transcripts and merges session state on a fresh host", async () => {
		const src = mkdtempSync(join(tmpdir(), "sync-src-"));
		const dst = mkdtempSync(join(tmpdir(), "sync-dst-"));
		const wsPath = "/workspaces/CYPACK-9";
		const projDir = join(src, "projects", sanitizeCwdForClaudeProjects(wsPath));
		mkdirSync(projDir, { recursive: true });
		writeFileSync(join(projDir, "claude-abc.jsonl"), '{"type":"noop"}\n');

		const bundleFile = join(src, "bundle.tar.gz");
		const wrote = await buildBundle({
			issueKey: "CYPACK-9",
			state: makeState("CYPACK-9", wsPath, "claude-abc"),
			claudeProjectsDir: join(src, "projects"),
			outFile: bundleFile,
		});
		expect(wrote).toBe(true);

		const stateFile = join(dst, "state", "edge-worker-state.json");
		const result = await restoreBundle({
			bundleFile,
			claudeProjectsDir: join(dst, "projects"),
			stateFile,
		});
		expect(result.restoredSessions).toBe(1);
		expect(
			existsSync(
				join(
					dst,
					"projects",
					sanitizeCwdForClaudeProjects(wsPath),
					"claude-abc.jsonl",
				),
			),
		).toBe(true);
		const state = JSON.parse(readFileSync(stateFile, "utf-8"));
		expect(state.state.agentSessions["linear-sess-1"].claudeSessionId).toBe(
			"claude-abc",
		);
	});

	it("strips runner session ids when the transcript is missing (re-prime fallback)", async () => {
		const src = mkdtempSync(join(tmpdir(), "sync-src-"));
		const dst = mkdtempSync(join(tmpdir(), "sync-dst-"));
		const bundleFile = join(src, "bundle.tar.gz");
		// No transcript dir on disk -> bundle carries state only.
		await buildBundle({
			issueKey: "CYPACK-9",
			state: makeState("CYPACK-9", "/workspaces/CYPACK-9", "claude-gone"),
			claudeProjectsDir: join(src, "projects"),
			outFile: bundleFile,
		});
		const stateFile = join(dst, "state", "edge-worker-state.json");
		await restoreBundle({
			bundleFile,
			claudeProjectsDir: join(dst, "projects"),
			stateFile,
		});
		const state = JSON.parse(readFileSync(stateFile, "utf-8"));
		expect(
			state.state.agentSessions["linear-sess-1"].claudeSessionId,
		).toBeUndefined();
	});

	it("returns false and writes nothing when no sessions match the issue", async () => {
		const src = mkdtempSync(join(tmpdir(), "sync-src-"));
		const outFile = join(src, "bundle.tar.gz");
		const wrote = await buildBundle({
			issueKey: "OTHER-1",
			state: makeState("CYPACK-9", "/workspaces/CYPACK-9", "x"),
			claudeProjectsDir: join(src, "projects"),
			outFile,
		});
		expect(wrote).toBe(false);
		expect(existsSync(outFile)).toBe(false);
	});

	it("does not overwrite sessions already present in the destination state file", async () => {
		const src = mkdtempSync(join(tmpdir(), "sync-src-"));
		const dst = mkdtempSync(join(tmpdir(), "sync-dst-"));
		const bundleFile = join(src, "bundle.tar.gz");
		await buildBundle({
			issueKey: "CYPACK-9",
			state: makeState("CYPACK-9", "/workspaces/CYPACK-9", "from-bundle"),
			claudeProjectsDir: join(src, "projects"),
			outFile: bundleFile,
		});
		const stateFile = join(dst, "state", "edge-worker-state.json");
		mkdirSync(join(dst, "state"), { recursive: true });
		writeFileSync(
			stateFile,
			JSON.stringify({
				version: "4.0",
				savedAt: "2026-01-01T00:00:00Z",
				state: makeState("CYPACK-9", "/workspaces/CYPACK-9", "local-live"),
			}),
		);
		await restoreBundle({
			bundleFile,
			claudeProjectsDir: join(dst, "projects"),
			stateFile,
		});
		const state = JSON.parse(readFileSync(stateFile, "utf-8"));
		expect(state.state.agentSessions["linear-sess-1"].claudeSessionId).toBe(
			"local-live",
		);
	});
});
