# Router Multi-Repository Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a router-mode (ACA) deployment register many repositories against its Linear workspace, nominate a default, associate repositories with Linear project/team names, and have the router pick the right repository before any sandbox boots.

**Architecture:** The matching rules move into `cyrus-core` as a pure function shared by the router and the edge worker. A global repository registry lives in Azure Table (file-backed in dev), seeded once from `containers.repositories`. `EventRouter` resolves the repository on `agentSessionCreated` using one Linear `fetchIssue`, persists the decision, and emits `CYRUS_REPOS_JSON` containing only the chosen repositories — so each sandbox clones one repo instead of all of them. Genuine ambiguity is resolved by a Linear elicitation posted by the router, with no container running while the user decides.

**Tech Stack:** TypeScript (strict, ESM, `.js` import specifiers), Zod 4, Vitest 4, Fastify 5, better-sqlite3, htmx + Pico CSS (vendored), Azure Table REST.

## Global Constraints

- **Language/tooling:** TypeScript strict mode, zero `any`. Package manager is pnpm (`pnpm@10.33.1`). Tests are Vitest. ESM only — every relative import ends in `.js`.
- **Spec:** `docs/superpowers/specs/2026-08-05-router-multi-repo-routing-design.md`. Read it before starting.
- **Routing priority, highest first:** description tag → routing labels → project name → team key → `isDefault`. Ties *within* one tier are ambiguous; matches across different tiers are not — the higher tier wins.
- **Project and team matching is case-insensitive whole-name.** Never substring.
- **Association syntax:** comma-separated `key=value`; `p` and `t` are the only keys and both repeatable; values may be double-quoted to contain commas or leading/trailing whitespace; unquoted values are trimmed.
- **Elicit only** on a tie within a tier, or no match with no default set.
- **Registry seeding is once-only.** After the registry is non-empty, `containers.repositories` is inert and the router logs that on every start.
- **Registry storage is plaintext JSON**, never envelope-encrypted — repository names and `org/repo` slugs are not secrets, and the registry must work without the *Key Vault Crypto User* role.
- **Reserved Azure Table partition key:** `g` + 64 zeros. It cannot collide with `setupPartitionKey`'s `u` + sha256 user keys.
- **Repository `name` pattern:** `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. It becomes `$WORKSPACES/repos/<name>` inside the sandbox and the `RepositoryConfig.id`.
- **GitHub slug pattern:** `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$`.
- **Setup UI invariants that must not regress:** `requireMutation` order is principal → CSRF → registration → fields; CSRF is read from body or `X-CSRF-Token` header, **never** the query string; DELETE controls carry CSRF as a header with `hx-params="none"`; the version token is captured at render time, not inside the save handler; no stored value is ever echoed into a response.
- **Never commit with `--no-verify`.** The pre-commit hook runs `pnpm build` and `pnpm typecheck`; both must pass.

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `packages/core/src/routing/associations.ts` | Parse/format the `p=`/`t=` association string. |
| `packages/core/src/routing/repoTags.ts` | Parse `[repo=…]` / `repo=…` description tags. Moved verbatim from `RepositoryRouter`. |
| `packages/core/src/routing/matchRepositories.ts` | The pure priority matcher. No I/O. |
| `packages/core/src/routing/index.ts` | Barrel re-export for the three above. |
| `packages/core/test/routing/associations.test.ts` | Parser/formatter round-trip and error cases. |
| `packages/core/test/routing/matchRepositories.test.ts` | Table-driven matcher cases. |
| `packages/router/src/RepositoryRegistry.ts` | `RegisteredRepository`, the `RepositoryRegistry` interface, `FileRepositoryRegistry`, and the `toRoutable` adapter. |
| `packages/router/src/TableRepositoryRegistry.ts` | Azure Table backend, plaintext JSON with ETag conditional writes. |
| `packages/router/src/RepositoryResolver.ts` | Registry + facts + matcher → a decision or a selection request. |
| `packages/router/src/setup/repositoryViews.ts` | Pure HTML rendering for the repositories page. |
| `packages/router/src/setup/repositoryRoutes.ts` | HTTP surface for `/setup/repositories*`. |
| `packages/router/test/RepositoryRegistry.test.ts` | File backend + `toRoutable`. |
| `packages/router/test/TableRepositoryRegistry.test.ts` | ETag conflict, seeding, plaintext round-trip. |
| `packages/router/test/RepositoryResolver.test.ts` | Resolution outcomes. |
| `packages/router/test/EventRouter.repo-selection.test.ts` | created → elicit → prompted → boot. |
| `packages/router/test/setup-repository-routes.test.ts` | CSRF, version token, validation. |
| `packages/router/test/setup-repository-views.test.ts` | Rendering and escaping. |
| `apps/f1/test-drives/router-multi-repo.md` | End-to-end validation record. |

**Modified:**

| File | Change |
| --- | --- |
| `packages/core/src/config-schemas.ts:272` | Add `isDefault` to `RepositoryConfigSchema`. |
| `packages/core/src/index.ts` | Export the routing module. |
| `packages/core/src/issue-tracker/types.ts` | Add the `Project` type alias. |
| `packages/core/src/issue-tracker/IIssueTrackerService.ts` | Declare `fetchProject`. |
| `packages/edge-worker/src/RepositoryRouter.ts` | Delegate matching to `matchRepositories`. |
| `packages/linear-event-transport/src/LinearIssueTrackerService.ts` | Implement `fetchProject`. |
| `packages/router-protocol/src/rpc-methods.ts` | Add `"fetchProject"`. |
| `packages/router-client/src/RouterIssueTrackerService.ts:237` | Implement the `project` getter. |
| `packages/router/src/RouterStore.ts` | Two new tables and their accessors. |
| `packages/router/src/LinearExecutor.ts:169` | Signal support on `postActivity`; add `fetchIssueFacts`. |
| `packages/router/src/EventRouter.ts` | Hold-and-elicit on created; intercept the answering prompt. |
| `packages/router/src/ContainerTargets.ts` | Per-issue `CYRUS_REPOS_JSON` via a live registry seam. |
| `packages/router/src/RouterServer.ts` | Build the registry, resolver, and repository routes. |
| `packages/router/src/setup/routes.ts` | Nav link to the repositories page. |
| `apps/cli/src/commands/RouterCommand.ts:177` | Widen the `containers.repositories` Zod schema. |
| `apps/cli/src/commands/ContainerBootCommand.ts:66,674` | Routing metadata on `RepoSpec` and in `buildRepositoryConfig`. |
| `docs/ROUTER.md:312` | Registry documentation. |
| `CLAUDE.md` | Three new router invariants. |
| `CHANGELOG.md` | User-facing entry. |

## Task Dependency Order

Tasks 1–3 (core) gate everything. Tasks 4–6 (registry) and 13 (`fetchProject`) are independent of each other. Tasks 7–11 (router resolution) depend on 1–6. Task 12 depends on 1. Tasks 14–16 (UI) depend on 4–6. Tasks 17–18 come last.

---

### Task 1: Association parser and the `isDefault` schema field

**Files:**
- Create: `packages/core/src/routing/associations.ts`
- Create: `packages/core/src/routing/index.ts`
- Modify: `packages/core/src/config-schemas.ts` (around line 287)
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/routing/associations.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface RepositoryAssociations { projectKeys: string[]; teamKeys: string[] }`
  - `class AssociationParseError extends Error`
  - `function parseAssociations(input: string): RepositoryAssociations`
  - `function formatAssociations(input: { projectKeys?: string[]; teamKeys?: string[] }): string`
  - `RepositoryConfigSchema` gains `isDefault?: boolean`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/routing/associations.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	AssociationParseError,
	formatAssociations,
	parseAssociations,
} from "../../src/routing/associations.js";

describe("parseAssociations", () => {
	it("returns empty arrays for an empty string", () => {
		expect(parseAssociations("")).toEqual({ projectKeys: [], teamKeys: [] });
		expect(parseAssociations("   ")).toEqual({ projectKeys: [], teamKeys: [] });
	});

	it("parses repeated p= and t= keys in order", () => {
		expect(parseAssociations("p=Platform,p=Billing,t=NOR")).toEqual({
			projectKeys: ["Platform", "Billing"],
			teamKeys: ["NOR"],
		});
	});

	it("trims whitespace around unquoted values and separators", () => {
		expect(parseAssociations("  p = Platform , t = NOR  ")).toEqual({
			projectKeys: ["Platform"],
			teamKeys: ["NOR"],
		});
	});

	it("keeps commas and spacing inside double-quoted values", () => {
		expect(parseAssociations('p="Q3 Migration, Phase 2",t=ENG')).toEqual({
			projectKeys: ["Q3 Migration, Phase 2"],
			teamKeys: ["ENG"],
		});
	});

	it("preserves leading and trailing spaces inside quotes", () => {
		expect(parseAssociations('p=" padded "')).toEqual({
			projectKeys: [" padded "],
			teamKeys: [],
		});
	});

	it("de-duplicates case-insensitively, keeping the first spelling", () => {
		expect(parseAssociations("t=NOR,t=nor,p=Platform,p=PLATFORM")).toEqual({
			projectKeys: ["Platform"],
			teamKeys: ["NOR"],
		});
	});

	it("rejects an unknown key", () => {
		expect(() => parseAssociations("x=Platform")).toThrow(AssociationParseError);
		expect(() => parseAssociations("x=Platform")).toThrow(
			'Unknown key "x". Use p= for a project name or t= for a team key.',
		);
	});

	it("rejects a pair with no equals sign", () => {
		expect(() => parseAssociations("Platform")).toThrow(
			'Expected key=value but got "Platform". Use p= for a project name or t= for a team key.',
		);
	});

	it("rejects an empty value", () => {
		expect(() => parseAssociations("p=,t=NOR")).toThrow(
			'The value for "p" is empty.',
		);
	});

	it("rejects an unterminated quote", () => {
		expect(() => parseAssociations('p="Q3 Migration')).toThrow(
			"Unterminated quoted value.",
		);
	});

	it("rejects trailing characters after a closing quote", () => {
		expect(() => parseAssociations('p="Platform"x')).toThrow(
			'Unexpected characters after the closing quote in "p".',
		);
	});
});

describe("formatAssociations", () => {
	it("returns an empty string when there is nothing to format", () => {
		expect(formatAssociations({})).toBe("");
		expect(formatAssociations({ projectKeys: [], teamKeys: [] })).toBe("");
	});

	it("emits projects before teams", () => {
		expect(
			formatAssociations({
				projectKeys: ["Platform", "Billing"],
				teamKeys: ["NOR"],
			}),
		).toBe("p=Platform,p=Billing,t=NOR");
	});

	it("quotes values containing a comma, an equals sign, a quote, or edge whitespace", () => {
		expect(formatAssociations({ projectKeys: ["Q3, Phase 2"] })).toBe(
			'p="Q3, Phase 2"',
		);
		expect(formatAssociations({ projectKeys: [" padded "] })).toBe(
			'p=" padded "',
		);
		expect(formatAssociations({ projectKeys: ['say "hi"'] })).toBe(
			'p="say \\"hi\\""',
		);
	});

	it("round-trips through parseAssociations", () => {
		const original = {
			projectKeys: ["Q3, Phase 2", " padded ", 'say "hi"', "Platform"],
			teamKeys: ["NOR", "ENG"],
		};
		expect(parseAssociations(formatAssociations(original))).toEqual(original);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-core test:run test/routing/associations.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/routing/associations.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/routing/associations.ts`:

```ts
/**
 * The `p=`/`t=` association string used by the router's setup UI to bind a
 * repository to Linear project and team names.
 *
 * Grammar: comma-separated `key=value` pairs. `p` (project name) and `t` (team
 * key) are the only keys and both are repeatable. A value may be double-quoted
 * to contain commas, equals signs, or edge whitespace; an unquoted value is
 * trimmed. Anything else is a parse error whose message is written to be shown
 * to a user verbatim.
 *
 *   p=Platform,p=Billing,t=NOR   ->  projects [Platform, Billing], teams [NOR]
 *   p="Q3 Migration",t=ENG       ->  projects [Q3 Migration],      teams [ENG]
 */

/** Parsed associations, in the order they were written. */
export interface RepositoryAssociations {
	projectKeys: string[];
	teamKeys: string[];
}

/** A malformed association string. `message` is user-facing copy. */
export class AssociationParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AssociationParseError";
	}
}

const KEY_HELP = "Use p= for a project name or t= for a team key.";

/**
 * Splits on commas that are not inside a double-quoted value.
 *
 * A plain `input.split(",")` would tear `p="Q3, Phase 2"` in half, so the scan
 * tracks quote state. A backslash inside quotes escapes the next character,
 * which is what lets a value contain a literal quote.
 */
function splitPairs(input: string): string[] {
	const pairs: string[] = [];
	let current = "";
	let inQuotes = false;
	let escaped = false;

	for (const char of input) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && inQuotes) {
			current += char;
			escaped = true;
			continue;
		}
		if (char === '"') {
			inQuotes = !inQuotes;
			current += char;
			continue;
		}
		if (char === "," && !inQuotes) {
			pairs.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (inQuotes) throw new AssociationParseError("Unterminated quoted value.");
	pairs.push(current);
	return pairs;
}

/**
 * Reads one value, which is either a double-quoted string (returned with its
 * escapes resolved and its surrounding whitespace preserved) or a bare run of
 * characters (returned trimmed).
 */
function readValue(key: string, raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed.startsWith('"')) {
		if (trimmed === "") {
			throw new AssociationParseError(`The value for "${key}" is empty.`);
		}
		return trimmed;
	}

	let value = "";
	let closed = false;
	let index = 1;
	for (; index < trimmed.length; index++) {
		const char = trimmed[index] as string;
		if (char === "\\" && index + 1 < trimmed.length) {
			index += 1;
			value += trimmed[index] as string;
			continue;
		}
		if (char === '"') {
			closed = true;
			index += 1;
			break;
		}
		value += char;
	}
	if (!closed) throw new AssociationParseError("Unterminated quoted value.");
	if (trimmed.slice(index).trim() !== "") {
		throw new AssociationParseError(
			`Unexpected characters after the closing quote in "${key}".`,
		);
	}
	if (value === "") {
		throw new AssociationParseError(`The value for "${key}" is empty.`);
	}
	return value;
}

/**
 * Appends `value` unless a case-insensitive equal is already present. Keeping
 * the FIRST spelling matters: it is what the UI renders back to the user, and
 * matching is case-insensitive anyway, so a later differing case carries no
 * information worth preserving.
 */
function pushUnique(target: string[], value: string): void {
	const folded = value.toLowerCase();
	if (target.some((existing) => existing.toLowerCase() === folded)) return;
	target.push(value);
}

export function parseAssociations(input: string): RepositoryAssociations {
	const result: RepositoryAssociations = { projectKeys: [], teamKeys: [] };
	if (input.trim() === "") return result;

	for (const pair of splitPairs(input)) {
		if (pair.trim() === "") continue;
		const separator = pair.indexOf("=");
		if (separator < 0) {
			throw new AssociationParseError(
				`Expected key=value but got "${pair.trim()}". ${KEY_HELP}`,
			);
		}
		const key = pair.slice(0, separator).trim().toLowerCase();
		const value = readValue(key, pair.slice(separator + 1));

		if (key === "p") pushUnique(result.projectKeys, value);
		else if (key === "t") pushUnique(result.teamKeys, value);
		else {
			throw new AssociationParseError(`Unknown key "${key}". ${KEY_HELP}`);
		}
	}
	return result;
}

/** True when `value` cannot be written bare without changing its meaning. */
function needsQuoting(value: string): boolean {
	return (
		value !== value.trim() ||
		value.includes(",") ||
		value.includes("=") ||
		value.includes('"') ||
		value === ""
	);
}

export function formatAssociations(input: {
	projectKeys?: string[];
	teamKeys?: string[];
}): string {
	const render = (key: string, value: string): string => {
		if (!needsQuoting(value)) return `${key}=${value}`;
		const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
		return `${key}="${escaped}"`;
	};
	return [
		...(input.projectKeys ?? []).map((value) => render("p", value)),
		...(input.teamKeys ?? []).map((value) => render("t", value)),
	].join(",");
}
```

Create `packages/core/src/routing/index.ts`:

```ts
export type { RepositoryAssociations } from "./associations.js";
export {
	AssociationParseError,
	formatAssociations,
	parseAssociations,
} from "./associations.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter cyrus-core test:run test/routing/associations.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Add `isDefault` to the repository schema**

In `packages/core/src/config-schemas.ts`, immediately after the `projectKeys` line (currently line 287):

```ts
	projectKeys: z.array(z.string()).optional(),

	/**
	 * Selected when no higher-priority routing method matches. At most one
	 * repository per Linear workspace should set this.
	 *
	 * Replaces the implicit catch-all — "the first repository that happens to
	 * have no routing configuration" — which silently switched off the moment
	 * routing metadata was added to every repository.
	 */
	isDefault: z.boolean().optional(),
```

- [ ] **Step 6: Export the routing module from core**

In `packages/core/src/index.ts`, add alongside the other re-exports:

```ts
// Repository routing — shared by the edge worker and the router so the two
// can never disagree about which repository an issue belongs to.
export type {
	RepositoryAssociations,
} from "./routing/index.js";
export {
	AssociationParseError,
	formatAssociations,
	parseAssociations,
} from "./routing/index.js";
```

- [ ] **Step 7: Verify the schema change did not break the JSON schema snapshot**

Run: `pnpm --filter cyrus-core test:run`
Expected: PASS. If `json-schema-export.test.ts` fails, regenerate the committed schemas it compares against (`packages/core/schemas/RepositoryConfig.json` and `RepositoryConfigPayload.json`) by following the regeneration command named in that test's failure output, then re-run.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/routing packages/core/test/routing packages/core/src/config-schemas.ts packages/core/src/index.ts packages/core/schemas
git commit -m "feat(core): add repository association parser and isDefault flag"
```

---

### Task 2: The shared repository matcher

**Files:**
- Create: `packages/core/src/routing/repoTags.ts`
- Create: `packages/core/src/routing/matchRepositories.ts`
- Modify: `packages/core/src/routing/index.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/routing/matchRepositories.test.ts`

**Interfaces:**
- Consumes: Task 1's `packages/core/src/routing/index.ts` barrel.
- Produces:
  - `interface RepoTag { repo: string; branch?: string }`
  - `function parseRepoTags(description: string): RepoTag[]`
  - `interface RoutableRepository { id: string; name: string; githubUrl?: string; gitlabUrl?: string; teamKeys?: string[]; routingLabels?: string[]; projectKeys?: string[]; isDefault?: boolean }`
  - `interface IssueFacts { teamKey?: string; projectName?: string; labels?: string[]; description?: string }`
  - `type RoutingMethod = "description-tag" | "label-based" | "project-based" | "team-based" | "default"`
  - `type MatchResult<T>` — see the code below
  - `function matchRepositories<T extends RoutableRepository>(facts: IssueFacts, repositories: readonly T[]): MatchResult<T>`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/routing/matchRepositories.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	matchRepositories,
	type RoutableRepository,
} from "../../src/routing/matchRepositories.js";

function repo(
	id: string,
	overrides: Partial<RoutableRepository> = {},
): RoutableRepository {
	return {
		id,
		name: id,
		githubUrl: `https://github.com/acme/${id}`,
		...overrides,
	};
}

const API = repo("cyrus-api", { projectKeys: ["Platform"], teamKeys: ["NOR"] });
const WEB = repo("cyrus-web", { teamKeys: ["WEB"] });
const INFRA = repo("cyrus-infra", { isDefault: true });
const ALL = [API, WEB, INFRA];

describe("matchRepositories", () => {
	it("returns unmatched for an empty registry", () => {
		expect(matchRepositories({ teamKey: "NOR" }, [])).toEqual({
			kind: "unmatched",
		});
	});

	it("matches a description tag by repository name", () => {
		const result = matchRepositories({ description: "[repo=cyrus-web]" }, ALL);
		expect(result).toMatchObject({
			kind: "matched",
			method: "description-tag",
		});
		expect(result.kind === "matched" && result.repositories).toEqual([WEB]);
	});

	it("matches a description tag by hosting URL suffix without substring bleed", () => {
		const hosted = repo("cyrus", { githubUrl: "https://github.com/acme/cyrus" });
		const hostedLong = repo("cyrus-hosted", {
			githubUrl: "https://github.com/acme/cyrus-hosted",
		});
		const result = matchRepositories({ description: "[repo=cyrus]" }, [
			hostedLong,
			hosted,
		]);
		expect(result.kind === "matched" && result.repositories).toEqual([hosted]);
	});

	it("carries per-repository base branch overrides from a tag", () => {
		const result = matchRepositories(
			{ description: "repo=cyrus-api,cyrus-web#release" },
			ALL,
		);
		expect(result.kind === "matched" && result.baseBranchOverrides).toEqual(
			new Map([
				["cyrus-api", "release"],
				["cyrus-web", "release"],
			]),
		);
	});

	it("prefers a description tag over labels, project, and team", () => {
		const labelled = repo("cyrus-web", {
			teamKeys: ["WEB"],
			routingLabels: ["frontend"],
		});
		const result = matchRepositories(
			{
				description: "[repo=cyrus-api]",
				labels: ["frontend"],
				projectKeys: undefined,
				teamKey: "WEB",
			} as never,
			[API, labelled],
		);
		expect(result).toMatchObject({ method: "description-tag" });
	});

	it("falls through to labels when no tag matches any repository", () => {
		const labelled = repo("cyrus-web", { routingLabels: ["frontend"] });
		const result = matchRepositories(
			{ description: "[repo=nonexistent]", labels: ["frontend"] },
			[API, labelled],
		);
		expect(result).toMatchObject({ kind: "matched", method: "label-based" });
		expect(result.kind === "matched" && result.repositories).toEqual([labelled]);
	});

	it("returns every repository whose routing labels match", () => {
		const a = repo("a", { routingLabels: ["shared"] });
		const b = repo("b", { routingLabels: ["shared"] });
		const result = matchRepositories({ labels: ["shared"] }, [a, b]);
		expect(result.kind === "matched" && result.repositories).toEqual([a, b]);
	});

	it("matches a project name case-insensitively", () => {
		const result = matchRepositories({ projectName: "pLaTfOrM" }, ALL);
		expect(result).toMatchObject({ kind: "matched", method: "project-based" });
		expect(result.kind === "matched" && result.repositories).toEqual([API]);
	});

	it("does not match a project name by substring", () => {
		const result = matchRepositories({ projectName: "Platform Migration" }, [
			API,
		]);
		expect(result).toEqual({ kind: "unmatched" });
	});

	it("matches a team key case-insensitively", () => {
		const result = matchRepositories({ teamKey: "web" }, ALL);
		expect(result).toMatchObject({ kind: "matched", method: "team-based" });
		expect(result.kind === "matched" && result.repositories).toEqual([WEB]);
	});

	it("prefers a project match over a team match on a different repository", () => {
		const result = matchRepositories(
			{ projectName: "Platform", teamKey: "WEB" },
			ALL,
		);
		expect(result).toMatchObject({ method: "project-based" });
		expect(result.kind === "matched" && result.repositories).toEqual([API]);
	});

	it("reports ambiguity when two repositories claim the same project", () => {
		const a = repo("a", { projectKeys: ["Platform"] });
		const b = repo("b", { projectKeys: ["platform"] });
		const result = matchRepositories({ projectName: "Platform" }, [a, b]);
		expect(result).toEqual({
			kind: "ambiguous",
			tier: "project",
			candidates: [a, b],
		});
	});

	it("reports ambiguity when two repositories claim the same team", () => {
		const a = repo("a", { teamKeys: ["NOR"] });
		const b = repo("b", { teamKeys: ["NOR"] });
		const result = matchRepositories({ teamKey: "NOR" }, [a, b]);
		expect(result).toEqual({
			kind: "ambiguous",
			tier: "team",
			candidates: [a, b],
		});
	});

	it("does not treat a cross-tier match as ambiguous", () => {
		const projectOnly = repo("a", { projectKeys: ["Platform"] });
		const teamOnly = repo("b", { teamKeys: ["NOR"] });
		const result = matchRepositories(
			{ projectName: "Platform", teamKey: "NOR" },
			[projectOnly, teamOnly],
		);
		expect(result).toMatchObject({ kind: "matched", method: "project-based" });
	});

	it("falls back to the default repository when nothing else matches", () => {
		const result = matchRepositories({ teamKey: "UNKNOWN" }, ALL);
		expect(result).toMatchObject({ kind: "matched", method: "default" });
		expect(result.kind === "matched" && result.repositories).toEqual([INFRA]);
	});

	it("reports ambiguity when two repositories are marked default", () => {
		const a = repo("a", { isDefault: true });
		const b = repo("b", { isDefault: true });
		const result = matchRepositories({}, [a, b]);
		expect(result).toEqual({
			kind: "ambiguous",
			tier: "default",
			candidates: [a, b],
		});
	});

	it("returns unmatched when nothing matches and no default is set", () => {
		expect(matchRepositories({ teamKey: "UNKNOWN" }, [API, WEB])).toEqual({
			kind: "unmatched",
		});
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-core test:run test/routing/matchRepositories.test.ts`
Expected: FAIL — cannot resolve `../../src/routing/matchRepositories.js`.

- [ ] **Step 3: Move the description-tag parser into core**

Create `packages/core/src/routing/repoTags.ts`. The body is lifted verbatim from
`RepositoryRouter.parseRepoTagsFromDescription` / `parseRepoValue`
(`packages/edge-worker/src/RepositoryRouter.ts:500-558`) so the existing
`RepositoryRouter` test suite keeps passing unchanged:

```ts
/**
 * `[repo=…]` description-tag parsing. Moved out of `RepositoryRouter` so the
 * router and the edge worker share one implementation; the behaviour is
 * unchanged and is pinned by the existing `RepositoryRouter` test suite.
 */

/** One parsed tag: a repository reference and an optional base-branch override. */
export interface RepoTag {
	repo: string;
	branch?: string;
}

/**
 * A repo value may name several repositories and end in `#branch`. The branch
 * applies to every repository in the comma-separated list.
 */
function parseRepoValue(value: string): RepoTag[] {
	const hashIndex = value.indexOf("#");
	let reposPart: string;
	let branch: string | undefined;

	if (hashIndex !== -1) {
		reposPart = value.slice(0, hashIndex);
		branch = value.slice(hashIndex + 1);
		if (!branch) branch = undefined;
	} else {
		reposPart = value;
	}

	return reposPart
		.split(",")
		.map((repo) => repo.trim())
		.filter((repo) => repo.length > 0)
		.map((repo) => (branch ? { repo, branch } : { repo }));
}

/**
 * Supported syntaxes:
 * - `[repo=name]` / `[repo=name#branch]` — bracketed, one repository per tag
 * - `repo=name,name2#branch` — unbracketed, comma-separated
 * - `repos=name,name2#branch` — the same with a plural key
 *
 * Escaped brackets (`\[repo=…\]`), which Linear sometimes produces, are handled.
 * Duplicates are removed, keeping the first occurrence.
 */
export function parseRepoTags(description: string): RepoTag[] {
	const tags: RepoTag[] = [];

	// Pattern 1: bracketed [repo=...]
	const bracketRegex = /\\?\[repo=([a-zA-Z0-9_\-/.#]+)\\?\]/g;
	for (const match of description.matchAll(bracketRegex)) {
		if (match[1]) tags.push(...parseRepoValue(match[1]));
	}

	// Pattern 2: unbracketed repos?=... — anchored to a line start or whitespace
	// so it cannot fire inside a URL or a filesystem path.
	const unbracketedRegex = /(?:^|[\s\n])repos?=([a-zA-Z0-9_\-/.#,]+)/gm;
	for (const match of description.matchAll(unbracketedRegex)) {
		if (match[1]) tags.push(...parseRepoValue(match[1]));
	}

	const seen = new Set<string>();
	return tags.filter((tag) => {
		if (seen.has(tag.repo)) return false;
		seen.add(tag.repo);
		return true;
	});
}
```

- [ ] **Step 4: Write the matcher**

Create `packages/core/src/routing/matchRepositories.ts`:

```ts
import { parseRepoTags } from "./repoTags.js";

/**
 * The minimum a repository must expose to be routed to. `RepositoryConfig`
 * satisfies this structurally; the router adapts its own registry entries onto
 * it. Deliberately narrower than `RepositoryConfig` so this module never
 * depends on the persistence schema.
 */
export interface RoutableRepository {
	id: string;
	name: string;
	githubUrl?: string;
	gitlabUrl?: string;
	teamKeys?: string[];
	routingLabels?: string[];
	projectKeys?: string[];
	isDefault?: boolean;
}

/** Everything about an issue that can influence routing. */
export interface IssueFacts {
	teamKey?: string;
	projectName?: string;
	labels?: string[];
	description?: string;
}

export type RoutingMethod =
	| "description-tag"
	| "label-based"
	| "project-based"
	| "team-based"
	| "default";

/** Tiers that can be ambiguous. Labels never are — every label match is used. */
export type AmbiguousTier = "project" | "team" | "default";

export type MatchResult<T extends RoutableRepository = RoutableRepository> =
	| {
			kind: "matched";
			repositories: T[];
			method: RoutingMethod;
			/** Repository id -> base branch, from `#branch` in a description tag. */
			baseBranchOverrides?: Map<string, string>;
	  }
	| { kind: "ambiguous"; candidates: T[]; tier: AmbiguousTier }
	| { kind: "unmatched" };

/** Case-insensitive whole-name membership. Never substring — see the spec. */
function includesFolded(
	haystack: readonly string[] | undefined,
	needle: string,
): boolean {
	if (!haystack) return false;
	const folded = needle.toLowerCase();
	return haystack.some((entry) => entry.toLowerCase() === folded);
}

/** Does a `[repo=x]` tag name this repository, by URL, name, or id? */
function tagMatches<T extends RoutableRepository>(repo: T, tag: string): boolean {
	// endsWith on the URL path segment, so "cyrus" cannot match "cyrus-hosted".
	if (
		repo.githubUrl?.endsWith(`/${tag}`) ||
		repo.githubUrl?.endsWith(`/${tag}.git`) ||
		repo.gitlabUrl?.endsWith(`/${tag}`) ||
		repo.gitlabUrl?.endsWith(`/${tag}.git`)
	) {
		return true;
	}
	if (repo.name.toLowerCase() === tag.toLowerCase()) return true;
	return repo.id === tag;
}

/**
 * Picks the repositories an issue belongs to, in priority order:
 *
 *   1. description tag   `[repo=…]`, explicit and always wins
 *   2. routing labels    every matching repository is returned
 *   3. project name      case-insensitive whole-name
 *   4. team key          case-insensitive whole-name
 *   5. isDefault         the configured fallback
 *
 * Two or more repositories matching within the SAME tier is `ambiguous` — the
 * caller decides whether to ask the user. Matches in DIFFERENT tiers are not
 * ambiguous: the higher tier wins outright.
 *
 * Pure: no I/O, no clock, no logging. Fact-gathering belongs to the caller.
 */
export function matchRepositories<T extends RoutableRepository>(
	facts: IssueFacts,
	repositories: readonly T[],
): MatchResult<T> {
	if (repositories.length === 0) return { kind: "unmatched" };

	// 1. Description tags.
	if (facts.description) {
		const tags = parseRepoTags(facts.description);
		const matched: T[] = [];
		const matchedIds = new Set<string>();
		const baseBranchOverrides = new Map<string, string>();
		for (const tag of tags) {
			for (const repo of repositories) {
				if (matchedIds.has(repo.id)) continue;
				if (!tagMatches(repo, tag.repo)) continue;
				matched.push(repo);
				matchedIds.add(repo.id);
				if (tag.branch) baseBranchOverrides.set(repo.id, tag.branch);
			}
		}
		if (matched.length > 0) {
			return {
				kind: "matched",
				repositories: matched,
				method: "description-tag",
				...(baseBranchOverrides.size > 0 ? { baseBranchOverrides } : {}),
			};
		}
	}

	// 2. Routing labels. Multiple matches are intentional, not ambiguous: a
	//    label deliberately fans an issue out across repositories.
	if (facts.labels && facts.labels.length > 0) {
		const matched = repositories.filter((repo) =>
			facts.labels?.some((label) => includesFolded(repo.routingLabels, label)),
		);
		if (matched.length > 0) {
			return { kind: "matched", repositories: matched, method: "label-based" };
		}
	}

	// 3. Project name.
	if (facts.projectName) {
		const matched = repositories.filter((repo) =>
			includesFolded(repo.projectKeys, facts.projectName as string),
		);
		if (matched.length === 1) {
			return {
				kind: "matched",
				repositories: matched,
				method: "project-based",
			};
		}
		if (matched.length > 1) {
			return { kind: "ambiguous", candidates: matched, tier: "project" };
		}
	}

	// 4. Team key.
	if (facts.teamKey) {
		const matched = repositories.filter((repo) =>
			includesFolded(repo.teamKeys, facts.teamKey as string),
		);
		if (matched.length === 1) {
			return { kind: "matched", repositories: matched, method: "team-based" };
		}
		if (matched.length > 1) {
			return { kind: "ambiguous", candidates: matched, tier: "team" };
		}
	}

	// 5. The configured default.
	const defaults = repositories.filter((repo) => repo.isDefault === true);
	if (defaults.length === 1) {
		return { kind: "matched", repositories: defaults, method: "default" };
	}
	if (defaults.length > 1) {
		return { kind: "ambiguous", candidates: defaults, tier: "default" };
	}

	return { kind: "unmatched" };
}
```

- [ ] **Step 5: Export from the barrel and the package index**

Append to `packages/core/src/routing/index.ts`:

```ts
export type {
	AmbiguousTier,
	IssueFacts,
	MatchResult,
	RoutableRepository,
	RoutingMethod,
} from "./matchRepositories.js";
export { matchRepositories } from "./matchRepositories.js";
export type { RepoTag } from "./repoTags.js";
export { parseRepoTags } from "./repoTags.js";
```

Extend the routing block added to `packages/core/src/index.ts` in Task 1:

```ts
export type {
	AmbiguousTier,
	IssueFacts,
	MatchResult,
	RepositoryAssociations,
	RepoTag,
	RoutableRepository,
	RoutingMethod,
} from "./routing/index.js";
export {
	AssociationParseError,
	formatAssociations,
	matchRepositories,
	parseAssociations,
	parseRepoTags,
} from "./routing/index.js";
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter cyrus-core test:run test/routing/`
Expected: PASS — 15 association tests plus 17 matcher tests.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/routing packages/core/test/routing packages/core/src/index.ts
git commit -m "feat(core): add shared repository matcher with default-repo tier"
```

---

### Task 3: Delegate `RepositoryRouter` to the shared matcher

**Files:**
- Modify: `packages/edge-worker/src/RepositoryRouter.ts`
- Test: `packages/edge-worker/test/RepositoryRouter.test.ts` (existing suite must pass unchanged, plus two new cases)

**Interfaces:**
- Consumes: `matchRepositories`, `parseRepoTags`, `RoutableRepository` from `cyrus-core` (Task 2).
- Produces: `RepositoryRoutingResult` gains `"default"` in its `routingMethod` union. `RepositoryRouter.parseRepoTagsFromDescription` keeps its exact public signature.

- [ ] **Step 1: Write the failing test**

Append inside the top-level `describe("RepositoryRouter", …)` block in
`packages/edge-worker/test/RepositoryRouter.test.ts`, after the existing
priority describes. Use the file's existing `env` fixture and repository-builder
helpers rather than inventing new ones — read the top of the file first and
mirror how `Priority 3: Project` cases construct their repositories.

```ts
	describe("Default repository routing", () => {
		it("routes to the isDefault repository when nothing else matches", async () => {
			const fallback = { ...env.repoA, id: "fallback", name: "fallback", isDefault: true, teamKeys: [], routingLabels: [], projectKeys: [] };
			const other = { ...env.repoB, id: "other", name: "other", teamKeys: ["OTHER"] };
			env.deps.fetchIssueLabels.mockResolvedValue([]);
			env.deps.fetchIssueDescription.mockResolvedValue("");

			const result = await env.router.determineRepositoryForWebhook(
				env.createdWebhook({ teamKey: "UNKNOWN" }),
				[other, fallback],
			);

			expect(result).toMatchObject({ type: "selected", routingMethod: "default" });
			expect(result.type === "selected" && result.repositories).toEqual([fallback]);
		});

		it("prefers isDefault over the deprecated implicit catch-all", async () => {
			const implicitCatchAll = { ...env.repoA, id: "implicit", name: "implicit", teamKeys: [], routingLabels: [], projectKeys: [] };
			const explicitDefault = { ...env.repoB, id: "explicit", name: "explicit", isDefault: true, teamKeys: ["X"] };
			env.deps.fetchIssueLabels.mockResolvedValue([]);
			env.deps.fetchIssueDescription.mockResolvedValue("");

			const result = await env.router.determineRepositoryForWebhook(
				env.createdWebhook({ teamKey: "UNKNOWN" }),
				[implicitCatchAll, explicitDefault],
			);

			expect(result.type === "selected" && result.repositories).toEqual([explicitDefault]);
		});
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-edge-worker test:run test/RepositoryRouter.test.ts`
Expected: FAIL — the first case yields `routingMethod: "catch-all"`, the second selects `implicit`.

- [ ] **Step 3: Replace the matching internals**

In `packages/edge-worker/src/RepositoryRouter.ts`:

1. Add to the `cyrus-core` import: `matchRepositories`, `parseRepoTags`, and the types `IssueFacts`, `RoutingMethod as CoreRoutingMethod`.
2. Add `"default"` to the `routingMethod` union in `RepositoryRoutingResult` (line 21).
3. Replace the bodies of `findRepositoriesByLabels`, `findRepositoriesByDescriptionTag`, `findRepositoryByProject`, and `findRepositoryByTeamKey` with a single fact-gathering step followed by one `matchRepositories` call. Keep Priority 0 (active session) and the workspace filter exactly as they are — they run before the matcher.

Replace the block from the workspace filter (line 206) through the end of the
catch-all block (line 334) with:

```ts
		// Filter repos by workspace
		const workspaceRepos = repos.filter(
			(repo) => repo.linearWorkspaceId === workspaceId,
		);
		if (workspaceRepos.length === 0) return { type: "none" };

		const facts = await this.gatherFacts(issueId, workspaceId, teamKey);
		const match = matchRepositories(facts, workspaceRepos);

		if (match.kind === "matched") {
			this.logger.info(
				`Repositories selected: [${match.repositories.map((r) => r.name).join(", ")}] (${match.method} routing)`,
			);
			if (match.baseBranchOverrides && match.baseBranchOverrides.size > 0) {
				const overrideEntries = Array.from(match.baseBranchOverrides.entries())
					.map(([id, branch]) => `${id}→${branch}`)
					.join(", ");
				this.logger.info(
					`Base branch overrides from description tags: ${overrideEntries}`,
				);
			}
			return {
				type: "selected",
				repositories: match.repositories,
				...(match.baseBranchOverrides
					? { baseBranchOverrides: match.baseBranchOverrides }
					: {}),
				routingMethod: match.method,
			};
		}

		if (match.kind === "ambiguous") {
			this.logger.info(
				`Ambiguous ${match.tier} routing across [${match.candidates
					.map((r) => r.name)
					.join(", ")}] - requesting user selection`,
			);
			return { type: "needs_selection", workspaceRepos: match.candidates };
		}

		// Deprecated implicit catch-all, kept so an existing self-hosted
		// config.json that predates `isDefault` keeps working. Sits BELOW the
		// matcher's `default` tier: an explicit isDefault always wins.
		// TODO(CYPACK): remove once self-hosted configs have migrated to isDefault.
		const catchAllRepo = workspaceRepos.find(
			(repo) =>
				(!repo.teamKeys || repo.teamKeys.length === 0) &&
				(!repo.routingLabels || repo.routingLabels.length === 0) &&
				(!repo.projectKeys || repo.projectKeys.length === 0),
		);
		if (catchAllRepo) {
			this.logger.info(
				`Repository selected: ${catchAllRepo.name} (workspace catch-all)`,
			);
			return {
				type: "selected",
				repositories: [catchAllRepo],
				routingMethod: "catch-all",
			};
		}

		// Try parsing issue identifier as fallback for team routing
		// TODO: Remove team prefix routing - should rely on explicit team-based routing only
		if (issueIdentifier?.includes("-")) {
			const prefix = issueIdentifier.split("-")[0];
			if (prefix) {
				const repo = workspaceRepos.find((r) => r.teamKeys?.includes(prefix));
				if (repo) {
					this.logger.info(
						`Repository selected: ${repo.name} (team prefix routing)`,
					);
					return {
						type: "selected",
						repositories: [repo],
						routingMethod: "team-prefix",
					};
				}
			}
		}

		this.logger.info(
			`No routing match for ${workspaceRepos.length} workspace repositories - requesting user selection`,
		);
		return { type: "needs_selection", workspaceRepos };
```

Add the fact-gathering method, which keeps each existing lookup's
error-swallowing behaviour:

```ts
	/**
	 * Collects everything the matcher needs, tolerating a failure in any single
	 * lookup. A failed description fetch must not suppress label routing, which
	 * is why each source is guarded separately rather than in one try block.
	 */
	private async gatherFacts(
		issueId: string | undefined,
		workspaceId: string,
		teamKey: string | undefined,
	): Promise<IssueFacts> {
		const facts: IssueFacts = {};
		if (teamKey) facts.teamKey = teamKey;
		if (!issueId) return facts;

		try {
			const description = await this.deps.fetchIssueDescription(
				issueId,
				workspaceId,
			);
			if (description) facts.description = description;
		} catch (error) {
			this.logger.error(`Failed to fetch description for routing:`, error);
		}

		try {
			facts.labels = await this.deps.fetchIssueLabels(issueId, workspaceId);
		} catch (error) {
			this.logger.error(`Failed to fetch labels for routing:`, error);
		}

		try {
			const issueTracker = this.deps.getIssueTracker(workspaceId);
			if (issueTracker) {
				const fullIssue = await issueTracker.fetchIssue(issueId);
				const project = await fullIssue?.project;
				if (project?.name) facts.projectName = project.name;
			} else {
				this.logger.warn(`No issue tracker found for workspace ${workspaceId}`);
			}
		} catch (error) {
			this.logger.debug(
				`Failed to fetch project for issue ${issueId}:`,
				error,
			);
		}

		return facts;
	}
```

Finally, replace the body of `parseRepoTagsFromDescription` so the public method
survives for its existing tests while the logic lives in core, and delete the
now-unused private `parseRepoValue`:

```ts
	/**
	 * @deprecated Use `parseRepoTags` from `cyrus-core`. Retained as a thin
	 * delegate because it is public API with an extensive test suite.
	 */
	parseRepoTagsFromDescription(
		description: string,
	): { repo: string; branch?: string }[] {
		return parseRepoTags(description);
	}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter cyrus-edge-worker test:run test/RepositoryRouter.test.ts`
Expected: PASS, including every pre-existing case.

Note on one behaviour change the existing suite may catch: project matching is
now case-insensitive. If a test asserted that a differing case does *not* match,
update that test — the case-insensitive behaviour is the intended change.

- [ ] **Step 5: Run the wider edge-worker suite**

Run: `pnpm --filter cyrus-edge-worker test:run`
Expected: PASS. `prompt-assembly.routing-context.test.ts` may need its expected
prompt text updated once Task 17 rewrites `PromptBuilder`; if it fails now,
leave it and note it for Task 17.

- [ ] **Step 6: Commit**

```bash
git add packages/edge-worker/src/RepositoryRouter.ts packages/edge-worker/test/RepositoryRouter.test.ts
git commit -m "refactor(edge-worker): route via the shared cyrus-core matcher"
```

---

### Task 4: Registry types and the file backend

**Files:**
- Create: `packages/router/src/RepositoryRegistry.ts`
- Test: `packages/router/test/RepositoryRegistry.test.ts`

**Interfaces:**
- Consumes: `RoutableRepository` from `cyrus-core` (Task 2).
- Produces:
  - `interface RegisteredRepository { name: string; githubSlug: string; linearWorkspaceId: string; baseBranch?: string; teamKeys?: string[]; projectKeys?: string[]; routingLabels?: string[]; isDefault?: boolean }`
  - `interface RegistrySnapshot { repositories: RegisteredRepository[]; version?: string }`
  - `interface RepositoryRegistry { list(): Promise<RegistrySnapshot>; put(repositories: RegisteredRepository[], version?: string): Promise<{ version: string }> }`
  - `class FileRepositoryRegistry implements RepositoryRegistry`
  - `const REPOSITORY_NAME_RE`, `const GITHUB_SLUG_RE`
  - `function validateRegisteredRepository(repo: RegisteredRepository): void`
  - `function toRoutable(repo: RegisteredRepository): RoutableRepository & { source: RegisteredRepository }`

- [ ] **Step 1: Write the failing test**

Create `packages/router/test/RepositoryRegistry.test.ts`:

```ts
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	FileRepositoryRegistry,
	type RegisteredRepository,
	toRoutable,
	validateRegisteredRepository,
} from "../src/RepositoryRegistry.js";
import { SetupConflictError } from "../src/TableSecretStore.js";

function freshPath(): string {
	return join(mkdtempSync(join(tmpdir(), "cyrus-registry-")), "repositories.json");
}

const API: RegisteredRepository = {
	name: "cyrus-api",
	githubSlug: "acme/cyrus-api",
	linearWorkspaceId: "ws-1",
	baseBranch: "main",
	projectKeys: ["Platform"],
	teamKeys: ["NOR"],
	isDefault: true,
};

describe("FileRepositoryRegistry", () => {
	it("reports an empty list when the file does not exist", async () => {
		expect(await new FileRepositoryRegistry(freshPath()).list()).toEqual({
			repositories: [],
			version: "0",
		});
	});

	it("round-trips a written registry", async () => {
		const registry = new FileRepositoryRegistry(freshPath());
		expect(await registry.put([API])).toEqual({ version: "1" });
		expect(await registry.list()).toEqual({ repositories: [API], version: "1" });
	});

	it("accepts a conditional write against the current version", async () => {
		const registry = new FileRepositoryRegistry(freshPath());
		const first = await registry.put([API]);
		await expect(
			registry.put([{ ...API, isDefault: false }], first.version),
		).resolves.toEqual({ version: "2" });
	});

	it("rejects a conditional write against a stale version", async () => {
		const registry = new FileRepositoryRegistry(freshPath());
		const stale = await registry.put([API]);
		await registry.put([API], stale.version);
		await expect(registry.put([API], stale.version)).rejects.toBeInstanceOf(
			SetupConflictError,
		);
	});

	it("writes atomically at mode 0600", async () => {
		const path = freshPath();
		await new FileRepositoryRegistry(path).put([API]);
		if (process.platform !== "win32") {
			expect(statSync(path).mode & 0o777).toBe(0o600);
		}
		expect(JSON.parse(readFileSync(path, "utf-8")).repositories).toHaveLength(1);
	});

	it("treats a corrupt file as empty rather than throwing", async () => {
		const path = freshPath();
		writeFileSync(path, "{ not json");
		expect(await new FileRepositoryRegistry(path).list()).toEqual({
			repositories: [],
			version: "0",
		});
	});

	it("validates every entry before writing anything", async () => {
		const path = freshPath();
		const registry = new FileRepositoryRegistry(path);
		await expect(
			registry.put([API, { ...API, name: "../escape" }]),
		).rejects.toThrow("is not valid");
		expect(await registry.list()).toEqual({ repositories: [], version: "0" });
	});
});

describe("validateRegisteredRepository", () => {
	it("accepts a well-formed entry", () => {
		expect(() => validateRegisteredRepository(API)).not.toThrow();
	});

	it("rejects a name that could escape the repos directory", () => {
		expect(() => validateRegisteredRepository({ ...API, name: "../etc" })).toThrow(
			'Repository name "../etc" is not valid',
		);
	});

	it("rejects an empty name", () => {
		expect(() => validateRegisteredRepository({ ...API, name: "" })).toThrow(
			"Repository name",
		);
	});

	it("rejects a slug that is not owner/repo", () => {
		expect(() =>
			validateRegisteredRepository({ ...API, githubSlug: "acme" }),
		).toThrow('GitHub slug "acme" must be in owner/repo form');
	});

	it("rejects a missing Linear workspace id", () => {
		expect(() =>
			validateRegisteredRepository({ ...API, linearWorkspaceId: "" }),
		).toThrow("Linear workspace id is required");
	});
});

describe("toRoutable", () => {
	it("derives id, name, and a GitHub URL the matcher can suffix-match", () => {
		const routable = toRoutable(API);
		expect(routable.id).toBe("cyrus-api");
		expect(routable.name).toBe("cyrus-api");
		expect(routable.githubUrl).toBe("https://github.com/acme/cyrus-api");
		expect(routable.projectKeys).toEqual(["Platform"]);
		expect(routable.isDefault).toBe(true);
		expect(routable.source).toBe(API);
	});

	it("omits optional routing fields that are absent", () => {
		const routable = toRoutable({
			name: "bare",
			githubSlug: "acme/bare",
			linearWorkspaceId: "ws-1",
		});
		expect(routable.teamKeys).toBeUndefined();
		expect(routable.projectKeys).toBeUndefined();
		expect(routable.routingLabels).toBeUndefined();
		expect(routable.isDefault).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-router test:run test/RepositoryRegistry.test.ts`
Expected: FAIL — cannot resolve `../src/RepositoryRegistry.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/router/src/RepositoryRegistry.ts`:

```ts
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { RoutableRepository } from "cyrus-core";
import { SetupConflictError } from "./TableSecretStore.js";

/**
 * One repository registered against the router's Linear workspace.
 *
 * The router's own persistence shape, deliberately narrower than
 * `RepositoryConfig`: the router knows a GitHub slug, not a filesystem path,
 * because the path only exists once a sandbox has cloned it.
 */
export interface RegisteredRepository {
	/** Also the sandbox directory name and the RepositoryConfig id. */
	name: string;
	/** "owner/repo". */
	githubSlug: string;
	linearWorkspaceId: string;
	baseBranch?: string;
	teamKeys?: string[];
	projectKeys?: string[];
	routingLabels?: string[];
	/** Selected when no higher-priority routing method matches. */
	isDefault?: boolean;
}

/** A read of the registry plus the version a conditional write must quote. */
export interface RegistrySnapshot {
	repositories: RegisteredRepository[];
	/** Opaque. `"0"` on the file backend when no registry exists yet. */
	version?: string;
}

/**
 * Durable storage for the global repository registry.
 *
 * `put` is conditional: passing the `version` from a prior `list` makes the
 * write fail with {@link SetupConflictError} if anything changed in between,
 * which turns two concurrent setup-UI edits into a visible conflict rather than
 * a silent overwrite. `undefined` is an unconditional write, reserved for
 * first-run seeding.
 */
export interface RepositoryRegistry {
	list(): Promise<RegistrySnapshot>;
	put(
		repositories: RegisteredRepository[],
		version?: string,
	): Promise<{ version: string }>;
}

/**
 * Names flow into `$WORKSPACES/repos/<name>` inside a sandbox and into the
 * `RepositoryConfig.id`, so this is the same class of gate `ISSUE_KEY_RE`
 * applies in `ContainerTargets.ts` — it is what stops `..` or a slash reaching
 * a path join.
 */
export const REPOSITORY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** "owner/repo" — exactly one slash, no traversal on either side. */
export const GITHUB_SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** Throws with user-facing copy when an entry cannot be stored. */
export function validateRegisteredRepository(repo: RegisteredRepository): void {
	if (!REPOSITORY_NAME_RE.test(repo.name)) {
		throw new Error(
			`Repository name ${JSON.stringify(repo.name)} is not valid. Use letters, digits, dots, dashes, or underscores, starting with a letter or digit (max 64 characters).`,
		);
	}
	if (!GITHUB_SLUG_RE.test(repo.githubSlug)) {
		throw new Error(
			`GitHub slug ${JSON.stringify(repo.githubSlug)} must be in owner/repo form.`,
		);
	}
	if (repo.linearWorkspaceId.trim() === "") {
		throw new Error("Linear workspace id is required.");
	}
}

/**
 * Adapts a registry entry onto the matcher's `RoutableRepository`, carrying the
 * original alongside so a match maps straight back without a lookup.
 *
 * The GitHub URL is synthesised because `[repo=…]` tags are matched by URL path
 * suffix — see `matchRepositories`. Without it, a tag naming the slug's repo
 * half would only match via the name, which is usually but not always the same.
 */
export function toRoutable(
	repo: RegisteredRepository,
): RoutableRepository & { source: RegisteredRepository } {
	return {
		id: repo.name,
		name: repo.name,
		githubUrl: `https://github.com/${repo.githubSlug}`,
		...(repo.teamKeys ? { teamKeys: repo.teamKeys } : {}),
		...(repo.projectKeys ? { projectKeys: repo.projectKeys } : {}),
		...(repo.routingLabels ? { routingLabels: repo.routingLabels } : {}),
		...(repo.isDefault !== undefined ? { isDefault: repo.isDefault } : {}),
		source: repo,
	};
}

/** On-disk shape. `version` is a monotonic counter rendered as a string. */
interface RegistryFile {
	version: string;
	repositories: RegisteredRepository[];
}

/**
 * File-backed registry for local and Docker development, mirroring how
 * `secretsPath` already defaults beside the router database: mode 0600 and an
 * atomic tmp+rename, matching `FileSecretStore`.
 *
 * A corrupt file reads as empty rather than throwing — a registry that cannot
 * be parsed must not stop the router from starting, and the next write heals it.
 */
export class FileRepositoryRegistry implements RepositoryRegistry {
	constructor(private readonly path: string) {}

	private read(): RegistryFile {
		if (!existsSync(this.path)) return { version: "0", repositories: [] };
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as unknown;
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				!Array.isArray((parsed as RegistryFile).repositories)
			) {
				return { version: "0", repositories: [] };
			}
			const file = parsed as RegistryFile;
			return {
				version: typeof file.version === "string" ? file.version : "0",
				repositories: file.repositories,
			};
		} catch {
			return { version: "0", repositories: [] };
		}
	}

	async list(): Promise<RegistrySnapshot> {
		const file = this.read();
		return { repositories: file.repositories, version: file.version };
	}

	async put(
		repositories: RegisteredRepository[],
		version?: string,
	): Promise<{ version: string }> {
		// Validate the whole batch before touching disk, so a bad entry never
		// leaves the registry half-written.
		for (const repo of repositories) validateRegisteredRepository(repo);

		const current = this.read();
		if (version !== undefined && version !== current.version) {
			throw new SetupConflictError(
				`the repository registry changed since it was read (expected version ${version}, found ${current.version})`,
			);
		}

		const next: RegistryFile = {
			version: String(Number(current.version) + 1),
			repositories,
		};
		mkdirSync(dirname(this.path), { recursive: true });
		const tmpPath = `${this.path}.tmp`;
		writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmpPath, this.path);
		// writeFileSync's mode only applies on creation; enforce on overwrite too.
		chmodSync(this.path, 0o600);
		return { version: next.version };
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter cyrus-router test:run test/RepositoryRegistry.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/router/src/RepositoryRegistry.ts packages/router/test/RepositoryRegistry.test.ts
git commit -m "feat(router): add repository registry types and file backend"
```

---

### Task 5: Azure Table registry backend

**Files:**
- Create: `packages/router/src/TableRepositoryRegistry.ts`
- Test: `packages/router/test/TableRepositoryRegistry.test.ts`

**Interfaces:**
- Consumes: Task 4's `RepositoryRegistry` / `RegisteredRepository` / `RegistrySnapshot` / `validateRegisteredRepository`; `azureRequest`, `AzureRequestPolicy`, `DEFAULT_REQUEST_TIMEOUT_MS`, `DEFAULT_MAX_ATTEMPTS`, `DEFAULT_MAX_RETRY_DELAY_MS`, `defaultSleep` from `./setup/envelope.js`; `SetupConflictError` from `./TableSecretStore.js`.
- Produces: `REGISTRY_PARTITION_KEY`, `REGISTRY_ROW_KEY`, `class TableRepositoryRegistry`, `interface TableRepositoryRegistryOptions`.

- [ ] **Step 1: Write the failing test**

Create `packages/router/test/TableRepositoryRegistry.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { RegisteredRepository } from "../src/RepositoryRegistry.js";
import {
	REGISTRY_PARTITION_KEY,
	REGISTRY_ROW_KEY,
	TableRepositoryRegistry,
} from "../src/TableRepositoryRegistry.js";
import { SetupConflictError } from "../src/TableSecretStore.js";

const API: RegisteredRepository = {
	name: "cyrus-api",
	githubSlug: "acme/cyrus-api",
	linearWorkspaceId: "ws-1",
	projectKeys: ["Platform"],
	isDefault: true,
};

function reply(status: number, body: unknown, etag?: string): Response {
	return new Response(status === 204 ? null : JSON.stringify(body), {
		status,
		headers: etag ? { etag } : {},
	});
}

function registry(fetchFn: typeof fetch) {
	return new TableRepositoryRegistry({
		tableEndpoint: "https://stexample.table.core.windows.net",
		tableName: "cyrussetup",
		fetchFn,
		tokenProvider: async () => "token",
		sleep: async () => {},
		newCorrelationId: () => "corr-1",
		now: () => 0,
		logger: { warn: vi.fn() },
	});
}

describe("TableRepositoryRegistry", () => {
	it("uses a partition key that cannot collide with a user record", () => {
		expect(REGISTRY_PARTITION_KEY).toBe(`g${"0".repeat(64)}`);
		expect(REGISTRY_PARTITION_KEY.startsWith("u")).toBe(false);
		expect(REGISTRY_ROW_KEY).toBe("repositories");
	});

	it("reports an empty registry when the entity does not exist", async () => {
		const fetchFn = vi.fn(async () =>
			reply(404, { "odata.error": { code: "ResourceNotFound" } }),
		) as unknown as typeof fetch;
		expect(await registry(fetchFn).list()).toEqual({ repositories: [] });
	});

	it("reads plaintext JSON and returns the ETag as the version", async () => {
		const fetchFn = vi.fn(async () =>
			reply(200, { ReposJson: JSON.stringify([API]) }, 'W/"v1"'),
		) as unknown as typeof fetch;
		expect(await registry(fetchFn).list()).toEqual({
			repositories: [API],
			version: 'W/"v1"',
		});
	});

	it("stores plaintext, never an encrypted envelope", async () => {
		const bodies: string[] = [];
		const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
			bodies.push(String(init.body));
			return reply(204, null, 'W/"v1"');
		}) as unknown as typeof fetch;

		await registry(fetchFn).put([API]);

		const body = JSON.parse(bodies[0] as string);
		expect(body.PartitionKey).toBe(REGISTRY_PARTITION_KEY);
		expect(body.RowKey).toBe(REGISTRY_ROW_KEY);
		expect(JSON.parse(body.ReposJson)).toEqual([API]);
		expect(body).not.toHaveProperty("Ciphertext");
		expect(body).not.toHaveProperty("WrappedDek");
	});

	it("POSTs an insert with no If-Match when no version is supplied", async () => {
		const seen: Array<{ method: string; headers: Record<string, string> }> = [];
		const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
			seen.push({
				method: String(init.method),
				headers: init.headers as Record<string, string>,
			});
			return reply(204, null, 'W/"v1"');
		}) as unknown as typeof fetch;

		await registry(fetchFn).put([API]);
		expect(seen[0]?.method).toBe("POST");
		expect(seen[0]?.headers["if-match"]).toBeUndefined();
	});

	it("PUTs with If-Match when a version is supplied, and never If-Match:*", async () => {
		const seen: Array<{ method: string; headers: Record<string, string> }> = [];
		const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
			seen.push({
				method: String(init.method),
				headers: init.headers as Record<string, string>,
			});
			return reply(204, null, 'W/"v3"');
		}) as unknown as typeof fetch;

		expect(await registry(fetchFn).put([API], 'W/"v2"')).toEqual({
			version: 'W/"v3"',
		});
		expect(seen[0]?.method).toBe("PUT");
		expect(seen[0]?.headers["if-match"]).toBe('W/"v2"');
	});

	it("raises SetupConflictError on 412", async () => {
		const fetchFn = vi.fn(async () =>
			reply(412, { "odata.error": { code: "UpdateConditionNotSatisfied" } }),
		) as unknown as typeof fetch;
		await expect(
			registry(fetchFn).put([API], 'W/"stale"'),
		).rejects.toBeInstanceOf(SetupConflictError);
	});

	it("raises SetupConflictError on a 409 insert race", async () => {
		const fetchFn = vi.fn(async () =>
			reply(409, { "odata.error": { code: "EntityAlreadyExists" } }),
		) as unknown as typeof fetch;
		await expect(registry(fetchFn).put([API])).rejects.toBeInstanceOf(
			SetupConflictError,
		);
	});

	it("refuses an invalid repository before making any request", async () => {
		const fetchFn = vi.fn(async () => reply(204, null)) as unknown as typeof fetch;
		await expect(
			registry(fetchFn).put([{ ...API, name: "../escape" }]),
		).rejects.toThrow("is not valid");
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("treats an unreadable stored payload as empty rather than throwing", async () => {
		const fetchFn = vi.fn(async () =>
			reply(200, { ReposJson: "{ not json" }, 'W/"v1"'),
		) as unknown as typeof fetch;
		expect(await registry(fetchFn).list()).toEqual({
			repositories: [],
			version: 'W/"v1"',
		});
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-router test:run test/TableRepositoryRegistry.test.ts`
Expected: FAIL — cannot resolve `../src/TableRepositoryRegistry.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/router/src/TableRepositoryRegistry.ts`:

```ts
import { randomUUID } from "node:crypto";
import type {
	RegisteredRepository,
	RegistrySnapshot,
	RepositoryRegistry,
} from "./RepositoryRegistry.js";
import { validateRegisteredRepository } from "./RepositoryRegistry.js";
import {
	type AzureRequestPolicy,
	azureRequest,
	DEFAULT_MAX_ATTEMPTS,
	DEFAULT_MAX_RETRY_DELAY_MS,
	DEFAULT_REQUEST_TIMEOUT_MS,
	defaultSleep,
} from "./setup/envelope.js";
import { SetupConflictError } from "./TableSecretStore.js";

const TABLE_SCOPE = "https://storage.azure.com/.default";
const DEFAULT_TABLE_NAME = "cyrussetup";

/**
 * The registry's partition key.
 *
 * `setupPartitionKey` mints per-user keys as `u` + 64 hex characters, so a
 * different first character alone guarantees this can never collide with a
 * user's secret record — and no email can ever hash to it. The 64 zeros keep
 * the key the same length as a user key, so a human scanning the table sees
 * one consistent shape.
 */
export const REGISTRY_PARTITION_KEY = `g${"0".repeat(64)}`;

/** The registry's single row. */
export const REGISTRY_ROW_KEY = "repositories";

export interface TableRepositoryRegistryOptions {
	/** Bare https origin, e.g. "https://stexample.table.core.windows.net". */
	tableEndpoint: string;
	/** Default {@link DEFAULT_TABLE_NAME}. */
	tableName?: string;
	tokenProvider?: () => Promise<string>;
	fetchFn?: typeof fetch;
	requestTimeoutMs?: number;
	maxAttempts?: number;
	maxRetryDelayMs?: number;
	sleep?: (ms: number) => Promise<void>;
	newCorrelationId?: () => string;
	now?: () => number;
	logger?: { warn(msg: string): void };
	signal?: AbortSignal;
}

function createTableTokenProvider(): () => Promise<string> {
	let credential:
		| { getToken(scope: string): Promise<{ token: string } | null> }
		| undefined;
	return async () => {
		if (!credential) {
			const { DefaultAzureCredential } = await import("@azure/identity");
			credential = new DefaultAzureCredential();
		}
		const token = await credential.getToken(TABLE_SCOPE);
		if (!token?.token) {
			throw new Error("DefaultAzureCredential returned no access token");
		}
		return token.token;
	};
}

/**
 * The global repository registry, stored as ONE Azure Table entity.
 *
 * Deliberately **plaintext**, unlike `TableSecretStore`: repository names and
 * `org/repo` slugs are not credentials, and keeping the KEK out of this path
 * means the registry works in a deployment that holds the Table role but not
 * *Key Vault Crypto User*. Encrypting it would add a failure mode to every
 * container boot in exchange for hiding nothing.
 *
 * Concurrency is the Table service's own ETag: `list` returns it as the opaque
 * `version` and `put` sends it back as `If-Match`. A 412 — or a 409 from a lost
 * insert race — becomes a {@link SetupConflictError}, which the setup UI renders
 * as "someone else changed this" instead of silently overwriting.
 */
export class TableRepositoryRegistry implements RepositoryRegistry {
	private readonly tableUrl: string;
	private readonly tokenProvider: () => Promise<string>;
	private readonly policy: AzureRequestPolicy;

	constructor(options: TableRepositoryRegistryOptions) {
		const origin = options.tableEndpoint.replace(/\/+$/, "");
		this.tableUrl = `${origin}/${options.tableName ?? DEFAULT_TABLE_NAME}`;
		this.tokenProvider = options.tokenProvider ?? createTableTokenProvider();
		this.policy = {
			fetchFn: options.fetchFn ?? fetch,
			requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
			maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
			maxRetryDelayMs: options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
			sleep: options.sleep ?? defaultSleep,
			newCorrelationId: options.newCorrelationId ?? randomUUID,
			now: options.now ?? Date.now,
			logger: options.logger ?? console,
			...(options.signal ? { signal: options.signal } : {}),
		};
	}

	private entityUrl(): string {
		return `${this.tableUrl}(PartitionKey='${REGISTRY_PARTITION_KEY}',RowKey='${REGISTRY_ROW_KEY}')`;
	}

	async list(): Promise<RegistrySnapshot> {
		const { response, correlationId } = await azureRequest(
			{
				method: "GET",
				url: this.entityUrl(),
				headers: {
					accept: "application/json;odata=nometadata",
					"x-ms-version": "2019-02-02",
					dataserviceversion: "3.0",
				},
				tokenProvider: this.tokenProvider,
				service: "Azure Table",
				noRetryStatuses: [404],
			},
			this.policy,
		);

		if (response.status === 404) return { repositories: [] };
		if (!response.ok) {
			throw new Error(
				`Azure Table read of the repository registry failed (${response.status}) [${correlationId}]: ${await response.text()}`,
			);
		}

		const etag = response.headers.get("etag") ?? undefined;
		const body = (await response.json()) as { ReposJson?: unknown };
		return {
			repositories: this.parseRepositories(body.ReposJson, correlationId),
			...(etag ? { version: etag } : {}),
		};
	}

	/**
	 * A stored payload we cannot read is reported as an empty registry, never a
	 * throw. Throwing would make every container boot fail on one corrupt row;
	 * empty degrades to "no repositories configured", which the boot path
	 * already reports with actionable copy, and the next save heals the row.
	 */
	private parseRepositories(
		raw: unknown,
		correlationId: string,
	): RegisteredRepository[] {
		if (typeof raw !== "string" || raw === "") return [];
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (!Array.isArray(parsed)) throw new Error("not a JSON array");
			return parsed as RegisteredRepository[];
		} catch (error) {
			this.policy.logger.warn(
				`Stored repository registry is unreadable [${correlationId}]: ${(error as Error).message}. Treating it as empty.`,
			);
			return [];
		}
	}

	async put(
		repositories: RegisteredRepository[],
		version?: string,
	): Promise<{ version: string }> {
		// Before any token acquisition or network use, so a malformed entry costs
		// nothing and fails with a message the UI can render.
		for (const repo of repositories) validateRegisteredRepository(repo);

		const entity = {
			PartitionKey: REGISTRY_PARTITION_KEY,
			RowKey: REGISTRY_ROW_KEY,
			ReposJson: JSON.stringify(repositories),
			UpdatedMs: this.policy.now(),
		};

		// No version -> Insert Entity (POST to the table). A version -> Update
		// Entity (PUT to the row) with If-Match. `If-Match: *` is deliberately
		// never sent: it is exactly the unconditional overwrite the ETag exists
		// to prevent.
		const isInsert = version === undefined;
		const { response, correlationId } = await azureRequest(
			{
				method: isInsert ? "POST" : "PUT",
				url: isInsert ? this.tableUrl : this.entityUrl(),
				headers: {
					"content-type": "application/json",
					accept: "application/json;odata=nometadata",
					"x-ms-version": "2019-02-02",
					dataserviceversion: "3.0",
					prefer: "return-no-content",
					...(isInsert ? {} : { "if-match": version }),
				},
				tokenProvider: this.tokenProvider,
				body: JSON.stringify(entity),
				service: "Azure Table",
				noRetryStatuses: [409],
			},
			this.policy,
		);

		if (response.status === 412 || response.status === 409) {
			throw new SetupConflictError(
				`the repository registry was modified by someone else [${correlationId}]`,
			);
		}
		if (!response.ok) {
			throw new Error(
				`Azure Table write of the repository registry failed (${response.status}) [${correlationId}]: ${await response.text()}`,
			);
		}
		const etag = response.headers.get("etag");
		if (!etag) {
			throw new Error(
				`Azure Table write of the repository registry returned no ETag [${correlationId}]`,
			);
		}
		return { version: etag };
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter cyrus-router test:run test/TableRepositoryRegistry.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/router/src/TableRepositoryRegistry.ts packages/router/test/TableRepositoryRegistry.test.ts
git commit -m "feat(router): add Azure Table repository registry backend"
```

---

### Task 6: Backend selection and once-only seeding

**Files:**
- Modify: `packages/router/src/RepositoryRegistry.ts` (append)
- Modify: `packages/router/src/RouterServer.ts`
- Modify: `apps/cli/src/commands/RouterCommand.ts` (around line 177)
- Test: `packages/router/test/RepositoryRegistry.test.ts` (append a describe block)

**Interfaces:**
- Consumes: Task 4's `RepositoryRegistry` / `FileRepositoryRegistry`; Task 5's `TableRepositoryRegistry`.
- Produces:
  - `function createRepositoryRegistry(options: { tableStore?: { endpoint: string; tableName?: string }; filePath: string }): RepositoryRegistry`
  - `function seedRepositoryRegistry(registry: RepositoryRegistry, configured: readonly RegisteredRepository[], logger: { info(msg: string): void; warn(msg: string): void }): Promise<{ seeded: boolean; count: number }>`
  - `RouterServer` exposes `readonly repositoryRegistry: RepositoryRegistry | undefined` for later tasks.
  - `containers.repositories` in `RouterConfigFileSchema` accepts the routing fields.

- [ ] **Step 1: Write the failing test**

Append to `packages/router/test/RepositoryRegistry.test.ts`:

```ts
import { seedRepositoryRegistry } from "../src/RepositoryRegistry.js";
import { vi } from "vitest";

describe("seedRepositoryRegistry", () => {
	const logger = () => ({ info: vi.fn(), warn: vi.fn() });

	it("writes the configured repositories into an empty registry", async () => {
		const registry = new FileRepositoryRegistry(freshPath());
		const log = logger();
		expect(await seedRepositoryRegistry(registry, [API], log)).toEqual({
			seeded: true,
			count: 1,
		});
		expect((await registry.list()).repositories).toEqual([API]);
		expect(log.info).toHaveBeenCalledWith(
			expect.stringContaining("Seeded the repository registry with 1"),
		);
	});

	it("never overwrites a non-empty registry, and says so", async () => {
		const registry = new FileRepositoryRegistry(freshPath());
		await registry.put([{ ...API, name: "already-here" }]);
		const log = logger();

		expect(await seedRepositoryRegistry(registry, [API], log)).toEqual({
			seeded: false,
			count: 1,
		});
		expect((await registry.list()).repositories[0]?.name).toBe("already-here");
		expect(log.info).toHaveBeenCalledWith(
			expect.stringContaining("authoritative"),
		);
	});

	it("is a no-op with no configured repositories and an empty registry", async () => {
		const registry = new FileRepositoryRegistry(freshPath());
		expect(await seedRepositoryRegistry(registry, [], logger())).toEqual({
			seeded: false,
			count: 0,
		});
	});

	it("warns and continues when a configured entry is invalid", async () => {
		const registry = new FileRepositoryRegistry(freshPath());
		const log = logger();
		const result = await seedRepositoryRegistry(
			registry,
			[API, { ...API, name: "../escape" }],
			log,
		);
		expect(result).toEqual({ seeded: false, count: 0 });
		expect(log.warn).toHaveBeenCalledWith(
			expect.stringContaining("is not valid"),
		);
		expect((await registry.list()).repositories).toEqual([]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-router test:run test/RepositoryRegistry.test.ts`
Expected: FAIL — `seedRepositoryRegistry` is not exported.

- [ ] **Step 3: Implement selection and seeding**

Append to `packages/router/src/RepositoryRegistry.ts`:

Add this import at the top of the file, beside the existing ones:

```ts
import { TableRepositoryRegistry } from "./TableRepositoryRegistry.js";
```

A static import is correct here even though a file-backed deployment never
touches Azure: `TableRepositoryRegistry` imports `@azure/identity` lazily inside
its own token provider, so nothing Azure-specific is loaded until a Table
request is actually made.

Then append:

```ts
/**
 * Chooses the registry backend, mirroring how `SecretStoreBackend` already
 * picks between Table and file. The Table backend needs no Key Vault key —
 * unlike the secret store, the registry is plaintext.
 */
export function createRepositoryRegistry(options: {
	tableStore?: { endpoint: string; tableName?: string };
	filePath: string;
}): RepositoryRegistry {
	if (options.tableStore) {
		return new TableRepositoryRegistry({
			tableEndpoint: options.tableStore.endpoint,
			...(options.tableStore.tableName
				? { tableName: options.tableStore.tableName }
				: {}),
		});
	}
	return new FileRepositoryRegistry(options.filePath);
}

/**
 * Writes `configured` into the registry the first time it is empty, and never
 * again.
 *
 * Seed-once rather than merge is deliberate. `containers.repositories` reaches
 * the router as the `CYRUS_ROUTER_CONTAINERS_JSON` environment variable, so a
 * merge would let a redeploy silently overwrite edits made in the setup UI —
 * exactly the surprise this design exists to remove. The log line on the
 * already-seeded path is what tells an operator editing that variable and
 * seeing nothing happen why it had no effect.
 *
 * An invalid configured entry is warned about and the whole seed is skipped:
 * partially seeding would leave a registry that neither matches the config nor
 * anything a human chose.
 */
export async function seedRepositoryRegistry(
	registry: RepositoryRegistry,
	configured: readonly RegisteredRepository[],
	logger: { info(msg: string): void; warn(msg: string): void },
): Promise<{ seeded: boolean; count: number }> {
	const snapshot = await registry.list();
	if (snapshot.repositories.length > 0) {
		logger.info(
			`Repository registry already holds ${snapshot.repositories.length} repositor${
				snapshot.repositories.length === 1 ? "y" : "ies"
			}; the stored registry is authoritative and containers.repositories in router-config.json is ignored. Edit repositories at /setup/repositories.`,
		);
		return { seeded: false, count: snapshot.repositories.length };
	}
	if (configured.length === 0) return { seeded: false, count: 0 };

	for (const repo of configured) {
		try {
			validateRegisteredRepository(repo);
		} catch (error) {
			logger.warn(
				`Not seeding the repository registry: ${(error as Error).message} Fix containers.repositories in router-config.json, or add repositories at /setup/repositories.`,
			);
			return { seeded: false, count: 0 };
		}
	}

	await registry.put([...configured], snapshot.version);
	logger.info(
		`Seeded the repository registry with ${configured.length} repositor${
			configured.length === 1 ? "y" : "ies"
		} from containers.repositories. The stored registry is authoritative from now on.`,
	);
	return { seeded: true, count: configured.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter cyrus-router test:run test/RepositoryRegistry.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Widen the router config schema**

In `apps/cli/src/commands/RouterCommand.ts`, replace the `repositories` array
element schema (currently line ~178) with:

```ts
			repositories: z.array(
				z.object({
					name: z.string(),
					githubSlug: z.string(),
					linearWorkspaceId: z.string(),
					baseBranch: z.string().optional(),
					// Routing metadata. Only ever used to SEED the registry on first
					// start — after that the stored registry is authoritative and
					// these are ignored. See seedRepositoryRegistry.
					teamKeys: z.array(z.string()).optional(),
					projectKeys: z.array(z.string()).optional(),
					routingLabels: z.array(z.string()).optional(),
					isDefault: z.boolean().optional(),
				}),
			),
```

Make the identical change to `RouterContainersConfig.repositories` in
`packages/router/src/RouterServer.ts` (currently line 105):

```ts
	repositories: Array<{
		name: string;
		githubSlug: string;
		linearWorkspaceId: string;
		baseBranch?: string;
		teamKeys?: string[];
		projectKeys?: string[];
		routingLabels?: string[];
		isDefault?: boolean;
	}>;
```

- [ ] **Step 6: Build the registry in RouterServer**

In `packages/router/src/RouterServer.ts`, inside the same block that builds
`secrets` and `containerTargets` (around line 765), add before the
`ContainerTargetService` construction:

```ts
		const repositoryRegistry = createRepositoryRegistry({
			...(containers.tableStore
				? {
						tableStore: {
							endpoint: containers.tableStore.endpoint,
							...(containers.tableStore.tableName
								? { tableName: containers.tableStore.tableName }
								: {}),
						},
					}
				: {}),
			filePath: join(dirname(this.config.dbPath), "repositories.json"),
		});
		this.repositoryRegistry = repositoryRegistry;

		// Seeding is fire-and-forget: it must not delay the listen(), and a
		// transient Table error here is recoverable — the next start retries,
		// and the setup UI can populate the registry by hand meanwhile.
		void seedRepositoryRegistry(
			repositoryRegistry,
			containers.repositories,
			this.logger,
		).catch((error: unknown) => {
			this.logger.warn(
				`Could not seed the repository registry: ${String(error)}`,
			);
		});
```

Declare the field on the class alongside `containerLifecycle`:

```ts
	/** Set only when `containers` is configured. Consumed by the setup UI. */
	repositoryRegistry: RepositoryRegistry | undefined;
```

Add the imports (`join`/`dirname` from `node:path` may already be present):

```ts
import {
	createRepositoryRegistry,
	type RepositoryRegistry,
	seedRepositoryRegistry,
} from "./RepositoryRegistry.js";
```

- [ ] **Step 7: Verify the whole router suite still passes**

Run: `pnpm --filter cyrus-router test:run && pnpm --filter cyrus-cli test:run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/router/src/RepositoryRegistry.ts packages/router/src/RouterServer.ts packages/router/test/RepositoryRegistry.test.ts apps/cli/src/commands/RouterCommand.ts
git commit -m "feat(router): select a registry backend and seed it once from config"
```

---

### Task 7: RouterStore tables for decisions and pending selections

**Files:**
- Modify: `packages/router/src/RouterStore.ts`
- Test: `packages/router/test/RouterStore.test.ts` (append a describe block)

**Interfaces:**
- Consumes: nothing.
- Produces, all on `RouterStore`:
  - `interface StoredRepositoryDecision { repoNames: string[]; baseBranchOverrides: Record<string, string>; method: string; decidedMs: number }`
  - `getIssueRepositories(issueKey: string): StoredRepositoryDecision | undefined`
  - `setIssueRepositories(issueKey: string, decision: Omit<StoredRepositoryDecision, "decidedMs">, nowMs: number): void`
  - `deleteIssueRepositories(issueKey: string): void`
  - `interface PendingRepoSelection { agentSessionId: string; issueKey: string; workspaceId: string; options: string[]; createdEvent: string; createdMs: number }`
  - `createPendingRepoSelection(row: PendingRepoSelection): void`
  - `getPendingRepoSelection(agentSessionId: string): PendingRepoSelection | undefined`
  - `deletePendingRepoSelection(agentSessionId: string): void`
  - `sweepPendingRepoSelections(cutoffMs: number): number`

- [ ] **Step 1: Write the failing test**

Append to `packages/router/test/RouterStore.test.ts` (reuse the file's existing
`new RouterStore(":memory:")` setup convention):

```ts
describe("repository decisions", () => {
	it("returns undefined for an issue with no decision", () => {
		const store = new RouterStore(":memory:");
		expect(store.getIssueRepositories("NOR-1")).toBeUndefined();
	});

	it("round-trips a decision", () => {
		const store = new RouterStore(":memory:");
		store.setIssueRepositories(
			"NOR-1",
			{
				repoNames: ["cyrus-api", "cyrus-web"],
				baseBranchOverrides: { "cyrus-web": "release" },
				method: "description-tag",
			},
			1000,
		);
		expect(store.getIssueRepositories("NOR-1")).toEqual({
			repoNames: ["cyrus-api", "cyrus-web"],
			baseBranchOverrides: { "cyrus-web": "release" },
			method: "description-tag",
			decidedMs: 1000,
		});
	});

	it("replaces an existing decision for the same issue", () => {
		const store = new RouterStore(":memory:");
		store.setIssueRepositories(
			"NOR-1",
			{ repoNames: ["a"], baseBranchOverrides: {}, method: "default" },
			1,
		);
		store.setIssueRepositories(
			"NOR-1",
			{ repoNames: ["b"], baseBranchOverrides: {}, method: "team-based" },
			2,
		);
		expect(store.getIssueRepositories("NOR-1")?.repoNames).toEqual(["b"]);
	});

	it("deletes a decision", () => {
		const store = new RouterStore(":memory:");
		store.setIssueRepositories(
			"NOR-1",
			{ repoNames: ["a"], baseBranchOverrides: {}, method: "default" },
			1,
		);
		store.deleteIssueRepositories("NOR-1");
		expect(store.getIssueRepositories("NOR-1")).toBeUndefined();
	});

	it("treats a corrupt stored row as absent rather than throwing", () => {
		const store = new RouterStore(":memory:");
		store.setIssueRepositories(
			"NOR-1",
			{ repoNames: ["a"], baseBranchOverrides: {}, method: "default" },
			1,
		);
		// Simulate a hand-edited / truncated row.
		store.rawDbForTests()
			.prepare("UPDATE issue_repositories SET repos_json = '{ broken' WHERE issue_key = ?")
			.run("NOR-1");
		expect(store.getIssueRepositories("NOR-1")).toBeUndefined();
	});
});

describe("pending repository selections", () => {
	const row = {
		agentSessionId: "sess-1",
		issueKey: "NOR-1",
		workspaceId: "ws-1",
		options: ["cyrus-api", "cyrus-web"],
		createdEvent: '{"action":"created"}',
		createdMs: 1000,
	};

	it("round-trips a pending selection", () => {
		const store = new RouterStore(":memory:");
		store.createPendingRepoSelection(row);
		expect(store.getPendingRepoSelection("sess-1")).toEqual(row);
	});

	it("returns undefined for an unknown session", () => {
		const store = new RouterStore(":memory:");
		expect(store.getPendingRepoSelection("nope")).toBeUndefined();
	});

	it("deletes a pending selection", () => {
		const store = new RouterStore(":memory:");
		store.createPendingRepoSelection(row);
		store.deletePendingRepoSelection("sess-1");
		expect(store.getPendingRepoSelection("sess-1")).toBeUndefined();
	});

	it("sweeps only selections older than the cutoff", () => {
		const store = new RouterStore(":memory:");
		store.createPendingRepoSelection(row);
		store.createPendingRepoSelection({
			...row,
			agentSessionId: "sess-2",
			createdMs: 5000,
		});
		expect(store.sweepPendingRepoSelections(2000)).toBe(1);
		expect(store.getPendingRepoSelection("sess-1")).toBeUndefined();
		expect(store.getPendingRepoSelection("sess-2")).toBeDefined();
	});
});
```

If `RouterStore` has no `rawDbForTests()` accessor, add one:

```ts
	/** Test-only escape hatch for simulating hand-edited rows. */
	rawDbForTests(): Database.Database {
		return this.db;
	}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-router test:run test/RouterStore.test.ts`
Expected: FAIL — `store.getIssueRepositories is not a function`.

- [ ] **Step 3: Add the tables**

In `packages/router/src/RouterStore.ts`, append to the `SCHEMA` template
literal (after the `container_teardowns` block):

```sql
CREATE TABLE IF NOT EXISTS issue_repositories (
  issue_key TEXT PRIMARY KEY,
  repos_json TEXT NOT NULL,
  overrides_json TEXT NOT NULL,
  method TEXT NOT NULL,
  decided_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_repo_selections (
  agent_session_id TEXT PRIMARY KEY,
  issue_key TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  options_json TEXT NOT NULL,
  created_event TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);
```

Both use `CREATE TABLE IF NOT EXISTS`, so an existing database picks them up on
the next start with no migration step — the same mechanism every other table
here relies on.

- [ ] **Step 4: Add the accessors**

Add to the `RouterStore` class:

```ts
/**
 * Which repositories an issue routes to, decided once by the router and reused
 * for every later event on that issue.
 *
 * Persisted rather than recomputed so a container destroyed and recreated
 * clones the SAME repository, and so a second agent session on the issue never
 * re-asks — the sandbox is per-issue and cloned at boot, so its repository
 * cannot change mid-issue.
 */
export interface StoredRepositoryDecision {
	repoNames: string[];
	/** Repository name -> base branch, from `#branch` in a description tag. */
	baseBranchOverrides: Record<string, string>;
	/** A `RoutingMethod`, kept as a string so the store stays schema-free. */
	method: string;
	decidedMs: number;
}

/** An elicitation posted, with the `created` webhook held until it is answered. */
export interface PendingRepoSelection {
	agentSessionId: string;
	issueKey: string;
	workspaceId: string;
	/** The option values offered, in the order they were offered. */
	options: string[];
	/** The serialized `created` webhook, replayed once the answer arrives. */
	createdEvent: string;
	createdMs: number;
}
```

```ts
	getIssueRepositories(issueKey: string): StoredRepositoryDecision | undefined {
		const row = this.db
			.prepare(
				"SELECT repos_json, overrides_json, method, decided_ms FROM issue_repositories WHERE issue_key = ?",
			)
			.get(issueKey) as
			| {
					repos_json: string;
					overrides_json: string;
					method: string;
					decided_ms: number;
			  }
			| undefined;
		if (!row) return undefined;
		try {
			const repoNames = JSON.parse(row.repos_json) as unknown;
			const overrides = JSON.parse(row.overrides_json) as unknown;
			if (!Array.isArray(repoNames)) return undefined;
			return {
				repoNames: repoNames as string[],
				baseBranchOverrides: (overrides ?? {}) as Record<string, string>,
				method: row.method,
				decidedMs: row.decided_ms,
			};
		} catch {
			// A corrupt row reads as absent. The resolver then re-derives the
			// decision from the registry, which is deterministic for every
			// non-ambiguous case — strictly better than throwing on a boot path.
			return undefined;
		}
	}

	setIssueRepositories(
		issueKey: string,
		decision: Omit<StoredRepositoryDecision, "decidedMs">,
		nowMs: number,
	): void {
		this.db
			.prepare(
				`INSERT INTO issue_repositories (issue_key, repos_json, overrides_json, method, decided_ms)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(issue_key) DO UPDATE SET
				   repos_json = excluded.repos_json,
				   overrides_json = excluded.overrides_json,
				   method = excluded.method,
				   decided_ms = excluded.decided_ms`,
			)
			.run(
				issueKey,
				JSON.stringify(decision.repoNames),
				JSON.stringify(decision.baseBranchOverrides),
				decision.method,
				nowMs,
			);
	}

	deleteIssueRepositories(issueKey: string): void {
		this.db
			.prepare("DELETE FROM issue_repositories WHERE issue_key = ?")
			.run(issueKey);
	}

	createPendingRepoSelection(row: PendingRepoSelection): void {
		this.db
			.prepare(
				`INSERT INTO pending_repo_selections
				   (agent_session_id, issue_key, workspace_id, options_json, created_event, created_ms)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(agent_session_id) DO UPDATE SET
				   issue_key = excluded.issue_key,
				   workspace_id = excluded.workspace_id,
				   options_json = excluded.options_json,
				   created_event = excluded.created_event,
				   created_ms = excluded.created_ms`,
			)
			.run(
				row.agentSessionId,
				row.issueKey,
				row.workspaceId,
				JSON.stringify(row.options),
				row.createdEvent,
				row.createdMs,
			);
	}

	getPendingRepoSelection(
		agentSessionId: string,
	): PendingRepoSelection | undefined {
		const row = this.db
			.prepare(
				"SELECT issue_key, workspace_id, options_json, created_event, created_ms FROM pending_repo_selections WHERE agent_session_id = ?",
			)
			.get(agentSessionId) as
			| {
					issue_key: string;
					workspace_id: string;
					options_json: string;
					created_event: string;
					created_ms: number;
			  }
			| undefined;
		if (!row) return undefined;
		let options: string[];
		try {
			const parsed = JSON.parse(row.options_json) as unknown;
			options = Array.isArray(parsed) ? (parsed as string[]) : [];
		} catch {
			options = [];
		}
		return {
			agentSessionId,
			issueKey: row.issue_key,
			workspaceId: row.workspace_id,
			options,
			createdEvent: row.created_event,
			createdMs: row.created_ms,
		};
	}

	deletePendingRepoSelection(agentSessionId: string): void {
		this.db
			.prepare(
				"DELETE FROM pending_repo_selections WHERE agent_session_id = ?",
			)
			.run(agentSessionId);
	}

	/** Drops selections created before `cutoffMs`. Returns how many were removed. */
	sweepPendingRepoSelections(cutoffMs: number): number {
		return this.db
			.prepare("DELETE FROM pending_repo_selections WHERE created_ms < ?")
			.run(cutoffMs).changes;
	}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter cyrus-router test:run test/RouterStore.test.ts`
Expected: PASS, including the 9 new cases.

- [ ] **Step 6: Commit**

```bash
git add packages/router/src/RouterStore.ts packages/router/test/RouterStore.test.ts
git commit -m "feat(router): persist repository decisions and pending selections"
```

---

### Task 8: Elicitation posting and issue-fact fetching on `LinearExecutor`

**Files:**
- Modify: `packages/router/src/LinearExecutor.ts` (around line 169)
- Test: `packages/router/test/LinearExecutor.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `IssueFacts` from `cyrus-core` (Task 2).
- Produces, on `LinearExecutor`:
  - `postActivity(workspaceId: string, agentSessionId: string, body: string, options?: { signal?: AgentActivitySignal; signalMetadata?: Record<string, unknown>; contentType?: AgentActivityContentType }): Promise<void>` — the existing three-argument call sites are unchanged.
  - `postRepositorySelection(workspaceId: string, agentSessionId: string, body: string, options: string[]): Promise<void>`
  - `fetchIssueFacts(workspaceId: string, issueId: string): Promise<IssueFacts | undefined>`

- [ ] **Step 1: Write the failing test**

Append to `packages/router/test/LinearExecutor.test.ts`, following the file's
existing tracker-stub conventions:

```ts
describe("postRepositorySelection", () => {
	it("posts an elicitation carrying a Select signal and the option list", async () => {
		const createAgentActivity = vi.fn(async () => ({ success: true }));
		const executor = executorWithTracker("ws-1", { createAgentActivity });

		await executor.postRepositorySelection("ws-1", "sess-1", "Which repo?", [
			"cyrus-api",
			"cyrus-web",
		]);

		expect(createAgentActivity).toHaveBeenCalledWith({
			agentSessionId: "sess-1",
			content: { type: "elicitation", body: "Which repo?" },
			signal: "select",
			signalMetadata: {
				options: [{ value: "cyrus-api" }, { value: "cyrus-web" }],
			},
		});
	});

	it("is a no-op when the workspace has no configured tracker", async () => {
		const executor = executorWithTracker("ws-other", {
			createAgentActivity: vi.fn(),
		});
		await expect(
			executor.postRepositorySelection("ws-missing", "sess-1", "x", ["a"]),
		).resolves.toBeUndefined();
	});
});

describe("postActivity", () => {
	it("still posts a plain thought when no options are given", async () => {
		const createAgentActivity = vi.fn(async () => ({ success: true }));
		const executor = executorWithTracker("ws-1", { createAgentActivity });
		await executor.postActivity("ws-1", "sess-1", "hello");
		expect(createAgentActivity).toHaveBeenCalledWith({
			agentSessionId: "sess-1",
			content: { type: "thought", body: "hello" },
		});
	});
});

describe("fetchIssueFacts", () => {
	it("collects team key, project name, labels, and description in one call", async () => {
		const executor = executorWithTracker("ws-1", {
			fetchIssue: vi.fn(async () => ({
				id: "issue-1",
				description: "[repo=cyrus-api]",
				team: Promise.resolve({ key: "NOR" }),
				project: Promise.resolve({ name: "Platform" }),
				labels: async () => ({ nodes: [{ name: "bug" }, { name: "urgent" }] }),
			})),
		});

		expect(await executor.fetchIssueFacts("ws-1", "issue-1")).toEqual({
			teamKey: "NOR",
			projectName: "Platform",
			labels: ["bug", "urgent"],
			description: "[repo=cyrus-api]",
		});
	});

	it("omits facts the issue does not carry rather than inventing them", async () => {
		const executor = executorWithTracker("ws-1", {
			fetchIssue: vi.fn(async () => ({
				id: "issue-1",
				team: Promise.resolve(undefined),
				project: Promise.resolve(undefined),
				labels: async () => ({ nodes: [] }),
			})),
		});

		expect(await executor.fetchIssueFacts("ws-1", "issue-1")).toEqual({
			labels: [],
		});
	});

	it("returns undefined when the workspace has no tracker", async () => {
		const executor = executorWithTracker("ws-1", { fetchIssue: vi.fn() });
		expect(await executor.fetchIssueFacts("ws-missing", "issue-1")).toBeUndefined();
	});

	it("degrades to the facts it did get when a sub-fetch throws", async () => {
		const executor = executorWithTracker("ws-1", {
			fetchIssue: vi.fn(async () => ({
				id: "issue-1",
				description: "hello",
				team: Promise.resolve({ key: "NOR" }),
				get project() {
					throw new Error("project unavailable");
				},
				labels: async () => {
					throw new Error("labels unavailable");
				},
			})),
		});

		expect(await executor.fetchIssueFacts("ws-1", "issue-1")).toEqual({
			teamKey: "NOR",
			description: "hello",
			labels: [],
		});
	});

	it("returns undefined when fetchIssue itself throws", async () => {
		const executor = executorWithTracker("ws-1", {
			fetchIssue: vi.fn(async () => {
				throw new Error("Linear 500");
			}),
		});
		expect(await executor.fetchIssueFacts("ws-1", "issue-1")).toBeUndefined();
	});
});
```

Add a helper near the top of the file if one does not already exist, matching
how the existing tests build an executor:

```ts
/** Builds a LinearExecutor whose only tracker is registered under `workspaceId`. */
function executorWithTracker(
	workspaceId: string,
	tracker: Partial<IIssueTrackerService>,
): LinearExecutor {
	const executor = new LinearExecutor({
		trackers: new Map([[workspaceId, tracker as IIssueTrackerService]]),
		logger: { info: vi.fn(), warn: vi.fn() },
	});
	return executor;
}
```

Read `LinearExecutor`'s constructor before writing this helper and match its
actual options object — the shape above is illustrative of the seam, not a
guarantee of the parameter names.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-router test:run test/LinearExecutor.test.ts`
Expected: FAIL — `executor.postRepositorySelection is not a function`.

- [ ] **Step 3: Extend `postActivity` and add the two new methods**

In `packages/router/src/LinearExecutor.ts`, replace `postActivity` (line 169)
with:

```ts
	/**
	 * Posts an activity to a session. A no-op when the workspace has no
	 * configured tracker (e.g. a router restart lost the session→workspace hint
	 * used by the stale-lock sweep).
	 *
	 * `options` exists so the router can post an *elicitation* with a `select`
	 * signal, not only the plain thoughts the offline/expiry/enrollment notices
	 * use. Every existing three-argument call site is unaffected.
	 */
	async postActivity(
		workspaceId: string,
		agentSessionId: string,
		body: string,
		options?: {
			contentType?: AgentActivityContentType;
			signal?: AgentActivitySignal;
			signalMetadata?: Record<string, unknown>;
		},
	): Promise<void> {
		const tracker = this.trackers.get(workspaceId);
		if (!tracker) return;
		await tracker.createAgentActivity({
			agentSessionId,
			content: {
				type: options?.contentType ?? AgentActivityContentType.Thought,
				body,
			},
			...(options?.signal ? { signal: options.signal } : {}),
			...(options?.signalMetadata
				? { signalMetadata: options.signalMetadata }
				: {}),
		});
	}

	/**
	 * Asks the user which repository an issue belongs to.
	 *
	 * This is the same Linear API `RepositoryRouter.elicitUserRepositorySelection`
	 * uses on a device, moved to the router so the question can be asked BEFORE a
	 * container exists — nothing runs, and nothing is billed, while the user
	 * decides.
	 */
	async postRepositorySelection(
		workspaceId: string,
		agentSessionId: string,
		body: string,
		options: string[],
	): Promise<void> {
		await this.postActivity(workspaceId, agentSessionId, body, {
			contentType: AgentActivityContentType.Elicitation,
			signal: AgentActivitySignal.Select,
			signalMetadata: { options: options.map((value) => ({ value })) },
		});
	}

	/**
	 * Reads everything the repository matcher needs, in ONE `fetchIssue`.
	 *
	 * Each sub-read is guarded separately: a Linear hiccup fetching labels must
	 * not suppress the team key we already have, because a partial fact set
	 * still routes correctly far more often than no fact set does. A failure of
	 * `fetchIssue` itself yields `undefined`, which the caller treats as "cannot
	 * route yet" rather than as "no facts".
	 */
	async fetchIssueFacts(
		workspaceId: string,
		issueId: string,
	): Promise<IssueFacts | undefined> {
		const tracker = this.trackers.get(workspaceId);
		if (!tracker) return undefined;

		let issue: Awaited<ReturnType<IIssueTrackerService["fetchIssue"]>>;
		try {
			issue = await tracker.fetchIssue(issueId);
		} catch (error) {
			this.logger.warn(
				`Could not fetch issue ${issueId} for repository routing: ${String(error)}`,
			);
			return undefined;
		}
		if (!issue) return undefined;

		const facts: IssueFacts = {};
		if (typeof issue.description === "string" && issue.description !== "") {
			facts.description = issue.description;
		}

		try {
			const team = await issue.team;
			if (team?.key) facts.teamKey = team.key;
		} catch (error) {
			this.logger.warn(
				`Could not read the team of issue ${issueId} for routing: ${String(error)}`,
			);
		}

		try {
			const project = await issue.project;
			if (project?.name) facts.projectName = project.name;
		} catch (error) {
			this.logger.warn(
				`Could not read the project of issue ${issueId} for routing: ${String(error)}`,
			);
		}

		try {
			const labels = await issue.labels();
			facts.labels = (labels?.nodes ?? [])
				.map((label) => label.name)
				.filter((name): name is string => typeof name === "string");
		} catch (error) {
			this.logger.warn(
				`Could not read the labels of issue ${issueId} for routing: ${String(error)}`,
			);
			facts.labels = [];
		}

		return facts;
	}
```

Extend the imports at the top of the file:

```ts
import {
	AgentActivityContentType,
	AgentActivitySignal,
	type IssueFacts,
} from "cyrus-core";
```

`AgentActivitySignal` is re-exported from `cyrus-core`
(`packages/core/src/issue-tracker/types.ts:521`); do not import it from
`@linear/sdk` directly.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter cyrus-router test:run test/LinearExecutor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/router/src/LinearExecutor.ts packages/router/test/LinearExecutor.test.ts
git commit -m "feat(router): post repository elicitations and fetch routing facts"
```

---

### Task 9: The repository resolver

**Files:**
- Create: `packages/router/src/RepositoryResolver.ts`
- Test: `packages/router/test/RepositoryResolver.test.ts`

**Interfaces:**
- Consumes: `matchRepositories`, `IssueFacts` (Task 2); `RepositoryRegistry`, `RegisteredRepository`, `toRoutable` (Task 4); `StoredRepositoryDecision` (Task 7).
- Produces:
  - `interface RepositoryDecision { repositories: RegisteredRepository[]; method: string; baseBranchOverrides: Record<string, string> }`
  - `type ResolveOutcome = { kind: "resolved"; decision: RepositoryDecision } | { kind: "needs_selection"; candidates: RegisteredRepository[]; reason: "ambiguous" | "unmatched" } | { kind: "unavailable"; reason: string }`
  - `class RepositoryResolver` with `resolve(opts: { workspaceId: string; issueId: string | undefined }): Promise<ResolveOutcome>` and `selectByOptionValue(value: string, candidates: RegisteredRepository[]): RepositoryDecision | undefined` and `fallbackDecision(repositories: RegisteredRepository[]): RepositoryDecision | undefined`

- [ ] **Step 1: Write the failing test**

Create `packages/router/test/RepositoryResolver.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type {
	RegisteredRepository,
	RepositoryRegistry,
} from "../src/RepositoryRegistry.js";
import { RepositoryResolver } from "../src/RepositoryResolver.js";

const API: RegisteredRepository = {
	name: "cyrus-api",
	githubSlug: "acme/cyrus-api",
	linearWorkspaceId: "ws-1",
	projectKeys: ["Platform"],
	teamKeys: ["NOR"],
};
const WEB: RegisteredRepository = {
	name: "cyrus-web",
	githubSlug: "acme/cyrus-web",
	linearWorkspaceId: "ws-1",
	teamKeys: ["WEB"],
};
const INFRA: RegisteredRepository = {
	name: "cyrus-infra",
	githubSlug: "acme/cyrus-infra",
	linearWorkspaceId: "ws-1",
	isDefault: true,
};

function resolver(
	repositories: RegisteredRepository[],
	facts: Record<string, unknown> | undefined,
) {
	const registry: RepositoryRegistry = {
		list: vi.fn(async () => ({ repositories })),
		put: vi.fn(async () => ({ version: "1" })),
	};
	return new RepositoryResolver({
		registry,
		fetchIssueFacts: vi.fn(async () => facts as never),
		logger: { info: vi.fn(), warn: vi.fn() },
	});
}

describe("RepositoryResolver.resolve", () => {
	it("resolves a team match to a single repository", async () => {
		const outcome = await resolver([API, WEB, INFRA], { teamKey: "WEB" }).resolve({
			workspaceId: "ws-1",
			issueId: "issue-1",
		});
		expect(outcome).toEqual({
			kind: "resolved",
			decision: {
				repositories: [WEB],
				method: "team-based",
				baseBranchOverrides: {},
			},
		});
	});

	it("prefers a project match over a team match", async () => {
		const outcome = await resolver([API, WEB, INFRA], {
			projectName: "Platform",
			teamKey: "WEB",
		}).resolve({ workspaceId: "ws-1", issueId: "issue-1" });
		expect(outcome).toMatchObject({
			kind: "resolved",
			decision: { method: "project-based" },
		});
	});

	it("carries base-branch overrides from a description tag", async () => {
		const outcome = await resolver([API, WEB], {
			description: "repo=cyrus-api,cyrus-web#release",
		}).resolve({ workspaceId: "ws-1", issueId: "issue-1" });
		expect(outcome).toMatchObject({
			kind: "resolved",
			decision: {
				method: "description-tag",
				baseBranchOverrides: {
					"cyrus-api": "release",
					"cyrus-web": "release",
				},
			},
		});
	});

	it("falls back to the default repository when nothing matches", async () => {
		const outcome = await resolver([API, WEB, INFRA], {
			teamKey: "UNKNOWN",
		}).resolve({ workspaceId: "ws-1", issueId: "issue-1" });
		expect(outcome).toMatchObject({
			kind: "resolved",
			decision: { repositories: [INFRA], method: "default" },
		});
	});

	it("asks for a selection when two repositories tie on a team", async () => {
		const a = { ...API, name: "a", teamKeys: ["NOR"] };
		const b = { ...WEB, name: "b", teamKeys: ["NOR"] };
		const outcome = await resolver([a, b], { teamKey: "NOR" }).resolve({
			workspaceId: "ws-1",
			issueId: "issue-1",
		});
		expect(outcome).toEqual({
			kind: "needs_selection",
			candidates: [a, b],
			reason: "ambiguous",
		});
	});

	it("asks over every repository when nothing matches and no default is set", async () => {
		const outcome = await resolver([API, WEB], { teamKey: "UNKNOWN" }).resolve({
			workspaceId: "ws-1",
			issueId: "issue-1",
		});
		expect(outcome).toEqual({
			kind: "needs_selection",
			candidates: [API, WEB],
			reason: "unmatched",
		});
	});

	it("reports unavailable when the registry is empty", async () => {
		const outcome = await resolver([], { teamKey: "NOR" }).resolve({
			workspaceId: "ws-1",
			issueId: "issue-1",
		});
		expect(outcome).toMatchObject({ kind: "unavailable" });
		expect(outcome.kind === "unavailable" && outcome.reason).toContain(
			"No repositories are registered",
		);
	});

	it("routes on the registry alone when the issue has no id", async () => {
		const outcome = await resolver([API, INFRA], undefined).resolve({
			workspaceId: "ws-1",
			issueId: undefined,
		});
		expect(outcome).toMatchObject({
			kind: "resolved",
			decision: { repositories: [INFRA], method: "default" },
		});
	});

	it("still routes on the default when facts could not be fetched", async () => {
		const outcome = await resolver([API, INFRA], undefined).resolve({
			workspaceId: "ws-1",
			issueId: "issue-1",
		});
		expect(outcome).toMatchObject({
			kind: "resolved",
			decision: { method: "default" },
		});
	});

	it("only considers repositories belonging to the event's workspace", async () => {
		const otherWorkspace = { ...WEB, name: "other", linearWorkspaceId: "ws-2" };
		const outcome = await resolver([otherWorkspace, INFRA], {
			teamKey: "WEB",
		}).resolve({ workspaceId: "ws-1", issueId: "issue-1" });
		expect(outcome).toMatchObject({
			kind: "resolved",
			decision: { repositories: [INFRA] },
		});
	});
});

describe("RepositoryResolver.selectByOptionValue", () => {
	it("matches an offered option back to its repository", () => {
		const decision = resolver([], undefined).selectByOptionValue("cyrus-web", [
			API,
			WEB,
		]);
		expect(decision).toEqual({
			repositories: [WEB],
			method: "user-selected",
			baseBranchOverrides: {},
		});
	});

	it("returns undefined for a value that was never offered", () => {
		expect(
			resolver([], undefined).selectByOptionValue("do the thing", [API, WEB]),
		).toBeUndefined();
	});

	it("ignores surrounding whitespace and case", () => {
		expect(
			resolver([], undefined).selectByOptionValue("  CYRUS-WEB ", [API, WEB]),
		).toMatchObject({ repositories: [WEB] });
	});
});

describe("RepositoryResolver.fallbackDecision", () => {
	it("prefers the default repository", () => {
		expect(resolver([], undefined).fallbackDecision([API, WEB, INFRA])).toEqual({
			repositories: [INFRA],
			method: "default",
			baseBranchOverrides: {},
		});
	});

	it("uses the first registered repository when none is marked default", () => {
		expect(resolver([], undefined).fallbackDecision([API, WEB])).toMatchObject({
			repositories: [API],
			method: "fallback-first",
		});
	});

	it("returns undefined when there is nothing to fall back to", () => {
		expect(resolver([], undefined).fallbackDecision([])).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-router test:run test/RepositoryResolver.test.ts`
Expected: FAIL — cannot resolve `../src/RepositoryResolver.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/router/src/RepositoryResolver.ts`:

```ts
import { type IssueFacts, matchRepositories } from "cyrus-core";
import {
	type RegisteredRepository,
	type RepositoryRegistry,
	toRoutable,
} from "./RepositoryRegistry.js";

/** What the router decided, in a form `ContainerTargets` can persist and replay. */
export interface RepositoryDecision {
	repositories: RegisteredRepository[];
	/** A `RoutingMethod`, or `"user-selected"` / `"fallback-first"`. */
	method: string;
	/** Repository name -> base branch. Empty when there are no overrides. */
	baseBranchOverrides: Record<string, string>;
}

export type ResolveOutcome =
	| { kind: "resolved"; decision: RepositoryDecision }
	| {
			kind: "needs_selection";
			candidates: RegisteredRepository[];
			reason: "ambiguous" | "unmatched";
	  }
	| { kind: "unavailable"; reason: string };

export interface RepositoryResolverDeps {
	registry: RepositoryRegistry;
	/** `LinearExecutor.fetchIssueFacts`. */
	fetchIssueFacts: (
		workspaceId: string,
		issueId: string,
	) => Promise<IssueFacts | undefined>;
	logger: { info(msg: string): void; warn(msg: string): void };
}

/**
 * Decides which repositories an issue belongs to, on the router, before any
 * container exists.
 *
 * The router is the right place for this because it is the only party holding a
 * Linear token: it can read the issue's project — which a device cannot, since
 * `RouterIssueTrackerService` has no project data of its own — and because
 * deciding here means the sandbox receives only the repositories it needs and
 * clones one instead of all of them.
 */
export class RepositoryResolver {
	constructor(private readonly deps: RepositoryResolverDeps) {}

	async resolve(opts: {
		workspaceId: string;
		issueId: string | undefined;
	}): Promise<ResolveOutcome> {
		const { repositories } = await this.deps.registry.list();
		const scoped = repositories.filter(
			(repo) => repo.linearWorkspaceId === opts.workspaceId,
		);
		if (scoped.length === 0) {
			return {
				kind: "unavailable",
				reason: `No repositories are registered for Linear workspace ${opts.workspaceId}. Add one at /setup/repositories.`,
			};
		}

		// Facts are best-effort. A Linear failure here degrades to "route on the
		// registry alone", which still lands on the default repository — a far
		// better outcome than refusing to start work.
		let facts: IssueFacts = {};
		if (opts.issueId) {
			const fetched = await this.deps.fetchIssueFacts(
				opts.workspaceId,
				opts.issueId,
			);
			if (fetched) {
				facts = fetched;
			} else {
				this.deps.logger.warn(
					`No issue facts available for ${opts.issueId}; routing on the registry alone`,
				);
			}
		}

		const routable = scoped.map(toRoutable);
		const match = matchRepositories(facts, routable);

		if (match.kind === "matched") {
			const overrides: Record<string, string> = {};
			for (const [id, branch] of match.baseBranchOverrides ?? []) {
				overrides[id] = branch;
			}
			return {
				kind: "resolved",
				decision: {
					repositories: match.repositories.map((repo) => repo.source),
					method: match.method,
					baseBranchOverrides: overrides,
				},
			};
		}

		if (match.kind === "ambiguous") {
			return {
				kind: "needs_selection",
				candidates: match.candidates.map((repo) => repo.source),
				reason: "ambiguous",
			};
		}

		return { kind: "needs_selection", candidates: scoped, reason: "unmatched" };
	}

	/**
	 * Maps a user's answer back to the repository it named.
	 *
	 * Compared case-insensitively and whitespace-trimmed: Linear echoes the
	 * option value back verbatim, but a user may also type the name by hand,
	 * and a near-miss on case would otherwise be indistinguishable from someone
	 * ignoring the question entirely.
	 */
	selectByOptionValue(
		value: string,
		candidates: RegisteredRepository[],
	): RepositoryDecision | undefined {
		const folded = value.trim().toLowerCase();
		const chosen = candidates.find(
			(repo) => repo.name.toLowerCase() === folded,
		);
		if (!chosen) return undefined;
		return {
			repositories: [chosen],
			method: "user-selected",
			baseBranchOverrides: {},
		};
	}

	/**
	 * The decision to use when a posted elicitation was ignored — the user typed
	 * a real prompt instead of picking. Prefers the configured default; if there
	 * is none, the first registered repository, because at this point the
	 * question has already been asked once and asking again would strand the
	 * session.
	 */
	fallbackDecision(
		repositories: RegisteredRepository[],
	): RepositoryDecision | undefined {
		const preferred =
			repositories.find((repo) => repo.isDefault === true) ?? repositories[0];
		if (!preferred) return undefined;
		return {
			repositories: [preferred],
			method: preferred.isDefault === true ? "default" : "fallback-first",
			baseBranchOverrides: {},
		};
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter cyrus-router test:run test/RepositoryResolver.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/router/src/RepositoryResolver.ts packages/router/test/RepositoryResolver.test.ts
git commit -m "feat(router): resolve an issue's repositories from the registry"
```

---

### Task 10: Hold-and-elicit in `EventRouter`

**Files:**
- Modify: `packages/router/src/EventRouter.ts`
- Modify: `packages/router/src/messages.ts`
- Test: `packages/router/test/EventRouter.repo-selection.test.ts`

**Interfaces:**
- Consumes: `RepositoryResolver`, `RepositoryDecision`, `ResolveOutcome` (Task 9); `StoredRepositoryDecision`, `PendingRepoSelection` and their accessors (Task 7).
- Produces:
  - `EventRouterOptions` gains `repositoryResolver?: RepositoryResolver` and `postRepositorySelection?: (workspaceId: string, agentSessionId: string, body: string, options: string[]) => Promise<void>`.
  - `messages.ts` gains `REPOSITORY_SELECTION_PROMPT` and `NO_REPOSITORIES_MESSAGE`.

- [ ] **Step 1: Add the message templates**

Append to `packages/router/src/messages.ts`:

```ts
/** Body of the repository-selection elicitation the router posts. */
export const REPOSITORY_SELECTION_PROMPT =
	"Which repository should I work in for this issue?";

/**
 * Templated with `{{reason}}` — render with {@link fillTemplate} before posting.
 */
export const NO_REPOSITORIES_MESSAGE = `I can't start work on this issue yet: {{reason}}

Once a repository is registered, re-assign this issue (or mention me again) and I'll pick it up.`;
```

- [ ] **Step 2: Write the failing test**

Create `packages/router/test/EventRouter.repo-selection.test.ts`. Model the
harness on `packages/router/test/EventRouter.test.ts` — read it first and reuse
its `RouterStore(":memory:")` setup, its fake gateway, and its webhook builders
rather than inventing new ones.

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContainerTargetService } from "../src/ContainerTargets.js";
import { EventRouter } from "../src/EventRouter.js";
import type { RegisteredRepository } from "../src/RepositoryRegistry.js";
import { RepositoryResolver } from "../src/RepositoryResolver.js";
import { RouterStore } from "../src/RouterStore.js";

const API: RegisteredRepository = {
	name: "cyrus-api",
	githubSlug: "acme/cyrus-api",
	linearWorkspaceId: "ws-1",
	teamKeys: ["NOR"],
};
const WEB: RegisteredRepository = {
	name: "cyrus-web",
	githubSlug: "acme/cyrus-web",
	linearWorkspaceId: "ws-1",
	teamKeys: ["NOR"],
};

describe("EventRouter repository selection", () => {
	let store: RouterStore;
	let postRepositorySelection: ReturnType<typeof vi.fn>;
	let enqueued: string[];

	beforeEach(() => {
		store = new RouterStore(":memory:");
		postRepositorySelection = vi.fn(async () => {});
		enqueued = [];
	});

	it("persists an unambiguous decision and delivers the created event", async () => {
		const { router, created } = harness([API], { teamKey: "NOR" });
		await router.route(created);

		expect(store.getIssueRepositories("NOR-1")).toMatchObject({
			repoNames: ["cyrus-api"],
			method: "team-based",
		});
		expect(enqueued).toHaveLength(1);
		expect(postRepositorySelection).not.toHaveBeenCalled();
	});

	it("holds the created event and elicits when two repositories tie", async () => {
		const { router, created } = harness([API, WEB], { teamKey: "NOR" });
		await router.route(created);

		expect(postRepositorySelection).toHaveBeenCalledWith(
			"ws-1",
			"sess-1",
			"Which repository should I work in for this issue?",
			["cyrus-api", "cyrus-web"],
		);
		// Nothing is delivered and NO container device is created while waiting.
		expect(enqueued).toEqual([]);
		expect(store.getContainerDeviceForIssue("NOR-1")).toBeUndefined();
		expect(store.getPendingRepoSelection("sess-1")).toMatchObject({
			issueKey: "NOR-1",
			options: ["cyrus-api", "cyrus-web"],
		});
	});

	it("does not post a second elicitation for a repeated created event", async () => {
		const { router, created } = harness([API, WEB], { teamKey: "NOR" });
		await router.route(created);
		await router.route({ ...created, agentSession: { ...created.agentSession } });
		expect(postRepositorySelection).toHaveBeenCalledTimes(1);
	});

	it("answering the elicitation resolves, replays the created event, and boots", async () => {
		const { router, created, prompted } = harness([API, WEB], { teamKey: "NOR" });
		await router.route(created);
		enqueued.length = 0;

		await router.route(prompted("cyrus-web"));

		expect(store.getIssueRepositories("NOR-1")).toMatchObject({
			repoNames: ["cyrus-web"],
			method: "user-selected",
		});
		expect(store.getPendingRepoSelection("sess-1")).toBeUndefined();
		// The held `created` event is delivered; the answer itself is consumed.
		expect(enqueued).toHaveLength(1);
		expect(JSON.parse(enqueued[0] as string).action).toBe("created");
	});

	it("an unrelated reply falls back and delivers BOTH the created event and the prompt", async () => {
		const { router, created, prompted } = harness([API, WEB], { teamKey: "NOR" });
		await router.route(created);
		enqueued.length = 0;

		await router.route(prompted("actually just fix the typo"));

		expect(store.getIssueRepositories("NOR-1")).toMatchObject({
			repoNames: ["cyrus-api"],
			method: "fallback-first",
		});
		expect(enqueued.map((raw) => JSON.parse(raw).action)).toEqual([
			"created",
			"prompted",
		]);
	});

	it("reuses a stored decision without re-resolving or re-asking", async () => {
		const { router, created, resolveSpy } = harness([API], { teamKey: "NOR" });
		await router.route(created);
		resolveSpy.mockClear();

		await router.route({ ...created, agentSession: { ...created.agentSession, id: "sess-2" } });
		expect(resolveSpy).not.toHaveBeenCalled();
	});

	it("posts an actionable notice when no repositories are registered", async () => {
		const { router, created, postActivity } = harness([], { teamKey: "NOR" });
		await router.route(created);

		expect(postActivity).toHaveBeenCalledWith(
			"ws-1",
			"sess-1",
			expect.stringContaining("No repositories are registered"),
		);
		expect(enqueued).toEqual([]);
	});

	function harness(
		repositories: RegisteredRepository[],
		facts: Record<string, unknown>,
	) {
		const { userId } = store.addUser({ email: "alice@example.com" });
		store.setUserExecutor("alice@example.com", JSON.stringify({ type: "aca" }));

		const registry = {
			list: vi.fn(async () => ({ repositories })),
			put: vi.fn(async () => ({ version: "1" })),
		};
		const resolver = new RepositoryResolver({
			registry,
			fetchIssueFacts: vi.fn(async () => facts as never),
			logger: { info: vi.fn(), warn: vi.fn() },
		});
		const resolveSpy = vi.spyOn(resolver, "resolve");

		const containerTargets = new ContainerTargetService({
			store,
			secrets: { get: async () => ({}), set: async () => {}, isFullyAuthenticated: async () => ({ ok: true, missing: [] }) } as never,
			executors: new Map([
				[
					"aca",
					{
						provider: "aca",
						ensureRunning: vi.fn(async () => {}),
						destroy: vi.fn(async () => {}),
						stop: vi.fn(async () => {}),
						status: vi.fn(async () => "running" as const),
						listManaged: vi.fn(async () => []),
					},
				],
			]) as never,
			registry,
			containersConfig: { routerUrlForContainers: "wss://router.example.com" },
			postActivity: async () => {},
			logger: { info: vi.fn(), warn: vi.fn() },
		});

		const postActivity = vi.fn(async () => {});
		const router = new EventRouter({
			store,
			gateway: { isOnline: () => false, deliverPending: vi.fn() },
			postActivity,
			containerTargets,
			repositoryResolver: resolver,
			postRepositorySelection,
			config: {
				eventTtlMs: 60_000,
				issueLock: false,
				creatorOnlyPrompting: false,
				affinityGraceMs: 600_000,
			},
			logger: { info: vi.fn(), warn: vi.fn() },
			now: () => 1000,
		});

		// Capture what reaches the queue without reaching into the store's schema.
		vi.spyOn(store, "enqueueEvent").mockImplementation((_deviceId, payload) => {
			enqueued.push(payload);
			return 1;
		});

		const agentSession = {
			id: "sess-1",
			issueId: "issue-1",
			issue: { id: "issue-1", identifier: "NOR-1", team: { key: "NOR" } },
			creator: { id: "user-1", email: "alice@example.com" },
		};
		const created = {
			action: "created",
			type: "AgentSessionEvent",
			organizationId: "ws-1",
			agentSession,
		} as never;
		const prompted = (body: string) =>
			({
				action: "prompted",
				type: "AgentSessionEvent",
				organizationId: "ws-1",
				agentSession,
				agentActivity: { userId: "user-1", content: { body } },
			}) as never;

		return { router, created, prompted, postActivity, resolveSpy };
	}
});
```

Read `EventRouter.test.ts` first and reconcile the fake gateway, secrets stub,
and executor-registry shapes above with what that file already uses — prefer its
existing helpers over the inline literals here wherever they exist.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter cyrus-router test:run test/EventRouter.repo-selection.test.ts`
Expected: FAIL — no elicitation is posted; every case routes straight through.

- [ ] **Step 4: Add the resolution hook to `routeCreated`**

In `packages/router/src/EventRouter.ts`, extend `EventRouterOptions`:

```ts
	/**
	 * Decides which repositories an issue routes to, before any container is
	 * created. Optional: omitting it keeps every container booting with the whole
	 * configured repository list (pre-registry behaviour).
	 */
	repositoryResolver?: RepositoryResolver;
	/** `LinearExecutor.postRepositorySelection`. Required alongside the resolver. */
	postRepositorySelection?: (
		workspaceId: string,
		agentSessionId: string,
		body: string,
		options: string[],
	) => Promise<void>;
```

Add imports:

```ts
import type {
	RepositoryDecision,
	RepositoryResolver,
} from "./RepositoryResolver.js";
import {
	fillTemplate,
	NO_REPOSITORIES_MESSAGE,
	REPOSITORY_SELECTION_PROMPT,
} from "./messages.js";
```

Insert this method on the class:

```ts
	/**
	 * Ensures the issue has a repository decision before anything boots.
	 *
	 * Returns `"ready"` when routing may continue, and `"held"` when an
	 * elicitation was posted (or a blocking notice was) and this webhook must
	 * NOT be delivered. A held event is stashed verbatim and replayed by
	 * {@link resumeHeldSelection} once the user answers.
	 *
	 * Deliberately runs BEFORE `resolveTarget`: creating the container device
	 * first would mint a device row — and boot a sandbox — for an issue whose
	 * repository nobody has chosen yet. Waiting here costs nothing, which is the
	 * whole point of asking on the router rather than inside a container.
	 */
	private async ensureRepositoryDecision(
		webhook: SessionEvent,
		issueKey: string,
		workspaceId: string,
		issueId: string | undefined,
	): Promise<"ready" | "held"> {
		const resolver = this.repositoryResolver;
		if (!resolver) return "ready";
		if (this.store.getIssueRepositories(issueKey)) return "ready";

		const sessionId = webhook.agentSession.id;
		if (this.store.getPendingRepoSelection(sessionId)) {
			// A repeated `created` delivery for a session already waiting on an
			// answer. Asking again would post a second elicitation and overwrite
			// the held event with an identical one — silent, but noisy in Linear.
			this.logger.info(
				`Session ${sessionId} is already waiting on a repository selection; not asking again`,
			);
			return "held";
		}

		const outcome = await resolver.resolve({ workspaceId, issueId });

		if (outcome.kind === "resolved") {
			this.persistDecision(issueKey, outcome.decision);
			return "ready";
		}

		if (outcome.kind === "unavailable") {
			await this.postActivity(
				workspaceId,
				sessionId,
				fillTemplate(NO_REPOSITORIES_MESSAGE, { reason: outcome.reason }),
			);
			this.logger.warn(
				`Cannot route session ${sessionId}: ${outcome.reason}`,
			);
			return "held";
		}

		const options = outcome.candidates.map((repo) => repo.name);
		if (!this.postRepositorySelection) {
			this.logger.warn(
				`Repository selection needed for ${issueKey} but no elicitation transport is configured; routing to a fallback`,
			);
			const fallback = resolver.fallbackDecision(outcome.candidates);
			if (!fallback) return "held";
			this.persistDecision(issueKey, fallback);
			return "ready";
		}

		try {
			await this.postRepositorySelection(
				workspaceId,
				sessionId,
				REPOSITORY_SELECTION_PROMPT,
				options,
			);
		} catch (error) {
			// Never stash a held event for an elicitation that was never posted:
			// nothing would ever arrive to release it, and the issue would sit
			// silently forever. Fall back instead, and say so.
			this.logger.warn(
				`Failed to post the repository selection for ${issueKey}: ${String(error)}; routing to a fallback`,
			);
			const fallback = resolver.fallbackDecision(outcome.candidates);
			if (!fallback) return "held";
			this.persistDecision(issueKey, fallback);
			return "ready";
		}

		this.store.createPendingRepoSelection({
			agentSessionId: sessionId,
			issueKey,
			workspaceId,
			options,
			createdEvent: JSON.stringify(webhook),
			createdMs: this.now(),
		});
		this.logger.info(
			`Posted a repository selection for ${issueKey} (${outcome.reason}) with options [${options.join(", ")}]; holding the created event`,
		);
		return "held";
	}

	private persistDecision(
		issueKey: string,
		decision: RepositoryDecision,
	): void {
		this.store.setIssueRepositories(
			issueKey,
			{
				repoNames: decision.repositories.map((repo) => repo.name),
				baseBranchOverrides: decision.baseBranchOverrides,
				method: decision.method,
			},
			this.now(),
		);
		this.logger.info(
			`Repositories for ${issueKey}: [${decision.repositories
				.map((repo) => repo.name)
				.join(", ")}] (${decision.method})`,
		);
	}
```

Call it at the top of `routeCreated`, immediately after `creator` is read and
before `resolveTargetOrInvalidKey`:

```ts
		// Repository selection happens here, on the router, before any container
		// device exists. `extractIssueKey` is the same gate the container path
		// uses; without a key there is no per-issue sandbox to route to and the
		// existing invalid-key handling below reports it.
		const issueKey = extractIssueKey(webhook);
		if (issueKey !== undefined && this.repositoryResolver) {
			const gate = await this.ensureRepositoryDecision(
				webhook,
				issueKey,
				workspaceId,
				issueId,
			);
			if (gate === "held") return;
		}
```

Store the two new options as private fields in the constructor, alongside the
existing `containerTargets` assignment:

```ts
		this.repositoryResolver = options.repositoryResolver;
		this.postRepositorySelection = options.postRepositorySelection;
```

with the declarations:

```ts
	private readonly repositoryResolver: RepositoryResolver | undefined;
	private readonly postRepositorySelection:
		| EventRouterOptions["postRepositorySelection"]
		| undefined;
```

- [ ] **Step 5: Intercept the answering prompt**

Add this method to the class:

```ts
	/**
	 * Consumes a prompt that answers a pending repository selection.
	 *
	 * Returns `true` when the prompt was the answer and this webhook has been
	 * fully handled, `false` when there was no pending selection and normal
	 * prompt routing should continue.
	 *
	 * Two shapes of answer, both terminal:
	 *  - the body names an offered option -> that repository is the decision, and
	 *    the HELD `created` event is replayed so the runner initialises from the
	 *    delegation. The answer itself is consumed: delivering "cyrus-web" as a
	 *    user prompt would start the session with a repository name as its task.
	 *  - anything else -> the user ignored the question. Fall back, then deliver
	 *    the held `created` event AND this prompt, which is the semantics device
	 *    mode already has (see packages/CLAUDE.md).
	 */
	private async resumeHeldSelection(webhook: SessionEvent): Promise<boolean> {
		const resolver = this.repositoryResolver;
		if (!resolver) return false;
		const sessionId = webhook.agentSession.id;
		const pending = this.store.getPendingRepoSelection(sessionId);
		if (!pending) return false;

		const { repositories } = await resolver
			.resolve({ workspaceId: pending.workspaceId, issueId: undefined })
			.then((outcome) =>
				outcome.kind === "needs_selection"
					? { repositories: outcome.candidates }
					: { repositories: [] },
			)
			.catch(() => ({ repositories: [] }));

		// Prefer the exact options that were offered; `repositories` is only a
		// safety net for a registry that changed while the user was deciding.
		const candidates =
			repositories.length > 0
				? repositories.filter((repo) => pending.options.includes(repo.name))
				: [];
		const offered =
			candidates.length > 0
				? candidates
				: pending.options.map((name) => ({
						name,
						githubSlug: "",
						linearWorkspaceId: pending.workspaceId,
					}));

		const body = webhook.agentActivity?.content?.body ?? "";
		const selected = resolver.selectByOptionValue(body, offered);
		const decision = selected ?? resolver.fallbackDecision(offered);

		this.store.deletePendingRepoSelection(sessionId);

		if (!decision) {
			this.logger.warn(
				`Pending repository selection for ${pending.issueKey} could not be resolved; dropping it`,
			);
			return false;
		}
		this.persistDecision(pending.issueKey, decision);

		// Replay the held delegation first, so the container's first event is the
		// one that starts a session.
		let held: SessionEvent | undefined;
		try {
			held = JSON.parse(pending.createdEvent) as SessionEvent;
		} catch (error) {
			this.logger.warn(
				`Held created event for ${pending.issueKey} is unreadable: ${String(error)}; routing the prompt alone`,
			);
		}
		if (held) await this.routeCreated(held);

		if (selected) {
			this.logger.info(
				`Session ${sessionId} selected repository ${decision.repositories[0]?.name}`,
			);
			return true;
		}

		this.logger.info(
			`Session ${sessionId} answered the repository selection with an unrelated prompt; used ${decision.repositories[0]?.name} and forwarding the prompt`,
		);
		return false;
	}
```

Call it as the first statement of `routePrompted`, after `sessionId` is read:

```ts
		if (await this.resumeHeldSelection(webhook)) return;
```

- [ ] **Step 6: Sweep abandoned selections**

In `sweepExpired`, alongside the existing webhook-claim sweep, add:

```ts
		// A selection nobody ever answered. `eventTtlMs` is the right bound: it
		// is already how long a queued event may wait for its device.
		const removed = this.store.sweepPendingRepoSelections(
			this.now() - this.config.eventTtlMs,
		);
		if (removed > 0) {
			this.logger.info(
				`Swept ${removed} unanswered repository selection(s) older than the event TTL`,
			);
		}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter cyrus-router test:run test/EventRouter.repo-selection.test.ts test/EventRouter.test.ts`
Expected: PASS. The pre-existing `EventRouter.test.ts` cases construct an
`EventRouter` without `repositoryResolver`, so they take the `return "ready"`
short-circuit and are unaffected.

- [ ] **Step 8: Commit**

```bash
git add packages/router/src/EventRouter.ts packages/router/src/messages.ts packages/router/test/EventRouter.repo-selection.test.ts
git commit -m "feat(router): resolve repositories and elicit before booting a container"
```

---

### Task 11: Per-issue `CYRUS_REPOS_JSON`

**Files:**
- Modify: `packages/router/src/ContainerTargets.ts` (lines 64-98, 459-500)
- Modify: `packages/router/src/RouterServer.ts`
- Test: `packages/router/test/ContainerTargets.test.ts`

**Interfaces:**
- Consumes: `RegisteredRepository`, `RepositoryRegistry` (Task 4); `getIssueRepositories` (Task 7).
- Produces: `ContainerRoutingDeps` replaces `containersConfig.repositories` with a top-level `registry: RepositoryRegistry`. `buildEnv` emits `CYRUS_REPOS_JSON` scoped to the issue's decision.

- [ ] **Step 1: Write the failing test**

In `packages/router/test/ContainerTargets.test.ts`, replace the module-level
`CONTAINERS_CONFIG` with a version carrying no `repositories`, add a registry
stub, and append a describe block:

```ts
const CONTAINERS_CONFIG: ContainerRoutingDeps["containersConfig"] = {
	routerUrlForContainers: "wss://router.example.com",
};

const REGISTERED: RegisteredRepository[] = [
	{
		name: "cyrus-api",
		githubSlug: "acme/cyrus-api",
		linearWorkspaceId: "ws-1",
		baseBranch: "main",
		teamKeys: ["NOR"],
	},
	{
		name: "cyrus-web",
		githubSlug: "acme/cyrus-web",
		linearWorkspaceId: "ws-1",
		isDefault: true,
	},
];

function stubRegistry(repositories = REGISTERED): RepositoryRegistry {
	return {
		list: vi.fn(async () => ({ repositories })),
		put: vi.fn(async () => ({ version: "1" })),
	};
}
```

Every existing `new ContainerTargetService({...})` in this file gains
`registry: stubRegistry(),`.

```ts
describe("per-issue repository selection in buildEnv", () => {
	it("emits only the repositories the router decided on", async () => {
		// ...construct the service exactly as the existing boot tests do...
		store.setIssueRepositories(
			"NOR-1",
			{ repoNames: ["cyrus-api"], baseBranchOverrides: {}, method: "team-based" },
			1,
		);

		service.boot(deviceId, { workspaceId: "ws-1", sessionId: "sess-1" });
		await vi.waitFor(() => expect(executor.ensureRunning).toHaveBeenCalled());

		const env = executor.ensureRunning.mock.calls[0][0].env;
		expect(JSON.parse(env.CYRUS_REPOS_JSON)).toEqual([
			{
				name: "cyrus-api",
				githubSlug: "acme/cyrus-api",
				linearWorkspaceId: "ws-1",
				baseBranch: "main",
				teamKeys: ["NOR"],
			},
		]);
	});

	it("applies a base-branch override from the decision", async () => {
		store.setIssueRepositories(
			"NOR-1",
			{
				repoNames: ["cyrus-api"],
				baseBranchOverrides: { "cyrus-api": "release" },
				method: "description-tag",
			},
			1,
		);

		service.boot(deviceId, { workspaceId: "ws-1", sessionId: "sess-1" });
		await vi.waitFor(() => expect(executor.ensureRunning).toHaveBeenCalled());

		const env = executor.ensureRunning.mock.calls[0][0].env;
		expect(JSON.parse(env.CYRUS_REPOS_JSON)[0].baseBranch).toBe("release");
	});

	it("falls back to the default repository when no decision was stored", async () => {
		service.boot(deviceId, { workspaceId: "ws-1", sessionId: "sess-1" });
		await vi.waitFor(() => expect(executor.ensureRunning).toHaveBeenCalled());

		const env = executor.ensureRunning.mock.calls[0][0].env;
		expect(JSON.parse(env.CYRUS_REPOS_JSON).map((r) => r.name)).toEqual([
			"cyrus-web",
		]);
	});

	it("drops a decided repository that has since been removed from the registry", async () => {
		store.setIssueRepositories(
			"NOR-1",
			{
				repoNames: ["cyrus-api", "deleted-repo"],
				baseBranchOverrides: {},
				method: "description-tag",
			},
			1,
		);

		service.boot(deviceId, { workspaceId: "ws-1", sessionId: "sess-1" });
		await vi.waitFor(() => expect(executor.ensureRunning).toHaveBeenCalled());

		const env = executor.ensureRunning.mock.calls[0][0].env;
		expect(JSON.parse(env.CYRUS_REPOS_JSON).map((r) => r.name)).toEqual([
			"cyrus-api",
		]);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("deleted-repo"),
		);
	});

	it("fails the boot with an actionable message when nothing resolves", async () => {
		const emptyService = new ContainerTargetService({
			store,
			secrets,
			executors,
			registry: stubRegistry([]),
			containersConfig: CONTAINERS_CONFIG,
			postActivity,
			logger,
		});

		emptyService.boot(deviceId, { workspaceId: "ws-1", sessionId: "sess-1" });
		await vi.waitFor(() => expect(postActivity).toHaveBeenCalled());
		expect(postActivity.mock.calls[0][2]).toContain("No repositories");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-router test:run test/ContainerTargets.test.ts`
Expected: FAIL — TypeScript rejects `registry` on `ContainerRoutingDeps`, and
`CYRUS_REPOS_JSON` still carries the whole configured list.

- [ ] **Step 3: Rework the deps and `buildEnv`**

In `packages/router/src/ContainerTargets.ts`, remove `repositories` from
`containersConfig` and add a top-level dep:

```ts
export interface ContainerRoutingDeps {
	store: RouterStore;
	secrets: SecretStoreBackend;
	executors: ExecutorRegistry;
	/**
	 * The live repository registry. Read per boot rather than captured at
	 * construction, so a repository added in the setup UI is visible to the very
	 * next container without restarting the router.
	 */
	registry: RepositoryRegistry;
	containersConfig: {
		routerUrlForContainers: string;
		requiredSecretKeys?: string[];
		defaultExecutor?: string;
	};
	// ...postActivity, logger, now unchanged...
}
```

Replace the `CYRUS_REPOS_JSON` line in `buildEnv` with a call to a new method,
and add that method:

```ts
		const env: Record<string, string> = {
			CYRUS_ROUTER_URL: this.deps.containersConfig.routerUrlForContainers,
			CYRUS_ISSUE_KEY: issueKey,
			CYRUS_REPOS_JSON: JSON.stringify(await this.reposForIssue(issueKey)),
		};
```

```ts
	/**
	 * The repositories THIS issue's sandbox should clone.
	 *
	 * The router decided this before the container existed and persisted it, so
	 * a container destroyed and recreated clones the same repository rather than
	 * silently switching. A missing decision — the router restarted and lost
	 * SQLite between Blob backups — degrades to the configured default rather
	 * than to "clone everything", which is what the pre-registry code did and
	 * what made a multi-repository deployment unusable.
	 */
	private async reposForIssue(
		issueKey: string,
	): Promise<RegisteredRepository[]> {
		const { repositories } = await this.deps.registry.list();
		const byName = new Map(repositories.map((repo) => [repo.name, repo]));
		const decision = this.deps.store.getIssueRepositories(issueKey);

		let chosen: RegisteredRepository[];
		if (decision) {
			const missing: string[] = [];
			chosen = [];
			for (const name of decision.repoNames) {
				const repo = byName.get(name);
				if (repo) chosen.push(repo);
				else missing.push(name);
			}
			if (missing.length > 0) {
				this.deps.logger.warn(
					`Issue ${issueKey} was routed to [${missing.join(", ")}], which ${
						missing.length === 1 ? "is" : "are"
					} no longer registered; booting without ${missing.length === 1 ? "it" : "them"}`,
				);
			}
			// A `#branch` override from a description tag is applied here rather
			// than stored on the registry entry, which is shared by every issue.
			chosen = chosen.map((repo) => {
				const override = decision.baseBranchOverrides[repo.name];
				return override ? { ...repo, baseBranch: override } : repo;
			});
		} else {
			chosen = [];
		}

		if (chosen.length > 0) return chosen;

		const fallback =
			repositories.find((repo) => repo.isDefault === true) ?? repositories[0];
		if (!fallback) {
			throw new Error(
				`No repositories are registered, so there is nothing to clone for ${issueKey}. Add one at /setup/repositories.`,
			);
		}
		this.deps.logger.warn(
			`No stored repository decision for ${issueKey}; falling back to ${fallback.name}`,
		);
		return [fallback];
	}
```

Add the import:

```ts
import type {
	RegisteredRepository,
	RepositoryRegistry,
} from "./RepositoryRegistry.js";
```

The throw is caught by `bootInner`'s existing try/catch, which posts the
container-boot-failed activity — so the "nothing registered" case surfaces in
Linear rather than only in the router log.

- [ ] **Step 4: Update `RouterServer` wiring**

In `packages/router/src/RouterServer.ts`, change the `ContainerTargetService`
construction to drop `repositories` and pass the registry built in Task 6:

```ts
		const containerTargets = new ContainerTargetService({
			store: this.store,
			secrets,
			executors,
			registry: repositoryRegistry,
			containersConfig: {
				routerUrlForContainers: containers.routerUrlForContainers,
				requiredSecretKeys: containers.requiredSecretKeys,
				defaultExecutor: containers.defaultExecutor,
			},
			postActivity: (workspaceId, agentSessionId, body) =>
				this.executor.postActivity(workspaceId, agentSessionId, body),
			logger: this.logger,
		});
```

Then build the resolver and hand both new options to `EventRouter`:

```ts
		const repositoryResolver = new RepositoryResolver({
			registry: repositoryRegistry,
			fetchIssueFacts: (workspaceId, issueId) =>
				this.executor.fetchIssueFacts(workspaceId, issueId),
			logger: this.logger,
		});
```

and, where `EventRouter` is constructed, add:

```ts
			repositoryResolver,
			postRepositorySelection: (workspaceId, sessionId, body, options) =>
				this.executor.postRepositorySelection(
					workspaceId,
					sessionId,
					body,
					options,
				),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter cyrus-router test:run`
Expected: PASS. `containers-e2e.test.ts` also constructs a
`ContainerTargetService` — update its deps the same way.

- [ ] **Step 6: Commit**

```bash
git add packages/router/src/ContainerTargets.ts packages/router/src/RouterServer.ts packages/router/test/ContainerTargets.test.ts packages/router/test/containers-e2e.test.ts
git commit -m "feat(router): scope CYRUS_REPOS_JSON to the issue's decided repositories"
```

---

### Task 12: Carry routing metadata into the sandbox

**Files:**
- Modify: `apps/cli/src/commands/ContainerBootCommand.ts` (lines 66-72, 674-684)
- Test: `apps/cli/src/commands/ContainerBootCommand.test.ts` (append)

**Interfaces:**
- Consumes: `RepositoryConfigSchema`'s `isDefault` (Task 1).
- Produces: `RepoSpec` gains `teamKeys?`, `projectKeys?`, `routingLabels?`, `isDefault?`; `buildRepositoryConfig` forwards them.

- [ ] **Step 1: Write the failing test**

Append to `apps/cli/src/commands/ContainerBootCommand.test.ts`:

```ts
describe("routing metadata", () => {
	it("accepts routing fields in CYRUS_REPOS_JSON", () => {
		const parsed = parseReposJson(
			JSON.stringify([
				{
					name: "cyrus-api",
					githubSlug: "acme/cyrus-api",
					linearWorkspaceId: "ws-1",
					baseBranch: "release",
					teamKeys: ["NOR"],
					projectKeys: ["Platform"],
					routingLabels: ["backend"],
					isDefault: true,
				},
			]),
		);
		expect(parsed[0]).toMatchObject({
			teamKeys: ["NOR"],
			projectKeys: ["Platform"],
			routingLabels: ["backend"],
			isDefault: true,
		});
	});

	it("still accepts an entry with no routing fields", () => {
		const parsed = parseReposJson(
			JSON.stringify([
				{
					name: "bare",
					githubSlug: "acme/bare",
					linearWorkspaceId: "ws-1",
				},
			]),
		);
		expect(parsed[0]?.teamKeys).toBeUndefined();
		expect(parsed[0]?.isDefault).toBeUndefined();
	});

	it("writes routing metadata into config.json so the in-sandbox router agrees", () => {
		const workspacesDir = mkdtempSync(join(tmpdir(), "cyrus-boot-config-"));
		const command = new ContainerBootCommand({ env: {}, logger: silentLogger() });

		command.writeConfig({
			workspacesDir,
			routerUrl: "wss://router.example.com",
			deviceToken: "token",
			repos: [
				{
					name: "cyrus-api",
					githubSlug: "acme/cyrus-api",
					linearWorkspaceId: "ws-1",
					baseBranch: "release",
					teamKeys: ["NOR"],
					projectKeys: ["Platform"],
					isDefault: true,
				},
			],
		});

		const config = JSON.parse(
			readFileSync(join(workspacesDir, ".cyrus", "config.json"), "utf-8"),
		);
		expect(config.repositories[0]).toMatchObject({
			id: "cyrus-api",
			name: "cyrus-api",
			baseBranch: "release",
			teamKeys: ["NOR"],
			projectKeys: ["Platform"],
			isDefault: true,
		});
	});

	it("omits absent routing fields rather than writing empty arrays", () => {
		const workspacesDir = mkdtempSync(join(tmpdir(), "cyrus-boot-config-"));
		const command = new ContainerBootCommand({ env: {}, logger: silentLogger() });

		command.writeConfig({
			workspacesDir,
			routerUrl: "wss://router.example.com",
			deviceToken: "token",
			repos: [
				{ name: "bare", githubSlug: "acme/bare", linearWorkspaceId: "ws-1" },
			],
		});

		const config = JSON.parse(
			readFileSync(join(workspacesDir, ".cyrus", "config.json"), "utf-8"),
		);
		expect(config.repositories[0]).not.toHaveProperty("teamKeys");
		expect(config.repositories[0]).not.toHaveProperty("isDefault");
		expect(config.repositories[0].baseBranch).toBe("main");
	});
});
```

Add a `silentLogger()` helper near the top of the test file if one does not
already exist:

```ts
function silentLogger() {
	return { info: () => {}, warn: () => {}, error: () => {} };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-ai test:run src/commands/ContainerBootCommand.test.ts`
Expected: FAIL — `parseReposJson` strips the unknown keys, so `teamKeys` is
`undefined`.

- [ ] **Step 3: Widen `RepoSpecSchema`**

In `apps/cli/src/commands/ContainerBootCommand.ts`, replace `RepoSpecSchema`
(line 66):

```ts
const RepoSpecSchema = z.object({
	name: z.string().min(1),
	githubSlug: z.string().min(1),
	linearWorkspaceId: z.string().min(1),
	baseBranch: z.string().optional(),
	// Routing metadata the ROUTER already used to pick this repository. It is
	// forwarded so the in-sandbox RepositoryRouter reaches the same conclusion
	// instead of falling into its catch-all — which, with more than one repo in
	// the list, would silently pick the first.
	teamKeys: z.array(z.string()).optional(),
	projectKeys: z.array(z.string()).optional(),
	routingLabels: z.array(z.string()).optional(),
	isDefault: z.boolean().optional(),
});
```

- [ ] **Step 4: Forward the fields in `buildRepositoryConfig`**

Replace `buildRepositoryConfig` (line 674):

```ts
	private buildRepositoryConfig(repo: RepoSpec, workspacesDir: string) {
		return {
			id: repo.name,
			name: repo.name,
			repositoryPath: join(workspacesDir, "repos", repo.name),
			workspaceBaseDir: workspacesDir,
			baseBranch: repo.baseBranch ?? "main",
			linearWorkspaceId: repo.linearWorkspaceId,
			isActive: true,
			// Spread conditionally: writing `teamKeys: undefined` would survive
			// Zod but land in config.json as an explicit null-ish key, which is
			// noise in a file an operator may read while debugging a boot.
			...(repo.teamKeys ? { teamKeys: repo.teamKeys } : {}),
			...(repo.projectKeys ? { projectKeys: repo.projectKeys } : {}),
			...(repo.routingLabels ? { routingLabels: repo.routingLabels } : {}),
			...(repo.isDefault !== undefined ? { isDefault: repo.isDefault } : {}),
		};
	}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter cyrus-ai test:run src/commands/ContainerBootCommand.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/commands/ContainerBootCommand.ts apps/cli/src/commands/ContainerBootCommand.test.ts
git commit -m "feat(cli): forward repository routing metadata into the sandbox config"
```

---

### Task 13: `fetchProject` RPC for device-mode project routing

**Files:**
- Modify: `packages/core/src/issue-tracker/types.ts`
- Modify: `packages/core/src/issue-tracker/IIssueTrackerService.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/linear-event-transport/src/LinearIssueTrackerService.ts`
- Modify: `packages/router-protocol/src/rpc-methods.ts`
- Modify: `packages/router-client/src/RouterIssueTrackerService.ts` (line 237)
- Test: `packages/router-client/test/RouterIssueTrackerService.project.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `type Project`, `IIssueTrackerService.fetchProject(idOrSlug: string): Promise<Project>`, `"fetchProject"` in `RPC_METHODS`, and a working `project` getter on `RouterIssueTrackerService`.

**Why this is in scope:** without it, `p=` associations work for ACA users (the
router resolves them) and silently never fire for router-mode users on a
physical device, whose EdgeWorker asks `RouterIssueTrackerService` for a project
that is hardcoded to `undefined`.

- [ ] **Step 1: Write the failing test**

Create `packages/router-client/test/RouterIssueTrackerService.project.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { RouterIssueTrackerService } from "../src/RouterIssueTrackerService.js";

function service(rpc: ReturnType<typeof vi.fn>) {
	return new RouterIssueTrackerService({ rpc } as never);
}

describe("RouterIssueTrackerService project", () => {
	it("resolves the project through the fetchProject RPC", async () => {
		const rpc = vi.fn(async (method: string) => {
			if (method === "fetchIssue") {
				return { id: "issue-1", identifier: "NOR-1", projectId: "proj-1" };
			}
			if (method === "fetchProject") return { id: "proj-1", name: "Platform" };
			throw new Error(`unexpected ${method}`);
		});

		const issue = await service(rpc).fetchIssue("issue-1");
		const project = await issue.project;

		expect(project?.name).toBe("Platform");
		expect(rpc).toHaveBeenCalledWith("fetchProject", ["proj-1"]);
	});

	it("is undefined when the issue has no project, without any RPC", async () => {
		const rpc = vi.fn(async () => ({ id: "issue-1", identifier: "NOR-1" }));
		const issue = await service(rpc).fetchIssue("issue-1");
		expect(await issue.project).toBeUndefined();
		expect(rpc).toHaveBeenCalledTimes(1);
	});

	it("fetches the project at most once per issue", async () => {
		const rpc = vi.fn(async (method: string) =>
			method === "fetchIssue"
				? { id: "issue-1", projectId: "proj-1" }
				: { id: "proj-1", name: "Platform" },
		);
		const issue = await service(rpc).fetchIssue("issue-1");
		await issue.project;
		await issue.project;
		expect(
			rpc.mock.calls.filter(([method]) => method === "fetchProject"),
		).toHaveLength(1);
	});
});
```

Match the constructor shape `RouterIssueTrackerService` actually takes — read
its constructor before writing `service()`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-router-client test:run`
Expected: FAIL — `project` resolves to `undefined` and `fetchProject` is never
called.

- [ ] **Step 3: Add the `Project` type**

In `packages/core/src/issue-tracker/types.ts`, beside the `Team` alias
(line 185):

```ts
/**
 * Project type — selects the properties routing and display need.
 *
 * @see {@link LinearSDK.Project} - Linear's complete Project type
 */
export type Project = Pick<
	LinearSDK.Project,
	"id" | "name" | "description" | "slugId"
>;
```

Export it from `packages/core/src/index.ts` alongside the other issue-tracker
types.

- [ ] **Step 4: Declare and implement `fetchProject`**

In `packages/core/src/issue-tracker/IIssueTrackerService.ts`, beside
`fetchTeam` (line 460):

```ts
	/**
	 * Fetch a project by id.
	 *
	 * Exists so a router-mode device can resolve `issue.project` — the router
	 * serializes issues over the wire and the SDK's project getter cannot
	 * survive that, so project-based repository routing has no other source.
	 *
	 * @param id - Project ID
	 * @returns Promise resolving to the project
	 * @throws Error if the project is not found
	 *
	 * @example
	 * ```typescript
	 * const project = await service.fetchProject('proj-1');
	 * console.log(project.name);
	 * ```
	 */
	fetchProject(id: string): Promise<Project>;
```

In `packages/linear-event-transport/src/LinearIssueTrackerService.ts`, beside
`fetchTeam` (line 817):

```ts
	async fetchProject(id: string): Promise<Project> {
		return await this.linearClient.project(id);
	}
```

Import `Project` from `cyrus-core` in that file.

- [ ] **Step 5: Allowlist the RPC**

In `packages/router-protocol/src/rpc-methods.ts`, add `"fetchProject"` to
`RPC_METHODS` immediately after `"fetchTeam"`:

```ts
	"fetchTeams",
	"fetchTeam",
	"fetchProject",
```

`LinearExecutor` dispatches reflectively over `IIssueTrackerService`, so no
router-side change is needed once the method is on the interface and the
allowlist.

- [ ] **Step 6: Implement the `project` getter**

In `packages/router-client/src/RouterIssueTrackerService.ts`, replace the getter
at line 237:

```ts
			/**
			 * Resolved through the `fetchProject` RPC. The router serializes a
			 * Linear SDK `Issue` with `JSON.stringify`, and `project` is a
			 * prototype getter over a private `_project` field, so only
			 * `projectId` survives the wire — this rebuilds the getter from it,
			 * the same way `parent` is rebuilt from `parentId` above.
			 *
			 * `undefined` when the issue has no project, which is a legal value
			 * for `Issue["project"]` and costs no round trip.
			 */
			get project(): Issue["project"] {
				if (!projectId) return undefined;
				return once("project", () =>
					self.fetchProject(projectId),
				) as unknown as Issue["project"];
			},
```

Add the method alongside `fetchIssue` (line 317):

```ts
	async fetchProject(id: string): Promise<Project> {
		return (await this.connection.rpc("fetchProject", [id])) as Project;
	}
```

`projectId` is already destructured from the raw payload (line 80); confirm it
is in scope where the getter is defined and add it to the destructuring if not.

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter cyrus-router-client test:run && pnpm --filter cyrus-core test:run && pnpm build`
Expected: PASS. `CLIIssueTrackerService` also implements `IIssueTrackerService` —
if the build reports it missing `fetchProject`, add an implementation there that
mirrors how that adapter handles `fetchTeam`.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/issue-tracker packages/core/src/index.ts packages/linear-event-transport/src/LinearIssueTrackerService.ts packages/router-protocol/src/rpc-methods.ts packages/router-client/src packages/router-client/test
git commit -m "feat: add fetchProject RPC so device-mode project routing works"
```

---

### Task 14: Repositories page rendering

**Files:**
- Create: `packages/router/src/setup/repositoryViews.ts`
- Test: `packages/router/test/setup-repository-views.test.ts`

**Interfaces:**
- Consumes: `escapeHtml` from `./views.js`; `formatAssociations` from `cyrus-core` (Task 1).
- Produces:
  - `interface RepositoryView { name: string; githubSlug: string; baseBranch: string; associations: string; isDefault: boolean }`
  - `interface RepositoriesPageModel { email: string; repositories: RepositoryView[]; workspaceIds: string[]; ambiguities: string[]; csrfToken: string; versionToken?: string; message?: SetupMessage }`
  - `function renderRepositoriesTable(model: RepositoriesPageModel): string`
  - `function renderRepositoriesPage(model: RepositoriesPageModel): string`
  - `function findAmbiguities(repositories: RepositoryView[]): string[]`

- [ ] **Step 1: Write the failing test**

Create `packages/router/test/setup-repository-views.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	findAmbiguities,
	type RepositoriesPageModel,
	renderRepositoriesPage,
	renderRepositoriesTable,
} from "../src/setup/repositoryViews.js";

const MODEL: RepositoriesPageModel = {
	email: "alice@example.com",
	repositories: [
		{
			name: "cyrus-api",
			githubSlug: "acme/cyrus-api",
			baseBranch: "main",
			associations: "p=Platform,t=NOR",
			isDefault: true,
		},
		{
			name: "cyrus-web",
			githubSlug: "acme/cyrus-web",
			baseBranch: "main",
			associations: "t=WEB",
			isDefault: false,
		},
	],
	workspaceIds: ["ws-1"],
	ambiguities: [],
	csrfToken: "csrf-token",
	versionToken: "version-token",
};

describe("renderRepositoriesTable", () => {
	it("renders one row per repository inside the swappable container", () => {
		const html = renderRepositoriesTable(MODEL);
		expect(html).toContain('<div id="repositories">');
		expect(html).toContain("cyrus-api");
		expect(html).toContain("acme/cyrus-web");
		expect(html).toContain('value="p=Platform,t=NOR"');
	});

	it("marks exactly one radio as the default", () => {
		const html = renderRepositoriesTable(MODEL);
		const checked = html.match(/name="isDefault"[^>]*checked/g) ?? [];
		expect(checked).toHaveLength(1);
		expect(html).toContain('value="cyrus-api"');
	});

	it("carries the CSRF token as a header on delete, never in the URL", () => {
		const html = renderRepositoriesTable(MODEL);
		expect(html).toContain('hx-delete="/setup/repositories/cyrus-web"');
		expect(html).toContain("X-CSRF-Token");
		expect(html).toContain('hx-params="none"');
		expect(html).not.toContain("?csrf=");
	});

	it("includes the version token as a hidden field", () => {
		expect(renderRepositoriesTable(MODEL)).toContain(
			'<input type="hidden" name="version" value="version-token">',
		);
	});

	it("omits the version field when there is no version token", () => {
		const { versionToken: _drop, ...rest } = MODEL;
		expect(renderRepositoriesTable(rest)).not.toContain('name="version"');
	});

	it("renders an ambiguity warning when one is reported", () => {
		const html = renderRepositoriesTable({
			...MODEL,
			ambiguities: ['Two repositories claim project "Platform"'],
		});
		expect(html).toContain('data-testid="ambiguity-banner"');
		expect(html).toContain("Two repositories claim project");
	});

	it("escapes every interpolated value", () => {
		const html = renderRepositoriesTable({
			...MODEL,
			repositories: [
				{
					name: "evil",
					githubSlug: '"><script>alert(1)</script>',
					baseBranch: "main",
					associations: "p=<b>x</b>",
					isDefault: false,
				},
			],
		});
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain("&lt;b&gt;");
	});

	it("hides the workspace selector when the router serves one workspace", () => {
		const html = renderRepositoriesTable(MODEL);
		expect(html).toContain('<input type="hidden" name="linearWorkspaceId" value="ws-1">');
		expect(html).not.toContain("<select");
	});

	it("offers a workspace selector when the router serves several", () => {
		const html = renderRepositoriesTable({
			...MODEL,
			workspaceIds: ["ws-1", "ws-2"],
		});
		expect(html).toContain("<select");
		expect(html).toContain("ws-2");
	});
});

describe("renderRepositoriesPage", () => {
	it("emits a nonce-scoped CSP with no unsafe-inline for scripts", () => {
		const html = renderRepositoriesPage(MODEL);
		expect(html).toMatch(/script-src 'self' 'nonce-[^']+'/);
		expect(html).not.toContain("script-src 'self' 'unsafe-inline'");
	});

	it("links back to the variables page", () => {
		expect(renderRepositoriesPage(MODEL)).toContain('href="/setup"');
	});
});

describe("findAmbiguities", () => {
	it("reports two repositories claiming the same project, case-insensitively", () => {
		expect(
			findAmbiguities([
				{ ...MODEL.repositories[0]!, name: "a", associations: "p=Platform" },
				{ ...MODEL.repositories[0]!, name: "b", associations: "p=platform" },
			]),
		).toEqual([
			'Repositories "a" and "b" both claim project "Platform" — Cyrus will have to ask which one to use.',
		]);
	});

	it("reports two repositories claiming the same team", () => {
		expect(
			findAmbiguities([
				{ ...MODEL.repositories[0]!, name: "a", associations: "t=NOR" },
				{ ...MODEL.repositories[0]!, name: "b", associations: "t=NOR" },
			])[0],
		).toContain('both claim team "NOR"');
	});

	it("reports more than one default", () => {
		expect(
			findAmbiguities([
				{ ...MODEL.repositories[0]!, name: "a", isDefault: true, associations: "" },
				{ ...MODEL.repositories[0]!, name: "b", isDefault: true, associations: "" },
			])[0],
		).toContain("more than one default");
	});

	it("is silent for a well-formed registry", () => {
		expect(findAmbiguities(MODEL.repositories)).toEqual([]);
	});

	it("ignores an unparseable association string rather than throwing", () => {
		expect(() =>
			findAmbiguities([
				{ ...MODEL.repositories[0]!, associations: "p=" },
			]),
		).not.toThrow();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-router test:run test/setup-repository-views.test.ts`
Expected: FAIL — cannot resolve `../src/setup/repositoryViews.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/router/src/setup/repositoryViews.ts`:

```ts
import { randomBytes } from "node:crypto";
import { parseAssociations } from "cyrus-core";
import { escapeHtml, renderMessage, type SetupMessage } from "./views.js";

/**
 * Pure HTML rendering for `/setup/repositories`. No I/O, no Fastify — every
 * function is a straight string transform, so it is unit-testable without a
 * server. Mirrors `views.ts`, and inherits its two invariants: every
 * interpolated value passes through {@link escapeHtml}, and the full page ships
 * a nonce-scoped CSP rather than `unsafe-inline`.
 *
 * Unlike the variables page there is nothing secret here — repository names and
 * slugs are rendered back verbatim, which is what makes editing possible.
 */

/** One row in the repositories table. */
export interface RepositoryView {
	name: string;
	githubSlug: string;
	baseBranch: string;
	/** The `p=`/`t=` string, already formatted by `formatAssociations`. */
	associations: string;
	isDefault: boolean;
}

export interface RepositoriesPageModel {
	email: string;
	repositories: RepositoryView[];
	/** Workspace ids the router serves. One means the field is auto-filled. */
	workspaceIds: string[];
	/** Human-readable warnings from {@link findAmbiguities}. */
	ambiguities: string[];
	csrfToken: string;
	/** Render-time version token, for conflict detection on save. */
	versionToken?: string;
	message?: SetupMessage;
}

/**
 * Surfaces, at configuration time, the ambiguities that would otherwise only
 * appear mid-issue as an elicitation the user has to answer.
 *
 * Never throws: a malformed association string is already reported by the save
 * path, and a banner renderer that can throw would take the whole page down.
 */
export function findAmbiguities(repositories: RepositoryView[]): string[] {
	const warnings: string[] = [];
	const projects = new Map<string, { name: string; repos: string[] }>();
	const teams = new Map<string, { name: string; repos: string[] }>();

	for (const repo of repositories) {
		let parsed: { projectKeys: string[]; teamKeys: string[] };
		try {
			parsed = parseAssociations(repo.associations);
		} catch {
			continue;
		}
		for (const project of parsed.projectKeys) {
			const key = project.toLowerCase();
			const entry = projects.get(key) ?? { name: project, repos: [] };
			entry.repos.push(repo.name);
			projects.set(key, entry);
		}
		for (const team of parsed.teamKeys) {
			const key = team.toLowerCase();
			const entry = teams.get(key) ?? { name: team, repos: [] };
			entry.repos.push(repo.name);
			teams.set(key, entry);
		}
	}

	const describe = (
		entries: Map<string, { name: string; repos: string[] }>,
		kind: string,
	): void => {
		for (const { name, repos } of entries.values()) {
			if (repos.length < 2) continue;
			const quoted = repos.map((repo) => `"${repo}"`);
			const list =
				quoted.length === 2
					? quoted.join(" and ")
					: `${quoted.slice(0, -1).join(", ")}, and ${quoted.at(-1)}`;
			const verb = repos.length > 2 ? "all claim" : "both claim";
			warnings.push(
				`Repositories ${list} ${verb} ${kind} "${name}" — Cyrus will have to ask which one to use.`,
			);
		}
	};
	describe(projects, "project");
	describe(teams, "team");

	const defaults = repositories.filter((repo) => repo.isDefault);
	if (defaults.length > 1) {
		warnings.push(
			`You have more than one default repository (${defaults
				.map((repo) => `"${repo.name}"`)
				.join(", ")}). Cyrus will ask which one to use instead of picking.`,
		);
	}
	return warnings;
}

function renderAmbiguityBanner(warnings: string[]): string {
	if (warnings.length === 0) return "";
	const items = warnings
		.map((warning) => `<li>${escapeHtml(warning)}</li>`)
		.join("");
	return `<article role="alert" data-testid="ambiguity-banner">
		<strong>Some issues will need a manual choice.</strong>
		<ul>${items}</ul>
	</article>`;
}

/**
 * The delete control's CSRF token travels as a **request header**, exactly as
 * in `views.ts`: htmx appends collected parameters to the URL for DELETE, and
 * the routes layer refuses a query-string token by design. `hx-params="none"`
 * stops the enclosing form's fields — csrf included — being swept into the URL.
 */
function renderDeleteButton(name: string, csrfToken: string): string {
	const headers = escapeHtml(JSON.stringify({ "X-CSRF-Token": csrfToken }));
	return `<button type="button" class="secondary" hx-delete="/setup/repositories/${encodeURIComponent(name)}" hx-target="#repositories" hx-swap="outerHTML" hx-headers="${headers}" hx-params="none">Delete</button>`;
}

function renderRow(repo: RepositoryView, csrfToken: string): string {
	const name = escapeHtml(repo.name);
	return `
	<tr>
		<td><code>${name}</code><input type="hidden" name="repo:${name}" value="1"></td>
		<td><input type="text" name="slug:${name}" value="${escapeHtml(repo.githubSlug)}"
			autocomplete="off" spellcheck="false" aria-label="GitHub slug for ${name}"></td>
		<td><input type="text" name="branch:${name}" value="${escapeHtml(repo.baseBranch)}"
			autocomplete="off" spellcheck="false" aria-label="Base branch for ${name}"></td>
		<td><input type="text" name="assoc:${name}" value="${escapeHtml(repo.associations)}"
			autocomplete="off" spellcheck="false" placeholder="p=Project,t=TEAM"
			aria-label="Associations for ${name}"></td>
		<td><input type="radio" name="isDefault" value="${name}"${repo.isDefault ? " checked" : ""}
			aria-label="Make ${name} the default"></td>
		<td>${renderDeleteButton(repo.name, csrfToken)}</td>
	</tr>`;
}

function renderWorkspaceField(workspaceIds: string[]): string {
	const first = workspaceIds[0];
	if (workspaceIds.length === 1 && first) {
		// The Linear token binds the workspace, so with one configured there is
		// nothing to choose and a select would be a field that can only be wrong.
		return `<input type="hidden" name="linearWorkspaceId" value="${escapeHtml(first)}">`;
	}
	const options = workspaceIds
		.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`)
		.join("");
	return `<label for="new-workspace">Linear workspace</label>
		<select id="new-workspace" name="linearWorkspaceId" required>${options}</select>`;
}

export function renderRepositoriesTable(model: RepositoriesPageModel): string {
	const rows = model.repositories
		.map((repo) => renderRow(repo, model.csrfToken))
		.join("");
	const versionField =
		model.versionToken === undefined
			? ""
			: `<input type="hidden" name="version" value="${escapeHtml(model.versionToken)}">`;

	return `<div id="repositories">
	${renderAmbiguityBanner(model.ambiguities)}
	<form hx-post="/setup/repositories/save" hx-target="#repositories" hx-swap="outerHTML">
		<input type="hidden" id="repo-csrf" name="csrf" value="${escapeHtml(model.csrfToken)}">
		${versionField}
		<table>
			<thead>
				<tr><th>Name</th><th>GitHub slug</th><th>Base branch</th><th>Associations</th><th>Default</th><th></th></tr>
			</thead>
			<tbody>${rows}</tbody>
		</table>
		<button type="submit">Save changes</button>
		<p><small>Associations use <code>p=</code> for a Linear project name and <code>t=</code> for a team key, both repeatable — for example <code>p=Platform,p=Billing,t=NOR</code>. Quote a value that contains a comma.</small></p>
	</form>
	<hr>
	<form hx-post="/setup/repositories" hx-target="#repositories" hx-swap="outerHTML">
		<input type="hidden" name="csrf" value="${escapeHtml(model.csrfToken)}">
		<label for="new-repo-name">Repository name</label>
		<input type="text" id="new-repo-name" name="name" required
			pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{0,63}"
			autocomplete="off" spellcheck="false" placeholder="cyrus-api">
		<label for="new-repo-slug">GitHub slug</label>
		<input type="text" id="new-repo-slug" name="githubSlug" required
			autocomplete="off" spellcheck="false" placeholder="acme/cyrus-api">
		<label for="new-repo-branch">Base branch</label>
		<input type="text" id="new-repo-branch" name="baseBranch"
			autocomplete="off" spellcheck="false" placeholder="main">
		<label for="new-repo-assoc">Associations</label>
		<input type="text" id="new-repo-assoc" name="associations"
			autocomplete="off" spellcheck="false" placeholder="p=Platform,t=NOR">
		${renderWorkspaceField(model.workspaceIds)}
		<button type="submit" class="secondary">Add repository</button>
	</form>
</div>`;
}

/** Kept byte-identical in intent to `views.ts`'s handler — see the note there. */
const BEFORE_SWAP_SCRIPT = `document.addEventListener("htmx:beforeSwap", (e) => {
	if ([400, 403, 409].includes(e.detail.xhr.status)) {
		e.detail.shouldSwap = true;
		e.detail.isError = false;
	}
});`;

export function renderRepositoriesPage(model: RepositoriesPageModel): string {
	const nonce = randomBytes(16).toString("base64");
	const csp = [
		"default-src 'none'",
		"style-src 'self' 'unsafe-inline'",
		`script-src 'self' 'nonce-${nonce}'`,
		"img-src 'self'",
		"connect-src 'self'",
		"form-action 'self'",
		"frame-ancestors 'none'",
		"base-uri 'none'",
	].join("; ");

	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<title>Cyrus repositories</title>
	<link rel="stylesheet" href="/setup/assets/pico.css">
	<script src="/setup/assets/htmx.js" defer></script>
	<script nonce="${nonce}">
		${BEFORE_SWAP_SCRIPT}
	</script>
</head>
<body>
	<main>
		<header>
			<h1>Cyrus repositories</h1>
			<p>Signed in as <strong>${escapeHtml(model.email)}</strong> &middot; <a href="/setup">Environment variables</a> &middot; <a href="/.auth/logout">Sign out</a></p>
		</header>
		${renderMessage(model.message)}
		<p><small>Cyrus clones one of these into each issue's workspace. It picks by <code>[repo=…]</code> in the issue description first, then routing labels, then project, then team, and finally the default.</small></p>
		${renderRepositoriesTable(model)}
	</main>
</body>
</html>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter cyrus-router test:run test/setup-repository-views.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/router/src/setup/repositoryViews.ts packages/router/test/setup-repository-views.test.ts
git commit -m "feat(router): render the setup repositories page"
```

---

### Task 15: Repositories page routes

**Files:**
- Create: `packages/router/src/setup/repositoryRoutes.ts`
- Test: `packages/router/test/setup-repository-routes.test.ts`

**Interfaces:**
- Consumes: Task 14's views; Task 4's `RepositoryRegistry` / `validateRegisteredRepository`; `parseAssociations` / `formatAssociations` (Task 1); `requireSetupPrincipal`, `SetupAuthError`, `CsrfTokens`, `SetupBootstrap` from the existing setup modules.
- Produces:
  - `interface RepositoryRouteDeps { registry: RepositoryRegistry; workspaceIds: string[]; auth: SetupAuthConfig; bootstrap: SetupBootstrap; csrf: CsrfTokens; verifyIdToken?: SetupIdTokenVerifier; logger: { info(msg: string): void; warn(msg: string): void }; maxFormBodyBytes?: number }`
  - `function registerRepositoryRoutes(fastify: FastifyInstance, deps: RepositoryRouteDeps): void`
  - `function applyRepositoryEdits(current: RegisteredRepository[], fields: Record<string, unknown>): { next: RegisteredRepository[]; changed: boolean }`

- [ ] **Step 1: Write the failing test**

Create `packages/router/test/setup-repository-routes.test.ts`. Reuse the harness
conventions from `setup-routes.test.ts` — the `dev-insecure-headers` auth mode,
the `Fastify()` + `inject()` pattern, and its `FORM` content type constant.

```ts
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	RegisteredRepository,
	RepositoryRegistry,
} from "../src/RepositoryRegistry.js";
import { RouterStore } from "../src/RouterStore.js";
import { SetupBootstrap } from "../src/setup/bootstrap.js";
import { createCsrfTokens } from "../src/setup/csrf.js";
import type { SetupAuthConfig } from "../src/setup/principal.js";
import {
	applyRepositoryEdits,
	registerRepositoryRoutes,
} from "../src/setup/repositoryRoutes.js";
import { SetupConflictError } from "../src/TableSecretStore.js";

const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const FORM = "application/x-www-form-urlencoded";
const DEV_AUTH: SetupAuthConfig = { auth: { mode: "dev-insecure-headers" } };

const API: RegisteredRepository = {
	name: "cyrus-api",
	githubSlug: "acme/cyrus-api",
	linearWorkspaceId: "ws-1",
	baseBranch: "main",
	projectKeys: ["Platform"],
	isDefault: true,
};

/** In-memory registry with real optimistic concurrency. */
function fakeRegistry(initial: RegisteredRepository[] = []) {
	let repositories = [...initial];
	let version = initial.length > 0 ? 1 : 0;
	const registry: RepositoryRegistry & { current: () => RegisteredRepository[] } = {
		current: () => repositories,
		list: async () => ({
			repositories: [...repositories],
			version: String(version),
		}),
		put: async (next, ifMatch) => {
			if (ifMatch !== undefined && ifMatch !== String(version)) {
				throw new SetupConflictError();
			}
			repositories = [...next];
			version += 1;
			return { version: String(version) };
		},
	};
	return registry;
}

function build(registry: RepositoryRegistry, registered = [ALICE]) {
	const store = new RouterStore(":memory:");
	for (const email of registered) store.addUser({ email });
	const fastify = Fastify();
	registerRepositoryRoutes(fastify, {
		registry,
		workspaceIds: ["ws-1"],
		auth: DEV_AUTH,
		bootstrap: new SetupBootstrap({
			store,
			secrets: { get: async () => ({}), set: async () => {} } as never,
			requiredKeys: [],
			autoProvisionUsers: false,
			logger: { info: vi.fn(), warn: vi.fn() },
		}),
		csrf: createCsrfTokens({ secret: "test-secret" }),
		logger: { info: vi.fn(), warn: vi.fn() },
	});
	return { fastify, store };
}

async function csrfFrom(fastify: FastifyInstance): Promise<string> {
	const page = await fastify.inject({
		method: "GET",
		url: "/setup/repositories",
		headers: { "x-cyrus-setup-email": ALICE },
	});
	return /name="csrf" value="([^"]+)"/.exec(page.body)?.[1] as string;
}

async function versionFrom(fastify: FastifyInstance): Promise<string> {
	const page = await fastify.inject({
		method: "GET",
		url: "/setup/repositories",
		headers: { "x-cyrus-setup-email": ALICE },
	});
	return /name="version" value="([^"]+)"/.exec(page.body)?.[1] as string;
}

describe("GET /setup/repositories", () => {
	it("renders the registry for a registered user", async () => {
		const { fastify } = build(fakeRegistry([API]));
		const response = await fastify.inject({
			method: "GET",
			url: "/setup/repositories",
			headers: { "x-cyrus-setup-email": ALICE },
		});
		expect(response.statusCode).toBe(200);
		expect(response.body).toContain("cyrus-api");
		expect(response.body).toContain('value="p=Platform"');
	});

	it("refuses an unregistered principal with 403", async () => {
		const { fastify } = build(fakeRegistry([API]));
		const response = await fastify.inject({
			method: "GET",
			url: "/setup/repositories",
			headers: { "x-cyrus-setup-email": BOB },
		});
		expect(response.statusCode).toBe(403);
		expect(response.body).not.toContain("cyrus-api");
	});

	it("refuses an unauthenticated request with 401", async () => {
		const { fastify } = build(fakeRegistry([API]));
		expect(
			(await fastify.inject({ method: "GET", url: "/setup/repositories" }))
				.statusCode,
		).toBe(401);
	});
});

describe("POST /setup/repositories", () => {
	it("adds a repository", async () => {
		const registry = fakeRegistry();
		const { fastify } = build(registry);
		const csrf = await csrfFrom(fastify);

		const response = await fastify.inject({
			method: "POST",
			url: "/setup/repositories",
			headers: { "x-cyrus-setup-email": ALICE, "content-type": FORM },
			payload: new URLSearchParams({
				csrf,
				name: "cyrus-web",
				githubSlug: "acme/cyrus-web",
				baseBranch: "main",
				associations: "t=WEB",
				linearWorkspaceId: "ws-1",
			}).toString(),
		});

		expect(response.statusCode).toBe(200);
		expect(registry.current()).toEqual([
			{
				name: "cyrus-web",
				githubSlug: "acme/cyrus-web",
				linearWorkspaceId: "ws-1",
				baseBranch: "main",
				teamKeys: ["WEB"],
			},
		]);
	});

	it("rejects a missing CSRF token with 403 and writes nothing", async () => {
		const registry = fakeRegistry();
		const { fastify } = build(registry);
		const response = await fastify.inject({
			method: "POST",
			url: "/setup/repositories",
			headers: { "x-cyrus-setup-email": ALICE, "content-type": FORM },
			payload: new URLSearchParams({ name: "x", githubSlug: "a/b" }).toString(),
		});
		expect(response.statusCode).toBe(403);
		expect(registry.current()).toEqual([]);
	});

	it("rejects a name that could escape the repos directory", async () => {
		const registry = fakeRegistry();
		const { fastify } = build(registry);
		const csrf = await csrfFrom(fastify);
		const response = await fastify.inject({
			method: "POST",
			url: "/setup/repositories",
			headers: { "x-cyrus-setup-email": ALICE, "content-type": FORM },
			payload: new URLSearchParams({
				csrf,
				name: "../escape",
				githubSlug: "acme/x",
				linearWorkspaceId: "ws-1",
			}).toString(),
		});
		expect(response.statusCode).toBe(400);
		expect(response.body).toContain("is not valid");
		expect(registry.current()).toEqual([]);
	});

	it("rejects a duplicate name case-insensitively", async () => {
		const registry = fakeRegistry([API]);
		const { fastify } = build(registry);
		const csrf = await csrfFrom(fastify);
		const response = await fastify.inject({
			method: "POST",
			url: "/setup/repositories",
			headers: { "x-cyrus-setup-email": ALICE, "content-type": FORM },
			payload: new URLSearchParams({
				csrf,
				name: "CYRUS-API",
				githubSlug: "acme/other",
				linearWorkspaceId: "ws-1",
			}).toString(),
		});
		expect(response.statusCode).toBe(400);
		expect(response.body).toContain("already registered");
		expect(registry.current()).toHaveLength(1);
	});

	it("surfaces an association parse error verbatim", async () => {
		const registry = fakeRegistry();
		const { fastify } = build(registry);
		const csrf = await csrfFrom(fastify);
		const response = await fastify.inject({
			method: "POST",
			url: "/setup/repositories",
			headers: { "x-cyrus-setup-email": ALICE, "content-type": FORM },
			payload: new URLSearchParams({
				csrf,
				name: "ok",
				githubSlug: "acme/ok",
				associations: "x=nope",
				linearWorkspaceId: "ws-1",
			}).toString(),
		});
		expect(response.statusCode).toBe(400);
		expect(response.body).toContain("Unknown key");
	});

	it("defaults the base branch to main", async () => {
		const registry = fakeRegistry();
		const { fastify } = build(registry);
		const csrf = await csrfFrom(fastify);
		await fastify.inject({
			method: "POST",
			url: "/setup/repositories",
			headers: { "x-cyrus-setup-email": ALICE, "content-type": FORM },
			payload: new URLSearchParams({
				csrf,
				name: "ok",
				githubSlug: "acme/ok",
				linearWorkspaceId: "ws-1",
			}).toString(),
		});
		expect(registry.current()[0]?.baseBranch).toBe("main");
	});
});

describe("POST /setup/repositories/save", () => {
	it("moves the default to the selected repository", async () => {
		const registry = fakeRegistry([
			API,
			{ name: "cyrus-web", githubSlug: "acme/cyrus-web", linearWorkspaceId: "ws-1" },
		]);
		const { fastify } = build(registry);
		const csrf = await csrfFrom(fastify);
		const version = await versionFrom(fastify);

		const response = await fastify.inject({
			method: "POST",
			url: "/setup/repositories/save",
			headers: { "x-cyrus-setup-email": ALICE, "content-type": FORM },
			payload: new URLSearchParams({
				csrf,
				version,
				"repo:cyrus-api": "1",
				"slug:cyrus-api": "acme/cyrus-api",
				"branch:cyrus-api": "main",
				"assoc:cyrus-api": "p=Platform",
				"repo:cyrus-web": "1",
				"slug:cyrus-web": "acme/cyrus-web",
				"branch:cyrus-web": "main",
				"assoc:cyrus-web": "",
				isDefault: "cyrus-web",
			}).toString(),
		});

		expect(response.statusCode).toBe(200);
		expect(registry.current().find((r) => r.name === "cyrus-api")?.isDefault).toBe(
			undefined,
		);
		expect(registry.current().find((r) => r.name === "cyrus-web")?.isDefault).toBe(
			true,
		);
	});

	it("409s on a stale version rather than overwriting", async () => {
		const registry = fakeRegistry([API]);
		const { fastify } = build(registry);
		const csrf = await csrfFrom(fastify);
		const stale = await versionFrom(fastify);
		await registry.put([{ ...API, baseBranch: "develop" }], stale);

		const response = await fastify.inject({
			method: "POST",
			url: "/setup/repositories/save",
			headers: { "x-cyrus-setup-email": ALICE, "content-type": FORM },
			payload: new URLSearchParams({
				csrf,
				version: stale,
				"repo:cyrus-api": "1",
				"slug:cyrus-api": "acme/cyrus-api",
				"branch:cyrus-api": "release",
				"assoc:cyrus-api": "",
			}).toString(),
		});

		expect(response.statusCode).toBe(409);
		expect(registry.current()[0]?.baseBranch).toBe("develop");
	});

	it("reports no changes without writing", async () => {
		const registry = fakeRegistry([API]);
		const putSpy = vi.spyOn(registry, "put");
		const { fastify } = build(registry);
		const csrf = await csrfFrom(fastify);
		const version = await versionFrom(fastify);
		putSpy.mockClear();

		const response = await fastify.inject({
			method: "POST",
			url: "/setup/repositories/save",
			headers: { "x-cyrus-setup-email": ALICE, "content-type": FORM },
			payload: new URLSearchParams({
				csrf,
				version,
				"repo:cyrus-api": "1",
				"slug:cyrus-api": "acme/cyrus-api",
				"branch:cyrus-api": "main",
				"assoc:cyrus-api": "p=Platform",
				isDefault: "cyrus-api",
			}).toString(),
		});

		expect(response.statusCode).toBe(200);
		expect(response.body).toContain("No changes to save");
		expect(putSpy).not.toHaveBeenCalled();
	});
});

describe("DELETE /setup/repositories/:name", () => {
	it("removes a repository when the CSRF token is a header", async () => {
		const registry = fakeRegistry([API]);
		const { fastify } = build(registry);
		const csrf = await csrfFrom(fastify);

		const response = await fastify.inject({
			method: "DELETE",
			url: "/setup/repositories/cyrus-api",
			headers: { "x-cyrus-setup-email": ALICE, "x-csrf-token": csrf },
		});

		expect(response.statusCode).toBe(200);
		expect(registry.current()).toEqual([]);
	});

	it("refuses a CSRF token supplied in the query string", async () => {
		const registry = fakeRegistry([API]);
		const { fastify } = build(registry);
		const csrf = await csrfFrom(fastify);

		const response = await fastify.inject({
			method: "DELETE",
			url: `/setup/repositories/cyrus-api?csrf=${encodeURIComponent(csrf)}`,
			headers: { "x-cyrus-setup-email": ALICE },
		});

		expect(response.statusCode).toBe(403);
		expect(registry.current()).toHaveLength(1);
	});

	it("is a no-op for an unknown repository", async () => {
		const registry = fakeRegistry([API]);
		const { fastify } = build(registry);
		const csrf = await csrfFrom(fastify);
		const response = await fastify.inject({
			method: "DELETE",
			url: "/setup/repositories/nope",
			headers: { "x-cyrus-setup-email": ALICE, "x-csrf-token": csrf },
		});
		expect(response.statusCode).toBe(200);
		expect(registry.current()).toHaveLength(1);
	});
});

describe("applyRepositoryEdits", () => {
	it("updates slug, branch, associations, and default together", () => {
		const result = applyRepositoryEdits([API], {
			"repo:cyrus-api": ["1"],
			"slug:cyrus-api": ["acme/renamed"],
			"branch:cyrus-api": ["develop"],
			"assoc:cyrus-api": ["t=NOR"],
			isDefault: ["cyrus-api"],
		});
		expect(result.changed).toBe(true);
		expect(result.next[0]).toEqual({
			name: "cyrus-api",
			githubSlug: "acme/renamed",
			linearWorkspaceId: "ws-1",
			baseBranch: "develop",
			teamKeys: ["NOR"],
			isDefault: true,
		});
	});

	it("drops a repository whose row was not submitted", () => {
		const result = applyRepositoryEdits(
			[API, { name: "b", githubSlug: "acme/b", linearWorkspaceId: "ws-1" }],
			{
				"repo:cyrus-api": ["1"],
				"slug:cyrus-api": ["acme/cyrus-api"],
				"branch:cyrus-api": ["main"],
				"assoc:cyrus-api": ["p=Platform"],
				isDefault: ["cyrus-api"],
			},
		);
		expect(result.next.map((repo) => repo.name)).toEqual(["cyrus-api"]);
		expect(result.changed).toBe(true);
	});

	it("clears associations when the field is emptied", () => {
		const result = applyRepositoryEdits([API], {
			"repo:cyrus-api": ["1"],
			"slug:cyrus-api": ["acme/cyrus-api"],
			"branch:cyrus-api": ["main"],
			"assoc:cyrus-api": [""],
			isDefault: ["cyrus-api"],
		});
		expect(result.next[0]?.projectKeys).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-router test:run test/setup-repository-routes.test.ts`
Expected: FAIL — cannot resolve `../src/setup/repositoryRoutes.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/router/src/setup/repositoryRoutes.ts`. It is a close sibling of
`routes.ts`; read that file first and mirror its guard order, version-token
minting, and `secureHtml` headers exactly.

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
	AssociationParseError,
	formatAssociations,
	parseAssociations,
} from "cyrus-core";
import {
	type RegisteredRepository,
	type RepositoryRegistry,
	validateRegisteredRepository,
} from "../RepositoryRegistry.js";
import { SetupConflictError } from "../TableSecretStore.js";
import type { SetupBootstrap } from "./bootstrap.js";
import type { CsrfTokens } from "./csrf.js";
import {
	DEFAULT_MAX_FORM_BODY_BYTES,
	FormBodyTooLargeError,
	parseFormBody,
} from "./formbody.js";
import {
	requireSetupPrincipal,
	type SetupAuthConfig,
	SetupAuthError,
	type SetupIdTokenVerifier,
	type SetupPrincipal,
} from "./principal.js";
import {
	findAmbiguities,
	type RepositoriesPageModel,
	renderRepositoriesPage,
	renderRepositoriesTable,
	type RepositoryView,
} from "./repositoryViews.js";
import { escapeHtml, type SetupMessage } from "./views.js";

/**
 * HTTP surface for `/setup/repositories*`, the global repository registry.
 *
 * Three properties carry over from `routes.ts` and are each pinned by a test:
 *
 * 1. **`GET` is read-only.** It never provisions and never writes.
 * 2. **The registry version is captured at RENDER time** and the save performs
 *    its conditional write against THAT version, so a concurrent edit is a
 *    visible 409 rather than a silent overwrite.
 * 3. **CSRF is body-or-header only, never a query string** — an 8-hour token in
 *    a URL lands in access logs and browser history.
 *
 * Unlike the variables page, values here ARE rendered back: repository names
 * and slugs are configuration, not credentials, and editing requires seeing
 * them. Nothing on this page ever reads the secret store.
 *
 * Authorization is `bootstrap.authorize` — any registered Cyrus user may edit.
 * The registry is global, so every mutation is logged with the actor's email.
 */

const CSP = [
	"default-src 'none'",
	"style-src 'self' 'unsafe-inline'",
	"script-src 'self' 'unsafe-inline'",
	"img-src 'self' data:",
	"connect-src 'self'",
	"form-action 'self'",
	"frame-ancestors 'none'",
	"base-uri 'none'",
].join("; ");

/** Domain-separates the version token from the CSRF token (same signer). */
const VERSION_SCOPE = "setup-repos-version";

export interface RepositoryRouteDeps {
	registry: RepositoryRegistry;
	/** Workspace ids the router serves; one means the field is auto-filled. */
	workspaceIds: string[];
	auth: SetupAuthConfig;
	bootstrap: SetupBootstrap;
	csrf: CsrfTokens;
	verifyIdToken?: SetupIdTokenVerifier;
	logger: { info(msg: string): void; warn(msg: string): void };
	maxFormBodyBytes?: number;
}

function lastValue(raw: unknown): string | undefined {
	if (typeof raw === "string") return raw;
	if (Array.isArray(raw)) {
		const last = raw.at(-1);
		return typeof last === "string" ? last : undefined;
	}
	return undefined;
}

function fieldsOf(request: FastifyRequest): Record<string, unknown> {
	const body = request.body;
	if (typeof body !== "object" || body === null) return {};
	return body as Record<string, unknown>;
}

function secureHtml(reply: FastifyReply): FastifyReply {
	return reply
		.header("content-type", "text/html; charset=utf-8")
		.header("cache-control", "no-store")
		.header("content-security-policy", CSP)
		.header("x-content-type-options", "nosniff")
		.header("referrer-policy", "no-referrer")
		.header("x-frame-options", "DENY");
}

function issueVersionToken(
	deps: RepositoryRouteDeps,
	email: string,
	version: string | undefined,
): string {
	const payload = Buffer.from(version ?? "", "utf-8").toString("hex");
	return `${payload}.${deps.csrf.issue(`${VERSION_SCOPE}|${email}|${payload}`)}`;
}

function readVersionToken(
	deps: RepositoryRouteDeps,
	email: string,
	token: string | undefined,
): { ok: true; version: string | undefined } | { ok: false } {
	if (!token) return { ok: false };
	const separator = token.indexOf(".");
	if (separator < 0) return { ok: false };
	const payload = token.slice(0, separator);
	if (!/^(?:[0-9a-f]{2})*$/.test(payload)) return { ok: false };
	if (
		!deps.csrf.verify(
			`${VERSION_SCOPE}|${email}|${payload}`,
			token.slice(separator + 1),
		)
	) {
		return { ok: false };
	}
	const version = Buffer.from(payload, "hex").toString("utf-8");
	return { ok: true, version: version === "" ? undefined : version };
}

function toView(repo: RegisteredRepository): RepositoryView {
	return {
		name: repo.name,
		githubSlug: repo.githubSlug,
		baseBranch: repo.baseBranch ?? "main",
		associations: formatAssociations({
			...(repo.projectKeys ? { projectKeys: repo.projectKeys } : {}),
			...(repo.teamKeys ? { teamKeys: repo.teamKeys } : {}),
		}),
		isDefault: repo.isDefault === true,
	};
}

async function buildModel(
	deps: RepositoryRouteDeps,
	principal: SetupPrincipal,
	message?: SetupMessage,
): Promise<RepositoriesPageModel> {
	const { repositories, version } = await deps.registry.list();
	const views = repositories.map(toView);
	return {
		email: principal.email,
		repositories: views,
		workspaceIds: deps.workspaceIds,
		ambiguities: findAmbiguities(views),
		csrfToken: deps.csrf.issue(principal.email),
		versionToken: issueVersionToken(deps, principal.email, version),
		...(message ? { message } : {}),
	};
}

async function respond(
	reply: FastifyReply,
	deps: RepositoryRouteDeps,
	principal: SetupPrincipal,
	status: number,
	message: SetupMessage,
): Promise<FastifyReply> {
	// Re-read: after a conflict the user must see what is ACTUALLY stored, and
	// after a success the fragment must carry the NEW version token or the next
	// save 409s.
	const model = await buildModel(deps, principal, message);
	return secureHtml(reply).status(status).send(renderRepositoriesTable(model));
}

async function authenticate(
	deps: RepositoryRouteDeps,
	request: FastifyRequest,
): Promise<{ principal: SetupPrincipal } | { error: SetupAuthError }> {
	try {
		return {
			principal: await requireSetupPrincipal(request.headers, deps.auth, {
				...(deps.verifyIdToken ? { verifyIdToken: deps.verifyIdToken } : {}),
			}),
		};
	} catch (error) {
		if (error instanceof SetupAuthError) return { error };
		throw error;
	}
}

/** principal -> CSRF -> registration -> fields, in that order. See routes.ts. */
async function requireMutation(
	deps: RepositoryRouteDeps,
	request: FastifyRequest,
): Promise<
	| { principal: SetupPrincipal; fields: Record<string, unknown> }
	| { error: SetupAuthError }
> {
	const auth = await authenticate(deps, request);
	if ("error" in auth) return auth;

	const fields = fieldsOf(request);
	const header = request.headers["x-csrf-token"];
	const token =
		lastValue(fields.csrf) ?? (typeof header === "string" ? header : undefined);
	if (!token || !deps.csrf.verify(auth.principal.email, token)) {
		return {
			error: new SetupAuthError(
				403,
				"This page expired, or the request did not come from it. Reload the page and try again.",
			),
		};
	}

	try {
		deps.bootstrap.authorize(auth.principal);
	} catch (error) {
		if (error instanceof SetupAuthError) return { error };
		throw error;
	}
	return { principal: auth.principal, fields };
}

function sendError(
	deps: RepositoryRouteDeps,
	reply: FastifyReply,
	error: SetupAuthError,
): FastifyReply {
	deps.logger.warn(
		`Repository setup request refused with ${error.status}: ${error.message}`,
	);
	const body =
		error.status === 401
			? `<p>You are not signed in. <a href="/.auth/login/aad?post_login_redirect_uri=%2Fsetup%2Frepositories">Sign in</a>.</p>`
			: `<p>${escapeHtml(error.message)}</p>`;
	return secureHtml(reply)
		.status(error.status)
		.send(
			`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Cyrus repositories</title></head><body><main><h1>Cyrus repositories</h1>${body}</main></body></html>`,
		);
}

/**
 * Folds a submitted form over the stored registry.
 *
 * A row is identified by its hidden `repo:<name>` marker, so a repository whose
 * row was not submitted is DROPPED — that is what makes the delete button's
 * effect survive a subsequent save. `isDefault` is one radio for the whole
 * table, so applying it here is what guarantees at most one default per write.
 */
export function applyRepositoryEdits(
	current: RegisteredRepository[],
	fields: Record<string, unknown>,
): { next: RegisteredRepository[]; changed: boolean } {
	const submitted = new Set(
		Object.keys(fields)
			.filter((field) => field.startsWith("repo:"))
			.map((field) => field.slice("repo:".length)),
	);
	const defaultName = lastValue(fields.isDefault);

	const next: RegisteredRepository[] = [];
	for (const repo of current) {
		if (!submitted.has(repo.name)) continue;

		const slug = lastValue(fields[`slug:${repo.name}`])?.trim();
		const branch = lastValue(fields[`branch:${repo.name}`])?.trim();
		const associations = lastValue(fields[`assoc:${repo.name}`]) ?? "";
		const parsed = parseAssociations(associations);

		next.push({
			name: repo.name,
			githubSlug: slug && slug !== "" ? slug : repo.githubSlug,
			linearWorkspaceId: repo.linearWorkspaceId,
			baseBranch: branch && branch !== "" ? branch : (repo.baseBranch ?? "main"),
			...(parsed.teamKeys.length > 0 ? { teamKeys: parsed.teamKeys } : {}),
			...(parsed.projectKeys.length > 0
				? { projectKeys: parsed.projectKeys }
				: {}),
			...(repo.routingLabels ? { routingLabels: repo.routingLabels } : {}),
			...(defaultName === repo.name ? { isDefault: true } : {}),
		});
	}

	return {
		next,
		changed: JSON.stringify(next) !== JSON.stringify(current),
	};
}

export function registerRepositoryRoutes(
	fastify: FastifyInstance,
	deps: RepositoryRouteDeps,
): void {
	const maxBytes = deps.maxFormBodyBytes ?? DEFAULT_MAX_FORM_BODY_BYTES;

	// Registered idempotently: `registerSetupRoutes` may already have added this
	// parser on the same instance, and Fastify throws on a duplicate.
	if (!fastify.hasContentTypeParser("application/x-www-form-urlencoded")) {
		fastify.addContentTypeParser(
			"application/x-www-form-urlencoded",
			{ parseAs: "string", bodyLimit: maxBytes },
			(_request, body, done) => {
				try {
					done(null, parseFormBody(body as string, { maxBytes }));
				} catch (error) {
					if (error instanceof FormBodyTooLargeError) {
						(error as Error & { statusCode?: number }).statusCode = 413;
					}
					done(error as Error, undefined);
				}
			},
		);
	}

	fastify.get("/setup/repositories", async (request, reply) => {
		const auth = await authenticate(deps, request);
		if ("error" in auth) return sendError(deps, reply, auth.error);
		try {
			deps.bootstrap.authorize(auth.principal);
		} catch (error) {
			if (error instanceof SetupAuthError) {
				return sendError(deps, reply, error);
			}
			throw error;
		}
		return secureHtml(reply).send(
			renderRepositoriesPage(await buildModel(deps, auth.principal)),
		);
	});

	fastify.get("/setup/repositories/table", async (request, reply) => {
		const auth = await authenticate(deps, request);
		if ("error" in auth) return sendError(deps, reply, auth.error);
		try {
			deps.bootstrap.authorize(auth.principal);
		} catch (error) {
			if (error instanceof SetupAuthError) {
				return sendError(deps, reply, error);
			}
			throw error;
		}
		return secureHtml(reply).send(
			renderRepositoriesTable(await buildModel(deps, auth.principal)),
		);
	});

	fastify.post("/setup/repositories", async (request, reply) => {
		const guard = await requireMutation(deps, request);
		if ("error" in guard) return sendError(deps, reply, guard.error);

		const name = lastValue(guard.fields.name)?.trim() ?? "";
		const githubSlug = lastValue(guard.fields.githubSlug)?.trim() ?? "";
		const baseBranch = lastValue(guard.fields.baseBranch)?.trim() || "main";
		const associations = lastValue(guard.fields.associations) ?? "";
		const linearWorkspaceId =
			lastValue(guard.fields.linearWorkspaceId)?.trim() ??
			deps.workspaceIds[0] ??
			"";

		let repo: RegisteredRepository;
		try {
			const parsed = parseAssociations(associations);
			repo = {
				name,
				githubSlug,
				linearWorkspaceId,
				baseBranch,
				...(parsed.teamKeys.length > 0 ? { teamKeys: parsed.teamKeys } : {}),
				...(parsed.projectKeys.length > 0
					? { projectKeys: parsed.projectKeys }
					: {}),
			};
			validateRegisteredRepository(repo);
		} catch (error) {
			const message =
				error instanceof AssociationParseError
					? error.message
					: (error as Error).message;
			return respond(reply, deps, guard.principal, 400, {
				kind: "error",
				text: message,
			});
		}

		const { repositories, version } = await deps.registry.list();
		if (
			repositories.some(
				(existing) => existing.name.toLowerCase() === name.toLowerCase(),
			)
		) {
			return respond(reply, deps, guard.principal, 400, {
				kind: "error",
				text: `${name} is already registered. Edit the existing row instead.`,
			});
		}

		try {
			await deps.registry.put([...repositories, repo], version);
		} catch (error) {
			if (error instanceof SetupConflictError) {
				return respond(reply, deps, guard.principal, 409, {
					kind: "conflict",
					text: "The repository list changed while you were editing. The current list is shown below — add your repository again.",
				});
			}
			throw error;
		}

		deps.logger.info(
			`${guard.principal.email} registered repository ${name} (${githubSlug})`,
		);
		return respond(reply, deps, guard.principal, 200, {
			kind: "ok",
			text: `Added ${name}. New sessions will use it; a session already running keeps the repository it started with.`,
		});
	});

	fastify.post("/setup/repositories/save", async (request, reply) => {
		const guard = await requireMutation(deps, request);
		if ("error" in guard) return sendError(deps, reply, guard.error);

		const token = readVersionToken(
			deps,
			guard.principal.email,
			lastValue(guard.fields.version),
		);
		if (!token.ok) {
			// Never fall through to an unconditional write — that is the fail-open
			// upsert the version token exists to prevent.
			return respond(reply, deps, guard.principal, 409, {
				kind: "conflict",
				text: "This page is out of date. The current repositories are shown below — re-enter your changes and save again.",
			});
		}

		const { repositories } = await deps.registry.list();
		let applied: ReturnType<typeof applyRepositoryEdits>;
		try {
			applied = applyRepositoryEdits(repositories, guard.fields);
			for (const repo of applied.next) validateRegisteredRepository(repo);
		} catch (error) {
			return respond(reply, deps, guard.principal, 400, {
				kind: "error",
				text: (error as Error).message,
			});
		}

		if (!applied.changed) {
			return respond(reply, deps, guard.principal, 200, {
				kind: "ok",
				text: "No changes to save.",
			});
		}

		try {
			await deps.registry.put(applied.next, token.version);
		} catch (error) {
			if (error instanceof SetupConflictError) {
				return respond(reply, deps, guard.principal, 409, {
					kind: "conflict",
					text: "The repository list was changed somewhere else while you were editing. The current list is shown below — re-enter your changes and save again.",
				});
			}
			throw error;
		}

		deps.logger.info(
			`${guard.principal.email} saved the repository registry (${applied.next.length} repositories)`,
		);
		return respond(reply, deps, guard.principal, 200, {
			kind: "ok",
			text: "Saved. New sessions use these repositories; a session already running keeps the repository it started with.",
		});
	});

	fastify.delete<{ Params: { name: string } }>(
		"/setup/repositories/:name",
		async (request, reply) => {
			const guard = await requireMutation(deps, request);
			if ("error" in guard) return sendError(deps, reply, guard.error);

			// Fastify already percent-decodes path params.
			const name = request.params.name;
			const { repositories, version } = await deps.registry.list();
			const next = repositories.filter(
				(repo) => repo.name.toLowerCase() !== name.toLowerCase(),
			);
			if (next.length === repositories.length) {
				return respond(reply, deps, guard.principal, 200, {
					kind: "ok",
					text: `${name} was not registered.`,
				});
			}

			try {
				await deps.registry.put(next, version);
			} catch (error) {
				if (error instanceof SetupConflictError) {
					return respond(reply, deps, guard.principal, 409, {
						kind: "conflict",
						text: "The repository list changed while you were editing. The current list is shown below — try again.",
					});
				}
				throw error;
			}

			deps.logger.info(
				`${guard.principal.email} removed repository ${name}`,
			);
			return respond(reply, deps, guard.principal, 200, {
				kind: "ok",
				text: `Removed ${name}. Issues already routed to it keep their workspace until it is torn down.`,
			});
		},
	);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter cyrus-router test:run test/setup-repository-routes.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/router/src/setup/repositoryRoutes.ts packages/router/test/setup-repository-routes.test.ts
git commit -m "feat(router): add setup routes for the repository registry"
```

---

### Task 16: Wire the repositories page into the server

**Files:**
- Modify: `packages/router/src/RouterServer.ts`
- Modify: `packages/router/src/setup/views.ts`
- Test: `packages/router/test/setup-views.test.ts` (append one case)

**Interfaces:**
- Consumes: `registerRepositoryRoutes` (Task 15); `repositoryRegistry` on `RouterServer` (Task 6).
- Produces: `/setup/repositories` served whenever the setup UI and containers are both configured; a nav link on `/setup`.

- [ ] **Step 1: Write the failing test**

Append to `packages/router/test/setup-views.test.ts`:

```ts
it("links to the repositories page from the variables page", () => {
	const html = renderPage(MODEL);
	expect(html).toContain('href="/setup/repositories"');
	expect(html).toContain("Repositories");
});
```

Use whatever page model constant that file already defines in place of `MODEL`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-router test:run test/setup-views.test.ts`
Expected: FAIL — no such link.

- [ ] **Step 3: Add the nav link**

In `packages/router/src/setup/views.ts`, in `renderPage`'s `<header>`, replace
the identity line with:

```ts
			<p>Signed in as <strong>${escapeHtml(model.email)}</strong> &middot; <a href="/setup/repositories">Repositories</a> &middot; <a href="/.auth/logout">Sign out</a></p>
```

- [ ] **Step 4: Register the routes**

In `packages/router/src/RouterServer.ts`, immediately after the existing
`registerSetupRoutes(...)` call, add:

```ts
			// The registry only exists when `containers` is configured; a
			// device-only deployment has no repositories to register.
			if (this.repositoryRegistry) {
				registerRepositoryRoutes(this.fastify, {
					registry: this.repositoryRegistry,
					workspaceIds: Object.keys(this.config.workspaces),
					auth: setupAuthConfig,
					bootstrap: setupBootstrap,
					csrf: setupCsrf,
					...(setupIdTokenVerifier
						? { verifyIdToken: setupIdTokenVerifier }
						: {}),
					logger: this.logger,
				});
			}
```

Reuse the exact local variable names `registerSetupRoutes` is already called
with — read that call site and substitute accordingly.

Add the import:

```ts
import { registerRepositoryRoutes } from "./setup/repositoryRoutes.js";
```

**Ordering caveat:** `repositoryRegistry` is assigned inside the containers
block. If setup routes are registered before that block runs, move the registry
construction from Task 6 above the setup-route registration, or register the
repository routes at the end of `start()`. Confirm the order by reading
`RouterServer.start()` in full before editing.

- [ ] **Step 5: Run the router suite**

Run: `pnpm --filter cyrus-router test:run && pnpm build && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/router/src/RouterServer.ts packages/router/src/setup/views.ts packages/router/test/setup-views.test.ts
git commit -m "feat(router): serve the repositories page from the setup UI"
```

---

### Task 17: Self-describing prompts, docs, and changelog

**Files:**
- Modify: `packages/edge-worker/src/PromptBuilder.ts`
- Modify: `packages/edge-worker/src/SlackChatAdapter.ts`
- Modify: `packages/edge-worker/src/ActivityPoster.ts`
- Modify: `docs/ROUTER.md` (around line 312 and 707)
- Modify: `CLAUDE.md`
- Modify: `CHANGELOG.md`
- Test: `packages/edge-worker/test/prompt-assembly.routing-context.test.ts`

**Interfaces:**
- Consumes: `isDefault` (Task 1); the routing methods from Task 2.
- Produces: no code interfaces — this task makes the product describe its own new behaviour.

**Why this task exists:** `CLAUDE.md` §8 requires that any change to routing
behaviour also updates the prompts that describe routing *to Cyrus itself*.
Cyrus uses those prompts to instruct users and to create correctly-routed
sub-issues; leaving them stale means it will keep telling people to use
`[repo=…]` tags for something the registry now handles.

- [ ] **Step 1: Update the routing-context prompt**

In `packages/edge-worker/src/PromptBuilder.ts`, extend the
`<repository_routing_context>` block so it documents the full priority order
including the default tier. Per the repo's testing rule, the prompt-assembly
tests assert the **entire** prompt, so read
`packages/edge-worker/test/prompt-assembly.routing-context.test.ts` first and
update its expected string in the same edit.

The block must state, in priority order:

1. `[repo=name]` or `[repo=name#branch]` in the issue description — highest
   priority, supports several repositories and a per-repository base branch.
2. Routing labels on the issue.
3. The issue's Linear **project** name, matched case-insensitively against each
   repository's configured project names.
4. The issue's **team** key, matched case-insensitively.
5. The repository marked as the **default**, used when nothing above matches.

And it must state that when two repositories match at the same level, Cyrus asks
the user to choose rather than guessing.

- [ ] **Step 2: Update the Slack orchestration prompt**

In `packages/edge-worker/src/SlackChatAdapter.ts`, find the orchestration notes
that document repo-routing syntax and add the project/team/default tiers using
the same wording as Step 1, so a Slack-initiated sub-issue is routed the same
way a Linear-initiated one is.

- [ ] **Step 3: Add display names for the new routing methods**

In `packages/edge-worker/src/ActivityPoster.ts`, extend the routing-method
display-name map so `"default"` renders as `Default repository` and
`"user-selected"` as `Selected by you`. An unmapped method currently falls
through to its raw slug, which reads as a bug in the Linear timeline.

- [ ] **Step 4: Rewrite the ROUTER.md containers example**

In `docs/ROUTER.md`, replace the `containers.repositories` example (line ~312)
with one that shows routing metadata, and add a new subsection after it:

````markdown
```json
    "repositories": [{
      "name": "cyrus-api",
      "githubSlug": "org/cyrus-api",
      "linearWorkspaceId": "<workspace-id>",
      "baseBranch": "main",
      "projectKeys": ["Platform"],
      "teamKeys": ["NOR"]
    }, {
      "name": "cyrus-infra",
      "githubSlug": "org/cyrus-infra",
      "linearWorkspaceId": "<workspace-id>",
      "baseBranch": "main",
      "isDefault": true
    }],
```

### The repository registry

`containers.repositories` **seeds** the registry the first time the router
starts with an empty one. After that the stored registry is authoritative and
the config array is ignored — the router logs this on every start. Manage
repositories at `https://<router-fqdn>/setup/repositories`, which any registered
Cyrus user can edit.

Each repository may be associated with Linear project names and team keys. In
the setup UI these are written as one string:

```
p=Platform,p=Billing,t=NOR
```

`p=` is a Linear **project name**, `t=` is a **team key**, both repeatable, both
matched case-insensitively against the whole name. Quote a value that contains
a comma: `p="Q3 Migration, Phase 2"`.

Cyrus picks a repository in this order, highest first:

1. `[repo=name]` / `[repo=name#branch]` in the issue description
2. Routing labels on the issue
3. The issue's project name
4. The issue's team key
5. The repository marked **Default**

The decision is made **on the router**, before any sandbox starts, so each
sandbox clones only the repository it needs. It is made once per issue and
reused for every later session on that issue — a sandbox is per-issue and cannot
change repository once cloned.

When two repositories match at the same level — both claiming project
`Platform`, say — or when nothing matches and no default is set, Cyrus posts a
selection prompt in Linear and waits. **No container runs while it waits.** The
setup UI warns about these collisions at configuration time so they can be fixed
before they interrupt anyone.
````

Also update the "Add repositories" section around line 707 to point at
`/setup/repositories` for router deployments.

- [ ] **Step 5: Add the router invariants to CLAUDE.md**

Append to the §12 "ACA executor and Azure router invariants" list:

```markdown
   - Repository selection for **container** targets happens on the **router**,
     in `EventRouter.routeCreated`, before any device row or sandbox exists.
     The decision is persisted in `issue_repositories` and is what
     `ContainerTargets.buildEnv` turns into `CYRUS_REPOS_JSON`, so a sandbox
     clones only the repositories the issue needs and a destroyed-and-recreated
     container clones the same ones. An ambiguous or unmatched issue with no
     default gets a Linear elicitation posted by the router and its `created`
     webhook is HELD in `pending_repo_selections` until the answer arrives —
     nothing boots while the user decides. Physical-device targets still route
     inside their own EdgeWorker.
   - `containers.repositories` in `router-config.json` only **seeds** the
     repository registry, and only when the registry is empty. After that the
     stored registry (Azure Table, or `repositories.json` beside the router db)
     is authoritative and the config array is inert — the router logs this on
     every start. Editing `CYRUS_ROUTER_CONTAINERS_JSON` on a seeded deployment
     changes nothing.
   - Azure Table partition keys are namespaced by their first character: `u` +
     sha256(email) for a user's secret record (`setupPartitionKey`), `g` + 64
     zeros for the global repository registry. The registry row is **plaintext
     JSON**, deliberately not envelope-encrypted, so it works without the *Key
     Vault Crypto User* role. Never store a credential on that row.
```

- [ ] **Step 6: Add the changelog entry**

Under `## [Unreleased]` in `CHANGELOG.md`, written from the perspective of
someone running the `cyrus` CLI:

```markdown
### Added

- Router deployments can now register multiple repositories and manage them from
  the setup UI at `/setup/repositories`, including a default repository and
  associations to Linear project and team names (`p=Platform,t=NOR`).
- When an issue's project or team matches a registered repository, Cyrus now
  clones only that repository — no more tagging every issue with `[repo=…]`.
- When two repositories match equally, or nothing matches and no default is set,
  Cyrus asks in Linear which one to use. Nothing runs while it waits.

### Changed

- Router deployments with more than one repository previously always used the
  first one and cloned all of them into every workspace. They are now routed by
  project, team, or the configured default, and only the chosen repository is
  cloned. Single-repository deployments are unaffected.
- Project and team routing now match names case-insensitively.
```

Add the PR link once the PR exists, per the repo's changelog rule.

- [ ] **Step 7: Verify**

Run: `pnpm --filter cyrus-edge-worker test:run && pnpm build && pnpm typecheck`
Expected: PASS, including the updated full-prompt assertions.

- [ ] **Step 8: Commit**

```bash
git add packages/edge-worker/src packages/edge-worker/test docs/ROUTER.md CLAUDE.md CHANGELOG.md
git commit -m "docs: describe registry-based repository routing to Cyrus and operators"
```

---

### Task 18: F1 end-to-end validation

**Files:**
- Create: `apps/f1/test-drives/router-multi-repo.md`

**Interfaces:**
- Consumes: everything. This is the acceptance gate.
- Produces: a recorded test drive, per the `CLAUDE.md` mandate that F1 is used
  during the testing-and-validation stage of any major work.

- [ ] **Step 1: Read the F1 protocol**

Read `skills/f1-test-drive/SKILL.md` (symlinked into `.claude/skills/`) and an
existing drive under `apps/f1/test-drives/` before starting, so this drive
matches the established format.

- [ ] **Step 2: Seed a two-repository registry**

Configure an F1 router with `containers.repositories` holding:

```json
[
  { "name": "alpha", "githubSlug": "f1/alpha", "linearWorkspaceId": "<ws>", "teamKeys": ["ALPHA"], "projectKeys": ["Platform"] },
  { "name": "beta",  "githubSlug": "f1/beta",  "linearWorkspaceId": "<ws>", "teamKeys": ["BETA"] },
  { "name": "gamma", "githubSlug": "f1/gamma", "linearWorkspaceId": "<ws>", "isDefault": true }
]
```

Start the router and confirm the log line reporting the registry was seeded with
three repositories.

- [ ] **Step 3: Drive the four scenarios**

For each, record the router log lines and the resulting `CYRUS_REPOS_JSON`:

1. **Team hit** — delegate an issue on team `BETA`. Expect
   `Repositories for BETA-n: [beta] (team-based)` and a sandbox that clones
   `beta` and nothing else.
2. **Project hit beats team** — delegate an issue on team `BETA` whose project is
   `Platform`. Expect `(project-based)` and `alpha`.
3. **Default fallback** — delegate an issue on a team no repository claims.
   Expect `(default)` and `gamma`.
4. **Ambiguity elicitation** — temporarily give `beta` `projectKeys: ["Platform"]`
   too, then delegate an issue whose project is `Platform`. Expect a selection
   prompt in Linear listing `alpha` and `beta`, **no container device row**, and
   nothing booted. Answer `beta` and confirm the held delegation is replayed,
   the sandbox boots, and it clones `beta`.

- [ ] **Step 4: Drive the setup UI**

With the F1 router's setup UI reachable, confirm:

- `/setup/repositories` lists all three with their associations rendered as
  `p=…,t=…` strings.
- Adding a repository, editing an association, and moving the default each
  persist and are reflected in the next issue's routing.
- The ambiguity banner appears while `alpha` and `beta` both claim `Platform`.
- Deleting a repository removes it from the list.

- [ ] **Step 5: Confirm the clone saving**

Inside a booted sandbox, confirm `$WORKSPACES/repos/` contains exactly one
directory, not three — this is the concrete win the whole change exists for.

- [ ] **Step 6: Write up the drive**

Record the sequence, the log excerpts, the Linear screenshots or activity text,
and anything that did not behave as this plan predicts. A surprise here is a
finding, not a formatting problem — write it down rather than smoothing it over.

- [ ] **Step 7: Commit**

```bash
git add apps/f1/test-drives/router-multi-repo.md
git commit -m "test(f1): record the router multi-repository routing test drive"
```

---

## Self-Review

**Spec coverage.** Every section of
`docs/superpowers/specs/2026-08-05-router-multi-repo-routing-design.md` maps to a
task:

| Spec section | Task(s) |
| --- | --- |
| §1 Shared routing core | 1, 2, 3 |
| §1 Association parser | 1 |
| §2 Registry storage | 4, 5 |
| §2 Seeding and live reads | 6, 11 |
| §3 Router-side resolution | 8, 9, 10 |
| §3 New RouterStore tables | 7 |
| §3 Degradation on SQLite loss | 7 (corrupt row), 10 (missing pending), 11 (missing decision) |
| §4 Container changes | 12 |
| §5 `fetchProject` RPC | 13 |
| §6 Setup UI | 14, 15, 16 |
| §7 Rollout and compatibility | 6 (seed-once), 17 (changelog) |
| §7 Documentation | 17 |
| §7 Testing | every task, plus 18 |

**Type consistency.** Names used across task boundaries, defined once and
referenced identically thereafter: `RepositoryAssociations`, `parseAssociations`,
`formatAssociations`, `AssociationParseError` (Task 1); `RepoTag`,
`parseRepoTags`, `RoutableRepository`, `IssueFacts`, `RoutingMethod`,
`AmbiguousTier`, `MatchResult`, `matchRepositories` (Task 2);
`RegisteredRepository`, `RegistrySnapshot`, `RepositoryRegistry`,
`FileRepositoryRegistry`, `validateRegisteredRepository`, `toRoutable`,
`REPOSITORY_NAME_RE`, `GITHUB_SLUG_RE` (Task 4); `TableRepositoryRegistry`,
`REGISTRY_PARTITION_KEY`, `REGISTRY_ROW_KEY` (Task 5);
`createRepositoryRegistry`, `seedRepositoryRegistry` (Task 6);
`StoredRepositoryDecision`, `PendingRepoSelection` (Task 7);
`postRepositorySelection`, `fetchIssueFacts` (Task 8); `RepositoryDecision`,
`ResolveOutcome`, `RepositoryResolver` (Task 9); `REPOSITORY_SELECTION_PROMPT`,
`NO_REPOSITORIES_MESSAGE` (Task 10); `RepositoryView`,
`RepositoriesPageModel`, `renderRepositoriesTable`, `renderRepositoriesPage`,
`findAmbiguities` (Task 14); `RepositoryRouteDeps`,
`registerRepositoryRoutes`, `applyRepositoryEdits` (Task 15).

**Two known reconciliations the implementer must make**, called out rather than
guessed at, because they depend on code shapes best read at implementation time:

1. The test harnesses in Tasks 8, 10, 13, and 16 are written against the seams
   those modules expose, but each says to read the existing sibling test file
   first and prefer its established helpers. Do that — do not add a parallel set.
2. Task 16 notes an ordering hazard: `repositoryRegistry` is assigned inside
   `RouterServer`'s containers block, and the setup routes may be registered
   before it. Read `RouterServer.start()` in full and place the registry
   construction above the setup-route registration.

**Behaviour changes to watch for in existing suites:**

- Task 3 makes project matching case-insensitive. A pre-existing test asserting
  that a differing case does *not* match must be updated — that is the intended
  change, not a regression.
- Task 11 removes `repositories` from `ContainerRoutingDeps.containersConfig`.
  Every construction site in `ContainerTargets.test.ts` and
  `containers-e2e.test.ts` needs the new `registry` dep.
- Task 17 rewrites the `<repository_routing_context>` prompt. Per the repo's
  testing rule, `prompt-assembly.routing-context.test.ts` asserts the entire
  prompt and must be updated in the same commit.
