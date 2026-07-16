/**
 * Tests for PersistenceManager durability: atomic saves and corrupt-file
 * handling. Uses a real temp directory (no fs mocks) so the rename/preserve
 * behavior is exercised end-to-end.
 */

import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	PERSISTENCE_VERSION,
	PersistenceManager,
	type SerializableEdgeWorkerState,
} from "../src/PersistenceManager.js";

describe("PersistenceManager durability", () => {
	let dir: string;
	let pm: PersistenceManager;
	const stateFile = () => join(dir, "edge-worker-state.json");

	const sampleState: SerializableEdgeWorkerState = {
		agentSessions: {
			"session-1": {
				id: "session-1",
				status: "active",
			} as SerializableEdgeWorkerState["agentSessions"][string],
		},
		agentSessionEntries: {},
		childToParentAgentSession: {},
		issueRepositoryCache: {},
	};

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "cyrus-persist-"));
		pm = new PersistenceManager(dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("round-trips saved state", async () => {
		await pm.saveEdgeWorkerState(sampleState);
		const loaded = await pm.loadEdgeWorkerState();
		expect(loaded).toEqual(sampleState);
	});

	it("leaves no temp files behind after a successful save", async () => {
		await pm.saveEdgeWorkerState(sampleState);
		const files = await readdir(dir);
		expect(files).toEqual(["edge-worker-state.json"]);
	});

	it("does not corrupt the previous good file when a concurrent save loses the race", async () => {
		// Two overlapping saves must not share a temp path; whichever renames
		// last wins with a fully-written file, and the loser leaves no debris.
		const a: SerializableEdgeWorkerState = {
			...sampleState,
			issueRepositoryCache: { "issue-a": ["repo-a"] },
		};
		const b: SerializableEdgeWorkerState = {
			...sampleState,
			issueRepositoryCache: { "issue-b": ["repo-b"] },
		};
		await Promise.all([pm.saveEdgeWorkerState(a), pm.saveEdgeWorkerState(b)]);

		// Only the real file remains — no orphaned .tmp files.
		const files = await readdir(dir);
		expect(files).toEqual(["edge-worker-state.json"]);

		// And it parses cleanly to one of the two writes (never a mangled mix).
		const loaded = await pm.loadEdgeWorkerState();
		expect([a.issueRepositoryCache, b.issueRepositoryCache]).toContainEqual(
			loaded?.issueRepositoryCache,
		);
	});

	it("preserves a corrupt state file instead of silently discarding it", async () => {
		// Simulate an ENOSPC-truncated file: valid prefix, unterminated JSON.
		await writeFile(
			stateFile(),
			'{"version":"4.0","savedAt":"x","state":{"agentSessions":{"s',
			"utf8",
		);

		const loaded = await pm.loadEdgeWorkerState();
		expect(loaded).toBeNull();

		// The corrupt file is moved aside, not left in place to be overwritten.
		const files = await readdir(dir);
		expect(files.some((f) => f.includes(".corrupt-"))).toBe(true);
		expect(existsSync(stateFile())).toBe(false);
	});

	it("a save after a corrupt load produces a valid, loadable file", async () => {
		await writeFile(stateFile(), "{ this is not json", "utf8");
		expect(await pm.loadEdgeWorkerState()).toBeNull();

		await pm.saveEdgeWorkerState(sampleState);
		const loaded = await pm.loadEdgeWorkerState();
		expect(loaded).toEqual(sampleState);

		const raw = JSON.parse(await readFile(stateFile(), "utf8"));
		expect(raw.version).toBe(PERSISTENCE_VERSION);
	});
});
