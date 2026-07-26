import { existsSync, mkdirSync, renameSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SerializableEdgeWorkerState } from "cyrus-core";
import * as tar from "tar";
import { sanitizeCwdForClaudeProjects } from "./paths.js";

export interface BundleManifest {
	version: 1;
	issueKey: string;
	createdAt: string;
	workspacePaths: string[];
}

function sessionsForIssue(
	state: SerializableEdgeWorkerState,
	issueKey: string,
) {
	const sessions = Object.entries(state.agentSessions ?? {}).filter(
		([, s]) =>
			(s as { issue?: { identifier?: string } }).issue?.identifier === issueKey,
	);
	return Object.fromEntries(sessions);
}

export async function buildBundle(opts: {
	issueKey: string;
	state: SerializableEdgeWorkerState;
	claudeProjectsDir: string;
	outFile: string;
}): Promise<boolean> {
	const sessions = sessionsForIssue(opts.state, opts.issueKey);
	const ids = Object.keys(sessions);
	if (ids.length === 0) return false;

	// The issue -> repo[] cache is what `EdgeWorker.restoreMappings` uses to
	// register each restored session's activity sink. Without it the restored
	// session has no sink and every work/result activity is silently dropped
	// (the timeline freezes after the prompt acknowledgment, which posts by a
	// different path). Persist the entries for the bundled sessions' issues so a
	// fresh host can rebuild the sink. Matches restoreMappings' own key lookup
	// (`issueContext?.issueId ?? issueId`), with `issue.id` as a fallback.
	const bundledIssueIds = new Set<string>();
	for (const s of Object.values(sessions)) {
		const sess = s as {
			issueId?: string;
			issueContext?: { issueId?: string };
			issue?: { id?: string };
		};
		for (const cand of [
			sess.issueContext?.issueId,
			sess.issueId,
			sess.issue?.id,
		]) {
			if (cand) bundledIssueIds.add(cand);
		}
	}
	const issueRepositoryCache = Object.fromEntries(
		Object.entries(opts.state.issueRepositoryCache ?? {}).filter(([issueId]) =>
			bundledIssueIds.has(issueId),
		),
	);

	const staging = await mkdtemp(join(tmpdir(), "cyrus-bundle-"));
	try {
		const workspacePaths = [
			...new Set(
				Object.values(sessions)
					.map((s) => (s as { workspace?: { path?: string } }).workspace?.path)
					.filter((p): p is string => Boolean(p)),
			),
		];
		for (const p of workspacePaths) {
			const src = join(opts.claudeProjectsDir, sanitizeCwdForClaudeProjects(p));
			if (existsSync(src)) {
				await cp(
					src,
					join(staging, "claude-projects", sanitizeCwdForClaudeProjects(p)),
					{
						recursive: true,
					},
				);
			}
		}
		const manifest: BundleManifest = {
			version: 1,
			issueKey: opts.issueKey,
			createdAt: new Date().toISOString(),
			workspacePaths,
		};
		await writeFile(
			join(staging, "manifest.json"),
			JSON.stringify(manifest, null, 2),
		);
		mkdirSync(join(staging, "state"), { recursive: true });
		const entries = Object.fromEntries(
			ids.map((id) => [id, opts.state.agentSessionEntries?.[id] ?? []]),
		);
		await writeFile(
			join(staging, "state", "sessions.json"),
			JSON.stringify(
				{
					agentSessions: sessions,
					agentSessionEntries: entries,
					issueRepositoryCache,
				},
				null,
				2,
			),
		);
		mkdirSync(dirname(opts.outFile), { recursive: true });
		const tmpOut = `${opts.outFile}.tmp`;
		await tar.create({ gzip: true, cwd: staging, file: tmpOut }, ["."]);
		renameSync(tmpOut, opts.outFile);
		return true;
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

/**
 * Exported so callers outside this module (e.g. `container-boot`'s
 * device -> container migration handling) can reuse the exact same
 * "which fields identify a resumable runner session" list rather than
 * re-declaring it and risking drift.
 */
export const RUNNER_ID_KEYS = [
	"claudeSessionId",
	"geminiSessionId",
	"codexSessionId",
	"cursorSessionId",
] as const;

export async function restoreBundle(opts: {
	bundleFile: string;
	claudeProjectsDir: string;
	stateFile: string;
}): Promise<{ restoredSessions: number }> {
	const staging = await mkdtemp(join(tmpdir(), "cyrus-restore-"));
	try {
		await tar.extract({ cwd: staging, file: opts.bundleFile });
		const projectsSrc = join(staging, "claude-projects");
		if (existsSync(projectsSrc)) {
			mkdirSync(opts.claudeProjectsDir, { recursive: true });
			await cp(projectsSrc, opts.claudeProjectsDir, {
				recursive: true,
				force: false,
			});
		}
		const bundled = JSON.parse(
			await readFile(join(staging, "state", "sessions.json"), "utf-8"),
		) as {
			agentSessions: Record<string, Record<string, unknown>>;
			agentSessionEntries: Record<string, unknown[]>;
			issueRepositoryCache?: Record<string, string[]>;
		};

		let existing: {
			version: string;
			savedAt: string;
			state: SerializableEdgeWorkerState;
		};
		if (existsSync(opts.stateFile)) {
			existing = JSON.parse(await readFile(opts.stateFile, "utf-8"));
		} else {
			existing = {
				version: "4.0",
				savedAt: new Date().toISOString(),
				state: {},
			};
		}
		existing.state.agentSessions ??= {};
		existing.state.agentSessionEntries ??= {};

		let restored = 0;
		for (const [id, session] of Object.entries(bundled.agentSessions)) {
			if (existing.state.agentSessions[id]) continue; // local state wins
			const workspacePath = (session as { workspace?: { path?: string } })
				.workspace?.path;
			for (const key of RUNNER_ID_KEYS) {
				const runnerId = session[key];
				if (typeof runnerId !== "string") continue;
				if (!workspacePath) {
					delete session[key]; // fail safe: can't validate without a workspace path
					continue;
				}
				const transcript = join(
					opts.claudeProjectsDir,
					sanitizeCwdForClaudeProjects(workspacePath),
					`${runnerId}.jsonl`,
				);
				if (!existsSync(transcript)) delete session[key]; // re-prime fallback
			}
			existing.state.agentSessions[id] = session as never;
			existing.state.agentSessionEntries[id] = (bundled.agentSessionEntries[
				id
			] ?? []) as never;
			restored++;
		}
		// Merge the issue -> repo[] cache so restoreMappings can re-register the
		// restored sessions' activity sinks. Local state wins, mirroring the
		// per-session merge above.
		if (bundled.issueRepositoryCache) {
			existing.state.issueRepositoryCache ??= {};
			for (const [issueId, repoIds] of Object.entries(
				bundled.issueRepositoryCache,
			)) {
				existing.state.issueRepositoryCache[issueId] ??= repoIds;
			}
		}

		existing.savedAt = new Date().toISOString();
		mkdirSync(dirname(opts.stateFile), { recursive: true });
		const tmp = `${opts.stateFile}.tmp`;
		await writeFile(tmp, JSON.stringify(existing, null, 2));
		renameSync(tmp, opts.stateFile);
		return { restoredSessions: restored };
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}
