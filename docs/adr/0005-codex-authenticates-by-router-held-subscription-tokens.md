---
status: accepted
---

# Codex authenticates by router-held ChatGPT subscription tokens

Making the Codex runner usable in a container needs a credential, and the
obvious one — `OPENAI_API_KEY` — bills separately from the ChatGPT subscription
a team is already paying for. We will instead run Codex on each user's own
ChatGPT subscription: the user produces an `auth.json` once by running
`codex login --device-auth` on their own machine and pastes it into `/setup`,
the router becomes the sole holder and sole refresher of that credential, and
each container is handed a freshly-minted short-lived token at boot, written to
`$CODEX_HOME/auth.json` by `ContainerBootCommand`.

The decisive constraint is **refresh-token rotation**. Codex refreshes when its
access token is within five minutes of `exp`, and every refresh rotates the
refresh token held by every other copy of that file. Our containers are
ephemeral and per-issue, so one user with three live issues is three copies of
one credential racing each other — precisely the configuration OpenAI's own
CI/CD guidance names: *"Do not share the same file across concurrent jobs or
multiple machines."* Making the router the only process that ever refreshes
dissolves the race rather than mitigating it, and a container handed a fresh
token at boot never reaches its refresh window during a normal session.

Delivery is not the hard part and was briefly mistaken for it. `ContainerBootCommand`
already materialises secret env vars into dotfiles twice — `~/.git-credentials`
from `GIT_TOKEN`, and `config.json` carrying `LINEAR_API_TOKEN` — so a
`CODEX_AUTH_JSON` → `$CODEX_HOME/auth.json` step is a third instance of an
established pattern. This is the mechanism the `NOR-290` note in
`docker/worker/Dockerfile` has been waiting on.

## Considered options

**`OPENAI_API_KEY` only.** Works today with no new machinery: the key is not in
`RESERVED_ENV_KEYS`, so `cyrus router secrets set` already delivers it. Rejected
because it bills separately from the subscription the team already holds, which
is most of what NOR-364 is asking for. It keeps one genuine advantage worth
remembering: the 404 model-fallback probe in `CodexConfigBuilder` is a **no-op
without an API key**, so API-key mode is the only mode where Codex model
fallback works at all. Accepting subscription auth means accepting that a bad
`codexDefaultModel` produces a hard error from the app-server rather than a
silent downgrade.

**`--device-auth` inside the sandbox.** Not categorically broken, which is
surprising: an ACA sandbox's filesystem survives park/resume *and*
snapshot/restore, so an `auth.json` written into a live container persists for
that issue's whole lineage. But sandboxes have no persistent storage across
issues — the only create sources are the group-wide disk image and a snapshot
labelled `cyrus.issue` — so the cost is one device-code interaction **per
issue**, mid-session, inside a 15-minute expiry window, surfaced through a
Linear activity because there is no other channel to show the user a code. It is
also gated server-side per workspace, and the CLI falls back to browser login
only on a 404, not on the 403 that gate returns.

**Transplant `auth.json` per user and let containers refresh.** The documented
path (`developers.openai.com/codex/auth/ci-cd-auth`) but explicitly discouraged,
and the rotation race above is exactly its stated failure mode. Also
`codex logout` on any copy revokes all of them.

**Codex service accounts / `--with-access-token`.** Static bearers with no
rotation race — the cleanest option by some distance, and the one OpenAI intends
for automation. Unavailable: Business/Enterprise only, and we are not.

## Consequences

**The egress allowlist must name `chatgpt.com`, not just `api.openai.com`.**
Under subscription auth, inference goes to `chatgpt.com/backend-api/codex/responses`
and `api.openai.com` is never touched; `auth.openai.com` carries refresh and
revocation. Allowlisting only `api.openai.com` produces the worst failure shape
available — authentication succeeds and every subsequent request fails. Because
ACA applies egress **at sandbox-create time only**, has no update API, and
`hostRules` replaces the entire allowlist including the router's own host, all
three hosts go into `DEFAULT_EGRESS_HOSTS` in code regardless of which auth mode
a given user runs, and `chatgpt.com` needs WebSocket upgrades permitted.

**Refreshed tokens do not live in the per-user secret bundle.** The bundle is
built around a single invariant — one writer, holding a render-time ETag, with
conflicts surfaced to a human — and every escape hatch is closed deliberately:
`putRecord` refuses `If-Match: *`, and the save path refuses to retry or merge.
A background refresher writing there would 412 any `/setup` form a user happened
to have open, discarding their typed input under the message *"Your settings
were changed somewhere else while you were editing"* — which would be false. It
would also tax `MAX_BUNDLE_BYTES` with a router-owned key the user cannot
delete. The precedent to follow is `KeyVaultTokenStore`, which exists precisely
because the per-user bundle was the wrong shape for refreshed Linear tokens.

**Refresh uses the Codex CLI's own OAuth `client_id` from a process that is not
the Codex CLI.** This is unofficial. OpenAI already gates device-code
authentication per workspace and could gate this too; if they do, the fallback
is `OPENAI_API_KEY`, which is why that path stays supported rather than being
removed.

**This is sound under OpenAI's terms only because credentials stay per-user.**
The terms prohibit sharing credentials *between humans*, not automation — one
person's credential driving their own sessions across many machines is
explicitly fine. A single team-wide subscription serving everyone's issues would
not be, so the per-user secret model is load-bearing here, not incidental.

**The credential is delivered to every container a subscribed user owns, not
only to those whose default runner is Codex** (amended for CYR-79). The router
builds a container's whole environment at boot, from the user's workspace-wide
default; the runner an issue actually gets is chosen later and repeatedly,
*inside* the sandbox, by `RunnerSelectionService` — from `[agent=]`/`[model=]`
tags and labels that can be edited between turns. Gating delivery on the default
therefore gated it on the wrong decision: a user whose default was Claude could
select Codex on one issue and get a session that authenticated with nothing,
failing on `401 Unauthorized: Missing bearer or basic authentication in header`
from `/v1/responses`. Resolving the effective runner on the router instead would
only move the mistake: it would resolve once, at boot, a decision that keeps
changing afterwards.

The boundary this trades on is that `CODEX_AUTH_JSON` is *the requesting user's
own* credential entering a container dedicated to *that same user's* issue,
alongside the rest of their bundle — `CLAUDE_CODE_OAUTH_TOKEN`, `GH_TOKEN`,
`LINEAR_API_TOKEN` — with the same lifetime and the same reachability. Nobody
gains access to a credential they could not already reach, and the per-user rule
above is untouched. What widens is exposure *over time*: a Claude session now has
a Codex credential on disk it will never use, at 0600, for as long as that
sandbox lives. `writeCodexAuth` scrubs the variable from the environment once
the file exists, so it is not also in every command the agent runs.

Two limits on how far that is bounded are worth stating rather than glossing.
First, the router writes a container's `auth.json` only at COLD create:
`AcaSandboxesProvider` discards the env `buildEnv` produces on the resume and
snapshot-restore paths, which inherit the frozen state — so "short-lived and
router-refreshed" describes the router's stored credential, not the copy a
long-lived sandbox is holding. Second, and from the same asymmetry, a mint that
fires on a resume rotates a refresh token whose superseded value is still on
that sandbox's disk. Neither is introduced here — both already applied to
Codex-default users — but unconditional delivery widens who meets them, and
closing them properly needs a router-to-worker channel for re-delivering a
credential to a live sandbox, which does not exist yet. Concurrent mints for one
user are serialized in `CodexTokenStore.mint`, which removes the rotation race
between simultaneous boots but not this one.

Delivery being unconditional means its failures must be, too. When Codex is the
user's default, an absent or unrefreshable credential still fails the boot with
its remedy; when it is not, the same failure is logged and the container boots,
because a lapsed ChatGPT subscription may not break the Claude session the user
actually asked for. The session that *does* select Codex then reports the problem
itself, from inside the sandbox: `assertCodexCredentialAvailable` in
`cyrus-codex-runner` checks `OPENAI_API_KEY` and `$CODEX_HOME/auth.json` before
the first turn and finalises an error activity naming both remedies, rather than
letting OpenAI's 401 be the user's only signal.
