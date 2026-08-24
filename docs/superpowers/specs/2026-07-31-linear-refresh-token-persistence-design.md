# Durable Linear OAuth Refresh Token Persistence + Re-Authorization Signal

**Date:** 2026-07-31
**Status:** Design (approved in brainstorming; pending spec review)

## Goal

Make the router's Linear OAuth refresh token survive restarts, and make a dead
credential loudly visible instead of silently degrading. Today an Azure Container
Apps router loses the rotated refresh token on every revision deploy and then
fails every Linear read and write for up to 24h with nothing but a repeating
stack trace to show for it.

## Background — the observed failure

Diagnosed on the `<subscription>` / `<resource-group>` deployment on 2026-07-30:

- Linear access tokens expire in **24 hours**, and Linear **rotates the refresh
  token on every use** — the old one dies immediately (30-minute replay grace for
  a lost response). Source: <https://linear.app/developers/oauth-2-0-authentication>.
- `RouterCommand.persistRefreshedTokens` writes the rotated pair to
  `/data/router-config.json`.
- `/data` is **ephemeral per ACA revision**. Both revision starts logged
  `Restored router state from …`, which only happens when the file is absent.
- `docker/router/entrypoint.mjs` then **regenerates** `router-config.json` from
  environment variables on every start — `docs/ROUTER.md:229` states plainly that
  "env is the source of truth".

The result is a two-restart fuse. Restart 1 loads an unused `RT0` from env and
refreshes fine to `RT1` (written only to ephemeral disk). Restart 2 reloads the
now-consumed `RT0` from env and gets `400 invalid_grant` forever. Observed
exactly: revision `0000010` started 02:16:45, first `400` at 03:04:01, then 12
consecutive failures and zero successes.

The blast radius is larger than it looks. Workers never call Linear directly —
`RouterIssueTrackerService` proxies **every** operation, including
`createAgentActivity`, over RPC to the router. A dead router token means no
worker can post anything at all.

### Why the existing code did not save us

`RouterServerConfig.onTokenRefresh` already exists as the designated seam, and
its doc comment already names this bug:

> Linear rotates the refresh token on every refresh, so failing to persist this
> leaves the *old* refresh token on disk — still usable today, but a restart
> replays a stale pair.

The hook was correct. Its only sink was a file on ephemeral storage.

## Non-goals

- Fixing the separate event-sequence regression found in the same investigation
  (router SQLite restores from a ≤5-min-stale blob, so `devices.next_seq` can
  fall below a device's persisted `lastAckedSeq`, after which every event is
  silently dropped as a duplicate). Tracked separately.
- Automating OAuth acquisition. Authorization-code flow requires one human
  consent click; `cyrus self-auth-linear` already covers it.
- Moving the router's SQLite off ephemeral storage.

## Design

### 1. Storage shape

One Key Vault secret per workspace, named `cyrus-linear-refresh-<workspaceId>`,
holding a JSON envelope rather than a bare token:

```json
{
  "refreshToken": "...",
  "accessToken": "...",
  "seedRefreshToken": "...",
  "updatedMs": 1785457484664
}
```

`seedRefreshToken` records the config/env value that started the current rotation
chain. Without it there is a sharp footgun: an operator re-runs
`self-auth-linear`, updates `linear-workspaces-json`, redeploys — and the router
keeps preferring the dead Key Vault token and stays broken.

### 2. Startup resolution

| Key Vault secret | `seedRefreshToken` vs config value | Tokens used |
| --- | --- | --- |
| absent | — | config/env values; the config refresh token is recorded as the seed on first write |
| present | **equal** | `KV.refreshToken` **and** `KV.accessToken` (authoritative; chain continues) |
| present | **differs** | config/env values (operator seeded fresh; chain resets, envelope overwritten on next refresh) |

Both tokens resolve together under the same rule — the envelope is treated as one
unit, never merged field-by-field with the config. Restoring `accessToken`
alongside the refresh token avoids a needless refresh on every boot.

Re-authorization therefore needs no CLI dance and no
`az keyvault secret delete`: update the existing secret, redeploy.

A Key Vault **read** failure at startup falls back to the config value rather
than refusing to boot. A router that starts with a possibly-stale token is
strictly better than one that will not start.

### 3. Components

- **New** `packages/router/src/KeyVaultTokenStore.ts` (~80 lines):
  `get(workspaceId)` / `set(workspaceId, envelope)`. Reuses the exported
  `createKeyVaultTokenProvider()` and the same Key Vault REST 7.4 request shape
  as `KeyVaultSecretStore`. It deliberately does **not** extend that class —
  `KeyVaultSecretStore` is modelled on per-user bundles (email-hashed secret
  names, `email`/`key` tags, tombstones, `UserSecretBundle`), none of which fits
  a per-workspace token envelope.
- **`apps/cli/src/commands/RouterCommand.ts`**: resolve tokens per §2 before
  constructing `RouterServer`; extend `persistRefreshedTokens` with a Key Vault
  write alongside the existing file write.
- **Config surface**: optional `linearTokenStore: { keyVaultUrl: string }` in
  `RouterConfigFileSchema`, plus `CYRUS_ROUTER_LINEAR_TOKEN_STORE_KEY_VAULT_URL`
  handled by `docker/router/entrypoint.mjs`.

`containers.keyVaultUrl` is intentionally **not** reused: it is scoped to
per-user container secrets, and a router with no container executor should still
be able to persist its own tokens.

### 4. The file write stays

Key Vault becomes authoritative, but `/data/router-config.json` keeps its write
as a local cache. It costs nothing and keeps self-host and docker-compose
deployments — which have no Key Vault — working exactly as they do today. The
Key Vault path is entirely opt-in on config presence.

### 5. Terminal-state signal

`executeTokenRefresh` currently throws a flat `Error("Token refresh failed: 400")`
for every failure mode. It gains a distinction:

- **Terminal** — HTTP 400/401 from the token endpoint. Throws a new
  `LinearRefreshTokenRejectedError` (exported from
  `packages/linear-event-transport`, alongside `LinearIssueTrackerService`)
  carrying status and response body.
- **Transient** — 5xx, network, timeout. Unchanged; keeps retrying.

Linear's 30-minute replay grace does not argue for retrying a 400. `RT(n+1)` is
persisted only on success, so a retry already *is* the replay of `RT(n)`; a 400
means the token is genuinely dead rather than raced.

A static `rejectedWorkspaces` map sits beside the existing
`workspaceRefreshTokens`. Once a workspace is marked, further refresh attempts
short-circuit **without an HTTP call**, which alone collapses the observed
12-per-burst stack-trace spam to a single line. The flag clears when a
*different* refresh token is registered for that workspace, so a redeploy with a
fresh seed recovers with no extra step.

Logged once, at ERROR:

```
Linear refused the refresh token for workspace <id> (HTTP <status>: <body>).
This is terminal — Linear rotates refresh tokens on use, so a consumed or revoked
token cannot recover. Cyrus can neither read nor write Linear for this workspace
until re-authorized, and all worker activity posting will fail silently.
Remedy: re-run `cyrus self-auth-linear`, update Key Vault secret
`cyrus-linear-refresh-<workspaceId>` (or router-config.json), restart the router.
If this appeared immediately after a credential change, check LINEAR_CLIENT_ID /
LINEAR_CLIENT_SECRET match the app that issued the token.
Suppressing further refresh attempts for this workspace.
```

### 6. Inspection surface

New `cyrus router linear status`, matching the existing
`users` / `devices` / `sessions` / `containers` / `secrets` subcommand pattern.
Per workspace: id, token source (`keyvault` or `config`), last refresh time, and
status (`ok`, or `rejected` with code and timestamp). Last refresh time is the
envelope's `updatedMs`; it renders as `—` when the source is `config`, since a
file-only deployment has no such record. The command probes Linear with the resolved access token (`{ viewer { id } }`)
rather than reading mirrored router state: it runs out of process and cannot see
the running router's in-memory rejection map, and mirroring that state into
SQLite would add a failure callback through `RouterServer` and `LinearOAuthConfig`
for strictly less truthful output. The rejection's status code and timestamp
remain in the once-only ERROR log.

## Error handling summary

| Failure | Behaviour |
| --- | --- |
| Key Vault write fails | Logged, non-fatal. In-memory client already holds the new token; file write still attempted. Matches today's file-write semantics. |
| Key Vault read fails at startup | Logged, falls back to config value. Router boots. |
| Refresh returns 400/401 | Terminal. Marked rejected, logged once with remedy, further attempts suppressed. |
| Refresh returns 5xx / network error | Transient. Existing retry behaviour unchanged. |
| No `linearTokenStore` configured | Key Vault path skipped entirely; today's file-only behaviour. |

## Infrastructure

**No Terraform change required.** The router's user-assigned identity already
holds `Key Vault Secrets Officer` on `<key-vault-name>` (verified via
`az role assignment list`), and the new secret is created at runtime so it never
enters Terraform state — no drift, no `lifecycle.ignore_changes`.

## Testing

Vitest, following the existing per-package layout.

- **`KeyVaultTokenStore`** — injected `fetchFn` and `tokenProvider`; get/set
  round-trip, 404 → `undefined`, non-2xx → throw, URL and `api-version=7.4`
  shape.
- **Startup resolution** — table-driven over the three §2 cases, plus Key Vault
  read failure falling back to config rather than failing to boot.
- **`persistRefreshedTokens`** — writes both sinks; a Key Vault failure still
  writes the file and stays non-fatal; a file failure stays non-fatal.
- **Terminal state** — 400 marks rejected and logs exactly once; a second attempt
  issues **zero** fetch calls (asserted on call count); 500 stays transient;
  registering a different refresh token clears the flag.
- **Regression** — existing `packages/router` and `apps/cli` router suites stay
  green; `SelfAuthCommand.test.ts` untouched.

## Documentation

- `docs/ROUTER.md` — extend the env table, and **correct the "env is the source
  of truth" paragraph** (~line 229). Leaving it would re-plant the exact
  misunderstanding that caused this outage.
- `infra/azure/README.md` — document the runtime-created secret and the
  re-authorization procedure.
- `CHANGELOG.md` — entry under `## [Unreleased]`.

## Rollout

This change does **not** resolve the current outage on its own. A one-time
re-authorization is still required to get a live refresh token in:

1. `cyrus --env-file <file> self-auth-linear`
2. Update the `linear-workspaces-json` / `linear-workspace-token` Key Vault
   secrets with the new pair.
3. Restart the router.

From then on the rotated token is persisted to Key Vault and survives restarts.
