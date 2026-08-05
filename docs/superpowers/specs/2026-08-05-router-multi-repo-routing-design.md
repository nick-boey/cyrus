# Multi-repository routing for router mode (ACA)

**Date:** 2026-08-05
**Status:** Design approved, pending implementation plan
**Scope:** `cyrus-core`, `cyrus-router`, `cyrus-router-protocol`, `cyrus-router-client`, `cyrus-edge-worker`, `apps/cli`

## Problem

Router mode supports exactly one *useful* repository per deployment. Registering
more than one is possible but does not do what an operator expects:

1. `containers.repositories` in `router-config.json` carries only
   `{name, githubSlug, linearWorkspaceId, baseBranch?}`
   (`packages/router/src/RouterServer.ts:105`). There is nowhere to record which
   Linear team or project a repository serves.
2. That array is JSON-stringified wholesale into `CYRUS_REPOS_JSON`
   (`packages/router/src/ContainerTargets.ts:485`), so **every sandbox clones
   every registered repository**, regardless of which one the issue concerns.
3. `ContainerBootCommand.buildRepositoryConfig`
   (`apps/cli/src/commands/ContainerBootCommand.ts:674`) writes repositories with
   no `teamKeys` / `projectKeys` / `routingLabels`. Inside the sandbox, every
   repository therefore qualifies as the catch-all
   (`packages/edge-worker/src/RepositoryRouter.ts:318`) and `RepositoryRouter`
   always selects **the first one**. A `[repo=…]` description tag is the only
   escape hatch — which is why routing currently has to be configured per issue.
4. Project-based routing cannot work in router mode at all, even with metadata
   plumbed through: `RouterIssueTrackerService`'s `project` getter is hardcoded
   to `undefined` because no `fetchProject` RPC exists
   (`packages/router-client/src/RouterIssueTrackerService.ts:237`).
5. There is no explicit "default repository". The catch-all is implicit and
   fragile — *the first repository that happens to have no routing config* —
   so adding routing metadata to every repository silently turns the catch-all
   off and pushes every unmatched issue into a selection elicitation.
6. `containers.repositories` reaches the router as the
   `CYRUS_ROUTER_CONTAINERS_JSON` environment variable
   (`docker/router/entrypoint.mjs:169`), so registering a repository requires an
   `az containerapp update` and a revision restart.

## Goals

- Register many repositories against the router's Linear workspace.
- Nominate one as the default, used whenever nothing more specific matches.
- Associate repositories with Linear project and team **names**, so routing is
  configured once per repository instead of once per issue.
- Manage all of the above from the router's `/setup` UI.
- Clone only the repository an issue actually needs.

## Non-goals

- Switching repositories mid-issue. `packages/CLAUDE.md` already states a
  repository is chosen once per issue; the sandbox is per-issue and cloned at
  boot, so this design enforces that more strictly rather than relaxing it.
- Per-user repository registries. The registry is global to the router.
- Replacing `[repo=…]` description tags. They remain the highest-priority
  routing method and continue to support multiple repositories and
  `#branch` overrides.

## Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Registry storage | Global, Azure Table | Durable across ACA restarts; the table, ETag conflict handling, and auth are already built for per-user secrets. |
| Routing location | Router pre-selects; sandbox clones what it is told | The router already holds the Linear token, so it can resolve team and project without a new RPC. One clone per sandbox instead of N. |
| Team vs project precedence | Project beats team | Matches the existing `RepositoryRouter` order (project is priority 3, team is priority 4). A project is the more specific signal. |
| When to elicit | Only on a true tie within a tier, or no match with no default | Precedence handles the common cases silently; the user is asked only when the registry genuinely cannot decide. |
| Association syntax | `p=`/`t=` repeatable keys, case-insensitive whole-name match | Parses directly into the existing `projectKeys[]` / `teamKeys[]` arrays. |
| Registry edit rights | Any registered setup user; every mutation logged | Matches the current trust model — a registered user already holds credentials and boots containers. |
| `fetchProject` RPC | In scope | Avoids a split where `p=` works for ACA users and silently never fires for physical-device users. |

## Architecture

### 1. Shared routing core (`cyrus-core`)

The matching rules move out of `RepositoryRouter` into a pure function so the
router and the edge worker cannot drift apart. Fact-gathering stays with each
caller — the router reads facts from one Linear `fetchIssue`, the edge worker
from its existing async lookups.

```ts
// packages/core/src/routing/matchRepositories.ts

export interface IssueFacts {
  teamKey?: string;
  projectName?: string;
  labels: string[];
  description?: string;
}

export type RoutingMethod =
  | "description-tag" | "label-based" | "project-based"
  | "team-based" | "default";

export type MatchResult =
  | {
      kind: "matched";
      repositories: RepositoryConfig[];
      method: RoutingMethod;
      baseBranchOverrides?: Map<string, string>;
    }
  | { kind: "ambiguous"; candidates: RepositoryConfig[]; tier: "project" | "team" }
  | { kind: "unmatched" };

export function matchRepositories(
  facts: IssueFacts,
  repositories: RepositoryConfig[],
): MatchResult;
```

Priority order, highest first:

1. **description tag** — `[repo=name]`, `[repo=name#branch]`, `repo=a,b#branch`,
   `repos=a,b`. Unchanged semantics, including multi-repository selection and
   per-repository base-branch overrides.
2. **routing labels**
3. **project name** — case-insensitive whole-name match against `projectKeys`
4. **team key** — case-insensitive whole-name match against `teamKeys`
5. **default** — the single repository with `isDefault: true`

Two or more repositories matching within the *same* tier returns `ambiguous`.
Matching across *different* tiers is not ambiguous — the higher tier wins.

Schema change to `RepositoryConfigSchema`
(`packages/core/src/config-schemas.ts:272`):

```ts
/** Selected when no higher-priority routing method matches. At most one per workspace. */
isDefault: z.boolean().optional(),
```

`teamKeys`, `routingLabels`, and `projectKeys` already exist and are unchanged.

`RepositoryRouter` is refactored to delegate to `matchRepositories`, retaining
its own responsibilities: fetching facts, the issue→repository cache, the
existing elicitation flow, and the Priority 0 active-session check. Device mode
consequently gains `isDefault` and case-insensitive project/team matching. The
implicit catch-all (`RepositoryRouter.ts:318`) is retained as a **deprecated
fallback below `isDefault`**, so an existing self-hosted `config.json` that
relies on it keeps working.

#### Association string parser

Also in `cyrus-core`, used by the setup UI and available to any future CLI:

```ts
export function parseAssociations(input: string): {
  projectKeys: string[];
  teamKeys: string[];
};
export function formatAssociations(input: {
  projectKeys?: string[];
  teamKeys?: string[];
}): string;
```

Grammar: comma-separated `key=value` pairs. `p` and `t` are the only keys and
both are repeatable. Values may be double-quoted to contain commas or leading
and trailing whitespace. Unquoted values are trimmed. An unknown key, an empty
value, or an unterminated quote is a parse error whose message is surfaced
verbatim to the user.

```
p=Platform,p=Billing,t=NOR   → { projectKeys: ["Platform","Billing"], teamKeys: ["NOR"] }
p="Q3 Migration",t=ENG       → { projectKeys: ["Q3 Migration"],       teamKeys: ["ENG"] }
```

`formatAssociations(parseAssociations(s))` must round-trip so the UI can render
a stored entry back into an editable string.

### 2. Registry storage

```ts
// packages/router/src/RepositoryRegistry.ts

export interface RegisteredRepository {
  name: string;
  githubSlug: string;
  linearWorkspaceId: string;
  baseBranch?: string;
  teamKeys?: string[];
  projectKeys?: string[];
  routingLabels?: string[];
  isDefault?: boolean;
}

export interface RepositoryRegistry {
  list(): Promise<{ repositories: RegisteredRepository[]; version?: string }>;
  /** Conditional write. Throws SetupConflictError when `version` is stale. */
  put(repositories: RegisteredRepository[], version?: string): Promise<{ version: string }>;
}
```

Two backends, selected the same way `SecretStoreBackend` already chooses between
Table, Key Vault, and file:

- **`TableRepositoryRegistry`** — one global entity in the existing `cyrussetup`
  table. Partition key `g` + 64 zeros, fixed row key. The `g` prefix cannot
  collide with the `u` + sha256 user partition keys minted by
  `setupPartitionKey` (`packages/router/src/TableSecretStore.ts:54`). Stored as
  **plaintext JSON**, not envelope-encrypted: repository names and `org/repo`
  slugs are not secrets, and skipping the KEK means the registry works without
  the *Key Vault Crypto User* role. It reuses `azureRequest` from
  `setup/envelope.ts` and the same ETag conditional-write path, so the UI
  inherits the existing 409-on-concurrent-edit behaviour.
- **`FileRepositoryRegistry`** — `<dirname(dbPath)>/repositories.json`, mode
  0600, atomic tmp+rename. For local and Docker development, mirroring how
  `secretsPath` already defaults.

Selection: `containers.tableStore` present → Table backend; otherwise file.

**Seeding.** On the first start where the registry is empty,
`containers.repositories` from `router-config.json` is written into it verbatim
and a log line records that the store is now authoritative. Subsequent starts do
not re-read the config array. Seed-once rather than merge: a merge would let a
redeploy silently overwrite edits made in the UI.

**Live reads.** `ContainerTargetService` currently receives `repositories` as a
frozen array (`packages/router/src/RouterServer.ts:773`). That field becomes a
`getRepositories(): Promise<RegisteredRepository[]>` seam so a UI edit takes
effect on the next container boot without restarting the router.

### 3. Router-side resolution and elicitation

Insertion point: `EventRouter.routeCreated`
(`packages/router/src/EventRouter.ts:633`), gated on `target.kind === "container"`,
placed before `deliverOrNotify` triggers `boot()`
(`EventRouter.ts:1079`).

```
routeCreated (container target)
  │
  ├─ issue_repositories row exists for this issueKey?
  │     └─ yes → deliver and boot exactly as today (no Linear call, no re-ask)
  │
  ├─ fetchIssue(issueId)     one Linear call: description, project, team, labels
  ├─ matchRepositories(facts, await registry.list())
  │     ├─ matched   → persist decision → deliver → boot
  │     ├─ ambiguous → elicit over the tied candidates
  │     └─ unmatched → default present ? persist + deliver : elicit over all
  │
  └─ elicit:
        postActivity(signal: Select, signalMetadata: { options })
        persist pending_repo_selections (options + the held `created` webhook)
        return — no device row is created, no container is booted
```

Nothing runs while the user decides. This is strictly better than the device-mode
equivalent, which boots first and then parks
(`RepositoryRouter.elicitUserRepositorySelection`, `RepositoryRouter.ts:622`).

Answering flow, intercepted in `routePrompted` **before** target resolution:

- **Body matches an offered option** → persist that decision, replay the held
  `created` webhook, `ensureDevice`, boot. The answering prompt itself is
  consumed, not forwarded — the runner initialises from the delegation, matching
  the semantics documented in `packages/CLAUDE.md`.
- **Body does not match** → the user ignored the elicitation. Fall back to the
  default repository (or the first registered repository if none is marked
  default), then deliver **both** the held `created` webhook and the prompt.

`LinearExecutor.postActivity` (`packages/router/src/LinearExecutor.ts:169`)
currently hardcodes an `AgentActivityContentType.Thought`. It gains optional
`content`, `signal`, and `signalMetadata` parameters. `createAgentActivity`
already accepts them — this is the same call `RepositoryRouter` makes today.

#### New RouterStore tables

```sql
CREATE TABLE issue_repositories (
  issue_key      TEXT PRIMARY KEY,
  repos_json     TEXT NOT NULL,   -- resolved names + baseBranch overrides
  method         TEXT NOT NULL,   -- RoutingMethod, for the timeline activity
  decided_ms     INTEGER NOT NULL
);

CREATE TABLE pending_repo_selections (
  agent_session_id TEXT PRIMARY KEY,
  issue_key        TEXT NOT NULL,
  workspace_id     TEXT NOT NULL,
  options_json     TEXT NOT NULL,
  created_event    TEXT NOT NULL,  -- the held webhook, replayed on answer
  created_ms       INTEGER NOT NULL
);
```

`ContainerTargets.buildEnv` (`ContainerTargets.ts:459`) reads
`issue_repositories` and emits `CYRUS_REPOS_JSON` containing **only** the chosen
repositories. The decision therefore survives a container destroy and recreate,
so a rebuilt sandbox clones the same repository.

`pending_repo_selections` rows are swept on the same tick as the existing expiry
sweep, using `eventTtlMs` as their lifetime.

#### Degradation when SQLite is lost between blob backups

SQLite is on ephemeral local storage with periodic Blob backup (`CLAUDE.md` §12),
so both tables can be lost on an unlucky restart:

- A missing `issue_repositories` row is **re-resolved deterministically** from
  the registry on the next boot. Same inputs, same answer; it re-elicits only if
  the original case was genuinely ambiguous.
- A missing `pending_repo_selections` row means the user's answer arrives as an
  ordinary prompt with no held event to replay. It routes to the default
  repository — the same outcome as ignoring the elicitation.

Neither case loses work or routes silently to a wrong repository.

### 4. Container changes

`CYRUS_REPOS_JSON` carries the routing metadata the router used, so the
sandbox's own `RepositoryRouter` agrees with the router's decision instead of
falling back to catch-all.

- `RepoSpecSchema` (`ContainerBootCommand.ts:66`) gains `teamKeys?`,
  `projectKeys?`, `routingLabels?`, `isDefault?`.
- `buildRepositoryConfig` (`ContainerBootCommand.ts:674`) passes them into the
  `RepositoryConfig` it writes.
- `cloneRepos` (`ContainerBootCommand.ts:586`) is **unchanged**. It already
  clones exactly what it is handed; the saving comes entirely from the shorter
  list.

`workspaceBaseDir`, worktree paths, the floor bundle, and
`canonicalizeRestoredWorkspaces` are untouched.

### 5. `fetchProject` RPC

Router-side pre-selection covers container targets only. Router-mode users on a
**physical device** still route inside their own EdgeWorker, where
`RouterIssueTrackerService.project` returns `undefined`. Without this, `p=`
associations would work for ACA users and silently never fire for device users.

Four additive edits:

1. `packages/router-protocol/src/rpc-methods.ts` — add `"fetchProject"` to
   `RPC_METHODS`.
2. `packages/core/src/issue-tracker/IIssueTrackerService.ts` — declare
   `fetchProject(id: string): Promise<Project>`.
3. `LinearIssueTrackerService` — implement it against the Linear SDK.
4. `packages/router-client/src/RouterIssueTrackerService.ts:237` — implement the
   `project` getter over `projectId` + the new RPC, replacing the hardcoded
   `undefined`.

No behaviour change for anyone not using project routing. Reflective dispatch in
`LinearExecutor` picks the method up automatically once it is on the interface
and the allowlist.

### 6. Setup UI

A new `/setup/repositories` page plus a nav link from the existing variables
page. It reuses the existing machinery verbatim: `requireMutation`'s
principal → CSRF → registration → fields ordering
(`packages/router/src/setup/routes.ts:421`), the render-time version token for
conflict detection (`routes.ts:195`), the htmx fragment swap, and the
`renderPage` CSP/nonce structure (`packages/router/src/setup/views.ts:221`).

| Name | GitHub slug | Base branch | Associations | Default | |
| --- | --- | --- | --- | --- | --- |
| `cyrus-api` | `ceedaragents/cyrus-api` | `main` | `p=Platform,t=NOR` | ● | Delete |
| `cyrus-web` | `ceedaragents/cyrus-web` | `main` | `t=WEB` | ○ | Delete |

Routes, mirroring the variables page one-for-one:

| Route | Purpose |
| --- | --- |
| `GET /setup/repositories` | Full page. Read-only, like `GET /setup`. |
| `GET /setup/repositories/table` | Fragment, for an explicit refresh. |
| `POST /setup/repositories` | Add one repository. |
| `POST /setup/repositories/save` | Bulk save under the version token. |
| `DELETE /setup/repositories/:name` | Remove one repository. |

The delete control carries its CSRF token as a **request header** with
`hx-params="none"`, per the R2-03 note in `views.ts:82`. htmx appends collected
parameters to the URL for DELETE, and the routes layer refuses a query-string
token by design — getting this wrong both leaks an 8-hour token into access logs
and 403s every click.

Validation:

- **`name`** — `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Load-bearing: it becomes
  `$WORKSPACES/repos/<name>` inside the sandbox and the `RepositoryConfig.id`,
  so it needs the same class of gate `ISSUE_KEY_RE` applies at
  `ContainerTargets.ts:19`. Unique, case-insensitively.
- **`githubSlug`** — `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$`.
- **`baseBranch`** — defaults to `main`.
- **Associations** — parsed by `parseAssociations`; parse errors surface
  verbatim, the way `normalizeSecretKey`'s messages already do.
- **`linearWorkspaceId`** — auto-filled and hidden when the router serves
  exactly one workspace (the common case, since the Linear token binds it); a
  `<select>` otherwise.
- **`isDefault`** — a radio group, so setting one clears the others inside the
  same conditional write.

A warning banner renders when two entries claim the same project or the same
team, surfacing at configuration time the ambiguity that would otherwise only
appear as a mid-issue elicitation.

**Authorization.** Any registered setup user may edit; `requireMutation`'s
existing registration check is sufficient and no new role is introduced. Every
add, edit, and delete is logged with the acting principal's email.

## Rollout and compatibility

- **Single-repository deployments are unaffected.** The registry seeds from
  `containers.repositories`; one repository in, one repository out, identical
  behaviour.
- **Multi-repository deployments change behaviour.** Today the sandbox always
  selects the first repository and clones them all. Afterwards it routes
  properly and clones one. This is the intended fix, and is called out in
  `CHANGELOG.md`.
- **Self-hosted device mode is unaffected** unless `isDefault` is adopted. The
  implicit catch-all remains as a deprecated fallback beneath it.
- `CYRUS_ROUTER_CONTAINERS_JSON` remains the seed source. After seeding it is
  inert; the router logs this on every start so an operator editing the
  environment variable and seeing no effect has an explanation in the log.

## Documentation

- `docs/ROUTER.md:312` — the `containers` example, plus a new section on the
  registry, the association syntax, and the default repository.
- `CLAUDE.md` §12 — three new router invariants: repository selection happens on
  the router for container targets; the registry is authoritative after seeding;
  the `g`-prefixed Table partition key is reserved.
- `packages/edge-worker/src/PromptBuilder.ts` — the
  `<repository_routing_context>` block must describe `isDefault` and the
  project/team associations, per the self-describing-prompts rule in `CLAUDE.md`
  §8. `SlackChatAdapter.ts` and `ActivityPoster.ts` need the same treatment.

## Testing

| Package | Coverage |
| --- | --- |
| `cyrus-core` | Table-driven `matchRepositories` cases: each tier, ties within a tier, cross-tier precedence, default, no-match. `parseAssociations` / `formatAssociations` round-trip, quoting, and error messages. |
| `cyrus-router` | Elicitation flow end to end (created → elicit → prompted → boot); `buildEnv` emitting per-issue repositories; registry ETag conflict; registry seeding is once-only; setup route CSRF, version-token, and validation paths. |
| `cyrus-router-client` | `project` getter resolving over the new `fetchProject` RPC. |
| `cyrus-edge-worker` | `RepositoryRouter` still satisfies its existing suite after delegating to `matchRepositories`; `isDefault` beats the deprecated catch-all. |
| `apps/cli` | `ContainerBootCommand` maps the new `RepoSpec` fields into `RepositoryConfig`. |

An **F1 test drive** covers the end-to-end validation stage per the `CLAUDE.md`
mandate: a `t=` hit, a `p=` hit, the default fallback, and an ambiguity
elicitation answered from Linear.
