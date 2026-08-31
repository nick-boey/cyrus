// apps/f1/test/router/repo-routing.test.ts
//
// Task 18 (router multi-repository routing) F1 end-to-end validation.
//
// Drives a real, in-process `RouterServer` (via the F1 `RouterRig`) through
// registry seeding, all four routing-priority scenarios from the task brief,
// the `/setup/repositories` UI, and a final check that a resolved issue's
// `CYRUS_REPOS_JSON` names exactly the repositories the router decided on —
// the clone-saving win the whole feature exists for.
//
// No Docker, no live Linear workspace: the container executor is a fake that
// records what it was asked to boot, and the issue tracker is F1's
// `CLIIssueTrackerService` wrapped to inject the team/project facts a real
// Linear workspace would supply (see `wrapWithFacts` below — the CLI tracker
// itself cannot produce these, which is recorded as a finding in the test
// drive write-up).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	CLIIssueTrackerService,
	IIssueTrackerService,
	Issue,
} from "cyrus-core";
import type {
	ContainerExecutor,
	ContainerStatus,
	IssueExecutionContext,
} from "cyrus-router-executors";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	type Creator,
	createdFixture,
	promptedFixture,
	seedSession,
	WORKSPACE,
} from "../../src/router/fixtures.js";
import {
	createRouterRig,
	type RigRepositoryConfig,
	type RouterRig,
} from "../../src/router/RouterRig.js";

/** Verbatim copy of `cyrus-router`'s `REPOSITORY_SELECTION_PROMPT` (internal, not re-exported). */
const REPOSITORY_SELECTION_PROMPT =
	"Which repository should I work in for this issue?";

const ALPHA: RigRepositoryConfig = {
	name: "alpha",
	githubSlug: "f1/alpha",
	linearWorkspaceId: WORKSPACE,
	teamKeys: ["ALPHA"],
	projectKeys: ["Platform"],
};
const BETA: RigRepositoryConfig = {
	name: "beta",
	githubSlug: "f1/beta",
	linearWorkspaceId: WORKSPACE,
	teamKeys: ["BETA"],
};
const GAMMA: RigRepositoryConfig = {
	name: "gamma",
	githubSlug: "f1/gamma",
	linearWorkspaceId: WORKSPACE,
	isDefault: true,
};

const ALICE: Creator = {
	id: "lin-alice",
	email: "alice@example.com",
	name: "Alice",
};

interface Boot {
	issueKey: string;
	env: Record<string, string>;
}

/** Records every `ensureRunning` call instead of booting anything real. */
function capturingExecutor(boots: Boot[]): ContainerExecutor {
	return {
		provider: "docker",
		async ensureRunning(ctx: IssueExecutionContext): Promise<void> {
			boots.push({ issueKey: ctx.issueKey, env: ctx.env });
			ctx.mintDeviceToken();
		},
		async stop(): Promise<void> {},
		async destroy(): Promise<void> {},
		async status(): Promise<ContainerStatus> {
			return "running";
		},
		async listManaged(): Promise<string[]> {
			return [];
		},
	};
}

interface InjectedFacts {
	teamKey?: string;
	projectName?: string;
}

/**
 * Wraps the rig's real `CLIIssueTrackerService` so `fetchIssue()` returns an
 * `Issue` whose `.team`/`.project` resolve to whatever this test wants a given
 * issue id to carry — see the `RouterRigOptions.wrapTracker` doc comment for
 * why the stock CLI tracker cannot do this itself.
 */
function wrapWithFacts(
	base: CLIIssueTrackerService,
	factsByIssueId: Map<string, InjectedFacts>,
): IIssueTrackerService {
	return new Proxy(base, {
		get(target, prop, receiver) {
			if (prop === "fetchIssue") {
				return async (idOrIdentifier: string): Promise<Issue> => {
					const facts = factsByIssueId.get(idOrIdentifier);
					if (!facts) {
						return (
							target as unknown as { fetchIssue(id: string): Promise<Issue> }
						).fetchIssue(idOrIdentifier);
					}
					return {
						id: idOrIdentifier,
						identifier: idOrIdentifier,
						team: facts.teamKey ? { key: facts.teamKey } : undefined,
						project: facts.projectName
							? { name: facts.projectName }
							: undefined,
						labels: async () => ({ nodes: [] }),
					} as unknown as Issue;
				};
			}
			return Reflect.get(target, prop, receiver);
		},
	}) as unknown as IIssueTrackerService;
}

function cyrusReposJson(boot: Boot | undefined): Array<{ name: string }> {
	if (!boot) throw new Error("no boot captured");
	return JSON.parse(boot.env.CYRUS_REPOS_JSON as string);
}

describe("router multi-repository routing (Task 18 F1 drive)", () => {
	let dir: string;
	let rig: RouterRig;
	let boots: Boot[];
	let logger: {
		info: ReturnType<typeof vi.fn>;
		warn: ReturnType<typeof vi.fn>;
	};
	const factsByIssueId = new Map<string, InjectedFacts>();

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "f1-repo-routing-"));
		boots = [];
		logger = { info: vi.fn(), warn: vi.fn() };
		rig = await createRouterRig({
			dbPath: join(dir, "router.db"),
			secretsPath: join(dir, "secrets.json"),
			artifactsDir: join(dir, "artifacts"),
			// dev-insecure-headers refuses to start off loopback.
			host: "127.0.0.1",
			repositories: [ALPHA, BETA, GAMMA],
			setupUi: { enabled: true, auth: { mode: "dev-insecure-headers" } },
			wrapTracker: (base) => wrapWithFacts(base, factsByIssueId),
			executors: new Map([["docker", capturingExecutor(boots)]]),
			logger,
		});
		await rig.seedUser({
			email: ALICE.email,
			linearId: ALICE.id,
			provider: "docker",
			claudeOauthToken: "test-claude-token",
		});
	});

	afterAll(async () => {
		await rig.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	it("Step 2: seeds the registry once from containers.repositories, three repositories", async () => {
		await vi.waitFor(() => {
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining(
					"Seeded the repository registry with 3 repositories from containers.repositories",
				),
			);
		});
		const snapshot = await rig.server.repositoryRegistry?.list();
		expect(snapshot?.repositories.map((r) => r.name).sort()).toEqual([
			"alpha",
			"beta",
			"gamma",
		]);
	});

	it("Scenario 1: team hit — BETA routes to beta alone, container clones only beta", async () => {
		const issueId = "issue-beta-1";
		const identifier = "BETA-1";
		factsByIssueId.set(issueId, { teamKey: "BETA" });

		seedSession(rig.tracker, "sess-beta-1", issueId);
		await rig.server.eventRouter.route(
			createdFixture({
				sessionId: "sess-beta-1",
				issue: { id: issueId, identifier, title: "Beta team issue" },
				creator: ALICE,
			}),
		);

		expect(rig.server.store.getIssueRepositories(identifier)).toMatchObject({
			repoNames: ["beta"],
			method: "team-based",
		});
		expect(logger.info).toHaveBeenCalledWith(
			`Repositories for ${identifier}: [beta] (team-based)`,
		);

		const boot = boots.find((b) => b.issueKey === identifier);
		expect(cyrusReposJson(boot)).toEqual([
			expect.objectContaining({ name: "beta" }),
		]);
	});

	it("Scenario 2: project hit beats team — BETA team + Platform project routes to alpha", async () => {
		const issueId = "issue-alpha-2";
		const identifier = "BETA-2";
		factsByIssueId.set(issueId, { teamKey: "BETA", projectName: "Platform" });

		seedSession(rig.tracker, "sess-alpha-2", issueId);
		await rig.server.eventRouter.route(
			createdFixture({
				sessionId: "sess-alpha-2",
				issue: {
					id: issueId,
					identifier,
					title: "Beta team, Platform project",
				},
				creator: ALICE,
			}),
		);

		expect(rig.server.store.getIssueRepositories(identifier)).toMatchObject({
			repoNames: ["alpha"],
			method: "project-based",
		});
		expect(logger.info).toHaveBeenCalledWith(
			`Repositories for ${identifier}: [alpha] (project-based)`,
		);

		const boot = boots.find((b) => b.issueKey === identifier);
		expect(cyrusReposJson(boot)).toEqual([
			expect.objectContaining({ name: "alpha" }),
		]);
	});

	it("Scenario 3: default fallback — an unclaimed team routes to gamma", async () => {
		const issueId = "issue-zeta-3";
		const identifier = "ZETA-1";
		factsByIssueId.set(issueId, { teamKey: "ZETA" });

		seedSession(rig.tracker, "sess-zeta-3", issueId);
		await rig.server.eventRouter.route(
			createdFixture({
				sessionId: "sess-zeta-3",
				issue: { id: issueId, identifier, title: "Unclaimed team" },
				creator: ALICE,
			}),
		);

		expect(rig.server.store.getIssueRepositories(identifier)).toMatchObject({
			repoNames: ["gamma"],
			method: "default",
		});
		expect(logger.info).toHaveBeenCalledWith(
			`Repositories for ${identifier}: [gamma] (default)`,
		);

		const boot = boots.find((b) => b.issueKey === identifier);
		expect(cyrusReposJson(boot)).toEqual([
			expect.objectContaining({ name: "gamma" }),
		]);
	});

	it("Setup UI: /setup/repositories lists all three with p=/t= associations", async () => {
		const res = await fetch(
			`http://127.0.0.1:${rig.server.port}/setup/repositories`,
			{
				headers: { "x-ms-client-principal-name": ALICE.email },
			},
		);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("alpha");
		expect(body).toContain("beta");
		expect(body).toContain("gamma");
		expect(body).toContain('value="p=Platform,t=ALPHA"'); // alpha's association
		expect(body).toContain('value="t=BETA"'); // beta's association
		expect(body).not.toContain('data-testid="ambiguity-banner"');
	});

	it("Scenario 4 setup: giving beta projectKeys=[Platform] too creates a tie, and the setup UI shows the ambiguity banner", async () => {
		const snapshot = await rig.server.repositoryRegistry?.list();
		if (!snapshot) throw new Error("registry not configured");
		const next = snapshot.repositories.map((r) =>
			r.name === "beta" ? { ...r, projectKeys: ["Platform"] } : r,
		);
		await rig.server.repositoryRegistry?.put(next, snapshot.version);

		const res = await fetch(
			`http://127.0.0.1:${rig.server.port}/setup/repositories`,
			{
				headers: { "x-ms-client-principal-name": ALICE.email },
			},
		);
		const body = await res.text();
		expect(body).toContain('data-testid="ambiguity-banner"');
		expect(body).toContain(
			"Repositories &quot;alpha&quot; and &quot;beta&quot; both claim project &quot;Platform&quot;",
		);
	});

	it("Scenario 4: ambiguity elicits, holds the created event with no container device row", async () => {
		const issueId = "issue-plat-4";
		const identifier = "PLAT-4";
		factsByIssueId.set(issueId, { projectName: "Platform" });

		seedSession(rig.tracker, "sess-plat-4", issueId);
		await rig.server.eventRouter.route(
			createdFixture({
				sessionId: "sess-plat-4",
				issue: {
					id: issueId,
					identifier,
					title: "Platform project, ambiguous",
				},
				creator: ALICE,
			}),
		);

		expect(rig.server.store.getIssueRepositories(identifier)).toBeUndefined();
		expect(
			rig.server.store.getContainerDeviceForIssue(identifier),
		).toBeUndefined();
		expect(
			rig.server.store.getPendingRepoSelection("sess-plat-4"),
		).toMatchObject({
			issueKey: identifier,
			options: ["alpha", "beta"],
		});
		expect(boots.find((b) => b.issueKey === identifier)).toBeUndefined();

		const elicitation = [
			...rig.tracker.getState().agentActivities.values(),
		].find((a) => a.agentSessionId === "sess-plat-4" && a.signal === "select");
		expect(elicitation?.content).toBe(REPOSITORY_SELECTION_PROMPT);
	});

	it("Scenario 4: answering 'beta' replays the held created event and boots a container that clones only beta", async () => {
		const identifier = "PLAT-4";
		await rig.server.eventRouter.route(
			promptedFixture({
				sessionId: "sess-plat-4",
				actorUserId: ALICE.id,
				creator: ALICE,
				issue: {
					id: "issue-plat-4",
					identifier,
					title: "Platform project, ambiguous",
				},
				body: "beta",
			}),
		);

		expect(rig.server.store.getIssueRepositories(identifier)).toMatchObject({
			repoNames: ["beta"],
			method: "user-selected",
		});
		expect(
			rig.server.store.getPendingRepoSelection("sess-plat-4"),
		).toBeUndefined();

		const boot = boots.find((b) => b.issueKey === identifier);
		expect(cyrusReposJson(boot)).toEqual([
			expect.objectContaining({ name: "beta" }),
		]);
	});

	it("Setup UI: adding a repository and moving the default persist and change the next issue's routing", async () => {
		const page = await fetch(
			`http://127.0.0.1:${rig.server.port}/setup/repositories`,
			{
				headers: { "x-ms-client-principal-name": ALICE.email },
			},
		);
		const pageBody = await page.text();
		const csrf = /name="csrf" value="([^"]+)"/.exec(pageBody)?.[1];
		if (!csrf) throw new Error("csrf token not found on repositories page");

		// Add "delta".
		const addRes = await fetch(
			`http://127.0.0.1:${rig.server.port}/setup/repositories`,
			{
				method: "POST",
				headers: {
					"x-ms-client-principal-name": ALICE.email,
					"content-type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					csrf,
					name: "delta",
					githubSlug: "f1/delta",
					linearWorkspaceId: WORKSPACE,
				}).toString(),
			},
		);
		expect(addRes.status).toBe(200);

		// Re-scrape csrf/version/current row values (the "add" mutated the version).
		const page2 = await fetch(
			`http://127.0.0.1:${rig.server.port}/setup/repositories`,
			{
				headers: { "x-ms-client-principal-name": ALICE.email },
			},
		);
		const body2 = await page2.text();
		expect(body2).toContain("delta");
		const csrf2 = /name="csrf" value="([^"]+)"/.exec(body2)?.[1];
		const version2 = /name="version" value="([^"]+)"/.exec(body2)?.[1];
		if (!csrf2 || !version2)
			throw new Error("csrf/version not found after add");

		const scrape = (name: string, field: "slug" | "branch" | "assoc"): string =>
			new RegExp(`name="${field}:${name}" value="([^"]*)"`).exec(body2)?.[1] ??
			"";

		// Move the default from gamma to delta, resubmitting every row (a row
		// not submitted is dropped by applyRepositoryEdits).
		const saveRes = await fetch(
			`http://127.0.0.1:${rig.server.port}/setup/repositories/save`,
			{
				method: "POST",
				headers: {
					"x-ms-client-principal-name": ALICE.email,
					"content-type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					csrf: csrf2,
					version: version2,
					"repo:alpha": "1",
					"slug:alpha": scrape("alpha", "slug"),
					"branch:alpha": scrape("alpha", "branch"),
					"assoc:alpha": scrape("alpha", "assoc"),
					"repo:beta": "1",
					"slug:beta": scrape("beta", "slug"),
					"branch:beta": scrape("beta", "branch"),
					"assoc:beta": scrape("beta", "assoc"),
					"repo:gamma": "1",
					"slug:gamma": scrape("gamma", "slug"),
					"branch:gamma": scrape("gamma", "branch"),
					"assoc:gamma": "", // no longer default; clear any stray association
					"repo:delta": "1",
					"slug:delta": scrape("delta", "slug"),
					"branch:delta": scrape("delta", "branch"),
					"assoc:delta": scrape("delta", "assoc"),
					isDefault: "delta",
				}).toString(),
			},
		);
		expect(saveRes.status).toBe(200);

		const snapshot = await rig.server.repositoryRegistry?.list();
		expect(
			snapshot?.repositories.find((r) => r.name === "delta")?.isDefault,
		).toBe(true);
		expect(
			snapshot?.repositories.find((r) => r.name === "gamma")?.isDefault,
		).toBe(undefined);

		// Reflected in the next issue's routing: an unclaimed team now falls
		// back to delta, not gamma.
		const issueId = "issue-omega-5";
		const identifier = "OMEGA-1";
		factsByIssueId.set(issueId, { teamKey: "OMEGA" });
		seedSession(rig.tracker, "sess-omega-5", issueId);
		await rig.server.eventRouter.route(
			createdFixture({
				sessionId: "sess-omega-5",
				issue: {
					id: issueId,
					identifier,
					title: "Unclaimed team, post-default-move",
				},
				creator: ALICE,
			}),
		);
		expect(rig.server.store.getIssueRepositories(identifier)).toMatchObject({
			repoNames: ["delta"],
			method: "default",
		});

		// Deleting "delta" removes it from the list.
		const delRes = await fetch(
			`http://127.0.0.1:${rig.server.port}/setup/repositories/delta`,
			{
				method: "DELETE",
				headers: {
					"x-ms-client-principal-name": ALICE.email,
					"x-csrf-token": csrf2,
				},
			},
		);
		expect(delRes.status).toBe(200);
		const finalSnapshot = await rig.server.repositoryRegistry?.list();
		expect(finalSnapshot?.repositories.map((r) => r.name).sort()).toEqual([
			"alpha",
			"beta",
			"gamma",
		]);
	});

	it("Step 5: the clone saving — a resolved issue's sandbox env names exactly one repository, not three", () => {
		const boot = boots.find((b) => b.issueKey === "BETA-1");
		const repos = cyrusReposJson(boot);
		expect(repos).toHaveLength(1);
		expect(repos[0]?.name).toBe("beta");
	});
});
