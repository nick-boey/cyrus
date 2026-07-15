# Per-User Container Secrets: Generic Env Passthrough + Auth Gate + Container Linear MCP

**Date:** 2026-07-15
**Status:** Design (approved in brainstorming; pending spec review)

## Goal

Let each router user supply an arbitrary set of environment variables that flow
into the containers spun up for their issues, so **any** tool that authenticates
via env vars (Codex CLI, extra MCP servers, cloud CLIs, etc.) works without code
changes. Define a configurable **minimum required set** of credentials that makes
a user "fully authenticated"; a user missing any required credential is blocked
from booting a container. As the first concrete payoff, wire the **full Linear
MCP inside the container's Claude session** (autonomous issue read/edit) from a
per-user Linear token. Also document the supported way to add tools to the worker
image.

## Background — current state

- **Per-user secrets** live in `SecretStore` (`packages/router/src/SecretStore.ts`)
  as a **fixed schema** (`USER_SECRET_KEYS = claudeOauthToken, githubPat,
  gitUserName, gitUserEmail, dotfilesRepo`), a 0600 JSON file keyed by lowercased
  email.
- **`ContainerTargets.buildEnv`** (`packages/router/src/ContainerTargets.ts:307`)
  maps those named keys to container env vars (`claudeOauthToken →
  CLAUDE_CODE_OAUTH_TOKEN`, `githubPat → GIT_TOKEN`, `gitUserName →
  GIT_USER_NAME`, `gitUserEmail → GIT_USER_EMAIL`, `dotfilesRepo → DOTFILES_REPO`)
  and **throws** if `claudeOauthToken` is absent (the only current hard
  requirement). The provider (`LocalDockerProvider.ensureRunning`) passes every
  `ctx.env` entry to `docker run` as `-e KEY=value`.
- **Linear** has two paths: (a) the router-proxied `cyrus-tools` issue interface
  (`RouterIssueTrackerService`) — works in containers today; and (b) the **official
  hosted Linear MCP** (`https://mcp.linear.app/mcp` + `Authorization: Bearer
  <linearToken>`, `McpConfigService.ts:137`), wired only when a workspace Linear
  token is available locally via `getLinearTokenForWorkspace`. In router/container
  mode that returns `null`, so **the container gets no Linear MCP** (the F1 drive
  confirmed only `cyrus-tools` + `cyrus-docs`). On a developer machine the Linear
  MCP authenticates via **interactive OAuth** (`~/.claude/plugins/.../linear/.mcp.json`
  is `{type:http, url:https://mcp.linear.app/mcp}` with no token; the token lives
  in Claude Code's credential store) — a flow a headless container cannot perform.

## Design decisions (from brainstorming)

1. **Pure-generic secret model with migration** — one per-user map keyed by the
   real env-var name; the 5 existing named keys migrate to their env-var names.
2. **Block boot** when a user is missing any required credential (generalizes the
   current Claude-token hard-fail).
3. **One spec** covering the generic passthrough, the auth gate, the container
   Linear MCP, the operator UX, and the tool-adding docs.
4. **Linear MCP in the container uses a static per-user token** (a Linear
   **Personal API Key**, or a pre-obtained OAuth access token) passed as
   `LINEAR_API_TOKEN` — the container cannot do interactive OAuth, and the hosted
   MCP already accepts a static Bearer.

## Components

### 1. SecretStore → generic env map (`packages/router/src/SecretStore.ts`)

- `UserSecretBundle` becomes `Record<string, string>` (env-var name → value).
  Remove `USER_SECRET_KEYS` / the fixed interface; `get`/`set`/`unset` operate on
  arbitrary string keys.
- **Migration:** on every read, a bundle containing any legacy key
  (`claudeOauthToken`, `githubPat`, `gitUserName`, `gitUserEmail`, `dotfilesRepo`)
  is transparently mapped to its env-var name
  (`CLAUDE_CODE_OAUTH_TOKEN`, `GIT_TOKEN`, `GIT_USER_NAME`, `GIT_USER_EMAIL`,
  `DOTFILES_REPO`); the file is rewritten in the new format on the next `set`.
  If both a legacy key and its new env-var name are present, the new key wins and
  the legacy key is dropped.
- `set` **rejects reserved keys** (see Reserved keys) with a clear error.

### 2. buildEnv — spread minus reserved (`packages/router/src/ContainerTargets.ts`)

- Build the router-controlled base (`CYRUS_ROUTER_URL`, `CYRUS_ISSUE_KEY`,
  `CYRUS_REPOS_JSON`; `CYRUS_DEVICE_TOKEN` is still minted by the provider), then
  **spread the user's map, skipping any reserved key** (skip-with-warning at boot,
  belt-and-braces even though `set` already rejects them).
- Replace the `claudeOauthToken`-only check with the generic **required-set gate**
  (Component 3).

### 3. "Fully authenticated" gate

- New optional field on `RouterContainersConfig`
  (`packages/router/src/RouterServer.ts`): `requiredSecretKeys?: string[]`,
  **default `["CLAUDE_CODE_OAUTH_TOKEN"]`** (preserves today's behavior).
  Operators set e.g. `["CLAUDE_CODE_OAUTH_TOKEN", "GIT_TOKEN", "LINEAR_API_TOKEN"]`.
- `buildEnv` throws if the user's map is missing **any** required key, naming all
  missing keys in one message. The existing `bootInner` catch posts a
  boot-failed activity to Linear (unchanged path), so the user sees exactly which
  credentials to add.
- Expose `isFullyAuthenticated(email): { ok: boolean; missing: string[] }` (on
  `SecretStore` or a thin helper) for operator visibility and future UI.

### 4. Container Linear MCP (`apps/cli/src/commands/ContainerBootCommand.ts` only)

No `McpConfigService`/`getLinearTokenForWorkspace` change is needed — the
container reuses the existing device-mode Linear MCP wiring. In `writeConfig`, if
`process.env.LINEAR_API_TOKEN` is set, populate
`linearWorkspaces[<repo.linearWorkspaceId>] = { linearToken: <that token> }` for
each configured repo's workspace. `getLinearTokenForWorkspace` then returns it and
`McpConfigService` wires `https://mcp.linear.app/mcp` (`Bearer <token>`)
automatically — the same code path device mode already uses. `LINEAR_API_TOKEN`
is an ordinary passthrough env (also visible to any other tool that wants it); the
only special-casing is `writeConfig` reading it to populate `linearWorkspaces`.

### 5. Operator UX

- `cyrus router secrets set <email> <ENV_VAR_NAME> <value>` — key is now the raw
  env-var name; `unset <email> <ENV_VAR_NAME>` unchanged in shape. Reserved keys
  are rejected here.
- New `cyrus router secrets list <email>` — prints the set keys (values masked)
  and, given `requiredSecretKeys`, which required keys are missing (the
  fully-authenticated view).
- F1 `router:seed-user` keeps `--claude-token` as a shortcut (maps to
  `CLAUDE_CODE_OAUTH_TOKEN`) and gains repeatable `--env KEY=VALUE`.

### 6. Docs — "Adding tools to the worker container"

A new doc (co-located with the worker image, e.g. `docker/worker/README.md` or a
`docs/` page) covering, in order of preference:

- **Overlay image (recommended):** a Dockerfile *outside* the cyrus repo,
  `FROM <published cyrus-worker tag>` + `USER root; RUN <install tools>; USER
  cyrus`; build it, point `containers.image` in router config at the new tag,
  restart the router. No app rebuild; only your layers rebuild. Codex-CLI example
  included.
- **`cyrus-setup.sh`** (repo-local, non-privileged, runs per worktree at boot) and
  **`dotfilesRepo`** (per-user `install.sh` at boot) as the runtime alternatives,
  with their trade-offs (re-runs every boot, no sudo).
- **Per-user tool credentials:** use `cyrus router secrets set <email>
  <ENV_VAR> <value>`; the value appears verbatim in the container env. Linear
  Personal API Key example (`LINEAR_API_TOKEN`) with a note that interactive
  OAuth is not possible in a container.

## Reserved keys (never user-overridable)

`CYRUS_ROUTER_URL`, `CYRUS_DEVICE_TOKEN`, `CYRUS_ISSUE_KEY`, `CYRUS_REPOS_JSON`
(router identity/routing — overriding these hijacks or breaks routing), plus
`PATH` and `HOME` (overriding breaks the container runtime). Rejected at
`secrets set` and skipped-with-warning in `buildEnv`. The list lives in one
exported constant shared by both call sites.

## Data flow

```
operator: cyrus router secrets set alice@x.com LINEAR_API_TOKEN lin_api_...
          → SecretStore (0600 JSON, key = env-var name)

route issue → ContainerTargets.bootInner
            → buildEnv(userId): base router vars + spread(user map − reserved)
              → throws if any requiredSecretKeys missing → boot-failed activity
            → LocalDockerProvider.ensureRunning → docker run -e KEY=value …

inside container → ContainerBootCommand.writeConfig
                 → if LINEAR_API_TOKEN present: linearWorkspaces[wsId].linearToken
                 → EdgeWorker.getLinearTokenForWorkspace → McpConfigService
                   → Linear MCP (https://mcp.linear.app/mcp, Bearer <token>)
```

## Error handling

- Missing required key → `buildEnv` throws `"<email> is not fully authenticated
  for containers: missing <KEY1>, <KEY2>. Set them with: cyrus router secrets set
  <email> <KEY> <value>"`; caught by `bootInner`, posted as a boot-failed activity.
- Reserved key at `secrets set` → CLI error naming the key and the reserved set.
- Legacy secrets file → migrated transparently; a parse/read error still throws
  (never silently reset — preserves the existing SecretStore safety invariant).

## Testing

- SecretStore: generic get/set/unset; legacy-key migration (each of the 5);
  reserved-key rejection; the existing "corrupt file throws, never resets"
  invariant still holds.
- buildEnv: spread of arbitrary keys; reserved keys skipped; required-set gate
  blocks with all missing keys named; default required set = `[CLAUDE_CODE_OAUTH_TOKEN]`.
- CLI: `secrets set/unset/list` (incl. reserved rejection and the
  missing-required view); registration smoke (the repo's known
  defined-but-unregistered failure class).
- ContainerBootCommand.writeConfig: `LINEAR_API_TOKEN` present → `linearWorkspaces`
  populated and validates against `EdgeConfigSchema`; absent → unchanged.
- Optional integration: the existing real-Docker e2e / F1 drive shows the Linear
  MCP appearing in `mcpServerNames` when `LINEAR_API_TOKEN` is seeded (manual, opt-in).

## Out of scope

- Router-builds-containers-from-a-Dockerfile (explicitly declined; overlay-image
  pattern covers the need).
- Interactive OAuth for the Linear (or any) MCP inside a container — static tokens
  only.
- Per-repo image selection; changing the router-proxied `cyrus-tools` path.

## Verify-at-implementation

- Exact `EdgeConfig.linearWorkspaces` field/shape in
  `packages/core/src/config-schemas.ts` (a `linearToken` per workspace exists;
  confirm the map key and required fields) so `writeConfig` produces a config that
  passes `EdgeConfigSchema.parse`.
- Whether `RouterServerConfig` needs the `requiredSecretKeys` field threaded through
  any config load/merge whitelist (cf. the ConfigManager whitelist gotcha in the
  root `CLAUDE.md`) — for the router this is `RouterContainersConfig`, verify it is
  read straight from config.
- Standardize the Linear env-var name as `LINEAR_API_TOKEN` (matches the
  claude-runner test-script convention); document it.
