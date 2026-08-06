# Implementation plan — Setup management UI (NOR-265)

> Consolidated from the Linear issue tree NOR-265 → NOR-266/267 → NOR-268/269/270/271/272/273.
> This document is the working plan of record for the feature. Linear remains the source of
> truth for status; this file is the source of truth for the technical design.

# Amendments — adversarial review round 1 (2026-08-01)

> **This section supersedes the plan text below it.** Where an amendment conflicts
> with the original issue text, the amendment wins. Findings are from an
> adversarial review by Codex (`gpt-5.6-sol`), recorded verbatim in
> `codex-review-round1.md`, plus independent verification of the codebase claims
> and of every external Azure/HTMX API fact the fixes depend on.
>
> **23 findings: 3 CRITICAL, 12 HIGH, 6 MEDIUM, 2 LOW. All 23 accepted** — one
> (F5) with reduced scope, one (F16) with a better fix than proposed. Two
> corrections were found independently of the review (A1, A2 below).

---

## Superseding decisions

### D1′ — supersedes D1. Setup authentication is an explicit strategy, not an inference.

The original D1 (`AllowAnonymous` + read identity headers) had no enforceable
trust boundary in application code. `parseEasyAuthPrincipal` read whatever
headers arrived; the proposed `devTrustHeaders` flag gated nothing, because the
parser was never made conditional on it. A self-hosted or Docker deployment that
enabled `setupUi` **without** an EasyAuth sidecar in front would therefore accept
an arbitrary `X-MS-CLIENT-PRINCIPAL-NAME` from any client on the network — and
`docker/router/entrypoint.mjs` binds Fastify to `0.0.0.0`.

The plan also inferred "EasyAuth is installed" from the presence of
`RouterServerConfig.entra`. That object configures **enrollment bearer-token
validation** for `/enroll` (`RouterServer.ts:204-214`, `enrollment.ts:68-113`).
It says nothing about ingress topology. That inference is removed.

Replacement config surface:

```ts
setupUi?: {
	/** Default false. */
	enabled: boolean;

	/**
	 * REQUIRED when enabled. No default — an operator must state how identity
	 * is established. Startup throws if absent or if more than one mode is set.
	 */
	auth:
		| {
				/**
				 * Trust the ACA EasyAuth sidecar's injected identity headers.
				 * Only legitimate behind an ACA ingress with authConfigs
				 * installed AND the header-strip property verified live
				 * (NOR-268 Task 4). Refuses to start unless
				 * `verifiedHeaderStrip: true` is also set, which an operator
				 * sets by hand only after running the verification.
				 */
				mode: "easyauth-headers";
				verifiedHeaderStrip: true;
		  }
		| {
				/**
				 * Cryptographically verify the ID token the sidecar forwards in
				 * X-MS-TOKEN-AAD-ID-TOKEN. Requires the ACA token store.
				 * Independent of ingress topology, so this is the preferred
				 * mode wherever the token store can be enabled.
				 */
				mode: "entra-token";
				/** Bare client-id GUID. NOT the api:// audience — see A2. */
				idTokenAudience: string;
		  }
		| {
				/**
				 * Local development only. Reads headers with no verification.
				 * Startup throws unless the bind host is a loopback address.
				 */
				mode: "dev-insecure-headers";
		  };

	allowedDomain?: string;

	/** Default FALSE — changed from true. See F5. */
	autoProvisionUsers?: boolean;
};
```

Rules the implementation must enforce, each with a test:

1. `enabled: true` with no `auth` → throw at construction.
2. `mode: "easyauth-headers"` without `verifiedHeaderStrip: true` → throw.
3. `mode: "dev-insecure-headers"` with a non-loopback bind host → throw.
4. `parseEasyAuthPrincipal` is **unreachable** outside header modes. In
   `entra-token` mode a forged `X-MS-CLIENT-PRINCIPAL-NAME` must be ignored
   entirely — assert this directly.
5. The presence or absence of `config.entra` never affects setup auth.

`mode: "entra-token"` is the recommended production mode. It removes undocumented
proxy topology from the credential path entirely, which is what F4 asks for.

### D2′ — supersedes D2 in part. Audiences differ between enrollment and sign-in.

Reusing the app registration stands. But `createEntraTokenVerifier()` cannot be
reused as-is (see A2): it compares `payload.aud` by exact equality against
`entra.audience`, which is the Application ID URI (`api://<client-id>`) used for
**access** tokens. An EasyAuth **ID** token carries the bare client-id GUID as
`aud`. `mode: "entra-token"` therefore constructs a *second* verifier instance
with `idTokenAudience`, and the verifier's return type widens from `string` to
the validated payload so the principal can carry `oid` and `name`.

Issuer handling (accepting both `sts.windows.net/{tid}/` v1 and
`login.microsoftonline.com/{tid}/v2.0` v2) is reused unchanged.

### D3′ — supersedes D3. One entity per user stands; the ciphertext property changes type.

`Ciphertext` becomes `Edm.Binary`, not base64-in-`Edm.String`.

Microsoft documents `Edm.String` as "A UTF-16-encoded value. String values may be
up to 64 KiB in size. Note that the maximum number of characters supported is
about 32 K or less." A base64 string therefore holds only ~32,768 characters
≈ **24 KiB of pre-base64 payload** — not the 1 MiB the original D3 cited, which
is the whole-entity limit and does not raise the per-property ceiling.
`Edm.Binary` is documented at "up to 64 KiB" of *raw bytes*, so switching lifts
the ceiling to 65,536 bytes (2.67×) by dropping both the base64 4/3 expansion and
the UTF-16 doubling. The wire still base64s it, but that cost no longer counts
against storage.

A ceiling you do not check is still a ceiling you will hit, so **also** enforce a
limit before wrapping: reject a serialized bundle over 32 KiB with a clear,
UI-renderable error naming the offending variable. Test the boundary and
multi-byte values.

### D4′ — supersedes D4. Never fetch a stored URL. *(CRITICAL — C3)*

The original design stored a versioned Key Vault key id (`KekKeyId`) on each row
and had `unwrap` build its request URL from it. That is an authenticated SSRF:
`KeyVaultKeyWrapper.unwrap` sends `Authorization: Bearer <vault-scoped token>` to
whatever host the row names, and the request happens **before** AES-GCM can
authenticate anything — so the AAD binding cannot help. Anyone with Table write
access could set `KekKeyId` to their own host and harvest a token carrying the
router identity's Key Vault permissions (already Secrets User + Secrets Officer,
plus the Crypto User role this issue adds). The existing `KeyVaultSecretStore`
avoids this class by building every URL from a fixed configured `vaultUrl`.

Replacement:

* Store **`KekVersion`** only — the bare version segment, never a URL.
* Validate it against `^[0-9a-f]{32}$` before use.
* Construct the request URL as
  `${configured vault}/keys/${configured key name}/${KekVersion}/unwrapkey`,
  taking vault and key name **exclusively** from `containers.tableStore.keyId`.
* Validate the `kid` Key Vault echoes back: it must be exactly the URL just
  constructed.
* Rotation stays decidable — the version is still per-record.

Mandatory tests: a hostile `KekVersion` (`https://attacker.example/...`,
`../../`, a 33-char hex, an empty string) produces **zero** `fetchFn` calls and
**zero** `tokenProvider` calls. Assert on call counts, not on the thrown message.

`key-version` is a required path parameter on `wrapkey`/`unwrapkey`, so there is
no "latest" fallback to accidentally depend on — this design is also the only one
that works.

### D5′ — supersedes D5. Narrow the claim to something true.

"Values never travel to the browser" is false: new secrets are typed into the
DOM, held by htmx, and sent in request bodies, where they are visible to
extensions, devtools, password managers, and any request-body logging.
`autocomplete="off"` is advisory, not a boundary.

The true and still-valuable property is: **stored values are never returned in a
response and never rendered.** Use that wording everywhere. Add an explicit
no-request-body-logging rule for `/setup*`, keep the strict same-origin CSP, and
state the residual DOM/request exposure in the user-facing threat model.

### D6′ — supersedes D6 in part. Infrastructure flags are one-way; only the selector rolls back.

`prevent_destroy = true` on the KEK combined with `count = var.enable_setup_table ? 1 : 0`
makes flipping that flag back a guaranteed apply failure. Treat the Table, KEK,
and role assignments as **create-once and persistent**. Rollback is expressed
*only* through the backend-selector field (`containers.tableStore` present or
absent). Decommissioning is a separate, explicit, gated workflow — export and
verify, disable the backend, retire key versions, then remove resources and
state — never a flag flip.

---

## New decision

### D7 — Terraform is staged. Auth infrastructure lands before the route exists. *(CRITICAL — C2)*

A single flag that both enables `/setup` and attaches `authConfigs` guarantees an
exploitable window: the `authConfigs` child resource depends on the Container
App, so the revision serving `/setup` necessarily goes live **before** the auth
sidecar exists. The post-apply trust gate runs after the whole apply and cannot
prevent it. With D1′ this is no longer a full compromise — the app refuses to
start in `easyauth-headers` mode without `verifiedHeaderStrip` — but the ordering
is fixed regardless, because defence in depth is the point.

Two independently-applied variables:

| Variable | Applies | Effect |
| --- | --- | --- |
| `enable_setup_auth` | first | Creates the client secret, `authConfigs`, redirect URI. `/setup` does not exist. |
| `enable_setup_ui` | second, separate apply | Sets `CYRUS_ROUTER_SETUP_UI_*`, enabling the routes. |

Rollback reverses the order: disable `enable_setup_ui`, apply, verify `/setup` is
gone, only then touch auth. The header-strip verification (NOR-268 Task 4) runs
**between** the two applies and is a hard gate on the second.

---

## Corrections found independently of the review

### A1 — the config-plumbing checklist is incomplete, and its stated failure mode is wrong.

The plan claims three registration sites. The complete list is:

1. `RouterServerConfig` / `RouterContainersConfig` (`RouterServer.ts:141`, `:71`)
2. `docker/router/entrypoint.mjs` — **both** the `config.X = …` mapping (`:144-228`)
   **and** the `anyProvided` gate (`:91-104`). *(F21 reached this independently.)*
3. `RouterConfigFileSchema` (`RouterCommand.ts:119`)
4. `infra/azure/terraform/router.tf` — the `env {}` blocks and
   `local.router_env_non_secret` (`:50-64`); for `containers.*` fields also
   `local.router_containers_config` (`:13-48`)
5. `docs/ROUTER.md` and `docker/router/.env.example`

The plan says an unmodelled field is "stripped on rewrite". It is not:
`persistRefreshedTokensToFile` (`RouterCommand.ts:669-695`) re-reads raw JSON and
preserves unknown keys. The strip actually happens at **every `cyrus router
start`** via `safeParse` + spread (`RouterCommand.ts:466`, `:482`) — strictly
worse, and matching the hazard `CLAUDE.md` item 9 already records.

### A2 — `createEntraTokenVerifier` is not reusable as claimed.

Folded into D2′ above. Wrong audience shape for ID tokens; returns `string` not
the payload.

---

## Finding-by-finding resolution

| # | Sev | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | CRITICAL | `devTrustHeaders` gates nothing | **Accepted** → D1′ |
| 2 | CRITICAL | Terraform ordering opens a public impersonation window | **Accepted** → D7 |
| 3 | CRITICAL | `KekKeyId` is an authenticated SSRF leaking a vault token | **Accepted** → D4′ |
| 4 | HIGH | EasyAuth trust claim broader than MS guarantees; one-path test | **Accepted** → D1′ `entra-token` mode preferred; NOR-268 Task 4 rewritten (below) |
| 5 | HIGH | Auto-provisioning before an enforceable allowlist; email as identity | **Accepted, scope reduced** — allowlist adopted here; oid re-keying deferred to NOR-274 |
| 6 | HIGH | Table REST headers incomplete; `Edm.Int64` wrongly encoded | **Accepted** → NOR-269 header/encoding spec (below) |
| 7 | HIGH | Create races; missing ETag fails open to upsert | **Accepted** → NOR-269 concurrency spec (below) |
| 8 | HIGH | ETag read at save time defeats two-tab conflict detection | **Accepted** → NOR-273 version token (below) |
| 9 | HIGH | `secrets migrate` can't see both source and target | **Accepted** — explicit `--from`/`--to`; public paginated enumeration API; injectable backend factories |
| 10 | HIGH | Key Vault retention is not a rollback | **Accepted** — bounded dual-write cutover, surfaced partial failures, verified reverse export before any rollback |
| 11 | HIGH | Default-executor migration can't recover historical intent | **Accepted — supersedes the plan's own fix.** See below |
| 12 | HIGH | htmx will not render 4xx fragments | **Accepted** → `htmx:beforeSwap` handler (below) |
| 13 | HIGH | Readiness banner outside the swap target | **Accepted** — move it inside `#variables`; assert DOM after both set and clear |
| 14 | HIGH | Dependency graph is internally false | **Accepted** — corrected critical path (below) |
| 15 | HIGH | Regression gate doesn't do the reconnect/webhook it claims | **Accepted** — force a socket close and require a fresh `hello`+heartbeat; send a genuinely signed webhook and observe routing; run on a staged revision |
| 16 | MEDIUM | Table capacity overstated | **Accepted, better fix** → D3′ `Edm.Binary` + enforced limit |
| 17 | MEDIUM | No deadlines or transient-error policy | **Accepted** — `AbortSignal` deadline (default 30s, configurable), correlation id, bounded retry on 408/429/5xx honouring `Retry-After`, **never** retry 412. Tests for timeout, abort, throttle, and that failure never degrades to an empty bundle |
| 18 | MEDIUM | CSRF mislabeled; token in URL; state-changing GET | **Accepted** — rename to *signed synchronizer token*; send via form body or `X-CSRF-Token`, never query string; bind to principal id as well as email; provisioning moves off GET (below) |
| 19 | MEDIUM | `enable_setup_table` not reversible | **Accepted** → D6′ |
| 20 | MEDIUM | `readonly secretBackendKind` won't compile | **Accepted** — `buildContainerTargets` returns `{ service, secrets, kind }`; readonly assigned in the constructor. Tests for no-containers / file / keyvault / table |
| 21 | MEDIUM | `anyProvided` gate missed; contradictory local recipes | **Accepted** → A1; one canonical local recipe that satisfies the final constructor invariants |
| 22 | LOW | Planned tests contradict each other | **Accepted** — scope the redaction assertion to value inputs only; render clear for `required && isSet` only |
| 23 | LOW | "Values never travel to the browser" overstated | **Accepted** → D5′ |

---

## Detail on the resolutions that change contracts

### F5 — accepted, with the identity re-keying deferred

Adopted now:

* `autoProvisionUsers` defaults **`false`** (was `true`). This reverses the Q1
  answer recorded on NOR-265, because that answer was given on the assumption
  that "Assignment required" was already enforced. It is not: the plan's own
  command sets `appRoleAssignmentRequired` but never performs the group
  assignment, and `authConfigs` carries no `allowedPrincipals` policy. Without
  one of those, any tenant user can sign in and provision themselves.
* Enabling auto-provisioning requires a **verified** prerequisite: either an
  Entra group assignment (with the actual command in the runbook, and evidence it
  ran) or an `authConfigs` `defaultAuthorizationPolicy.allowedPrincipals` policy.
  NOR-270 gains an acceptance criterion that an unassigned tenant user is refused.

Deferred to a new follow-up issue, **not** folded in:

* Re-keying identity from email to `(tenantId, oid)`. The security reasoning is
  sound — a UPN rename creates a new identity, and email reuse re-attaches a
  different Entra object to old state. But `RouterStore` is email-keyed
  throughout (`RouterStore.ts:7-13`), as are devices, secrets, and every CLI
  surface. Re-keying is a router-wide migration several times the size of this
  feature, and doing it inside this change would be scope creep that also makes
  the security-critical parts harder to review. Recorded as **NOR-274** with the
  rename/reuse scenarios written down. Interim mitigation: persist `oid` on the
  user row now (cheap, additive) so the eventual migration has the data it needs,
  and log a warning when a known email presents a different `oid`.

### F6 — Table REST: exact required headers and Int64 encoding

Verified against Microsoft's first-party REST reference.

```
x-ms-version:            2020-12-06      # ≥ this for OAuth on Table; the
                                         # per-operation "Optional" label is
                                         # boilerplate and wrong for Table
Authorization:           Bearer <token>  # scope https://storage.azure.com/.default
Accept:                  application/json;odata=minimalmetadata
Content-Type:            application/json
DataServiceVersion:      3.0;NetFx       # send BOTH — the docs disagree with
MaxDataServiceVersion:   3.0;NetFx       # each other about which is required
x-ms-date:               <RFC1123>       # unsigned under Bearer; send anyway
```

`Accept` must be `minimalmetadata`, **not** `nometadata`: `nometadata` strips the
`@odata.type` annotations, and without them an `Edm.Int64` is indistinguishable
from a string on read.

`UpdatedMs` must be sent as a JSON **string** with an explicit annotation. A bare
number is inferred as `Edm.Int32` (no decimal point) or `Edm.Double` (with one) —
never Int64:

```json
"UpdatedMs@odata.type": "Edm.Int64",
"UpdatedMs": "1754006400000"
```

Same pattern for the binary ciphertext:

```json
"Ciphertext@odata.type": "Edm.Binary",
"Ciphertext": "<standard base64>"
```

Key Vault crypto payloads remain **base64url** (RFC 4648 §5, unpadded) — a
different encoding from the Table binary property, which is standard base64.
Getting these two confused is the single likeliest implementation bug here, so
each gets its own round-trip test. Node's `Buffer.from(s, "base64url")` decodes
leniently and accepts both alphabets, which is what we want on the read path.

Every mocked-fetch test is explicitly **not** API-contract proof. NOR-269 gains a
disposable real-Azure integration smoke covering GET, insert, conditional update,
412, wrap, and unwrap, run manually against a scratch account and documented — not
in CI.

### F7 — Table concurrency: create and update are different operations

Confirmed and worse than the review stated. Microsoft documents that when
`If-Match` is absent, the service does not merely behave like an upsert — it
**switches operation** to Insert-Or-Replace and returns 204. The failure is
therefore silent: no conflict logic can fire, and any property omitted from the
payload is dropped. `If-None-Match` returns 400 on Table PUT, so conditional-PUT
create-if-absent does not exist.

* **Create** → `POST` Insert Entity. HTTP 409 `EntityAlreadyExists` means someone
  won the race; re-read and apply the conflict policy.
* **Update** → `PUT` with a concrete `If-Match: <etag>`. HTTP 412 means stale.
* A successful GET or PUT that returns **no ETag** is a protocol error — throw.
  Never fall through to an unconditional write. The original design's `?? ""`
  turned this into a fail-open upsert.
* `If-Match: *` is permitted only where last-writer-wins is genuinely intended,
  and must carry a comment saying so. Today: nowhere.

Tests: a true concurrent-create race (two callers both observing 404), a
missing-ETag response, and 409/412 paths.

### F8 — conflict detection needs a render-time version

Reading the ETag inside the save handler always yields the *current* value, so
the advertised "two tabs, second one 409s" can essentially never fire — a 412
would require another write to land in the microseconds between the handler's own
GET and PUT. The proposed test manufactured the conflict inside a fake store and
so proved nothing about the real flow.

Fix: capture the record ETag when **rendering** the page, embed it as an opaque
signed token bound to the principal (so it cannot be replayed across users), and
use *that* for the conditional write. Test sequentially: render A, render B, save
A fully, then save B and require 409.

### F11 — preserve NULL's historical meaning; add an inherit sentinel

This supersedes the plan's own Task 4 fix. The plan proposed writing
`{"type":"device"}` going forward and treating remaining NULLs as "unset" — but
NULL is already ambiguous *today* between "explicitly set to device" and "never
configured", and `listUsers` does not even expose `executor_json`
(`RouterStore.ts:374-395`). No new column and no pre-flight can retrospectively
recover intent, so the plan's runbook step ("note anyone showing device") either
selects every NULL user or guesses.

Corrected semantics:

* `NULL` keeps meaning **physical device**. It is never captured by the default.
* A new explicit `{"type":"default"}` sentinel means "inherit
  `containers.defaultExecutor`". Newly auto-provisioned users get it.
* `{"type":"device"}` is written by `set-executor … device` going forward, and is
  equivalent to NULL.
* Corrupt JSON keeps degrading to physical device with a warning — never to a
  cloud sandbox.
* Existing users move onto the default only from an **operator-supplied
  allowlist**. There is no automatic inference, and the runbook says so.

This is strictly safer than the original and needs no migration to be correct on
day one.

### F12 — htmx does not swap 4xx

Verified: htmx 2.x ships
`[{code:"204",swap:false},{code:"[23]..",swap:true},{code:"[45]..",swap:false,error:true}]`.
4xx/5xx are not swapped; `htmx:responseError` fires and the DOM is untouched. So
every planned 400/403/409 fragment — including the fresh CSRF token inside it —
would have been silently discarded, leaving a stale token in the page. Fastify
`inject` tests assert status and body and would have passed throughout.

Fix: an explicit `htmx:beforeSwap` handler in the inline page script, allowing
swaps for exactly 400, 403, and 409:

```js
document.body.addEventListener("htmx:beforeSwap", (e) => {
	if ([400, 403, 409].includes(e.detail.xhr.status)) {
		e.detail.shouldSwap = true;
		e.detail.isError = false;
	}
});
```

Chosen over overriding `htmx.config.responseHandling` because that requires
re-declaring the whole array *and* ordering the specific entry before `[45]..`
(first match wins) — a documented footgun. `beforeSwap` fires even for
non-swapped error responses and `shouldSwap`/`isError` are read back after the
event, so this is the supported seam. `HX-Retarget` alone would *not* work.

Add browser-level coverage for invalid name, expired CSRF, and ETag conflict —
status-only assertions cannot catch this class.

### F14 — corrected dependency graph

The plan's diagram claimed NOR-271 "only needs NOR-268's `parseEasyAuthPrincipal`",
but NOR-271's own `SetupRouteDeps` declares `bootstrap: SetupBootstrap` as a
required member and calls it on every GET; NOR-270 in turn consumes NOR-269's
`ensureRecord`. Verified directly against the plan text. The real path:

```
NOR-268 ─┐
         ├─> NOR-270 ─> NOR-271 ─> NOR-272 ─> NOR-273
NOR-269 ─┘
```

268 and 269 remain genuinely concurrent. Everything after 270 is serial. Do not
staff against the original diagram.

### F18 — provisioning moves off GET

`GET /setup` calling `bootstrap.ensure()` creates a SQLite user row and a Table
record, so a plain cross-site navigation could provision an account for any
signed-in tenant user — on a route the plan describes as "read-only" and which
carries no CSRF token.

Fix: `GET /setup` becomes genuinely read-only. When no record exists it renders a
"Set up your account" page whose single control is a CSRF-protected `POST
/setup/provision`. One extra click for a first-time user; removes idempotent
cross-site provisioning entirely.

The mechanism is also renamed: it is a **stateless signed synchronizer token**,
not double-submit (there is no second cookie to compare). Tokens travel in the
form body or an `X-CSRF-Token` header — never a query string, where the 8-hour
token would land in access logs and browser history.


---

# Original issue text (as authored in Linear)

> Everything below predates the review. Where it conflicts with the amendments
> above, the amendments win.

---

# NOR-265: Create UI for managing setup

**State:** Backlog | **Priority:** --- | **Assignee:** Unassigned | **Project:** Cyrus | **Milestone:** First multi-user release

Replace the current `az` CLI-based setup flow in Cyrus with a simple authenticated UI for managing user environment variables.

This parent issue tracks the end-to-end delivery of the feature. Implementation is split into backend and UI workstreams:

* [NOR-266](https://linear.app/<workspace>/issue/NOR-266/build-setup-management-backend-foundation)
  * [NOR-268](https://linear.app/<workspace>/issue/NOR-268/set-up-entra-authentication-and-app-registration)
  * [NOR-269](https://linear.app/<workspace>/issue/NOR-269/move-user-environment-variable-storage-to-azure-table-with-envelope)
  * [NOR-270](https://linear.app/<workspace>/issue/NOR-270/create-user-setup-records-on-first-sign-in)
* [NOR-267](https://linear.app/<workspace>/issue/NOR-267/build-setup-management-ui)
  * [NOR-271](https://linear.app/<workspace>/issue/NOR-271/implement-authenticated-setup-management-page-shell)
  * [NOR-272](https://linear.app/<workspace>/issue/NOR-272/add-ui-for-managing-optional-environment-variables)
  * [NOR-273](https://linear.app/<workspace>/issue/NOR-273/persist-setup-changes-from-the-ui)

Target shape:

* simple static HTMX site styled with Pico CSS
* authentication managed by the native ACA auth sidecar with Entra
* table view of environment variables
* add and delete support for non-required environment variables
* save flow to persist changes to the server
* first sign-in bootstraps a user record with empty values for required variables

The parent issue should stay focused on scope, sequencing, and overall delivery. Detailed implementation work belongs in the child issues.

## Sub-issues

- **NOR-267**: Build setup management UI _[Backlog]_
- **NOR-266**: Build setup management backend foundation _[Todo]_


## Comments

### Comment

## Implementation plan — Setup management UI (parent)

Reviewed against the current `deploy` repo on branch `deploy` (`0ddf8adc`). This comment covers architecture, the decisions the child issues inherit, sequencing, and the open questions I need a call on. Task-level plans (files, interfaces, TDD steps) are in the comments on NOR-266/267 and their children.

---

### Goal

Replace `az containerapp exec` + `az keyvault secret set` as the way a teammate's per-user container environment variables get set, with an authenticated web page served by the router.

### Architecture

The setup UI is **served by the existing router Fastify app** (`packages/router`), not a separate service. Reasons:

* It needs the same SQLite `users` table (`RouterStore`) and the same `SecretStoreBackend` the container boot path reads (`ContainerTargets.buildEnv`). A separate app would need cross-service calls or a duplicate copy of both.
* The router Container App already has external ingress, a managed identity with Key Vault rights, and a Terraform stack. Adding an ACA `authConfigs` child resource is a much smaller surface than a second app.
* HTMX needs a server returning HTML fragments — "static site" in the issue description means *no build step / no SPA framework*, not *no server*. Pico CSS + htmx are vendored into the router image; there is no bundler, no npm UI dependency, and no CDN fetch at runtime (ACA egress is deny-by-default).

Three new pieces, one per backend child issue:

```
packages/router/src/
  setup/
    principal.ts     # NOR-268 — read + validate the EasyAuth identity headers
    bootstrap.ts     # NOR-270 — first sign-in creates user row + empty record
    routes.ts        # NOR-271/272/273 — Fastify routes, HTMX fragments
    views.ts         # NOR-271/272 — HTML rendering (pure functions, unit-testable)
    csrf.ts          # NOR-271 — double-submit token
    envelope.ts      # NOR-269 — AES-256-GCM + Key Vault wrapKey/unwrapKey
    vendor/          # NOR-271 — pinned pico.classless.min.css + htmx.min.js as TS strings
  TableSecretStore.ts  # NOR-269 — SecretStoreBackend over Azure Table
```

### Decisions the children inherit

**D1 — Auth is `AllowAnonymous` at the sidecar, enforced in-app on `/setup*`.**
ACA `globalValidation.unauthenticatedClientAction` supports `AllowAnonymous | RedirectToLoginPage | Return401 | Return403`, plus `excludedPaths`. Default-deny (`RedirectToLoginPage` + `excludedPaths`) is the more obvious choice, and I rejected it: the router's machine routes include **dynamic path segments** — `/artifacts/issues/:issueKey/bundle`, `/containers/issues/:issueKey/teardown-complete` — plus the `/device` WebSocket upgrade, `/linear-webhook`, `/webhook`, `/enroll`, `/workspaces`, `/healthz`. `excludedPaths` is a path list with no documented wildcard semantics, so a mis-scoped list silently breaks Linear webhook delivery and every worker's WSS on a live router. `AllowAnonymous` is provably non-breaking for all of them and moves the enforcement into code we can unit-test without Azure.

The load-bearing security property is that the sidecar strips client-supplied identity headers. Microsoft states this explicitly ("External requests aren't allowed to set these headers, so they're present only if set by Container Apps"). NOR-268 carries an **explicit live verification** of that claim — curl with a forged `X-MS-CLIENT-PRINCIPAL-NAME` must not authenticate. If it fails, the fallback is to also verify `X-MS-TOKEN-AAD-ID-TOKEN` with the existing `createEntraTokenVerifier()` in `enrollment.ts`; that requires enabling the ACA token store.

**D2 — Reuse the existing router app registration.** `CLAUDE.md` records the invariant "Entra enrollment uses one app registration/audience per router deployment". Rather than minting a second app, NOR-268 extends the existing one: enable ID token issuance, add the `https://<fqdn>/.auth/login/aad/callback` web redirect URI, and add a client secret. `entra_audience` continues to serve enrollment and additionally becomes the EasyAuth allowed audience.

**D3 — One Table entity per user, holding the whole encrypted bundle.**
Not one entity per variable. This gives a single GET for `SecretStoreBackend.get(email)`, one ETag for the whole record (which is exactly the optimistic-concurrency unit NOR-273's save flow needs), and one wrap/unwrap round trip per read/write instead of N. Entity limits (1 MB, 64 KB/property) are far above any realistic env-var set.

**D4 — Envelope encryption: fresh AES-256-GCM DEK per write, wrapped by a Key Vault RSA key.**
Not a long-lived DEK. The GCM AAD is bound to `PartitionKey|RowKey` so a ciphertext copied onto another user's row fails to open. The versioned KEK id is stored on the record so rotation is decidable rather than guessed.

**D5 — Values never travel to the browser.**
The table renders variable *names* and a set/not-set indicator. Every value input is empty with a masked placeholder. An empty input on save means "leave unchanged". There is no reveal button and no `GET` that returns a plaintext value. This is what makes the whole page safe to leave open on a laptop.

**D6 — Storage backend selection is additive and flag-gated.**
`containers.tableStore` selects `TableSecretStore`; else existing `containers.keyVaultUrl` selects `KeyVaultSecretStore`; else the 0600 file store. Self-hosted and Docker deployments are byte-identical with the field unset. Same for the UI: `setupUi.enabled` defaults to `false`.

### Global constraints (apply to every child)

* TypeScript, ESM (`.js` import specifiers), tabs, Biome — match the surrounding files.
* Tests are Vitest in `packages/router/test/*.test.ts`. No test may require Azure, Docker, or network — inject `fetchFn` / `tokenProvider` seams the way `KeyVaultSecretStore` and `StateBackup` already do.
* Azure REST is hand-rolled `fetch`, consistent with `KeyVaultSecretStore.ts` and `StateBackup.ts`. Do **not** add `@azure/data-tables` or `@azure/keyvault-keys`; `@azure/identity` is already a dependency and is the only Azure SDK used.
* Key Vault REST: `api-version=7.4`, scope `https://vault.azure.net/.default`. Key Vault crypto payloads are **base64url**, not base64.
* Storage REST: scope `https://storage.azure.com/.default`, `x-ms-version: 2020-12-06` or later.
* Terraform: `azurerm ~> 4.0`, `azapi ~> 2.0`, `azuread ~> 3.0` are already declared in `infra/azure/terraform/versions.tf`.
* Router hosting stays **single replica** — do not introduce anything that assumes shared cross-replica state.
* Key validation goes through the existing `normalizeSecretKey()` in `SecretStore.ts` (reserved keys, `^[A-Za-z_][A-Za-z0-9_]*$`). Do not re-implement it.
* Every PR updates `CHANGELOG.md` (user-facing) or `CHANGELOG.internal.md` per `CLAUDE.md`, and runs `pnpm test:packages:run` + `pnpm typecheck`.

### Sequencing

```
NOR-269 (Table + envelope)  ──────────────┐
                                          ├──> NOR-270 (bootstrap) ──┐
NOR-268 (Entra + auth sidecar) ──┬────────┘                          │
                                 └──> NOR-271 (shell) ──> NOR-272 (add/delete) ──> NOR-273 (save)
```

* **NOR-268 and NOR-269 are independent** and can run concurrently. Both are shippable behind flags before any UI exists.
* **NOR-271 unblocks the UI chain** and only needs NOR-268's `parseEasyAuthPrincipal`. It renders against *any* `SecretStoreBackend`, so it is developable locally against the 0600 file store with a fake principal header — no Azure required.
* **NOR-270 lands after 268 + 269** because "required variables initialized to empty" needs both the identity and the record semantics.
* **NOR-273 is last** because its conflict handling depends on NOR-269's ETag surface.

### Risks

1. **Regressing the live router.** The router is in production; `/setup` is additive but the Terraform `authConfigs` resource changes ingress behaviour for *every* path. Mitigated by D1 (`AllowAnonymous`) and by a post-apply smoke of `/healthz`, `/linear-webhook`, and a worker WSS reconnect — that smoke is an acceptance criterion on NOR-268, not an afterthought.
2. **Header trust.** See D1. Verified explicitly, with a documented fallback.
3. **Rotation semantics are unchanged and surprising.** A secret written through the UI reaches a worker only on the next **create-from-image** — a running, suspended, or snapshot-restored sandbox keeps its baked env (`CLAUDE.md` item 12). The UI must say so and link the `cyrus router containers destroy <issueKey>` remedy. Assigned to NOR-273.
4. **Data migration.** Existing users' secrets live in Key Vault today. NOR-269 includes a `cyrus router secrets migrate` command; do not cut over `containers.tableStore` before it has run and been verified.
5. **Auto-provisioning is an access-control decision.** See open question Q1.

### Open questions

**Q1 — Should first sign-in auto-create a router user?** The description says "first sign-in bootstraps a user record". Taken literally, anyone who can sign in with a tenant account in `entra_allowed_domain` becomes a Cyrus user and can store secrets. That is probably intended for a single-org deployment, but it is a policy call. NOR-270's plan implements it gated on the domain allowlist and behind `setupUi.autoProvisionUsers` (default `true`); say the word and I'll flip the default to "existing users only, unknown emails get a 403 with an admin contact".

**Q2 — Does the UI own executor assignment too?** Today `cyrus router users set-executor <email> aca` is a separate manual step, and a bootstrapped user with no executor still routes to a physical device that does not exist. Not in scope as written. I'd suggest NOR-270 also default a bootstrapped user's executor to `aca` when `containers.aca` is configured — small, and it removes the one remaining `az containerapp exec` step. Confirm and I'll fold it in.

**Q3 — Is `az containerapp exec` admin retired or retained?** The plan keeps `cyrus router secrets set` working against all three backends (file / Key Vault / Table) so the CLI stays a break-glass path. If you want it removed, that is a separate cleanup issue.

---

Happy to also drop the consolidated version into `docs/superpowers/plans/` alongside the other design docs if you want it in-repo.


#### Reply

**Open questions resolved** (2026-08-01):

**Q1 — Auto-provision: yes.** First sign-in creates the router user. No plan change; NOR-270 already implements this with `autoProvisionUsers` defaulting to `true`. The flag stays so a future deployment can lock it down without a code change, and because NOR-270's tests cover both branches.

**Q2 — Executor: ACA sandboxes, as a router-level default.** This *does* change the plan. Rather than having bootstrap stamp `executor_json` onto each user, the router gains `containers.defaultExecutor`, and `ContainerTargetService.executorFor()` falls back to it when a user has no explicit setting. Reasons: it covers users created by *any* path (`cyrus router users add`, `/setup` bootstrap, a restored `router.db`), it is declarative in the Terraform-rendered containers JSON like the rest of the ACA config, and it needs no migration of existing rows. Terraform sets it to `"aca"` whenever the `aca` block is present. Detailed task added to NOR-270.

**There is a sharp edge here worth flagging.** Today `executor_json = NULL` means "physical device", and `cyrus router users set-executor <email> device` writes `NULL`. If `defaultExecutor: "aca"` simply fills in for NULL, then **every user who was deliberately set to `device` silently flips to ACA sandboxes** — indistinguishable from a user who was never configured. The fix is to make "device" an explicit stored sentinel (`{"type":"device"}`) and land that *before* the default is enabled. NOR-270's new Task 4 sequences the two, and the runbook has a pre-flight that lists which users would change.

**Q3 — `az containerapp exec` stays as break-glass.** No plan change. `cyrus router secrets set/list/unset` keeps working against all three backends (file / Key Vault / Table); NOR-273's doc task demotes it from "the documented path" to a break-glass subsection rather than deleting it.

Net effect on scope: one additional task on NOR-270 (~half a day, including the CLI change and the migration pre-flight). Sequencing, decisions D1–D6, and every other child plan are unchanged.





---

# NOR-266: Build setup management backend foundation

**State:** Todo | **Priority:** --- | **Assignee:** (author) | **Project:** Cyrus | **Milestone:** First multi-user release

Create the backend foundation for the setup management feature, including authentication prerequisites, user bootstrap, and persistent storage for user environment variables. This issue groups the server-side work needed before the UI can fully function.

## Parent

- **NOR-265**: Create UI for managing setup _[Backlog]_


## Sub-issues

- **NOR-270**: Create user setup records on first sign-in _[Backlog]_
- **NOR-269**: Move user environment variable storage to Azure Table with envelope encryption _[Backlog]_
- **NOR-268**: Set up Entra authentication and app registration _[Backlog]_


## Comments

### Comment

## Implementation plan — backend foundation (grouping issue)

Sequencing and shared contracts for NOR-268 / NOR-269 / NOR-270. Step-by-step task plans live on each child. Architecture decisions (D1–D6) are on NOR-265.

---

### What "foundation" means here

Everything under this issue is **shippable and mergeable before any UI exists**, and every piece is flag-gated so a self-hosted or Docker deployment with the new fields unset behaves byte-identically to today.

| Child | Deliverable | Verifiable without the UI by |
| --- | --- | --- |
| NOR-268 | ACA auth sidecar + `parseEasyAuthPrincipal()` | `curl -I https://<fqdn>/.auth/login/aad` returns a login redirect; unit tests over header parsing |
| NOR-269 | `TableSecretStore` + Terraform table/KEK/RBAC + `secrets migrate` | `cyrus router secrets set/list/unset` against the Table backend inside the replica |
| NOR-270 | `SetupBootstrap.ensure()` | unit tests + `cyrus router users list` showing the auto-created row |

### Order

**NOR-268 and NOR-269 run concurrently — they share no files.** NOR-270 lands third; it consumes NOR-268's `SetupPrincipal` and NOR-269's `ensureRecord`.

The one shared file all three touch is `packages/router/src/RouterServer.ts` (config interface + wiring). Land 268 first so 269 and 270 rebase onto a settled `RouterServerConfig`, or accept a small merge in `buildContainerTargets`. Either is fine; just don't run 269 and 270 in parallel against an unlanded 268.

### Shared contracts

These are the exact signatures the children produce and consume. Any drift here is a bug — the UI issues code against them.

**From NOR-268** — `packages/router/src/setup/principal.ts`:

```ts
export interface SetupPrincipal {
	/** Lowercased. The identity key everywhere downstream. */
	email: string;
	name?: string;
	/** Entra object id (`oid`), for logging only. */
	objectId?: string;
}

export interface SetupAuthConfig {
	/** Rejects principals outside this email domain when set. */
	allowedDomain?: string;
}

/** Returns undefined when the sidecar injected no identity headers. */
export function parseEasyAuthPrincipal(
	headers: Record<string, string | string[] | undefined>,
): SetupPrincipal | undefined;

export class SetupAuthError extends Error {
	constructor(readonly status: 401 | 403, message: string);
}

/** Throws SetupAuthError; never returns a principal that failed the domain gate. */
export function requireSetupPrincipal(
	headers: Record<string, string | string[] | undefined>,
	config: SetupAuthConfig,
): SetupPrincipal;
```

**From NOR-269** — `packages/router/src/TableSecretStore.ts`:

```ts
export class TableSecretStore implements SecretStoreBackend {
	constructor(opts: TableSecretStoreOptions);

	// SecretStoreBackend (unchanged contract — ContainerTargets keeps working)
	get(email: string): Promise<UserSecretBundle>;
	set(email: string, key: string, value: string | undefined): Promise<void>;
	isFullyAuthenticated(
		email: string,
		requiredKeys: readonly string[],
	): Promise<{ ok: boolean; missing: string[] }>;

	// Extra surface the UI needs
	getRecord(
		email: string,
	): Promise<{ bundle: UserSecretBundle; etag: string } | undefined>;
	putRecord(
		email: string,
		bundle: UserSecretBundle,
		ifMatch?: string,
	): Promise<{ etag: string }>; // throws SetupConflictError on HTTP 412
	ensureRecord(
		email: string,
		requiredKeys: readonly string[],
	): Promise<{ created: boolean }>;
}

export class SetupConflictError extends Error {}
```

`getRecord` / `putRecord` / `ensureRecord` are **not** on `SecretStoreBackend` — the file and Key Vault backends do not gain them. NOR-271/273 must feature-detect (`store instanceof TableSecretStore`, or a `supportsRecords(): boolean` on the class) and fall back to per-key `set()` loops for the file backend so local dev still works. NOR-273's plan specifies that fallback.

**From NOR-270** — `packages/router/src/setup/bootstrap.ts`:

```ts
export class SetupBootstrap {
	constructor(deps: {
		store: RouterStore;
		secrets: SecretStoreBackend;
		requiredKeys: readonly string[];
		autoProvisionUsers: boolean;
		logger: { info(msg: string): void; warn(msg: string): void };
	});

	/** Idempotent. Throws SetupAuthError(403) when the user is unknown and
	 *  autoProvisionUsers is false. */
	ensure(principal: SetupPrincipal): Promise<{
		userId: number;
		createdUser: boolean;
		createdRecord: boolean;
	}>;
}
```

### Config surface added across the three children

`RouterContainersConfig` (NOR-269):

```ts
/** Selects the Azure Table backend. Highest precedence; then keyVaultUrl; then the file store. */
tableStore?: {
	/** e.g. "https://<storage-account>.table.core.windows.net" */
	endpoint: string;
	/** Default "cyrussetup". */
	tableName?: string;
	/** Versioned Key Vault key id used as the KEK. */
	keyId: string;
};
```

`RouterServerConfig` (NOR-268 + NOR-270):

```ts
setupUi?: {
	/** Default false. */
	enabled: boolean;
	/** Defaults to `entra.allowedDomain`. */
	allowedDomain?: string;
	/** Default true. See Q1 on NOR-265. */
	autoProvisionUsers?: boolean;
};
```

**Do not forget the entrypoint.** `docker/router/entrypoint.mjs` builds `router-config.json` from env vars — a field added to the TypeScript interface but not mapped there is invisible in every hosted deployment. New vars: `CYRUS_ROUTER_SETUP_UI_ENABLED`, `CYRUS_ROUTER_SETUP_UI_ALLOWED_DOMAIN`, `CYRUS_ROUTER_SETUP_UI_AUTO_PROVISION`. `tableStore` arrives inside the existing `CYRUS_ROUTER_CONTAINERS_JSON` blob rendered by Terraform, so it needs no new var — but `apps/cli/src/commands/RouterCommand.ts`'s `RouterConfigFileSchema` (around line 184) does need the new Zod fields or the CLI will strip them.

### Definition of done for this grouping issue

1. All three children merged.
2. `terraform apply` on the dev stack is clean, and post-apply: `/healthz` answers, a Linear webhook routes end-to-end, and a worker WSS session reconnects. (Regression gate from NOR-265 risk #1.)
3. `cyrus router secrets list <email>` inside the replica returns the same keys before and after the Key Vault → Table migration.
4. A container boot for a migrated user succeeds — i.e. `ContainerTargets.buildEnv` reads the Table backend and `isFullyAuthenticated` passes.
5. An F1 test drive covering delegate → boot → activity posting, per the `CLAUDE.md` testing mandate.





---

# NOR-268: Set up Entra authentication and app registration

**State:** Backlog | **Priority:** --- | **Assignee:** Unassigned | **Project:** Cyrus | **Milestone:** First multi-user release

Configure authentication for the setup management application using Entra and the ACA native auth sidecar. Create the required app registration and document the configuration needed for sign-in and protected access to the setup UI.

## Parent

- **NOR-266**: Build setup management backend foundation _[Todo]_


## Comments

### Comment

## Implementation plan — Entra authentication and app registration

Inherits decisions D1 (AllowAnonymous + in-app enforcement) and D2 (reuse the existing app registration) from NOR-265, and the `SetupPrincipal` contract from NOR-266.

**Files**
* Create: `packages/router/src/setup/principal.ts`
* Create: `packages/router/test/setup-principal.test.ts`
* Modify: `packages/router/src/index.ts` (exports)
* Modify: `packages/router/src/RouterServer.ts` (`RouterServerConfig.setupUi`)
* Modify: `docker/router/entrypoint.mjs` (env → config)
* Modify: `apps/cli/src/commands/RouterCommand.ts` (`RouterConfigFileSchema`)
* Create: `infra/azure/terraform/auth.tf`
* Modify: `infra/azure/terraform/variables.tf`, `router.tf`, `outputs.tf`
* Modify: `infra/azure/README.md`, `docs/ROUTER.md`

**Produces** (consumed by NOR-270, NOR-271): `SetupPrincipal`, `SetupAuthConfig`, `SetupAuthError`, `parseEasyAuthPrincipal`, `requireSetupPrincipal`.

---

### Background: what the sidecar gives us

ACA built-in auth ("EasyAuth") runs as a sidecar on the replica and injects claims as request headers. The relevant ones:

| Header | Contents |
| --- | --- |
| `X-MS-CLIENT-PRINCIPAL-NAME` | `preferred_username` — the email for an Entra work account |
| `X-MS-CLIENT-PRINCIPAL-ID` | the `oid`/`sub` |
| `X-MS-CLIENT-PRINCIPAL-IDP` | `aad` for Microsoft Entra ID |
| `X-MS-CLIENT-PRINCIPAL` | base64 JSON `{ auth_typ, claims: [{ typ, val }], name_typ, role_typ }` |

Microsoft documents that "External requests aren't allowed to set these headers, so they're present only if set by Container Apps." That statement is the entire trust basis of D1 and **Task 4 verifies it live**.

Sign-in/out endpoints are `/.auth/login/aad`, `/.auth/login/aad/callback`, `/.auth/logout` — all handled by the sidecar, never by our Fastify app.

---

### Task 1: `parseEasyAuthPrincipal`

- [ ] **Step 1: Write the failing tests**

`packages/router/test/setup-principal.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	parseEasyAuthPrincipal,
	requireSetupPrincipal,
	SetupAuthError,
} from "../src/setup/principal.js";

function principalHeader(claims: Array<[string, string]>): string {
	return Buffer.from(
		JSON.stringify({
			auth_typ: "aad",
			name_typ: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
			role_typ: "roles",
			claims: claims.map(([typ, val]) => ({ typ, val })),
		}),
	).toString("base64");
}

describe("parseEasyAuthPrincipal", () => {
	it("returns undefined when no identity headers are present", () => {
		expect(parseEasyAuthPrincipal({})).toBeUndefined();
	});

	it("reads the email from X-MS-CLIENT-PRINCIPAL-NAME and lowercases it", () => {
		expect(
			parseEasyAuthPrincipal({
				"x-ms-client-principal-name": "Alice@Example.COM",
				"x-ms-client-principal-id": "oid-1",
			}),
		).toEqual({ email: "alice@example.com", objectId: "oid-1" });
	});

	it("falls back through the decoded claims when the name header is absent", () => {
		expect(
			parseEasyAuthPrincipal({
				"x-ms-client-principal": principalHeader([
					["upn", "bob@example.com"],
					["name", "Bob Example"],
				]),
			}),
		).toEqual({ email: "bob@example.com", name: "Bob Example" });
	});

	it("prefers preferred_username over upn over email", () => {
		expect(
			parseEasyAuthPrincipal({
				"x-ms-client-principal": principalHeader([
					["email", "third@example.com"],
					["upn", "second@example.com"],
					["preferred_username", "first@example.com"],
				]),
			})?.email,
		).toBe("first@example.com");
	});

	it("returns undefined when the principal blob has no email-bearing claim", () => {
		expect(
			parseEasyAuthPrincipal({
				"x-ms-client-principal": principalHeader([["roles", "admin"]]),
			}),
		).toBeUndefined();
	});

	it("returns undefined for an unparseable principal blob rather than throwing", () => {
		expect(
			parseEasyAuthPrincipal({ "x-ms-client-principal": "not-base64-json" }),
		).toBeUndefined();
	});

	it("ignores array-valued headers (duplicate header injection)", () => {
		expect(
			parseEasyAuthPrincipal({
				"x-ms-client-principal-name": ["a@example.com", "b@example.com"],
			}),
		).toBeUndefined();
	});
});

describe("requireSetupPrincipal", () => {
	it("throws 401 when unauthenticated", () => {
		expect(() => requireSetupPrincipal({}, {})).toThrowError(
			expect.objectContaining({ status: 401 }),
		);
	});

	it("throws 403 when the domain is not allowed", () => {
		expect(() =>
			requireSetupPrincipal(
				{ "x-ms-client-principal-name": "eve@evil.test" },
				{ allowedDomain: "example.com" },
			),
		).toThrowError(expect.objectContaining({ status: 403 }));
	});

	it("compares the domain case-insensitively", () => {
		expect(
			requireSetupPrincipal(
				{ "x-ms-client-principal-name": "alice@EXAMPLE.com" },
				{ allowedDomain: "Example.COM" },
			).email,
		).toBe("alice@example.com");
	});

	it("is a SetupAuthError so routes can map status directly", () => {
		try {
			requireSetupPrincipal({}, {});
		} catch (error) {
			expect(error).toBeInstanceOf(SetupAuthError);
		}
	});
});
```

- [ ] **Step 2: Run to verify it fails**

`pnpm --filter cyrus-router test:run setup-principal` → FAIL, "Cannot find module '../src/setup/principal.js'".

- [ ] **Step 3: Implement**

`packages/router/src/setup/principal.ts`:

```ts
/** Claim types that carry an email, most-preferred first. */
const EMAIL_CLAIMS = [
	"preferred_username",
	"upn",
	"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn",
	"email",
	"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
] as const;

const NAME_CLAIMS = [
	"name",
	"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
] as const;

export interface SetupPrincipal {
	email: string;
	name?: string;
	objectId?: string;
}

export interface SetupAuthConfig {
	allowedDomain?: string;
}

export class SetupAuthError extends Error {
	constructor(
		readonly status: 401 | 403,
		message: string,
	) {
		super(message);
		this.name = "SetupAuthError";
	}
}

type HeaderBag = Record<string, string | string[] | undefined>;

/**
 * A duplicated header arrives as an array. That is never something the sidecar
 * produces, so treat it as hostile input and read nothing rather than guessing
 * which copy is authentic.
 */
function single(headers: HeaderBag, name: string): string | undefined {
	const value = headers[name];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function decodeClaims(blob: string): Array<{ typ?: string; val?: string }> {
	try {
		const parsed = JSON.parse(Buffer.from(blob, "base64").toString("utf-8")) as {
			claims?: Array<{ typ?: string; val?: string }>;
		};
		return Array.isArray(parsed.claims) ? parsed.claims : [];
	} catch {
		return [];
	}
}

function firstClaim(
	claims: Array<{ typ?: string; val?: string }>,
	types: readonly string[],
): string | undefined {
	for (const type of types) {
		const hit = claims.find((claim) => claim.typ === type && claim.val);
		if (hit?.val) return hit.val;
	}
	return undefined;
}

/**
 * Reads the identity Azure Container Apps' built-in auth sidecar injected.
 *
 * These headers are only trustworthy because the sidecar strips any
 * client-supplied copy before forwarding — see D1 on NOR-265. Never call this
 * on a deployment where requests can reach the app without passing through it.
 */
export function parseEasyAuthPrincipal(
	headers: HeaderBag,
): SetupPrincipal | undefined {
	const claims = (() => {
		const blob = single(headers, "x-ms-client-principal");
		return blob ? decodeClaims(blob) : [];
	})();

	const email =
		single(headers, "x-ms-client-principal-name") ??
		firstClaim(claims, EMAIL_CLAIMS);
	if (!email) return undefined;

	const name = firstClaim(claims, NAME_CLAIMS);
	const objectId = single(headers, "x-ms-client-principal-id");
	return {
		email: email.toLowerCase(),
		...(name ? { name } : {}),
		...(objectId ? { objectId } : {}),
	};
}

/** {@link parseEasyAuthPrincipal} plus the domain gate, as a throwing call. */
export function requireSetupPrincipal(
	headers: HeaderBag,
	config: SetupAuthConfig,
): SetupPrincipal {
	const principal = parseEasyAuthPrincipal(headers);
	if (!principal) {
		throw new SetupAuthError(401, "not signed in");
	}
	if (config.allowedDomain) {
		const domain = principal.email.split("@")[1]?.toLowerCase();
		if (domain !== config.allowedDomain.toLowerCase()) {
			throw new SetupAuthError(403, "account domain is not allowed");
		}
	}
	return principal;
}
```

- [ ] **Step 4: Run to verify it passes**

`pnpm --filter cyrus-router test:run setup-principal` → PASS.

- [ ] **Step 5: Export and commit**

Add to `packages/router/src/index.ts` next to the existing enrollment exports:

```ts
export {
	parseEasyAuthPrincipal,
	requireSetupPrincipal,
	SetupAuthError,
	type SetupAuthConfig,
	type SetupPrincipal,
} from "./setup/principal.js";
```

```bash
git add packages/router/src/setup/principal.ts packages/router/test/setup-principal.test.ts packages/router/src/index.ts
git commit -m "feat(router): parse the ACA built-in auth principal headers"
```

---

### Task 2: config plumbing

- [ ] **Step 1: Write the failing test**

Append to `packages/router/test/RouterServer.test.ts`:

```ts
it("refuses to start with devTrustHeaders enabled alongside entra config", () => {
	expect(
		() =>
			new RouterServer({
				port: 0,
				dbPath: join(tmpdir(), `router-${Date.now()}.db`),
				workspaces: {},
				webhook: { verificationMode: "direct", secret: "x" },
				entra: { tenantId: "t", audience: "api://a" },
				setupUi: { enabled: true, devTrustHeaders: true },
			}),
	).toThrowError(/devTrustHeaders/);
});
```

- [ ] **Step 2: Run it — FAIL** (`setupUi` is not a known property).

- [ ] **Step 3: Implement**

In `packages/router/src/RouterServer.ts`, add to `RouterServerConfig`:

```ts
/**
 * Opt-in web UI for managing per-user container environment variables.
 * Omitting it (the default) registers no `/setup` routes at all.
 */
setupUi?: {
	enabled: boolean;
	/** Defaults to `entra.allowedDomain`. */
	allowedDomain?: string;
	/** Default true. See NOR-265 Q1. */
	autoProvisionUsers?: boolean;
	/**
	 * LOCAL DEVELOPMENT ONLY. Accepts `X-MS-CLIENT-PRINCIPAL-*` headers with no
	 * auth sidecar in front, so `/setup` can be exercised without Azure. In a
	 * real deployment this makes the page trivially impersonatable, which is
	 * why the constructor refuses to start when it is combined with `entra`.
	 */
	devTrustHeaders?: boolean;
};
```

And at the top of the constructor, before any other work:

```ts
if (config.setupUi?.devTrustHeaders && config.entra) {
	throw new Error(
		"setupUi.devTrustHeaders is a local-development escape hatch and cannot be used on a deployment configured with Entra. Remove it from router-config.json.",
	);
}
```

- [ ] **Step 4: Run it — PASS.**

- [ ] **Step 5: Map the env vars in `docker/router/entrypoint.mjs`**

Immediately after the existing `CYRUS_ROUTER_ENTRA_*` block (~line 206):

```js
if (env.CYRUS_ROUTER_SETUP_UI_ENABLED) {
	config.setupUi = {
		enabled: toBoolean(
			"CYRUS_ROUTER_SETUP_UI_ENABLED",
			env.CYRUS_ROUTER_SETUP_UI_ENABLED,
		),
		...(env.CYRUS_ROUTER_SETUP_UI_ALLOWED_DOMAIN
			? { allowedDomain: env.CYRUS_ROUTER_SETUP_UI_ALLOWED_DOMAIN }
			: {}),
		...(env.CYRUS_ROUTER_SETUP_UI_AUTO_PROVISION
			? {
					autoProvisionUsers: toBoolean(
						"CYRUS_ROUTER_SETUP_UI_AUTO_PROVISION",
						env.CYRUS_ROUTER_SETUP_UI_AUTO_PROVISION,
					),
				}
			: {}),
	};
}
```

Add a matching case to `docker/router/entrypoint.test.mjs` asserting the generated `router-config.json` contains `setupUi.enabled === true`.

- [ ] **Step 6: Widen the CLI Zod schema**

`apps/cli/src/commands/RouterCommand.ts`, in `RouterConfigFileSchema` (~line 184) — the CLI reads and rewrites `router-config.json`, so an unmodelled field is silently dropped:

```ts
setupUi: z
	.object({
		enabled: z.boolean(),
		allowedDomain: z.string().optional(),
		autoProvisionUsers: z.boolean().optional(),
		devTrustHeaders: z.boolean().optional(),
	})
	.optional(),
```

- [ ] **Step 7: Commit**

```bash
git add packages/router/src/RouterServer.ts packages/router/test/RouterServer.test.ts \
  docker/router/entrypoint.mjs docker/router/entrypoint.test.mjs \
  apps/cli/src/commands/RouterCommand.ts
git commit -m "feat(router): add setupUi config surface and dev-header guard"
```

---

### Task 3: Entra app registration (manual, documented)

Per D2 we extend the **existing** router app registration rather than minting a second one — `CLAUDE.md` records "one app registration/audience per router deployment" as an invariant.

- [ ] **Step 1: Extend the app registration**

```bash
APP_ID=<the existing router app registration's client id>
FQDN=$(terraform -chdir=infra/azure/terraform output -raw router_fqdn)

# EasyAuth needs implicit ID token issuance.
az ad app update --id "$APP_ID" --enable-id-token-issuance true

# Add the callback WITHOUT dropping any existing web redirect URIs.
EXISTING=$(az ad app show --id "$APP_ID" --query "web.redirectUris" -o tsv | tr '\n' ' ')
az ad app update --id "$APP_ID" \
  --web-redirect-uris $EXISTING "https://$FQDN/.auth/login/aad/callback"

# One client secret for the sidecar. Record the value; it is shown once.
az ad app credential reset --id "$APP_ID" \
  --display-name "cyrus-router-easyauth" --years 2 --query password -o tsv
```

`az ad app update --web-redirect-uris` **replaces** the list — the `EXISTING` capture above is not optional. Overwriting it breaks enrollment sign-in.

- [ ] **Step 2: Restrict who can sign in (recommended)**

By default any account in the tenant can obtain a token for the app. Set *Assignment required* and assign the Cyrus users group:

```bash
az ad sp update --id "$APP_ID" --set appRoleAssignmentRequired=true
```

Note this in the README as the enforcement point that `entra_allowed_domain` alone does not provide.

- [ ] **Step 3: Record the secret as a tfvar**

Add to `dev.tfvars` (which is gitignored):

```hcl
setup_ui_client_id     = "<APP_ID>"
setup_ui_client_secret = "<the password from step 1>"
```

- [ ] **Step 4: Document**

Rewrite `infra/azure/README.md` §8 to cover both uses of the single app registration (enrollment token validation *and* EasyAuth sign-in), and mirror it into `docs/ROUTER.md` under "Key Vault and Entra operations".

---

### Task 4: Terraform — the `authConfigs` resource

- [ ] **Step 1: Add variables**

`infra/azure/terraform/variables.tf`:

```hcl
variable "enable_setup_ui" {
  description = "Enable the authenticated setup management UI: attaches the ACA built-in auth (EasyAuth) sidecar to the router Container App and turns on the router's /setup routes."
  type        = bool
  default     = false
}

variable "setup_ui_client_id" {
  description = "Client id of the router Entra app registration used by the auth sidecar. Required when enable_setup_ui is true."
  type        = string
  default     = null
}

variable "setup_ui_client_secret" {
  description = "Client secret for setup_ui_client_id. Stored in Key Vault and referenced by the Container App as a secret; never rendered into an output."
  type        = string
  default     = null
  sensitive   = true
}

variable "setup_ui_allowed_domain" {
  description = "Optional email domain allowlist enforced in-app on /setup, on top of the app registration's own assignment requirement."
  type        = string
  default     = null
}

variable "setup_ui_auto_provision_users" {
  description = "Create a router user record on a teammate's first successful /setup sign-in. See NOR-265 Q1."
  type        = bool
  default     = true
}

locals {
  setup_ui_enabled = var.enable_setup_ui
}

# Fail the plan rather than producing an auth config that cannot authenticate.
resource "terraform_data" "validate_setup_ui" {
  count = var.enable_setup_ui && (var.setup_ui_client_id == null || var.setup_ui_client_secret == null) ? 1 : 0
  lifecycle {
    precondition {
      condition     = false
      error_message = "enable_setup_ui requires setup_ui_client_id and setup_ui_client_secret."
    }
  }
}
```

- [ ] **Step 2: Create `infra/azure/terraform/auth.tf`**

```hcl
################################################################################
# ACA built-in authentication (EasyAuth) for the setup management UI
#
# `unauthenticatedClientAction = AllowAnonymous` is deliberate — see D1 on
# NOR-265. The router serves machine routes with dynamic path segments
# (/artifacts/issues/:issueKey/bundle, /containers/issues/:issueKey/
# teardown-complete), a WebSocket upgrade at /device, and the Linear webhook.
# `globalValidation.excludedPaths` is a path list with no documented wildcard
# semantics, so a default-deny posture would silently break webhook delivery
# and every worker's WSS. The router enforces authentication itself on /setup*,
# reading the identity headers the sidecar injects (and which it strips from
# client requests).
################################################################################

resource "azurerm_key_vault_secret" "setup_ui_client_secret" {
  count        = local.setup_ui_enabled ? 1 : 0
  name         = "setup-ui-client-secret"
  value        = var.setup_ui_client_secret
  key_vault_id = azurerm_key_vault.this.id
}

resource "azapi_resource" "router_auth" {
  count     = local.setup_ui_enabled ? 1 : 0
  type      = "Microsoft.App/containerApps/authConfigs@2024-03-01"
  name      = "current" # the only permitted name for this child resource
  parent_id = azurerm_container_app.router.id

  body = {
    properties = {
      platform = {
        enabled = true
      }
      globalValidation = {
        unauthenticatedClientAction = "AllowAnonymous"
      }
      httpSettings = {
        requireHttps = true
      }
      identityProviders = {
        azureActiveDirectory = {
          enabled = true
          registration = {
            openIdIssuer           = "https://login.microsoftonline.com/${var.entra_tenant_id}/v2.0"
            clientId               = var.setup_ui_client_id
            clientSecretSettingName = "setup-ui-client-secret"
          }
          validation = {
            allowedAudiences = compact([
              var.setup_ui_client_id,
              var.entra_audience,
            ])
          }
        }
      }
    }
  }

  depends_on = [azurerm_container_app.router]
}
```

- [ ] **Step 3: Wire the client secret + setup env into the Container App**

In `infra/azure/terraform/router.tf`, add alongside the existing `secret` blocks:

```hcl
dynamic "secret" {
  for_each = local.setup_ui_enabled ? toset(["setup-ui"]) : toset([])
  content {
    name                = "setup-ui-client-secret"
    identity            = azurerm_user_assigned_identity.router.id
    key_vault_secret_id = azurerm_key_vault_secret.setup_ui_client_secret[0].versionless_id
  }
}
```

and inside `template.container`, after the Entra env blocks:

```hcl
dynamic "env" {
  for_each = local.setup_ui_enabled ? toset(["setup-ui"]) : toset([])
  content {
    name  = "CYRUS_ROUTER_SETUP_UI_ENABLED"
    value = "true"
  }
}
dynamic "env" {
  for_each = local.setup_ui_enabled && var.setup_ui_allowed_domain != null ? toset(["setup-ui-domain"]) : toset([])
  content {
    name  = "CYRUS_ROUTER_SETUP_UI_ALLOWED_DOMAIN"
    value = var.setup_ui_allowed_domain
  }
}
dynamic "env" {
  for_each = local.setup_ui_enabled ? toset(["setup-ui-provision"]) : toset([])
  content {
    name  = "CYRUS_ROUTER_SETUP_UI_AUTO_PROVISION"
    value = tostring(var.setup_ui_auto_provision_users)
  }
}
```

The `secret` block must exist on the Container App before the authConfig references it by `clientSecretSettingName` — hence the `depends_on` in Task 4 Step 2. Note the Container App itself does **not** depend on the authConfig, so there is no cycle.

- [ ] **Step 4: Add an output**

`infra/azure/terraform/outputs.tf`:

```hcl
output "setup_ui_url" {
  description = "Where teammates manage their environment variables. Null when enable_setup_ui is false."
  value       = local.setup_ui_enabled ? "https://${azurerm_container_app.router.ingress[0].fqdn}/setup" : null
}
```

- [ ] **Step 5: Plan and apply against dev**

```bash
terraform -chdir=infra/azure/terraform plan -var-file=dev.tfvars
terraform -chdir=infra/azure/terraform apply -var-file=dev.tfvars
```

- [ ] **Step 6: THE REGRESSION GATE — verify machine routes still work**

This is the acceptance criterion, not a formality. `authConfigs` changes ingress for the whole app.

```bash
FQDN=$(terraform -chdir=infra/azure/terraform output -raw router_fqdn)

# 1. Health probe still answers anonymously (ACA's own readiness probe depends on this).
curl -fsS "https://$FQDN/healthz"                         # expect {"status":"ok"}

# 2. Unauthenticated machine routes still reach the app, not the login page.
curl -s -o /dev/null -w '%{http_code}\n' "https://$FQDN/workspaces"   # expect 401 (our app), NOT 302
curl -s -o /dev/null -w '%{http_code}\n' -X POST "https://$FQDN/linear-webhook"  # expect 4xx from our handler, NOT 302

# 3. Worker WSS reconnect — the one that would be catastrophic to miss.
az containerapp exec --name <router-app> --resource-group "$RESOURCE_GROUP"
#   inside: cyrus router containers list   → an existing worker still shows connected
```

Any `302` to `/.auth/login/aad` on routes 2 or 3 means the config is wrong — do not proceed.

- [ ] **Step 7: THE TRUST GATE — verify header stripping**

```bash
# Forged identity header, no session cookie. MUST NOT authenticate.
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'X-MS-CLIENT-PRINCIPAL-NAME: attacker@example.com' \
  "https://$FQDN/setup"
# expect 401 — the sidecar strips the header before the app sees it.
```

If this returns 200, **stop and escalate**. The fallback is to enable the ACA token store and additionally verify `X-MS-TOKEN-AAD-ID-TOKEN` with the existing `createEntraTokenVerifier()` from `packages/router/src/enrollment.ts` — that function already validates issuer and audience against the same tenant, so the change is contained to `requireSetupPrincipal`, but it adds a blob storage container to the Terraform stack.

(`/setup` returns 404 until NOR-271 lands — run this gate as part of NOR-271's acceptance if 268 merges first, and record the result on this issue either way.)

- [ ] **Step 8: Commit**

```bash
git add infra/azure/terraform/auth.tf infra/azure/terraform/variables.tf \
  infra/azure/terraform/router.tf infra/azure/terraform/outputs.tf \
  infra/azure/README.md docs/ROUTER.md
git commit -m "feat(infra): attach the ACA auth sidecar for the setup UI"
```

---

### Also update

* `CHANGELOG.internal.md` under `## [Unreleased]` → `### Added` (infra/auth plumbing is not user-facing until the UI ships).
* `docs/ROUTER.md` env var table (~line 228) with the three new `CYRUS_ROUTER_SETUP_UI_*` vars.
* `scripts/check-aca-arm-parity.sh` — check whether it needs to know about the new child resource.

### Definition of done

1. `pnpm --filter cyrus-router test:run` and `pnpm typecheck` pass.
2. `terraform plan` is clean and idempotent on a second apply.
3. Steps 6 and 7 above both pass, with the output pasted into this issue.
4. `enable_setup_ui = false` produces a plan with **no** diff against the current stack.





---

# NOR-269: Move user environment variable storage to Azure Table with envelope encryption

**State:** Backlog | **Priority:** --- | **Assignee:** Unassigned | **Project:** Cyrus | **Milestone:** First multi-user release

Replace key vault storage for user environment variables with Azure Table storage protected by envelope encryption. Define the table schema, encryption approach, and read/write path needed by the setup management feature.

## Parent

- **NOR-266**: Build setup management backend foundation _[Todo]_


## Comments

### Comment

## Implementation plan — Azure Table storage with envelope encryption

Inherits D3 (one entity per user) and D4 (fresh DEK per write, Key Vault RSA KEK) from NOR-265, and the `TableSecretStore` contract from NOR-266.

**Files**
* Create: `packages/router/src/setup/envelope.ts`, `packages/router/src/TableSecretStore.ts`
* Create: `packages/router/test/setup-envelope.test.ts`, `packages/router/test/TableSecretStore.test.ts`
* Modify: `packages/router/src/RouterServer.ts` (`tableStore` config + backend selection)
* Modify: `packages/router/src/index.ts` (exports)
* Modify: `apps/cli/src/commands/RouterCommand.ts` (`openSecretStore`, Zod schema, `secrets migrate`)
* Modify: `infra/azure/terraform/main.tf`, `variables.tf`, `router.tf`, `outputs.tf`
* Modify: `docs/ROUTER.md`, `infra/azure/README.md`, `docker/worker/README.md`

**Produces**: `TableSecretStore`, `SetupConflictError`, `setupPartitionKey`, `SETUP_ROW_KEY`, `sealBundle`, `openBundle`, `KeyVaultKeyWrapper`.

---

### Why this replaces Key Vault

The current `KeyVaultSecretStore` stores one Key Vault secret per (user, env-var) pair, named `u<sha256(email):20>-<sha256(key):10>`, with `email`/`key` tags carrying the reversible metadata. That works but has three properties that make a UI painful:

* **`get(email)` is a full vault list plus one GET per secret.** Rendering a page for a user with ten variables is eleven round trips, and the list call is not filtered server-side.
* **No transactional unit.** Saving a form of ten values is ten independent PUTs; a partial failure leaves a half-saved record with no way to detect it.
* **No ETag.** Two browser tabs saving concurrently silently last-write-wins per key, interleaving into a state neither user submitted.

One Table entity per user fixes all three: one GET, one PUT, one ETag.

### Data model

Table `cyrussetup` (name must be alphanumeric and not start with a digit).

| Property | Type | Contents |
| --- | --- | --- |
| `PartitionKey` | string | `u` + `sha256(lowercase email)` hex, full 64 chars |
| `RowKey` | string | `bundle` (constant — one record per user) |
| `Email` | string | lowercase email, for `secrets list` / admin reversibility |
| `SchemaVersion` | int32 | `1` |
| `KekKeyId` | string | **versioned** Key Vault key id, e.g. `https://kv.vault.azure.net/keys/cyrus-setup-kek/abc123` |
| `WrappedDek` | string | base64 of the RSA-OAEP-256-wrapped 32-byte DEK |
| `Iv` | string | base64 of the 12-byte GCM IV |
| `AuthTag` | string | base64 of the 16-byte GCM tag |
| `Ciphertext` | string | base64 of AES-256-GCM(JSON.stringify(bundle)) |
| `UpdatedMs` | int64 | last write, for admin diagnostics |

Notes on the choices:

* **PartitionKey is a hash, not the email.** Table keys forbid `/ \ # ?`; an email is legal today but the hash removes any future encoding question and keeps PII out of the key, which appears in URLs and in Storage diagnostic logs.
* **`KekKeyId` is the versioned id.** Storing the versionless id would make it impossible to tell, after a key rotation, whether a given record still needs re-wrapping.
* **GCM AAD = `${PartitionKey}|${RowKey}|${SchemaVersion}`.** A ciphertext copied onto a different user's row fails to authenticate rather than decrypting into their environment.

---

### Task 1: envelope crypto

- [ ] **Step 1: Write the failing tests**

`packages/router/test/setup-envelope.test.ts`:

```ts
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	type KeyWrapper,
	openBundle,
	sealBundle,
} from "../src/setup/envelope.js";

/** Deterministic stand-in for Key Vault: XOR wrap, so tests need no network. */
function fakeWrapper(kid = "https://kv.test/keys/kek/v1"): KeyWrapper {
	const mask = Buffer.alloc(32, 0xab);
	return {
		async wrap(dek) {
			const wrapped = Buffer.alloc(dek.length);
			for (let i = 0; i < dek.length; i++) wrapped[i] = dek[i]! ^ mask[i]!;
			return { kid, wrapped };
		},
		async unwrap(_kid, wrapped) {
			const dek = Buffer.alloc(wrapped.length);
			for (let i = 0; i < wrapped.length; i++) dek[i] = wrapped[i]! ^ mask[i]!;
			return dek;
		},
	};
}

describe("sealBundle / openBundle", () => {
	const aad = "upk|bundle|1";

	it("round-trips a bundle", async () => {
		const bundle = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-x", GIT_TOKEN: "ghp_y" };
		const sealed = await sealBundle(bundle, fakeWrapper(), aad);
		expect(await openBundle(sealed, fakeWrapper(), aad)).toEqual(bundle);
	});

	it("round-trips an empty bundle", async () => {
		const sealed = await sealBundle({}, fakeWrapper(), aad);
		expect(await openBundle(sealed, fakeWrapper(), aad)).toEqual({});
	});

	it("never leaks a plaintext value into the envelope", async () => {
		const sealed = await sealBundle(
			{ SECRET: "correct-horse-battery-staple" },
			fakeWrapper(),
			aad,
		);
		expect(JSON.stringify(sealed)).not.toContain("correct-horse");
		expect(JSON.stringify(sealed)).not.toContain("SECRET");
	});

	it("uses a fresh IV and DEK on every seal", async () => {
		const a = await sealBundle({ K: "v" }, fakeWrapper(), aad);
		const b = await sealBundle({ K: "v" }, fakeWrapper(), aad);
		expect(a.iv).not.toBe(b.iv);
		expect(a.ciphertext).not.toBe(b.ciphertext);
	});

	it("rejects a tampered ciphertext", async () => {
		const sealed = await sealBundle({ K: "v" }, fakeWrapper(), aad);
		const raw = Buffer.from(sealed.ciphertext, "base64");
		raw[0] ^= 0xff;
		await expect(
			openBundle(
				{ ...sealed, ciphertext: raw.toString("base64") },
				fakeWrapper(),
				aad,
			),
		).rejects.toThrow();
	});

	it("rejects a record replayed under a different AAD", async () => {
		const sealed = await sealBundle({ K: "v" }, fakeWrapper(), "userA|bundle|1");
		await expect(
			openBundle(sealed, fakeWrapper(), "userB|bundle|1"),
		).rejects.toThrow();
	});

	it("records the versioned key id the DEK was wrapped with", async () => {
		const sealed = await sealBundle({}, fakeWrapper("https://kv.test/keys/kek/v9"), aad);
		expect(sealed.kid).toBe("https://kv.test/keys/kek/v9");
	});

	it("passes the stored kid back to unwrap so a rotated KEK still opens old rows", async () => {
		const seen: string[] = [];
		const wrapper = fakeWrapper("https://kv.test/keys/kek/v1");
		const spy: KeyWrapper = {
			wrap: wrapper.wrap,
			unwrap: async (kid, wrapped) => {
				seen.push(kid);
				return wrapper.unwrap(kid, wrapped);
			},
		};
		const sealed = await sealBundle({ K: "v" }, spy, aad);
		await openBundle(sealed, spy, aad);
		expect(seen).toEqual(["https://kv.test/keys/kek/v1"]);
	});

	it("ignores a random 32-byte DEK's content — any wrapper output works", async () => {
		expect(randomBytes(32)).toHaveLength(32); // sanity anchor for the constant
	});
});
```

- [ ] **Step 2: Run — FAIL** (`Cannot find module '../src/setup/envelope.js'`).

- [ ] **Step 3: Implement `packages/router/src/setup/envelope.ts`**

```ts
import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
} from "node:crypto";
import type { UserSecretBundle } from "../SecretStore.js";

const ALGORITHM = "aes-256-gcm";
const DEK_BYTES = 32;
const IV_BYTES = 12;
const WRAP_ALG = "RSA-OAEP-256";
const KEY_VAULT_SCOPE = "https://vault.azure.net/.default";

/** An encrypted bundle plus everything needed to open it. No plaintext. */
export interface SealedBundle {
	/** Versioned Key Vault key id the DEK was wrapped with. */
	kid: string;
	/** base64 */
	wrappedDek: string;
	/** base64 */
	iv: string;
	/** base64 */
	authTag: string;
	/** base64 */
	ciphertext: string;
}

/** Wraps and unwraps a data encryption key. The Key Vault seam. */
export interface KeyWrapper {
	wrap(dek: Buffer): Promise<{ kid: string; wrapped: Buffer }>;
	unwrap(kid: string, wrapped: Buffer): Promise<Buffer>;
}

/**
 * Encrypts `bundle` under a **fresh** 256-bit DEK and wraps that DEK with the
 * KEK. A new DEK per write means a compromised single-record DEK never widens
 * to the rest of the table, and it removes any IV-reuse hazard entirely.
 *
 * `aad` binds the ciphertext to the row it lives on — see D4 on NOR-265.
 */
export async function sealBundle(
	bundle: UserSecretBundle,
	wrapper: KeyWrapper,
	aad: string,
): Promise<SealedBundle> {
	const dek = randomBytes(DEK_BYTES);
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv(ALGORITHM, dek, iv);
	cipher.setAAD(Buffer.from(aad, "utf-8"));
	const ciphertext = Buffer.concat([
		cipher.update(JSON.stringify(bundle), "utf-8"),
		cipher.final(),
	]);
	const authTag = cipher.getAuthTag();
	const { kid, wrapped } = await wrapper.wrap(dek);
	dek.fill(0);
	return {
		kid,
		wrappedDek: wrapped.toString("base64"),
		iv: iv.toString("base64"),
		authTag: authTag.toString("base64"),
		ciphertext: ciphertext.toString("base64"),
	};
}

/** Inverse of {@link sealBundle}. Throws on any tampering or AAD mismatch. */
export async function openBundle(
	sealed: SealedBundle,
	wrapper: KeyWrapper,
	aad: string,
): Promise<UserSecretBundle> {
	const dek = await wrapper.unwrap(
		sealed.kid,
		Buffer.from(sealed.wrappedDek, "base64"),
	);
	try {
		const decipher = createDecipheriv(
			ALGORITHM,
			dek,
			Buffer.from(sealed.iv, "base64"),
		);
		decipher.setAAD(Buffer.from(aad, "utf-8"));
		decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));
		const plaintext = Buffer.concat([
			decipher.update(Buffer.from(sealed.ciphertext, "base64")),
			decipher.final(),
		]);
		return JSON.parse(plaintext.toString("utf-8")) as UserSecretBundle;
	} finally {
		dek.fill(0);
	}
}

/** Key Vault crypto payloads are base64url, not base64. */
function toBase64Url(buffer: Buffer): string {
	return buffer.toString("base64url");
}

export interface KeyVaultKeyWrapperOptions {
	/** Versioned key id: https://<vault>/keys/<name>/<version> */
	keyId: string;
	tokenProvider?: () => Promise<string>;
	fetchFn?: typeof fetch;
}

export function createKeyVaultCryptoTokenProvider(): () => Promise<string> {
	let credential:
		| { getToken(scope: string): Promise<{ token: string } | null> }
		| undefined;
	return async () => {
		if (!credential) {
			const { DefaultAzureCredential } = await import("@azure/identity");
			credential = new DefaultAzureCredential();
		}
		const token = await credential!.getToken(KEY_VAULT_SCOPE);
		if (!token?.token)
			throw new Error("DefaultAzureCredential returned no access token");
		return token.token;
	};
}

/**
 * Key Vault REST 7.4 wrapKey/unwrapKey. Needs the *Key Vault Crypto User* role
 * on the vault — the router's existing Secrets User/Officer grants do not cover
 * key operations.
 */
export class KeyVaultKeyWrapper implements KeyWrapper {
	private readonly keyId: string;
	private readonly tokenProvider: () => Promise<string>;
	private readonly fetchFn: typeof fetch;

	constructor(opts: KeyVaultKeyWrapperOptions) {
		this.keyId = opts.keyId.replace(/\/$/, "");
		this.tokenProvider =
			opts.tokenProvider ?? createKeyVaultCryptoTokenProvider();
		this.fetchFn = opts.fetchFn ?? fetch;
	}

	async wrap(dek: Buffer): Promise<{ kid: string; wrapped: Buffer }> {
		const body = await this.crypto(this.keyId, "wrapkey", toBase64Url(dek));
		return {
			// Prefer the kid Key Vault echoes back: if `keyId` was versionless,
			// this is what pins the record to the version actually used.
			kid: body.kid ?? this.keyId,
			wrapped: Buffer.from(body.value, "base64url"),
		};
	}

	async unwrap(kid: string, wrapped: Buffer): Promise<Buffer> {
		const body = await this.crypto(kid, "unwrapkey", toBase64Url(wrapped));
		return Buffer.from(body.value, "base64url");
	}

	private async crypto(
		keyId: string,
		operation: "wrapkey" | "unwrapkey",
		value: string,
	): Promise<{ kid?: string; value: string }> {
		const url = `${keyId}/${operation}?api-version=7.4`;
		const response = await this.fetchFn(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${await this.tokenProvider()}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ alg: WRAP_ALG, value }),
		});
		if (!response.ok) {
			throw new Error(
				`Key Vault ${operation} ${url} failed (${response.status}): ${await response.text()}`,
			);
		}
		return (await response.json()) as { kid?: string; value: string };
	}
}
```

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Commit**

```bash
git add packages/router/src/setup/envelope.ts packages/router/test/setup-envelope.test.ts
git commit -m "feat(router): envelope encryption for user secret bundles"
```

---

### Task 2: `TableSecretStore`

- [ ] **Step 1: Write the failing tests**

`packages/router/test/TableSecretStore.test.ts` — model the fetch fake on the existing `KeyVaultSecretStore.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { SetupConflictError, TableSecretStore } from "../src/TableSecretStore.js";

const ENDPOINT = "https://sttest.table.core.windows.net";
const KEY_ID = "https://kv.test/keys/kek/v1";

/** In-memory Table + Key Vault crypto double. */
function harness(seed: Record<string, Record<string, unknown>> = {}) {
	const rows = new Map(Object.entries(seed));
	let etagCounter = 0;
	const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";

		if (url.includes("/wrapkey") || url.includes("/unwrapkey")) {
			const { value } = JSON.parse(String(init?.body)) as { value: string };
			// Identity "wrap": exercises encoding, not cryptography.
			return new Response(JSON.stringify({ kid: KEY_ID, value }), {
				status: 200,
			});
		}

		const key = url.slice(url.indexOf("cyrussetup")).split("?")[0]!;
		if (method === "GET") {
			const row = rows.get(key);
			if (!row) return new Response("", { status: 404 });
			return new Response(JSON.stringify(row), {
				status: 200,
				headers: { ETag: String(row.__etag) },
			});
		}
		if (method === "POST") {
			const row = JSON.parse(String(init?.body)) as Record<string, unknown>;
			const insertKey = `cyrussetup(PartitionKey='${row.PartitionKey}',RowKey='${row.RowKey}')`;
			if (rows.has(insertKey)) return new Response("", { status: 409 });
			rows.set(insertKey, { ...row, __etag: `W/"${++etagCounter}"` });
			return new Response("", { status: 204 });
		}
		if (method === "PUT") {
			const ifMatch = new Headers(init?.headers).get("if-match");
			const existing = rows.get(key);
			if (ifMatch && ifMatch !== "*" && existing?.__etag !== ifMatch) {
				return new Response("", { status: 412 });
			}
			const row = JSON.parse(String(init?.body)) as Record<string, unknown>;
			rows.set(key, { ...row, __etag: `W/"${++etagCounter}"` });
			return new Response("", {
				status: 204,
				headers: { ETag: `W/"${etagCounter}"` },
			});
		}
		throw new Error(`unexpected ${method} ${url}`);
	});

	const store = new TableSecretStore({
		tableEndpoint: ENDPOINT,
		tableName: "cyrussetup",
		keyId: KEY_ID,
		tokenProvider: async () => "storage-token",
		keyVaultTokenProvider: async () => "vault-token",
		fetchFn: fetchFn as unknown as typeof fetch,
		now: () => 1_000,
	});
	return { store, fetchFn, rows };
}

describe("TableSecretStore", () => {
	it("returns an empty bundle for a user with no record", async () => {
		const { store } = harness();
		expect(await store.get("alice@example.com")).toEqual({});
	});

	it("round-trips a value through set/get", async () => {
		const { store } = harness();
		await store.set("alice@example.com", "GIT_TOKEN", "ghp_x");
		expect(await store.get("alice@example.com")).toEqual({ GIT_TOKEN: "ghp_x" });
	});

	it("is case-insensitive on email", async () => {
		const { store } = harness();
		await store.set("Alice@Example.COM", "GIT_TOKEN", "ghp_x");
		expect(await store.get("alice@example.com")).toEqual({ GIT_TOKEN: "ghp_x" });
	});

	it("maps legacy key names through normalizeSecretKey", async () => {
		const { store } = harness();
		await store.set("alice@example.com", "githubPat", "ghp_x");
		expect(await store.get("alice@example.com")).toEqual({ GIT_TOKEN: "ghp_x" });
	});

	it("rejects reserved env keys before any network call", async () => {
		const { store, fetchFn } = harness();
		await expect(
			store.set("alice@example.com", "CYRUS_DEVICE_TOKEN", "x"),
		).rejects.toThrow(/reserved/);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("removes a key when the value is undefined", async () => {
		const { store } = harness();
		await store.set("alice@example.com", "A", "1");
		await store.set("alice@example.com", "B", "2");
		await store.set("alice@example.com", "A", undefined);
		expect(await store.get("alice@example.com")).toEqual({ B: "2" });
	});

	it("reports missing required keys", async () => {
		const { store } = harness();
		await store.set("alice@example.com", "A", "1");
		expect(
			await store.isFullyAuthenticated("alice@example.com", ["A", "B"]),
		).toEqual({ ok: false, missing: ["B"] });
	});

	it("treats an empty string as missing", async () => {
		const { store } = harness();
		await store.set("alice@example.com", "A", "");
		expect(
			await store.isFullyAuthenticated("alice@example.com", ["A"]),
		).toEqual({ ok: false, missing: ["A"] });
	});

	it("never writes a plaintext value into the entity body", async () => {
		const { store, fetchFn } = harness();
		await store.set("alice@example.com", "GIT_TOKEN", "super-secret-value");
		const bodies = fetchFn.mock.calls
			.map(([, init]) => String((init as RequestInit | undefined)?.body ?? ""))
			.join("\n");
		expect(bodies).not.toContain("super-secret-value");
	});

	it("does not put the email in the partition key", async () => {
		const { store, fetchFn } = harness();
		await store.set("alice@example.com", "A", "1");
		const urls = fetchFn.mock.calls.map(([input]) => String(input)).join("\n");
		expect(urls).not.toContain("alice@example.com");
	});

	it("returns an etag from getRecord", async () => {
		const { store } = harness();
		await store.set("alice@example.com", "A", "1");
		const record = await store.getRecord("alice@example.com");
		expect(record?.bundle).toEqual({ A: "1" });
		expect(record?.etag).toMatch(/^W\//);
	});

	it("putRecord with a stale etag throws SetupConflictError", async () => {
		const { store } = harness();
		await store.set("alice@example.com", "A", "1");
		const first = await store.getRecord("alice@example.com");
		await store.putRecord("alice@example.com", { A: "2" }, first!.etag);
		await expect(
			store.putRecord("alice@example.com", { A: "3" }, first!.etag),
		).rejects.toBeInstanceOf(SetupConflictError);
	});

	it("ensureRecord creates required keys as empty strings", async () => {
		const { store } = harness();
		expect(
			await store.ensureRecord("alice@example.com", ["CLAUDE_CODE_OAUTH_TOKEN"]),
		).toEqual({ created: true });
		expect(await store.get("alice@example.com")).toEqual({
			CLAUDE_CODE_OAUTH_TOKEN: "",
		});
	});

	it("ensureRecord is idempotent and never clobbers an existing value", async () => {
		const { store } = harness();
		await store.set("alice@example.com", "CLAUDE_CODE_OAUTH_TOKEN", "real");
		expect(
			await store.ensureRecord("alice@example.com", ["CLAUDE_CODE_OAUTH_TOKEN"]),
		).toEqual({ created: false });
		expect(await store.get("alice@example.com")).toEqual({
			CLAUDE_CODE_OAUTH_TOKEN: "real",
		});
	});

	it("ensureRecord backfills a newly-required key onto an existing record", async () => {
		const { store } = harness();
		await store.set("alice@example.com", "CLAUDE_CODE_OAUTH_TOKEN", "real");
		expect(
			await store.ensureRecord("alice@example.com", [
				"CLAUDE_CODE_OAUTH_TOKEN",
				"LINEAR_API_TOKEN",
			]),
		).toEqual({ created: true });
		expect(await store.get("alice@example.com")).toEqual({
			CLAUDE_CODE_OAUTH_TOKEN: "real",
			LINEAR_API_TOKEN: "",
		});
	});

	it("caches reads briefly and invalidates on write", async () => {
		const { store, fetchFn } = harness();
		await store.set("alice@example.com", "A", "1");
		await store.get("alice@example.com");
		const afterFirst = fetchFn.mock.calls.length;
		await store.get("alice@example.com");
		expect(fetchFn.mock.calls.length).toBe(afterFirst); // served from cache
		await store.set("alice@example.com", "B", "2");
		await store.get("alice@example.com");
		expect(fetchFn.mock.calls.length).toBeGreaterThan(afterFirst);
	});

	it("sends the OAuth bearer token and a supported x-ms-version", async () => {
		const { store, fetchFn } = harness();
		await store.get("alice@example.com");
		const headers = new Headers(
			(fetchFn.mock.calls[0]![1] as RequestInit).headers,
		);
		expect(headers.get("authorization")).toBe("Bearer storage-token");
		expect(headers.get("x-ms-version")).toBe("2020-12-06");
		expect(headers.get("accept")).toContain("odata=nometadata");
	});

	it("throws rather than resolving to {} on a 500 from Table storage", async () => {
		const { store, fetchFn } = harness();
		fetchFn.mockResolvedValueOnce(new Response("boom", { status: 500 }));
		await expect(store.get("alice@example.com")).rejects.toThrow(/500/);
	});
});
```

That last test matters: `FileSecretStore.readAll` has an explicit comment about never degrading a read failure to `{}` because a later `set()` would then destroy the record. The Table store inherits that rule.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `packages/router/src/TableSecretStore.ts`**

```ts
import { createHash } from "node:crypto";
import {
	KeyVaultKeyWrapper,
	type KeyWrapper,
	openBundle,
	sealBundle,
} from "./setup/envelope.js";
import {
	normalizeSecretKey,
	type SecretStoreBackend,
	type UserSecretBundle,
} from "./SecretStore.js";

const STORAGE_SCOPE = "https://storage.azure.com/.default";
/** Minimum version whose Table service honours OAuth bearer tokens cleanly. */
const X_MS_VERSION = "2020-12-06";
const CACHE_TTL_MS = 60_000;
const SCHEMA_VERSION = 1;

export const SETUP_ROW_KEY = "bundle";
export const DEFAULT_TABLE_NAME = "cyrussetup";

/** Optimistic-concurrency failure — the record changed since it was read. */
export class SetupConflictError extends Error {
	constructor(message = "the record was modified by someone else") {
		super(message);
		this.name = "SetupConflictError";
	}
}

/** `u` + sha256(lowercased email). Keeps PII out of URLs and diagnostic logs. */
export function setupPartitionKey(email: string): string {
	return `u${createHash("sha256").update(email.toLowerCase()).digest("hex")}`;
}

export interface TableSecretStoreOptions {
	/** e.g. "https://<storage-account>.table.core.windows.net" */
	tableEndpoint: string;
	tableName?: string;
	/** Versioned Key Vault key id used as the KEK. */
	keyId: string;
	tokenProvider?: () => Promise<string>;
	keyVaultTokenProvider?: () => Promise<string>;
	fetchFn?: typeof fetch;
	now?: () => number;
	logger?: { warn(msg: string): void };
	/** Test seam; defaults to a {@link KeyVaultKeyWrapper} over `keyId`. */
	keyWrapper?: KeyWrapper;
}

interface TableEntity {
	PartitionKey: string;
	RowKey: string;
	Email: string;
	SchemaVersion: number;
	KekKeyId: string;
	WrappedDek: string;
	Iv: string;
	AuthTag: string;
	Ciphertext: string;
	UpdatedMs: number;
}

export function createStorageTokenProvider(): () => Promise<string> {
	let credential:
		| { getToken(scope: string): Promise<{ token: string } | null> }
		| undefined;
	return async () => {
		if (!credential) {
			const { DefaultAzureCredential } = await import("@azure/identity");
			credential = new DefaultAzureCredential();
		}
		const token = await credential!.getToken(STORAGE_SCOPE);
		if (!token?.token)
			throw new Error("DefaultAzureCredential returned no access token");
		return token.token;
	};
}

/**
 * Per-user container secrets in an Azure Table, one entity per user, encrypted
 * with envelope encryption (see {@link sealBundle}).
 *
 * Chosen over {@link KeyVaultSecretStore} for the setup UI because a whole
 * bundle is one GET, one PUT, and one ETag — which is what makes a form save
 * atomic and concurrent edits detectable. See D3 on NOR-265.
 */
export class TableSecretStore implements SecretStoreBackend {
	private readonly tableUrl: string;
	private readonly tableName: string;
	private readonly tokenProvider: () => Promise<string>;
	private readonly fetchFn: typeof fetch;
	private readonly now: () => number;
	private readonly logger: { warn(msg: string): void };
	private readonly wrapper: KeyWrapper;
	private readonly cache = new Map<
		string,
		{ expiresAt: number; bundle: UserSecretBundle; etag: string }
	>();

	constructor(opts: TableSecretStoreOptions) {
		this.tableName = opts.tableName ?? DEFAULT_TABLE_NAME;
		this.tableUrl = `${opts.tableEndpoint.replace(/\/$/, "")}/${this.tableName}`;
		this.tokenProvider = opts.tokenProvider ?? createStorageTokenProvider();
		this.fetchFn = opts.fetchFn ?? fetch;
		this.now = opts.now ?? Date.now;
		this.logger = opts.logger ?? console;
		this.wrapper =
			opts.keyWrapper ??
			new KeyVaultKeyWrapper({
				keyId: opts.keyId,
				tokenProvider: opts.keyVaultTokenProvider,
				fetchFn: opts.fetchFn,
			});
	}

	/** Lets the UI feature-detect the record surface without instanceof. */
	supportsRecords(): boolean {
		return true;
	}

	async get(email: string): Promise<UserSecretBundle> {
		return { ...((await this.getRecord(email))?.bundle ?? {}) };
	}

	async getRecord(
		email: string,
	): Promise<{ bundle: UserSecretBundle; etag: string } | undefined> {
		const id = email.toLowerCase();
		const cached = this.cache.get(id);
		if (cached && cached.expiresAt > this.now()) {
			return { bundle: { ...cached.bundle }, etag: cached.etag };
		}

		const response = await this.request("GET", this.entityUrl(id));
		if (response.status === 404) return undefined;
		const entity = (await response.json()) as TableEntity;
		const etag = response.headers.get("etag") ?? "";
		const bundle = await openBundle(
			{
				kid: entity.KekKeyId,
				wrappedDek: entity.WrappedDek,
				iv: entity.Iv,
				authTag: entity.AuthTag,
				ciphertext: entity.Ciphertext,
			},
			this.wrapper,
			this.aad(id),
		);
		this.cache.set(id, {
			expiresAt: this.now() + CACHE_TTL_MS,
			bundle,
			etag,
		});
		return { bundle: { ...bundle }, etag };
	}

	async set(
		email: string,
		key: string,
		value: string | undefined,
	): Promise<void> {
		// Validate before any network call, exactly like FileSecretStore.
		const normalizedKey = normalizeSecretKey(key);
		const id = email.toLowerCase();
		const record = await this.getRecord(id);
		const bundle = { ...(record?.bundle ?? {}) };
		if (value === undefined) {
			delete bundle[normalizedKey];
		} else {
			bundle[normalizedKey] = value;
		}
		await this.putRecord(id, bundle, record?.etag);
	}

	async putRecord(
		email: string,
		bundle: UserSecretBundle,
		ifMatch?: string,
	): Promise<{ etag: string }> {
		const id = email.toLowerCase();
		this.cache.delete(id);
		const sealed = await sealBundle(bundle, this.wrapper, this.aad(id));
		const entity: TableEntity = {
			PartitionKey: setupPartitionKey(id),
			RowKey: SETUP_ROW_KEY,
			Email: id,
			SchemaVersion: SCHEMA_VERSION,
			KekKeyId: sealed.kid,
			WrappedDek: sealed.wrappedDek,
			Iv: sealed.iv,
			AuthTag: sealed.authTag,
			Ciphertext: sealed.ciphertext,
			UpdatedMs: this.now(),
		};
		// No If-Match => Insert Or Replace Entity (upsert). With an If-Match it is
		// a conditional Update Entity, which is what makes the UI's save flow
		// detect a concurrent edit instead of silently overwriting it.
		const response = await this.request(
			"PUT",
			this.entityUrl(id),
			entity,
			ifMatch,
		);
		if (response.status === 412) {
			throw new SetupConflictError();
		}
		this.cache.delete(id);
		return { etag: response.headers.get("etag") ?? "" };
	}

	/**
	 * Creates the user's record if absent, and adds any `requiredKeys` that are
	 * not present as empty strings. Never overwrites a stored value. Returns
	 * whether anything was written.
	 */
	async ensureRecord(
		email: string,
		requiredKeys: readonly string[],
	): Promise<{ created: boolean }> {
		const id = email.toLowerCase();
		const record = await this.getRecord(id);
		const bundle = { ...(record?.bundle ?? {}) };
		let changed = record === undefined;
		for (const key of requiredKeys) {
			if (!Object.hasOwn(bundle, key)) {
				bundle[normalizeSecretKey(key)] = "";
				changed = true;
			}
		}
		if (!changed) return { created: false };
		await this.putRecord(id, bundle, record?.etag);
		return { created: true };
	}

	async isFullyAuthenticated(
		email: string,
		requiredKeys: readonly string[],
	): Promise<{ ok: boolean; missing: string[] }> {
		const bundle = await this.get(email);
		const missing = requiredKeys.filter(
			(key) => !(Object.hasOwn(bundle, key) && bundle[key]),
		);
		return { ok: missing.length === 0, missing };
	}

	private aad(email: string): string {
		return `${setupPartitionKey(email)}|${SETUP_ROW_KEY}|${SCHEMA_VERSION}`;
	}

	private entityUrl(email: string): string {
		return `${this.tableUrl}(PartitionKey='${setupPartitionKey(email)}',RowKey='${SETUP_ROW_KEY}')`;
	}

	private async request(
		method: string,
		url: string,
		body?: unknown,
		ifMatch?: string,
	): Promise<Response> {
		const response = await this.fetchFn(url, {
			method,
			headers: {
				authorization: `Bearer ${await this.tokenProvider()}`,
				"x-ms-version": X_MS_VERSION,
				accept: "application/json;odata=nometadata",
				DataServiceVersion: "3.0",
				...(body === undefined ? {} : { "content-type": "application/json" }),
				...(ifMatch ? { "if-match": ifMatch } : {}),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		// 404 (no record) and 412 (etag conflict) are meaningful states the
		// callers handle. Anything else non-2xx MUST throw: degrading a read
		// failure to "empty bundle" would let a later write destroy the record —
		// the same hazard FileSecretStore.readAll documents.
		if (
			!response.ok &&
			response.status !== 404 &&
			response.status !== 412
		) {
			throw new Error(
				`Azure Table ${method} ${url} failed (${response.status}): ${await response.text()}`,
			);
		}
		return response;
	}
}
```

- [ ] **Step 4: Run — PASS. Then export from `packages/router/src/index.ts` and commit.**

```bash
git add packages/router/src/TableSecretStore.ts packages/router/test/TableSecretStore.test.ts packages/router/src/index.ts
git commit -m "feat(router): add the Azure Table per-user secret backend"
```

---

### Task 3: backend selection

- [ ] **Step 1: Write the failing test** in `packages/router/test/RouterServer.test.ts`:

```ts
it("selects the Table backend when containers.tableStore is set", () => {
	const server = new RouterServer({
		/* ...minimal config... */
		containers: {
			image: "img",
			routerUrlForContainers: "ws://x",
			repositories: [],
			keyVaultUrl: "https://kv.test",
			tableStore: {
				endpoint: "https://st.table.core.windows.net",
				keyId: "https://kv.test/keys/kek/v1",
			},
		},
		executorRegistryFactory: () => new Map(),
	});
	// tableStore wins over keyVaultUrl
	expect(server.secretBackendKind).toBe("table");
});
```

Add a `readonly secretBackendKind: "file" | "keyvault" | "table"` field on `RouterServer`, assigned in `buildContainerTargets`. It is a one-line test seam that also makes the choice visible in a startup log line — worth having when diagnosing "why is my secret not there".

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** In `RouterContainersConfig` add:

```ts
/**
 * Selects the Azure Table + envelope-encryption backend for per-user secrets.
 * Takes precedence over {@link keyVaultUrl}, which takes precedence over the
 * local 0600 file. Absent (the default) leaves existing deployments unchanged.
 */
tableStore?: {
	endpoint: string;
	/** Default "cyrussetup". */
	tableName?: string;
	/** Versioned Key Vault key id used as the KEK. */
	keyId: string;
};
```

and replace the selection in `buildContainerTargets` (currently lines ~504–512):

```ts
const secretsPath =
	containers.secretsPath ??
	join(dirname(this.config.dbPath), "user-secrets.json");
let secrets: SecretStoreBackend;
if (containers.tableStore) {
	this.secretBackendKind = "table";
	secrets = new TableSecretStore({
		tableEndpoint: containers.tableStore.endpoint,
		tableName: containers.tableStore.tableName,
		keyId: containers.tableStore.keyId,
		logger: this.logger,
	});
} else if (containers.keyVaultUrl) {
	this.secretBackendKind = "keyvault";
	secrets = new KeyVaultSecretStore({
		vaultUrl: containers.keyVaultUrl,
		logger: this.logger,
	});
} else {
	this.secretBackendKind = "file";
	secrets = new SecretStore(secretsPath);
}
this.logger.info(`Per-user secret backend: ${this.secretBackendKind}`);
```

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Mirror the selection in the CLI.** `apps/cli/src/commands/RouterCommand.ts` `openSecretStore()` (~line 407) has the same two-branch logic; add the `tableStore` branch first so `cyrus router secrets set/list/unset` inside the replica hit the same store the router reads. Extend `RouterConfigFileSchema` (~line 184) with the `tableStore` object, or the CLI will strip it on rewrite.

- [ ] **Step 6: Commit.**

---

### Task 4: migration from Key Vault

- [ ] **Step 1: Write the failing test** in `apps/cli/src/commands/RouterCommand.test.ts` — assert `secrets migrate --dry-run` lists each (email, key) pair it would copy and writes nothing.

- [ ] **Step 2–4: Implement `cyrus router secrets migrate`.**

```
cyrus router secrets migrate [--dry-run] [--overwrite]
```

Reads every tagged secret from the configured `containers.keyVaultUrl` (reuse `KeyVaultSecretStore`'s list-by-tag walk, including `nextLink` pagination), groups by email, and writes one Table record per user via `putRecord`. Default is **skip a user who already has a Table record**; `--overwrite` replaces. Never prints a value — print `email  KEY  (24 bytes)` only.

- [ ] **Step 5: Commit.**

Runbook order — put this verbatim in `infra/azure/README.md`:

1. `terraform apply` with `enable_setup_table = true` but `containers.tableStore` **not yet** in the containers JSON. This creates the table, the KEK, and the role assignments without changing the running backend.
2. `az containerapp exec` → `cyrus router secrets migrate --dry-run`, eyeball the list.
3. `cyrus router secrets migrate`.
4. Flip `enable_setup_table_backend = true` so the containers JSON gains `tableStore`, apply, and let the revision roll.
5. `cyrus router secrets list <email>` for two users — keys must match pre-migration.
6. Delegate a test issue and confirm the worker boots.
7. Leave the Key Vault secrets in place for at least one week as the rollback path. Deleting them is a separate follow-up.

---

### Task 5: Terraform

- [ ] **Step 1: Add to `infra/azure/terraform/main.tf`**

```hcl
################################################################################
# Setup UI storage: Azure Table + envelope-encryption KEK
################################################################################

resource "azurerm_storage_table" "setup" {
  count                = var.enable_setup_table ? 1 : 0
  name                 = "cyrussetup"
  storage_account_name = azurerm_storage_account.this.name
}

# RSA key used only to wrap/unwrap per-record data encryption keys. Creating it
# requires the applying principal to hold Key Vault Crypto Officer on the vault
# — the Secrets Officer grant the stack already has does NOT cover key ops.
resource "azurerm_key_vault_key" "setup_kek" {
  count        = var.enable_setup_table ? 1 : 0
  name         = "cyrus-setup-kek"
  key_vault_id = azurerm_key_vault.this.id
  key_type     = "RSA"
  key_size     = 2048
  key_opts     = ["wrapKey", "unwrapKey"]

  # Rotating the key does NOT re-wrap existing records: each row stores the
  # versioned kid it was wrapped with and unwraps against that version. Keep
  # old versions enabled until a re-wrap pass has run.
  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_role_assignment" "router_table_data_contributor" {
  count = var.enable_setup_table ? 1 : 0
  # Table-scoped, not account-scoped: the router must not gain access to the
  # backup blob container's siblings through this grant.
  scope                = "${azurerm_storage_account.this.id}/tableServices/default/tables/${azurerm_storage_table.setup[0].name}"
  role_definition_name = "Storage Table Data Contributor"
  principal_id         = azurerm_user_assigned_identity.router.principal_id
}

resource "azurerm_role_assignment" "router_kv_crypto_user" {
  count                = var.enable_setup_table ? 1 : 0
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Crypto User"
  principal_id         = azurerm_user_assigned_identity.router.principal_id
}
```

- [ ] **Step 2: Add the variables**

```hcl
variable "enable_setup_table" {
  description = "Create the Azure Table, envelope-encryption KEK, and role assignments for per-user setup records. Safe to enable before cutting the backend over."
  type        = bool
  default     = false
}

variable "enable_setup_table_backend" {
  description = "Point the router at the Azure Table backend by adding containers.tableStore to CYRUS_ROUTER_CONTAINERS_JSON. Enable only AFTER `cyrus router secrets migrate` has run."
  type        = bool
  default     = false

  validation {
    condition     = !var.enable_setup_table_backend || var.enable_setup_table
    error_message = "enable_setup_table_backend requires enable_setup_table."
  }
}
```

Two flags, deliberately: creating the infrastructure and switching the read path are separate blast radii, and step 2 of the runbook needs the table to exist while the router still reads Key Vault.

- [ ] **Step 3: Extend the containers JSON** in `router.tf`'s `local.router_containers_config`:

```hcl
tableStore = var.enable_setup_table_backend ? {
  endpoint  = "https://${azurerm_storage_account.this.name}.table.core.windows.net"
  tableName = azurerm_storage_table.setup[0].name
  keyId     = azurerm_key_vault_key.setup_kek[0].id # versioned
} : null
```

Then strip nulls before `jsonencode` (or use a `merge()` guarded by the flag) — a literal `"tableStore": null` would fail the Zod parse in `RouterCommand`.

- [ ] **Step 4: Provider note.** `azurerm_storage_table` uses the storage account key for the data-plane create by default. If the account has shared-key access disabled, set `storage_use_azuread = true` in the `provider "azurerm"` block in `versions.tf` and grant the applying principal *Storage Table Data Contributor*. Check which applies to the dev account before planning.

- [ ] **Step 5: Apply, verify, commit.**

```bash
terraform -chdir=infra/azure/terraform plan -var-file=dev.tfvars
terraform -chdir=infra/azure/terraform apply -var-file=dev.tfvars
az storage entity query --table-name cyrussetup \
  --account-name <account> --auth-mode login --num-results 5
```

---

### Also update

* `docs/ROUTER.md` — new "Azure Table setup records" section next to the Key Vault one, documenting the schema, the two flags, and the rotation caveat.
* `infra/azure/README.md` §9 and the "Secret rotation (N4)" section.
* `docker/worker/README.md` — the `secretsPath` table entry needs to mention that Table/Key Vault backends supersede it.
* `CLAUDE.md` item 12 — add a bullet: `containers.tableStore` selects the Table backend over `containers.keyVaultUrl`; records are envelope-encrypted with a KEK whose **versioned** id is stored per row, so KEK rotation requires an explicit re-wrap pass.
* `CHANGELOG.internal.md`.

### Definition of done

1. `pnpm --filter cyrus-router test:run` and `pnpm typecheck` pass; new tests cover round-trip, tamper, AAD replay, conflict, cache, and the "no plaintext in the request body" assertion.
2. `enable_setup_table = false` produces no Terraform diff.
3. Migration runbook executed on dev; `secrets list` output identical before and after.
4. A worker boots for a migrated user (`ContainerTargets.buildEnv` → Table backend).

### Known limitation to record, not solve here

KEK rotation does not re-wrap existing rows — each row unwraps against the versioned kid it stored. That is correct and intentional (old rows keep working across a rotation), but it means old key versions must stay enabled until a re-wrap pass runs. A `cyrus router secrets rewrap` command is a sensible follow-up issue; it is not needed for this milestone.





---

# NOR-270: Create user setup records on first sign-in

**State:** Backlog | **Priority:** --- | **Assignee:** Unassigned | **Project:** Cyrus | **Milestone:** First multi-user release

When a user logs in for the first time, create their setup record with all required environment variables initialized to empty values. The bootstrap flow should integrate with the authenticated application and persistent storage.

## Parent

- **NOR-266**: Build setup management backend foundation _[Todo]_


## Comments

### Comment

## Implementation plan — create user setup records on first sign-in

Consumes `SetupPrincipal` (NOR-268) and `ensureRecord` (NOR-269). Produces `SetupBootstrap`, consumed by NOR-271's `GET /setup` handler.

**Files**
* Create: `packages/router/src/setup/bootstrap.ts`
* Create: `packages/router/test/setup-bootstrap.test.ts`
* Modify: `packages/router/src/RouterStore.ts` (add `getUserByEmail`)
* Modify: `packages/router/test/RouterStore.test.ts`
* Modify: `packages/router/src/index.ts`

---

### What "bootstrap" has to cover

Two separate records, and it is easy to only think of one:

1. **The SQLite `users` row.** Without it there is no `user_id`, so `EventRouter` cannot route the teammate's issues and `ContainerTargets` has no owner to boot a container for. Created today by `cyrus router users add <email>`.
2. **The secret record** — the env-var bundle, with every required key present and empty. Without it the setup page has nothing to render rows for, and `isFullyAuthenticated` reports an empty `missing` list only by accident.

`SetupBootstrap.ensure()` does both, idempotently, on every `/setup` request. Not just the first: making it unconditional-but-idempotent is what makes it self-healing when `requiredSecretKeys` gains a new entry after users already exist.

### Required keys

The authoritative set is the same one `ContainerTargets.buildEnv` computes:

```ts
[...new Set([
	...DEFAULT_REQUIRED_SECRET_KEYS,          // ["CLAUDE_CODE_OAUTH_TOKEN"]
	...(containersConfig.requiredSecretKeys ?? []),
])]
```

Do **not** hardcode `CLAUDE_CODE_OAUTH_TOKEN` here. `RouterServer` computes the list once and passes it into both `ContainerTargetService` and `SetupBootstrap`, so the page and the boot gate can never disagree about what "required" means — which is the failure mode where the UI says "all set" and the container refuses to boot.

### Access-control posture

`autoProvisionUsers` (default `true`, see NOR-265 Q1) decides what happens for an email with no `users` row:

* `true` — create the row. The gate is that the teammate got past the auth sidecar *and* `setupUi.allowedDomain`. In a single-tenant deployment with the app registration set to *assignment required* (NOR-268 Task 3 Step 2), that is a real gate.
* `false` — throw `SetupAuthError(403)`. NOR-271 renders a "your account is not registered, ask an admin to run `cyrus router users add`" page rather than a bare 403 body.

Bootstrap **never** creates a device row, an enrollment code, or an executor assignment. Executor assignment is Q2 on NOR-265 and is deliberately out of scope until that's answered.

---

### Task 1: `RouterStore.getUserByEmail`

- [ ] **Step 1: Write the failing test**

Append to `packages/router/test/RouterStore.test.ts`:

```ts
describe("getUserByEmail", () => {
	it("returns undefined for an unknown email", () => {
		const store = new RouterStore(":memory:");
		expect(store.getUserByEmail("nobody@example.com")).toBeUndefined();
		store.close();
	});

	it("finds a user case-insensitively", () => {
		const store = new RouterStore(":memory:");
		const { userId } = store.addUser({
			email: "Alice@Example.com",
			name: "Alice",
		});
		expect(store.getUserByEmail("alice@example.COM")).toEqual({
			userId,
			email: "Alice@Example.com",
			name: "Alice",
		});
		store.close();
	});
});
```

- [ ] **Step 2: Run — FAIL** (`store.getUserByEmail is not a function`).

- [ ] **Step 3: Implement**, next to `getUserEmail` (~line 958) in `packages/router/src/RouterStore.ts`:

```ts
/**
 * Looks a user up by email. `users.email` is `UNIQUE COLLATE NOCASE`, so the
 * `COLLATE NOCASE` here matches the index and the comparison the constraint
 * already enforces — a case-varying sign-in resolves to the same row rather
 * than failing an insert with a UNIQUE violation.
 */
getUserByEmail(
	email: string,
): { userId: number; email: string; name?: string } | undefined {
	const row = this.db
		.prepare(
			"SELECT user_id, email, name FROM users WHERE email = ? COLLATE NOCASE",
		)
		.get(email) as
		| { user_id: number; email: string; name: string | null }
		| undefined;
	if (!row) return undefined;
	return {
		userId: row.user_id,
		email: row.email,
		...(row.name ? { name: row.name } : {}),
	};
}
```

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Commit**

```bash
git add packages/router/src/RouterStore.ts packages/router/test/RouterStore.test.ts
git commit -m "feat(router): add RouterStore.getUserByEmail"
```

---

### Task 2: `SetupBootstrap`

- [ ] **Step 1: Write the failing tests**

`packages/router/test/setup-bootstrap.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { RouterStore } from "../src/RouterStore.js";
import { FileSecretStore } from "../src/SecretStore.js";
import { SetupBootstrap } from "../src/setup/bootstrap.js";
import { SetupAuthError } from "../src/setup/principal.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REQUIRED = ["CLAUDE_CODE_OAUTH_TOKEN", "GIT_TOKEN"] as const;

function harness(autoProvisionUsers = true) {
	const store = new RouterStore(":memory:");
	const secrets = new FileSecretStore(
		join(mkdtempSync(join(tmpdir(), "cyrus-bootstrap-")), "user-secrets.json"),
	);
	const logger = { info: vi.fn(), warn: vi.fn() };
	const bootstrap = new SetupBootstrap({
		store,
		secrets,
		requiredKeys: REQUIRED,
		autoProvisionUsers,
		logger,
	});
	return { store, secrets, bootstrap, logger };
}

describe("SetupBootstrap.ensure", () => {
	it("creates the user row and the empty required keys on first sign-in", async () => {
		const { store, secrets, bootstrap } = harness();
		const result = await bootstrap.ensure({
			email: "alice@example.com",
			name: "Alice Example",
		});
		expect(result).toEqual({
			userId: expect.any(Number),
			createdUser: true,
			createdRecord: true,
		});
		expect(store.getUserByEmail("alice@example.com")).toMatchObject({
			email: "alice@example.com",
			name: "Alice Example",
		});
		expect(await secrets.get("alice@example.com")).toEqual({
			CLAUDE_CODE_OAUTH_TOKEN: "",
			GIT_TOKEN: "",
		});
	});

	it("is idempotent — a second sign-in creates nothing", async () => {
		const { bootstrap } = harness();
		await bootstrap.ensure({ email: "alice@example.com" });
		expect(await bootstrap.ensure({ email: "alice@example.com" })).toEqual({
			userId: expect.any(Number),
			createdUser: false,
			createdRecord: false,
		});
	});

	it("never overwrites a stored value", async () => {
		const { secrets, bootstrap } = harness();
		await secrets.set("alice@example.com", "CLAUDE_CODE_OAUTH_TOKEN", "real");
		await bootstrap.ensure({ email: "alice@example.com" });
		expect(await secrets.get("alice@example.com")).toEqual({
			CLAUDE_CODE_OAUTH_TOKEN: "real",
			GIT_TOKEN: "",
		});
	});

	it("backfills a newly-required key for an existing user", async () => {
		const { store, secrets, bootstrap } = harness();
		store.addUser({ email: "alice@example.com" });
		await secrets.set("alice@example.com", "CLAUDE_CODE_OAUTH_TOKEN", "real");
		const result = await bootstrap.ensure({ email: "alice@example.com" });
		expect(result).toEqual({
			userId: expect.any(Number),
			createdUser: false,
			createdRecord: true,
		});
		expect(await secrets.get("alice@example.com")).toEqual({
			CLAUDE_CODE_OAUTH_TOKEN: "real",
			GIT_TOKEN: "",
		});
	});

	it("matches an existing user case-insensitively instead of duplicating", async () => {
		const { store, bootstrap } = harness();
		const { userId } = store.addUser({ email: "Alice@Example.com" });
		const result = await bootstrap.ensure({ email: "alice@example.com" });
		expect(result.userId).toBe(userId);
		expect(result.createdUser).toBe(false);
		expect(store.listUsers()).toHaveLength(1);
	});

	it("throws 403 for an unknown user when auto-provisioning is off", async () => {
		const { bootstrap, store } = harness(false);
		await expect(
			bootstrap.ensure({ email: "stranger@example.com" }),
		).rejects.toBeInstanceOf(SetupAuthError);
		expect(store.listUsers()).toHaveLength(0);
	});

	it("still ensures the record for a known user when auto-provisioning is off", async () => {
		const { bootstrap, store, secrets } = harness(false);
		store.addUser({ email: "alice@example.com" });
		await bootstrap.ensure({ email: "alice@example.com" });
		expect(await secrets.get("alice@example.com")).toEqual({
			CLAUDE_CODE_OAUTH_TOKEN: "",
			GIT_TOKEN: "",
		});
	});

	it("does not create a device row", async () => {
		const { bootstrap, store } = harness();
		await bootstrap.ensure({ email: "alice@example.com" });
		expect(store.listDevices()).toHaveLength(0);
	});

	it("logs provisioning once, at info", async () => {
		const { bootstrap, logger } = harness();
		await bootstrap.ensure({ email: "alice@example.com" });
		await bootstrap.ensure({ email: "alice@example.com" });
		expect(logger.info).toHaveBeenCalledTimes(1);
		expect(logger.info.mock.calls[0]![0]).toContain("alice@example.com");
	});

	it("survives a concurrent first sign-in from two tabs", async () => {
		const { bootstrap, store } = harness();
		const [a, b] = await Promise.all([
			bootstrap.ensure({ email: "alice@example.com" }),
			bootstrap.ensure({ email: "alice@example.com" }),
		]);
		expect(a.userId).toBe(b.userId);
		expect(store.listUsers()).toHaveLength(1);
	});
});
```

That last one is the interesting case: two tabs opened at once both see "no user" and both call `addUser`, and the second hits the `UNIQUE COLLATE NOCASE` constraint. The implementation must catch that and re-read rather than propagating a SQLITE_CONSTRAINT error to a user whose only mistake was double-clicking.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `packages/router/src/setup/bootstrap.ts`**

```ts
import type { RouterStore } from "../RouterStore.js";
import type { SecretStoreBackend } from "../SecretStore.js";
import { normalizeSecretKey } from "../SecretStore.js";
import { SetupAuthError, type SetupPrincipal } from "./principal.js";

export interface SetupBootstrapDeps {
	store: RouterStore;
	secrets: SecretStoreBackend;
	/**
	 * DEFAULT_REQUIRED_SECRET_KEYS ∪ containers.requiredSecretKeys, computed
	 * once by RouterServer and shared with ContainerTargetService so the page
	 * and the container boot gate can never disagree about what is required.
	 */
	requiredKeys: readonly string[];
	autoProvisionUsers: boolean;
	logger: { info(msg: string): void; warn(msg: string): void };
}

export interface SetupBootstrapResult {
	userId: number;
	createdUser: boolean;
	createdRecord: boolean;
}

/**
 * Makes a signed-in teammate's router state exist: the SQLite `users` row that
 * routing needs, and a secret record carrying every required env var (empty
 * when unset) so the setup page has rows to render.
 *
 * Called on every `/setup` request, not only the first. It is idempotent, and
 * running it unconditionally is what makes it self-healing: adding an entry to
 * `containers.requiredSecretKeys` backfills into existing users' records the
 * next time they open the page, instead of leaving them with a record that
 * silently lacks a key the boot gate now demands.
 */
export class SetupBootstrap {
	constructor(private readonly deps: SetupBootstrapDeps) {}

	async ensure(principal: SetupPrincipal): Promise<SetupBootstrapResult> {
		const email = principal.email.toLowerCase();
		const { userId, createdUser } = this.ensureUser(email, principal.name);
		const createdRecord = await this.ensureRecord(email);
		return { userId, createdUser, createdRecord };
	}

	private ensureUser(
		email: string,
		name: string | undefined,
	): { userId: number; createdUser: boolean } {
		const existing = this.deps.store.getUserByEmail(email);
		if (existing) return { userId: existing.userId, createdUser: false };

		if (!this.deps.autoProvisionUsers) {
			throw new SetupAuthError(
				403,
				`${email} is not a registered Cyrus user. Ask an administrator to run: cyrus router users add ${email}`,
			);
		}

		try {
			const { userId } = this.deps.store.addUser({
				email,
				...(name ? { name } : {}),
			});
			this.deps.logger.info(`Provisioned Cyrus user ${email} from /setup`);
			return { userId, createdUser: true };
		} catch (error) {
			// Two tabs signing in at once both saw "no user" and both inserted.
			// `users.email` is UNIQUE COLLATE NOCASE, so the loser lands here —
			// re-read rather than surfacing a SQLITE_CONSTRAINT to the teammate.
			const raced = this.deps.store.getUserByEmail(email);
			if (raced) return { userId: raced.userId, createdUser: false };
			throw error;
		}
	}

	/**
	 * Adds every required key that is absent, as an empty string. Uses the
	 * backend's atomic whole-record path when it has one (the Table backend), so
	 * a five-key bootstrap is a single conditional write rather than five
	 * independent ones.
	 */
	private async ensureRecord(email: string): Promise<boolean> {
		const backend = this.deps.secrets as SecretStoreBackend & {
			ensureRecord?: (
				email: string,
				requiredKeys: readonly string[],
			) => Promise<{ created: boolean }>;
		};
		if (typeof backend.ensureRecord === "function") {
			const { created } = await backend.ensureRecord(
				email,
				this.deps.requiredKeys,
			);
			return created;
		}

		// File / Key Vault backends: per-key fallback. Read once, then write only
		// the genuinely absent keys — `set()` is a whole-file rewrite on the file
		// backend, so writing unconditionally would be O(n) rewrites per page load.
		const bundle = await this.deps.secrets.get(email);
		let created = false;
		for (const key of this.deps.requiredKeys) {
			if (Object.hasOwn(bundle, key)) continue;
			await this.deps.secrets.set(email, normalizeSecretKey(key), "");
			created = true;
		}
		return created;
	}
}
```

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Export and commit**

```ts
// packages/router/src/index.ts
export {
	SetupBootstrap,
	type SetupBootstrapDeps,
	type SetupBootstrapResult,
} from "./setup/bootstrap.js";
```

```bash
git add packages/router/src/setup/bootstrap.ts packages/router/test/setup-bootstrap.test.ts packages/router/src/index.ts
git commit -m "feat(router): bootstrap user and setup record on first sign-in"
```

---

### Task 3: wire it into `RouterServer`

- [ ] **Step 1: Hoist the required-keys computation**

In `packages/router/src/ContainerTargets.ts`, extract the set currently computed inline in `buildEnv` (~line 450) into an exported helper so both callers use one implementation:

```ts
/** DEFAULT_REQUIRED_SECRET_KEYS ∪ config, de-duplicated, order-stable. */
export function resolveRequiredSecretKeys(
	extra: readonly string[] | undefined,
): string[] {
	return [...new Set([...DEFAULT_REQUIRED_SECRET_KEYS, ...(extra ?? [])])];
}
```

and call it from `buildEnv`. Existing `ContainerTargets.test.ts` cases must still pass unchanged — that is the regression check.

- [ ] **Step 2: Construct the bootstrap in `buildContainerTargets`**

```ts
const requiredKeys = resolveRequiredSecretKeys(containers.requiredSecretKeys);
this.setupBootstrap = new SetupBootstrap({
	store: this.store,
	secrets,
	requiredKeys,
	autoProvisionUsers: this.config.setupUi?.autoProvisionUsers ?? true,
	logger: this.logger,
});
```

Store it on a `private setupBootstrap?: SetupBootstrap` field, mirroring how `terminalTeardown` is held. NOR-271 reads it when registering `/setup`.

- [ ] **Step 3: Guard the case NOR-271 will hit**

`setupUi.enabled` with no `containers` config means there is no secret store and no bootstrap. Fail at construction with a clear message rather than 500-ing on the first page load:

```ts
if (config.setupUi?.enabled && !config.containers) {
	throw new Error(
		"setupUi.enabled requires a `containers` configuration — the setup page manages the per-user container secret store, which only exists when containers are configured.",
	);
}
```

Add a `RouterServer.test.ts` case for it.

- [ ] **Step 4: Run the full router suite — PASS. Commit.**

---

### Also update

* `docs/ROUTER.md` — note that opening `/setup` registers the teammate, so `cyrus router users add` becomes optional when `autoProvisionUsers` is on.
* `infra/azure/README.md` §9 — the manual `users add` step becomes conditional.
* `CHANGELOG.internal.md`.

### Definition of done

1. `pnpm --filter cyrus-router test:run` and `pnpm typecheck` pass.
2. Two concurrent `ensure()` calls for the same new email produce one user row (test asserted).
3. Adding a key to `containers.requiredSecretKeys` and reopening `/setup` backfills it as empty for an existing user.
4. `autoProvisionUsers: false` + unknown email → `SetupAuthError(403)` and no row written.


#### Reply

Correction to Task 3 Step 2 — `buildContainerTargets` must stash **three** fields, not one. NOR-271's route registration reads all three, and the plan above only named `setupBootstrap`:

```ts
// packages/router/src/RouterServer.ts — alongside `private terminalTeardown?`
private setupBootstrap?: SetupBootstrap;
private setupSecrets?: SecretStoreBackend;
private setupRequiredKeys?: readonly string[];
```

and in `buildContainerTargets`, after the backend selection:

```ts
const requiredKeys = resolveRequiredSecretKeys(containers.requiredSecretKeys);
this.setupSecrets = secrets;
this.setupRequiredKeys = requiredKeys;
this.setupBootstrap = new SetupBootstrap({
	store: this.store,
	secrets,
	requiredKeys,
	autoProvisionUsers: this.config.setupUi?.autoProvisionUsers ?? true,
	logger: this.logger,
});
```

`requiredKeys` also feeds `ContainerTargetService`'s `containersConfig` so the boot gate and the page compute the required set from the same call — that is the point of hoisting `resolveRequiredSecretKeys` in Step 1.


#### Reply

## Added: Task 4 — router-level default executor

Resolves NOR-265 Q2: on this Azure deployment every user should run in an ACA sandbox, set once for the router rather than per user.

**Files**
* Modify: `packages/router/src/ContainerTargets.ts` (`executorFor` fallback)
* Modify: `packages/router/src/RouterServer.ts` (`containers.defaultExecutor`)
* Modify: `apps/cli/src/commands/RouterCommand.ts` (`device` sentinel, `users list` column, Zod schema)
* Modify: `packages/router/test/ContainerTargets.test.ts`, `apps/cli/src/commands/RouterCommand.test.ts`
* Modify: `infra/azure/terraform/router.tf`, `docs/ROUTER.md`, `infra/azure/README.md`

### The trap

`ContainerTargets.executorFor()` (line ~109) returns `undefined` for a user with no `executor_json`, and `undefined` means "route to a physical device". `cyrus router users set-executor <email> device` writes `NULL` — **the same state as never-configured**.

So a naive `?? defaultExecutor` fallback silently moves every deliberately-set-to-`device` user onto ACA sandboxes. On this router that is probably nobody, but it is not something to find out in production, and the `cyrus-setup-client` flow exists precisely to put teammates on their own machines.

Fix: store `device` explicitly as `{"type":"device"}`, and only fall back for a genuinely absent value. Land Step 1 and Step 2 (and the pre-flight) **before** Terraform sets `defaultExecutor`.

---

- [ ] **Step 1: Write the failing tests**

Append to `packages/router/test/ContainerTargets.test.ts`:

```ts
describe("executorFor — default executor", () => {
	it("uses the user's explicit executor over the default", () => {
		const service = build({ defaultExecutor: "aca" });
		store.setUserExecutor("alice@example.com", JSON.stringify({ type: "docker" }));
		expect(service.executorFor(userId)).toBe("docker");
	});

	it("falls back to the default when the user has no executor set", () => {
		const service = build({ defaultExecutor: "aca" });
		expect(service.executorFor(userId)).toBe("aca");
	});

	it("honours an explicit device sentinel over the default", () => {
		const service = build({ defaultExecutor: "aca" });
		store.setUserExecutor("alice@example.com", JSON.stringify({ type: "device" }));
		expect(service.executorFor(userId)).toBeUndefined();
	});

	it("returns undefined with no default configured — today's behaviour", () => {
		const service = build({});
		expect(service.executorFor(userId)).toBeUndefined();
	});

	it("does not apply the default when executor_json is corrupt", () => {
		const service = build({ defaultExecutor: "aca" });
		store.setUserExecutor("alice@example.com", "{not json");
		// A corrupt row is an unknown intent, not an unset one. Falling back to a
		// container executor here would boot a sandbox for a user whose actual
		// setting we failed to read.
		expect(service.executorFor(userId)).toBeUndefined();
		expect(logger.warn).toHaveBeenCalled();
	});
});
```

The corrupt-row case is the one that needs a deliberate decision: today it logs and degrades to physical device. It must keep doing that rather than picking up the default — degrading an unreadable setting into "boot a cloud sandbox" is the wrong direction.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement**

`packages/router/src/ContainerTargets.ts` — add `defaultExecutor?: string` to `containersConfig` in `ContainerRoutingDeps`, and rewrite `executorFor`:

```ts
/**
 * Which container provider a user's sessions route to, or `undefined` for the
 * physical-device path.
 *
 * Resolution order:
 *   1. `users.executor_json` — an explicit per-user choice, including the
 *      `{"type":"device"}` sentinel, which pins a user to their own machine.
 *   2. `containers.defaultExecutor` — the router-wide default (Azure sets
 *      `"aca"`), applied only when the user has made no choice at all.
 *   3. `undefined` — physical device.
 *
 * A corrupt `executor_json` deliberately does NOT fall through to the default:
 * an unreadable setting is an unknown intent, not an unset one, and quietly
 * upgrading it to "boot a cloud sandbox" is the wrong way to fail.
 */
executorFor(userId: number): string | undefined {
	const json = this.deps.store.getUserExecutor(userId);
	if (!json) {
		return this.deps.containersConfig.defaultExecutor;
	}
	try {
		const parsed = JSON.parse(json) as { type?: string };
		return parsed.type && parsed.type !== "device" ? parsed.type : undefined;
	} catch {
		this.deps.logger.warn(
			`Corrupt executor_json for user ${userId}; using physical device`,
		);
		return undefined;
	}
}
```

`RouterServer.ts` — add to `RouterContainersConfig`:

```ts
/**
 * Provider every user routes to unless they have an explicit per-user
 * executor. Terraform sets this to "aca" on the Azure stack so a teammate is
 * usable the moment they sign in, with no `users set-executor` step.
 *
 * Omitting it (the default) keeps today's behaviour: an unconfigured user
 * routes to their enrolled physical device.
 */
defaultExecutor?: string;
```

and pass it through in `buildContainerTargets`'s `containersConfig`:

```ts
containersConfig: {
	routerUrlForContainers: containers.routerUrlForContainers,
	repositories: containers.repositories,
	requiredSecretKeys: containers.requiredSecretKeys,
	defaultExecutor: containers.defaultExecutor,
},
```

Validate it at construction — an unregistered provider name would otherwise surface as a per-boot `no executor configured for provider 'aca'` on every routed event:

```ts
if (
	containers.defaultExecutor &&
	!executors.has(containers.defaultExecutor)
) {
	throw new Error(
		`containers.defaultExecutor is "${containers.defaultExecutor}" but no such executor is registered (have: ${[...executors.keys()].join(", ")})`,
	);
}
```

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Make `device` an explicit sentinel**

`apps/cli/src/commands/RouterCommand.ts`, `usersSetExecutor` (~line 833) currently writes `null` for `device`:

```ts
const updated = store.setUserExecutor(
	email,
	// Stored explicitly rather than as NULL: with containers.defaultExecutor
	// set, NULL means "no choice, use the router default", so "device" needs
	// a value of its own to pin this user to their own machine.
	JSON.stringify({ type }),
);
```

`type === "device"` now stores `{"type":"device"}` instead of clearing the column. `executorFor` already maps that to `undefined`, so the routing behaviour for such a user is unchanged. Update the doc comment above the method — it currently states the NULL behaviour as the contract.

Add a CLI test asserting `set-executor <email> device` writes `{"type":"device"}` and that `set-executor` output tells the user their choice now overrides the router default.

- [ ] **Step 6: Make the effective executor visible**

`cyrus router users list` shows registration state but not which executor a user resolves to — with a router-wide default that becomes the first thing an operator needs. Add an `EXECUTOR` column rendering `aca (default)` / `docker` / `device` / `device (default)`, computed with the same precedence as `executorFor`. Without this the pre-flight in Step 7 cannot be done accurately.

- [ ] **Step 7: Terraform**

In `infra/azure/terraform/router.tf`, inside `local.router_containers_config`, alongside the `aca` block:

```hcl
# Every teammate on this router runs in an ACA sandbox unless they have an
# explicit per-user executor. Set only when the aca block exists, so a
# docker-only or device-only deployment is unaffected.
defaultExecutor = "aca"
```

Guard it the same way the `aca` block is guarded, and strip it when absent rather than emitting `null` (the `RouterConfigFileSchema` parse in `RouterCommand` rejects a null).

- [ ] **Step 8: Pre-flight before enabling on an existing router**

Run this **after** Steps 5–6 ship and **before** the Terraform change applies:

```bash
az containerapp exec --name <router-app> --resource-group "$RESOURCE_GROUP"
# Inside the replica:
cyrus router users list        # EXECUTOR column — note anyone showing "device"

# For each such user, pin them explicitly so the default cannot capture them:
cyrus router secrets list <email>   # sanity check you have the right person
cyrus router users set-executor <email> device
```

Then apply the Terraform change and re-run `cyrus router users list`: everyone previously blank should now read `aca (default)`, and every explicitly-pinned user should still read `device`.

- [ ] **Step 9: Update the docs**

* `docs/ROUTER.md` — document `containers.defaultExecutor`, the resolution order, and that `set-executor` is now an override rather than the only way to get a container.
* `infra/azure/README.md` §9 — drop `cyrus router users set-executor alice@example.com aca` from the registration steps; it is now automatic. Add the pre-flight above to the upgrade notes.
* `CLAUDE.md` item 12 — add a bullet: on the ACA stack, `containers.defaultExecutor: "aca"` means an unconfigured user routes to a sandbox; `executor_json = NULL` means "use the default" and `{"type":"device"}` is the explicit physical-device pin.
* `CHANGELOG.internal.md`.

- [ ] **Step 10: Commit**

```bash
pnpm test:packages:run && pnpm typecheck
git add packages/router/src/ContainerTargets.ts packages/router/src/RouterServer.ts \
  packages/router/test/ContainerTargets.test.ts apps/cli/src/commands/RouterCommand.ts \
  apps/cli/src/commands/RouterCommand.test.ts infra/azure/terraform/router.tf \
  docs/ROUTER.md infra/azure/README.md CLAUDE.md
git commit -m "feat(router): route users to a default executor when none is set"
```

---

### Ordering constraint

Steps 5–6 (the `device` sentinel and the `EXECUTOR` column) must be **deployed and the pre-flight run** before Step 7's Terraform change applies. They are independent commits and can ship in the same PR, but the *apply* has to come after the pre-flight — otherwise there is a window where a `device` user is routed to a sandbox.

### Additions to this issue's definition of done

5. A user with no `executor_json` resolves to `aca`; one with `{"type":"device"}` resolves to physical device (both test asserted).
6. A corrupt `executor_json` still degrades to physical device, not to the default.
7. `cyrus router users list` shows the effective executor and marks which ones come from the default.
8. Pre-flight run on dev with its output recorded here before the Terraform change is applied.





---

# NOR-267: Build setup management UI

**State:** Backlog | **Priority:** --- | **Assignee:** Unassigned | **Project:** Cyrus | **Milestone:** First multi-user release

Create the authenticated setup management UI for viewing and editing user environment variables. This issue groups the page shell, variable management interactions, and persistence flow.

## Parent

- **NOR-265**: Create UI for managing setup _[Backlog]_


## Sub-issues

- **NOR-273**: Persist setup changes from the UI _[Backlog]_
- **NOR-272**: Add UI for managing optional environment variables _[Backlog]_
- **NOR-271**: Implement authenticated setup management page shell _[Backlog]_


## Comments

### Comment

## Implementation plan — setup management UI (grouping issue)

Sequencing and shared contracts for NOR-271 / NOR-272 / NOR-273. Step-by-step task plans live on each child. Architecture decisions (D1–D6) are on NOR-265; backend contracts are on NOR-266.

---

### Shape

A server-rendered page at `GET /setup`, served by the router's existing Fastify instance. Pico CSS (classless) + htmx, both **vendored into the router image** — ACA egress is deny-by-default and a CDN reference would simply fail to load. No bundler, no npm UI dependency, no framework.

All rendering lives in `packages/router/src/setup/views.ts` as **pure functions returning strings**. That is what makes the UI unit-testable in Vitest without a browser: assert on the HTML. Fastify routes in `routes.ts` do auth + data access and hand a model to the views.

### Route inventory (final — children implement subsets)

| Route | Issue | Returns |
| --- | --- | --- |
| `GET /setup` | 271 | Full HTML page |
| `GET /setup/assets/pico.css` | 271 | Vendored CSS, immutable cache |
| `GET /setup/assets/htmx.js` | 271 | Vendored JS, immutable cache |
| `GET /setup/variables` | 271 | `<table>` fragment (htmx target) |
| `POST /setup/variables` | 272 | Adds an optional variable; returns the table fragment |
| `DELETE /setup/variables/:name` | 272 | Removes an optional variable; returns the table fragment |
| `POST /setup/save` | 273 | Persists all changed values; returns table + status fragment |

Everything under `/setup` gets `Cache-Control: no-store` except the two asset routes.

### Shared contracts

**`packages/router/src/setup/views.ts`** — produced by NOR-271, extended by NOR-272/273:

```ts
export interface VariableView {
	name: string;
	/** From DEFAULT_REQUIRED_SECRET_KEYS ∪ containers.requiredSecretKeys. */
	required: boolean;
	/** true when a non-empty value is stored. The value itself never appears. */
	isSet: boolean;
}

export interface SetupMessage {
	kind: "ok" | "error" | "conflict";
	text: string;
}

export interface SetupPageModel {
	email: string;
	variables: VariableView[];
	/** Required names with no stored value — drives the "not ready" banner. */
	missingRequired: string[];
	csrfToken: string;
	message?: SetupMessage;
}

export function renderPage(model: SetupPageModel): string;
export function renderVariablesTable(model: SetupPageModel): string;
export function escapeHtml(value: string): string;
```

`renderPage` embeds `renderVariablesTable` output so the first paint needs no htmx round trip. Every mutation route re-renders `renderVariablesTable` — one fragment, one swap target (`#variables`), no partial-row updates. That keeps the client trivially consistent and avoids a whole class of htmx state bugs.

**`packages/router/src/setup/routes.ts`** — the composition seam:

```ts
export interface SetupRouteDeps {
	store: RouterStore;
	secrets: SecretStoreBackend;
	requiredKeys: readonly string[];
	auth: SetupAuthConfig;      // NOR-268
	bootstrap: SetupBootstrap;  // NOR-270
	csrf: CsrfTokens;           // NOR-271
	logger: { info(msg: string): void; warn(msg: string): void };
}

export function registerSetupRoutes(
	fastify: FastifyInstance,
	deps: SetupRouteDeps,
): void;
```

Registered from `RouterServer`'s constructor (Fastify v5 forbids adding routes after `listen()` — same reason `/healthz` is registered there), guarded by `config.setupUi?.enabled`.

### Invariants every child must hold

1. **No secret value is ever written into a response.** Inputs render with `value=""` and a masked placeholder. There is no reveal control and no route that returns a stored value. Add a test that greps the rendered HTML for a known secret value and asserts absence.
2. **Empty input means unchanged.** Clearing a value is an explicit action (delete for optional, clear for required), never a side effect of submitting a blank box.
3. **Every mutating route checks CSRF and the principal**, in that order, before touching storage.
4. **Escape everything.** Variable names are user-supplied. `escapeHtml` on every interpolation; a test with a name like `A"><script>` must round-trip inert. (`normalizeSecretKey` already rejects such names, but the view must not depend on that.)
5. **Key validation is `normalizeSecretKey()` from `SecretStore.ts`.** Do not re-implement the reserved-key list or the env-name regex — `RESERVED_ENV_KEYS` exists and `ContainerTargets.buildEnv` enforces it a second time at boot.

### Order

Strictly sequential: **271 → 272 → 273**. Each depends on the previous one's routes and view model.

271 needs only NOR-268's `parseEasyAuthPrincipal`. It is developable and demoable locally against the 0600 file store with a hand-set `X-MS-CLIENT-PRINCIPAL-NAME` header — no Azure, no Table, no Entra. That is deliberate: it decouples the UI chain from the backend chain after 268 lands.

### Local development recipe (put this in the PR description for 271)

```bash
# Terminal 1 — router with the setup UI on, file secret store, no Azure.
cat > /tmp/cyrus-router/router-config.json <<'JSON'
{ "port": 3456, "dbPath": "/tmp/cyrus-router/router.db",
  "workspaces": {}, "webhook": { "verificationMode": "direct", "secret": "x" },
  "setupUi": { "enabled": true, "devTrustHeaders": true } }
JSON
cyrus --cyrus-home /tmp/cyrus-router router start

# Terminal 2 — impersonate the sidecar.
curl -H 'X-MS-CLIENT-PRINCIPAL-NAME: alice@example.com' http://127.0.0.1:3456/setup
```

`setupUi.devTrustHeaders` (default `false`) is what permits header-only auth without a sidecar in front. NOR-271 must make it **refuse to start** if `devTrustHeaders` is true while `entra` is configured — that flag being on in production is the one way this design fails open.

### Definition of done for this grouping issue

1. All three children merged.
2. A teammate signs in at `https://<router-fqdn>/setup`, sees their required variables, sets `CLAUDE_CODE_OAUTH_TOKEN`, adds an optional variable, saves, and a subsequently delegated Linear issue boots a worker with those values — verified via an F1 test drive.
3. `docs/ROUTER.md` and `infra/azure/README.md` step 9 replaced: the UI is the documented path, `az containerapp exec` demoted to break-glass.
4. Page renders correctly with values redacted in the response body (test asserted, not eyeballed).





---

# NOR-271: Implement authenticated setup management page shell

**State:** Backlog | **Priority:** --- | **Assignee:** Unassigned | **Project:** Cyrus | **Milestone:** First multi-user release

Build the initial static HTMX page for setup management, styled with Pico CSS and protected by the configured authentication flow. Include the base layout and page structure needed to load and display the user's environment variables.

## Parent

- **NOR-267**: Build setup management UI _[Backlog]_


## Comments

### Comment

## Implementation plan — authenticated setup management page shell

First of the UI chain. Consumes `requireSetupPrincipal` (NOR-268) and `SetupBootstrap` (NOR-270). Produces `views.ts`, `csrf.ts`, `routes.ts`, and the vendored assets that NOR-272 and NOR-273 extend.

**Files**
* Create: `packages/router/src/setup/views.ts`, `csrf.ts`, `routes.ts`, `formbody.ts`
* Create: `packages/router/src/setup/vendor/pico.ts`, `packages/router/src/setup/vendor/htmx.ts`
* Create: `scripts/vendor-setup-assets.mjs`
* Create: `packages/router/test/setup-views.test.ts`, `setup-csrf.test.ts`, `setup-routes.test.ts`
* Modify: `packages/router/src/RouterServer.ts` (register the routes)
* Modify: `packages/router/src/index.ts`

---

### Scope boundary

This issue delivers a **read-only** page: sign in, see your variables, see which required ones are unset. Add/delete is NOR-272; saving is NOR-273. The value inputs render in this issue (so the layout is settled) but the save button is disabled with a "coming in NOR-273" title — or, if you prefer not to ship a dead control, omit the inputs and add them in 273. Either is fine; pick one and say which in the PR.

### Why assets are vendored as TypeScript

ACA egress is deny-by-default, so a `<link>` to a CDN silently fails. The options were: (a) ship `.css`/`.js` files and add a copy step to the router's `tsc` build plus `files` in `package.json`; (b) embed them as exported string constants in `.ts` modules. (b) needs zero build changes and zero Dockerfile changes, and `tsc` already compiles everything under `src/`. The cost is two large generated files in git, which is acceptable for two pinned vendor blobs.

`scripts/vendor-setup-assets.mjs` regenerates them from pinned versions so nobody hand-edits them:

```js
#!/usr/bin/env node
// Regenerates packages/router/src/setup/vendor/*.ts from pinned upstream
// releases. Run manually and commit the result — the router image never
// fetches these at build or run time (ACA egress is deny-by-default).
import { writeFileSync } from "node:fs";

const ASSETS = [
	{
		out: "packages/router/src/setup/vendor/pico.ts",
		export: "PICO_CSS",
		url: "https://unpkg.com/@picocss/pico@2.1.1/css/pico.classless.min.css",
	},
	{
		out: "packages/router/src/setup/vendor/htmx.ts",
		export: "HTMX_JS",
		url: "https://unpkg.com/htmx.org@2.0.4/dist/htmx.min.js",
	},
];

for (const asset of ASSETS) {
	const response = await fetch(asset.url);
	if (!response.ok) throw new Error(`${asset.url} → ${response.status}`);
	const body = await response.text();
	writeFileSync(
		asset.out,
		`// GENERATED by scripts/vendor-setup-assets.mjs — do not edit.\n` +
			`// Source: ${asset.url}\n` +
			`export const ${asset.export} = ${JSON.stringify(body)};\n`,
	);
	console.log(`wrote ${asset.out} (${body.length} bytes)`);
}
```

Confirm the exact latest stable versions when you run it and pin whatever you get; the URLs above are the shape, not a version assertion.

---

### Task 1: HTML escaping and the view functions

- [ ] **Step 1: Write the failing tests**

`packages/router/test/setup-views.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	escapeHtml,
	renderPage,
	renderVariablesTable,
	type SetupPageModel,
} from "../src/setup/views.js";

const model: SetupPageModel = {
	email: "alice@example.com",
	variables: [
		{ name: "CLAUDE_CODE_OAUTH_TOKEN", required: true, isSet: true },
		{ name: "GIT_TOKEN", required: true, isSet: false },
		{ name: "MY_TOOL_KEY", required: false, isSet: true },
	],
	missingRequired: ["GIT_TOKEN"],
	csrfToken: "tok.123",
};

describe("escapeHtml", () => {
	it("escapes the five significant characters", () => {
		expect(escapeHtml(`<a href="x" data='y'>&</a>`)).toBe(
			"&lt;a href=&quot;x&quot; data=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
		);
	});

	it("escapes ampersands before anything else", () => {
		expect(escapeHtml("&lt;")).toBe("&amp;lt;");
	});
});

describe("renderVariablesTable", () => {
	it("renders one row per variable, names included", () => {
		const html = renderVariablesTable(model);
		expect(html).toContain("CLAUDE_CODE_OAUTH_TOKEN");
		expect(html).toContain("GIT_TOKEN");
		expect(html).toContain("MY_TOOL_KEY");
	});

	it("marks required variables and does not offer to delete them", () => {
		const html = renderVariablesTable(model);
		expect(html).not.toMatch(
			/CLAUDE_CODE_OAUTH_TOKEN[\s\S]{0,400}hx-delete/,
		);
	});

	it("distinguishes set from unset without revealing anything", () => {
		const html = renderVariablesTable(model);
		expect(html).toMatch(/GIT_TOKEN[\s\S]{0,400}Not set/);
		expect(html).toMatch(/MY_TOOL_KEY[\s\S]{0,400}Set/);
	});

	it("renders value inputs empty", () => {
		expect(renderVariablesTable(model)).not.toMatch(/value="[^"]+"/);
	});

	it("escapes a hostile variable name", () => {
		const html = renderVariablesTable({
			...model,
			variables: [{ name: `X"><script>alert(1)</script>`, required: false, isSet: false }],
		});
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain("&lt;script&gt;");
	});

	it("embeds the csrf token as a hidden field", () => {
		expect(renderVariablesTable(model)).toContain('value="tok.123"');
	});
});

describe("renderPage", () => {
	it("includes the signed-in email and a sign-out link", () => {
		const html = renderPage(model);
		expect(html).toContain("alice@example.com");
		expect(html).toContain("/.auth/logout");
	});

	it("references only same-origin assets", () => {
		const html = renderPage(model);
		expect(html).toContain("/setup/assets/pico.css");
		expect(html).toContain("/setup/assets/htmx.js");
		expect(html).not.toMatch(/https?:\/\/(unpkg|cdn|jsdelivr)/);
	});

	it("warns when a required variable is unset", () => {
		expect(renderPage(model)).toMatch(/GIT_TOKEN/);
		expect(renderPage(model)).toMatch(/not.*ready|missing/i);
	});

	it("shows no warning when nothing is missing", () => {
		const html = renderPage({ ...model, missingRequired: [] });
		expect(html).not.toMatch(/not ready/i);
	});

	it("embeds the table so the first paint needs no htmx request", () => {
		expect(renderPage(model)).toContain("MY_TOOL_KEY");
	});

	it("renders a message banner when one is present", () => {
		const html = renderPage({
			...model,
			message: { kind: "error", text: "Something went wrong" },
		});
		expect(html).toContain("Something went wrong");
	});
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `packages/router/src/setup/views.ts`**

Full file — every interpolation goes through `escapeHtml`, and no stored value ever reaches the output.

```ts
export interface VariableView {
	name: string;
	required: boolean;
	/** Whether a non-empty value is stored. The value itself never appears. */
	isSet: boolean;
}

export interface SetupMessage {
	kind: "ok" | "error" | "conflict";
	text: string;
}

export interface SetupPageModel {
	email: string;
	variables: VariableView[];
	missingRequired: string[];
	csrfToken: string;
	message?: SetupMessage;
}

/** `&` first — escaping it later would double-escape the entities we emit. */
export function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function renderRow(variable: VariableView): string {
	const name = escapeHtml(variable.name);
	return `
	<tr>
		<td><code>${name}</code>${variable.required ? ' <small aria-label="required">required</small>' : ""}</td>
		<td>${variable.isSet ? "Set" : "<em>Not set</em>"}</td>
		<td>
			<input type="password" name="value:${name}" value=""
				autocomplete="off" spellcheck="false"
				placeholder="${variable.isSet ? "unchanged" : "enter a value"}"
				aria-label="Value for ${name}">
		</td>
		<td>${variable.required ? "" : `<button type="button" class="secondary" hx-delete="/setup/variables/${encodeURIComponent(variable.name)}" hx-target="#variables" hx-swap="outerHTML" hx-include="#csrf">Delete</button>`}</td>
	</tr>`;
}

export function renderVariablesTable(model: SetupPageModel): string {
	const rows = model.variables.map(renderRow).join("");
	return `<div id="variables">
	<input type="hidden" id="csrf" name="csrf" value="${escapeHtml(model.csrfToken)}">
	<table>
		<thead>
			<tr><th>Variable</th><th>Status</th><th>New value</th><th></th></tr>
		</thead>
		<tbody>${rows}</tbody>
	</table>
</div>`;
}

function renderMessage(message: SetupMessage | undefined): string {
	if (!message) return "";
	const role = message.kind === "ok" ? "status" : "alert";
	return `<article role="${role}" data-kind="${message.kind}">${escapeHtml(message.text)}</article>`;
}

function renderMissingBanner(missing: string[]): string {
	if (missing.length === 0) return "";
	const names = missing.map((name) => `<code>${escapeHtml(name)}</code>`).join(", ");
	return `<article role="alert">
		<strong>Your sessions are not ready to run.</strong>
		These required variables have no value yet: ${names}.
	</article>`;
}

export function renderPage(model: SetupPageModel): string {
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Cyrus setup</title>
	<link rel="stylesheet" href="/setup/assets/pico.css">
	<script src="/setup/assets/htmx.js" defer></script>
</head>
<body>
	<main>
		<header>
			<h1>Cyrus setup</h1>
			<p>Signed in as <strong>${escapeHtml(model.email)}</strong> · <a href="/.auth/logout">Sign out</a></p>
		</header>
		${renderMessage(model.message)}
		${renderMissingBanner(model.missingRequired)}
		<p><small>These environment variables are injected into the container that runs your Cyrus sessions. Values are never displayed back to you — leave a field blank to keep the stored value.</small></p>
		${renderVariablesTable(model)}
	</main>
</body>
</html>`;
}
```

- [ ] **Step 4: Run — PASS. Commit.**

---

### Task 2: CSRF tokens

The EasyAuth session is a cookie, and we do not control its `SameSite` attribute — so treat cross-site POST as possible and defend explicitly.

- [ ] **Step 1: Write the failing tests**

`packages/router/test/setup-csrf.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CsrfTokens } from "../src/setup/csrf.js";

describe("CsrfTokens", () => {
	it("accepts a token it issued for the same principal", () => {
		const csrf = new CsrfTokens({ now: () => 1_000 });
		expect(csrf.verify("alice@example.com", csrf.issue("alice@example.com"))).toBe(true);
	});

	it("rejects a token issued for a different principal", () => {
		const csrf = new CsrfTokens({ now: () => 1_000 });
		expect(csrf.verify("bob@example.com", csrf.issue("alice@example.com"))).toBe(false);
	});

	it("rejects an expired token", () => {
		let now = 1_000;
		const csrf = new CsrfTokens({ now: () => now, ttlMs: 60_000 });
		const token = csrf.issue("alice@example.com");
		now = 62_000;
		expect(csrf.verify("alice@example.com", token)).toBe(false);
	});

	it("rejects a tampered token", () => {
		const csrf = new CsrfTokens({ now: () => 1_000 });
		const token = csrf.issue("alice@example.com");
		expect(csrf.verify("alice@example.com", `${token}x`)).toBe(false);
	});

	it("rejects a malformed or empty token without throwing", () => {
		const csrf = new CsrfTokens({ now: () => 1_000 });
		for (const bad of ["", "nodot", "a.b.c", "....", "x.notanumber"]) {
			expect(csrf.verify("alice@example.com", bad)).toBe(false);
		}
	});

	it("uses a distinct secret per instance, so a restart invalidates tokens", () => {
		const token = new CsrfTokens({ now: () => 1_000 }).issue("alice@example.com");
		expect(new CsrfTokens({ now: () => 1_000 }).verify("alice@example.com", token)).toBe(false);
	});
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `packages/router/src/setup/csrf.ts`**

```ts
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

export interface CsrfTokensOptions {
	now?: () => number;
	ttlMs?: number;
	/** Test seam. Defaults to 32 fresh random bytes per instance. */
	secret?: Buffer;
}

/**
 * Double-submit CSRF tokens for the setup page.
 *
 * The EasyAuth session cookie is issued by the auth sidecar, so its SameSite
 * attribute is not ours to set — a cross-site form POST could otherwise ride
 * the teammate's session. Each rendered page embeds a token bound to the
 * signed-in principal; every mutating route requires it back.
 *
 * The secret is per-process and in-memory. The router is deliberately single
 * replica, so there is no cross-replica validation to worry about; a restart
 * invalidates outstanding tokens, and the user's next action re-renders the
 * page with a fresh one.
 */
export class CsrfTokens {
	private readonly secret: Buffer;
	private readonly now: () => number;
	private readonly ttlMs: number;

	constructor(options: CsrfTokensOptions = {}) {
		this.secret = options.secret ?? randomBytes(32);
		this.now = options.now ?? Date.now;
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
	}

	issue(principalEmail: string): string {
		const expiresAt = this.now() + this.ttlMs;
		return `${this.sign(principalEmail, expiresAt)}.${expiresAt}`;
	}

	verify(principalEmail: string, token: string): boolean {
		const separator = token.lastIndexOf(".");
		if (separator <= 0) return false;
		const signature = token.slice(0, separator);
		const expiresAt = Number(token.slice(separator + 1));
		if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) {
			return false;
		}
		const expected = Buffer.from(this.sign(principalEmail, expiresAt));
		const actual = Buffer.from(signature);
		// timingSafeEqual throws on a length mismatch, so check first.
		return (
			expected.length === actual.length && timingSafeEqual(expected, actual)
		);
	}

	private sign(principalEmail: string, expiresAt: number): string {
		return createHmac("sha256", this.secret)
			.update(`${principalEmail.toLowerCase()}|${expiresAt}`)
			.digest("base64url");
	}
}
```

- [ ] **Step 4: Run — PASS. Commit.**

---

### Task 3: form body parsing

Fastify v5 parses JSON out of the box but **not** `application/x-www-form-urlencoded`, which is what htmx posts by default. Rather than add `@fastify/formbody`, register a parser the same way `artifacts.ts` already does for its binary body.

- [ ] **Step 1–4:** create `packages/router/src/setup/formbody.ts`:

```ts
import { parse } from "node:querystring";
import type { FastifyInstance } from "fastify";

/** 64 KB — a setup form is a handful of tokens, never more. */
const BODY_LIMIT = 64 * 1024;

/**
 * Teaches Fastify to parse the urlencoded bodies htmx submits. Registered
 * instead of pulling in @fastify/formbody: it is ten lines, and it keeps the
 * router's dependency surface unchanged.
 */
export function registerFormBodyParser(fastify: FastifyInstance): void {
	fastify.addContentTypeParser(
		"application/x-www-form-urlencoded",
		{ parseAs: "string", bodyLimit: BODY_LIMIT },
		(_request, body, done) => {
			try {
				done(null, parse(body as string));
			} catch (error) {
				done(error as Error, undefined);
			}
		},
	);
}
```

Test that a duplicated field (`a=1&a=2`) arrives as an array and that a body over the limit is rejected with 413 — NOR-272/273 both read fields off this and must not be surprised.

---

### Task 4: the routes

- [ ] **Step 1: Write the failing tests**

`packages/router/test/setup-routes.test.ts` — use `fastify.inject()`, no network:

```ts
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerSetupRoutes } from "../src/setup/routes.js";
// ...build deps over an in-memory RouterStore + FileSecretStore, as in
// setup-bootstrap.test.ts

describe("GET /setup", () => {
	it("returns 401 with no principal headers", async () => {
		const app = build({});
		const res = await app.inject({ method: "GET", url: "/setup" });
		expect(res.statusCode).toBe(401);
	});

	it("returns 403 for a principal outside the allowed domain", async () => {
		const app = build({ allowedDomain: "example.com" });
		const res = await app.inject({
			method: "GET",
			url: "/setup",
			headers: { "x-ms-client-principal-name": "eve@evil.test" },
		});
		expect(res.statusCode).toBe(403);
	});

	it("renders the page for a signed-in teammate", async () => {
		const app = build({});
		const res = await app.inject({
			method: "GET",
			url: "/setup",
			headers: { "x-ms-client-principal-name": "alice@example.com" },
		});
		expect(res.statusCode).toBe(200);
		expect(res.headers["content-type"]).toContain("text/html");
		expect(res.body).toContain("alice@example.com");
		expect(res.body).toContain("CLAUDE_CODE_OAUTH_TOKEN");
	});

	it("bootstraps the user on first visit", async () => {
		const { app, store } = buildWithStore({});
		await app.inject({
			method: "GET",
			url: "/setup",
			headers: { "x-ms-client-principal-name": "alice@example.com" },
		});
		expect(store.getUserByEmail("alice@example.com")).toBeDefined();
	});

	it("never sends a stored value to the browser", async () => {
		const { app, secrets } = buildWithStore({});
		await secrets.set("alice@example.com", "GIT_TOKEN", "ghp_supersecret");
		const res = await app.inject({
			method: "GET",
			url: "/setup",
			headers: { "x-ms-client-principal-name": "alice@example.com" },
		});
		expect(res.body).not.toContain("ghp_supersecret");
	});

	it("sets no-store and the hardening headers", async () => {
		const app = build({});
		const res = await app.inject({
			method: "GET",
			url: "/setup",
			headers: { "x-ms-client-principal-name": "alice@example.com" },
		});
		expect(res.headers["cache-control"]).toBe("no-store");
		expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
		expect(res.headers["x-content-type-options"]).toBe("nosniff");
		expect(res.headers["referrer-policy"]).toBe("no-referrer");
	});

	it("renders a helpful page, not a bare 403, for an unregistered user", async () => {
		const app = build({ autoProvisionUsers: false });
		const res = await app.inject({
			method: "GET",
			url: "/setup",
			headers: { "x-ms-client-principal-name": "stranger@example.com" },
		});
		expect(res.statusCode).toBe(403);
		expect(res.body).toContain("cyrus router users add");
	});
});

describe("GET /setup/variables", () => {
	it("returns just the table fragment", async () => {
		const app = build({});
		const res = await app.inject({
			method: "GET",
			url: "/setup/variables",
			headers: { "x-ms-client-principal-name": "alice@example.com" },
		});
		expect(res.body).toContain('id="variables"');
		expect(res.body).not.toContain("<!doctype html>");
	});

	it("requires authentication", async () => {
		const app = build({});
		expect(
			(await app.inject({ method: "GET", url: "/setup/variables" })).statusCode,
		).toBe(401);
	});
});

describe("GET /setup/assets", () => {
	it("serves the vendored css with a long cache", async () => {
		const app = build({});
		const res = await app.inject({ method: "GET", url: "/setup/assets/pico.css" });
		expect(res.statusCode).toBe(200);
		expect(res.headers["content-type"]).toContain("text/css");
		expect(res.headers["cache-control"]).toContain("immutable");
	});

	it("serves assets without authentication (they contain nothing private)", async () => {
		const app = build({ allowedDomain: "example.com" });
		expect(
			(await app.inject({ method: "GET", url: "/setup/assets/htmx.js" })).statusCode,
		).toBe(200);
	});
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `packages/router/src/setup/routes.ts`**

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RouterStore } from "../RouterStore.js";
import type { SecretStoreBackend } from "../SecretStore.js";
import type { SetupBootstrap } from "./bootstrap.js";
import type { CsrfTokens } from "./csrf.js";
import { registerFormBodyParser } from "./formbody.js";
import {
	requireSetupPrincipal,
	type SetupAuthConfig,
	SetupAuthError,
	type SetupPrincipal,
} from "./principal.js";
import { HTMX_JS } from "./vendor/htmx.js";
import { PICO_CSS } from "./vendor/pico.js";
import {
	renderPage,
	renderVariablesTable,
	type SetupPageModel,
	type VariableView,
} from "./views.js";

/**
 * Locked down hard because the page holds credentials: no external anything,
 * no framing, no form posts off-origin. `unsafe-inline` covers only styles —
 * htmx and Pico both need it for the attribute-driven bits, and no inline
 * <script> exists on the page.
 */
const CSP =
	"default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; " +
	"img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export interface SetupRouteDeps {
	store: RouterStore;
	secrets: SecretStoreBackend;
	requiredKeys: readonly string[];
	auth: SetupAuthConfig;
	bootstrap: SetupBootstrap;
	csrf: CsrfTokens;
	logger: { info(msg: string): void; warn(msg: string): void };
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

export function registerSetupRoutes(
	fastify: FastifyInstance,
	deps: SetupRouteDeps,
): void {
	registerFormBodyParser(fastify);

	// Assets carry no user data, so they are deliberately unauthenticated —
	// otherwise the login redirect would race the stylesheet on first paint.
	fastify.get("/setup/assets/pico.css", async (_request, reply) =>
		reply
			.header("content-type", "text/css; charset=utf-8")
			.header("cache-control", "public, max-age=31536000, immutable")
			.send(PICO_CSS),
	);
	fastify.get("/setup/assets/htmx.js", async (_request, reply) =>
		reply
			.header("content-type", "text/javascript; charset=utf-8")
			.header("cache-control", "public, max-age=31536000, immutable")
			.send(HTMX_JS),
	);

	fastify.get("/setup", async (request, reply) => {
		const outcome = await resolve(deps, request);
		if ("error" in outcome) {
			return secureHtml(reply)
				.status(outcome.error.status)
				.send(renderError(outcome.error));
		}
		return secureHtml(reply).send(renderPage(outcome.model));
	});

	fastify.get("/setup/variables", async (request, reply) => {
		const outcome = await resolve(deps, request);
		if ("error" in outcome) {
			return secureHtml(reply)
				.status(outcome.error.status)
				.send(renderError(outcome.error));
		}
		return secureHtml(reply).send(renderVariablesTable(outcome.model));
	});
}

/** Authenticate → bootstrap → read → build the page model. Shared by both GETs. */
async function resolve(
	deps: SetupRouteDeps,
	request: FastifyRequest,
): Promise<{ model: SetupPageModel } | { error: SetupAuthError }> {
	let principal: SetupPrincipal;
	try {
		principal = requireSetupPrincipal(request.headers, deps.auth);
		await deps.bootstrap.ensure(principal);
	} catch (error) {
		if (error instanceof SetupAuthError) return { error };
		throw error;
	}
	return { model: await buildModel(deps, principal) };
}

export async function buildModel(
	deps: SetupRouteDeps,
	principal: SetupPrincipal,
	message?: SetupPageModel["message"],
): Promise<SetupPageModel> {
	const bundle = await deps.secrets.get(principal.email);
	const required = new Set(deps.requiredKeys);
	const names = [
		// Required first, in configured order; then the rest alphabetically, so
		// the table does not reshuffle between renders.
		...deps.requiredKeys,
		...Object.keys(bundle)
			.filter((name) => !required.has(name))
			.sort(),
	];
	const variables: VariableView[] = names.map((name) => ({
		name,
		required: required.has(name),
		isSet: Boolean(bundle[name]),
	}));
	return {
		email: principal.email,
		variables,
		missingRequired: deps.requiredKeys.filter((key) => !bundle[key]),
		csrfToken: deps.csrf.issue(principal.email),
		...(message ? { message } : {}),
	};
}

function renderError(error: SetupAuthError): string {
	const body =
		error.status === 401
			? `<p>You are not signed in. <a href="/.auth/login/aad?post_login_redirect_uri=/setup">Sign in</a>.</p>`
			: `<p>${escapeForError(error.message)}</p>`;
	return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Cyrus setup</title><link rel="stylesheet" href="/setup/assets/pico.css"></head>
<body><main><h1>Cyrus setup</h1>${body}</main></body></html>`;
}

function escapeForError(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}
```

Note the ordering rule in `buildModel`: required keys in configured order, then the rest sorted. Without it the table order follows `Object.keys` on a decrypted JSON object, which shifts whenever a key is added or removed — visually confusing, and it makes NOR-272's fragment-swap tests flaky.

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Register from `RouterServer`**

In the constructor, after `registerArtifactsRoute` (Fastify v5 forbids adding routes post-`listen()`):

```ts
if (config.setupUi?.enabled) {
	// buildContainerTargets ran above and assigned these; the constructor
	// guard added in NOR-270 Task 3 Step 3 guarantees `containers` is set.
	registerSetupRoutes(this.fastify, {
		store: this.store,
		secrets: this.setupSecrets!,
		requiredKeys: this.setupRequiredKeys!,
		auth: {
			allowedDomain:
				config.setupUi.allowedDomain ?? config.entra?.allowedDomain,
		},
		bootstrap: this.setupBootstrap!,
		csrf: new CsrfTokens(),
		logger: this.logger,
	});
	this.logger.info("Setup UI enabled at /setup");
}
```

`devTrustHeaders` needs no branch here — `parseEasyAuthPrincipal` already reads whatever headers arrive. The flag exists purely so the constructor guard from NOR-268 Task 2 can refuse the dangerous combination; document that in a comment so nobody "fixes" it by adding a redundant check.

- [ ] **Step 6: Full suite + typecheck. Commit.**

```bash
pnpm --filter cyrus-router test:run && pnpm typecheck
git add packages/router/src/setup packages/router/test/setup-*.test.ts \
  packages/router/src/RouterServer.ts scripts/vendor-setup-assets.mjs
git commit -m "feat(router): serve the authenticated setup page shell"
```

---

### Manual verification

```bash
mkdir -p /tmp/cyrus-router
cat > /tmp/cyrus-router/router-config.json <<'JSON'
{ "port": 3456, "dbPath": "/tmp/cyrus-router/router.db", "workspaces": {},
  "webhook": { "verificationMode": "direct", "secret": "x" },
  "containers": { "image": "img", "routerUrlForContainers": "ws://localhost", "repositories": [] },
  "setupUi": { "enabled": true, "devTrustHeaders": true } }
JSON
cyrus --cyrus-home /tmp/cyrus-router router start

curl -s http://127.0.0.1:3456/setup                                   # 401 page
curl -s -H 'X-MS-CLIENT-PRINCIPAL-NAME: alice@example.com' \
  http://127.0.0.1:3456/setup | head -40                              # rendered page
```

Then open it in a browser through a local proxy that injects the header, and confirm Pico styling loads and the console is clean.

### Definition of done

1. `pnpm --filter cyrus-router test:run`, `pnpm typecheck`, `pnpm lint` pass.
2. Response body contains no stored value (test asserted).
3. CSP, `no-store`, `nosniff`, `no-referrer`, `DENY` present on every `/setup` HTML response.
4. `setupUi` absent → zero new routes registered (add a test asserting `/setup` 404s).
5. If NOR-268 has already been applied to dev, run its **Task 4 Step 7 trust gate** now and record the result on NOR-268.





---

# NOR-272: Add UI for managing optional environment variables

**State:** Backlog | **Priority:** --- | **Assignee:** Unassigned | **Project:** Cyrus | **Milestone:** First multi-user release

Show environment variables in a simple table and allow users to add and delete non-required variables. The UI should distinguish required variables from optional ones and support in-page editing interactions.

## Parent

- **NOR-267**: Build setup management UI _[Backlog]_


## Comments

### Comment

## Implementation plan — add and delete optional environment variables

Builds directly on NOR-271's `routes.ts` / `views.ts` / `csrf.ts`. Adds two mutating routes and the shared mutation guard that NOR-273 reuses.

**Files**
* Modify: `packages/router/src/setup/routes.ts` (`POST /setup/variables`, `DELETE /setup/variables/:name`, `requireMutation`)
* Modify: `packages/router/src/setup/views.ts` (add-variable form)
* Modify: `packages/router/test/setup-routes.test.ts`, `setup-views.test.ts`

---

### Interaction model

One swap target, always. Every mutation returns the whole `#variables` fragment (`hx-target="#variables" hx-swap="outerHTML"`), never a single row. Row-level swaps would need the client to reason about ordering and about the "required vs optional" split, and every such bug is invisible until a teammate loses a variable. Re-rendering the fragment costs one extra read and removes the class entirely.

Required vs optional:

| | Rename | Delete | Clear value |
| --- | --- | --- | --- |
| Required (`DEFAULT_REQUIRED_SECRET_KEYS` ∪ `containers.requiredSecretKeys`) | no | **no** | yes (NOR-273) |
| Optional | no (delete + re-add) | yes | yes, via delete |

Deleting a required variable is refused server-side, not merely hidden in the UI. The row has no delete button, but the route is reachable by hand, and a required key removed from the record makes `ContainerTargets.buildEnv` throw on the next boot with `not fully authenticated`. Refuse it with a 400 and a message, and add the test.

### Validation

`normalizeSecretKey()` from `SecretStore.ts` is the only validator. It already:

* maps legacy names (`githubPat` → `GIT_TOKEN`) — so adding `githubPat` correctly produces a `GIT_TOKEN` row rather than a second one;
* rejects `RESERVED_ENV_KEYS` (`CYRUS_ROUTER_URL`, `CYRUS_DEVICE_TOKEN`, `CYRUS_ISSUE_KEY`, `CYRUS_REPOS_JSON`, `CYRUS_WORKSPACES_DIR`, `CYRUS_REPO_CACHE_DIR`, `PATH`, `HOME`, `NODE_OPTIONS`);
* rejects anything failing `^[A-Za-z_][A-Za-z0-9_]*$`.

Its thrown messages are already user-appropriate — surface them verbatim in the banner rather than writing a second set.

---

### Task 1: the shared mutation guard

Every mutating route needs the same four checks in the same order. Factor it once now; NOR-273 depends on it.

- [ ] **Step 1: Write the failing tests** (append to `setup-routes.test.ts`)

```ts
describe("mutation guard", () => {
	it("rejects a mutation with no principal", async () => {
		const app = build({});
		const res = await app.inject({
			method: "POST",
			url: "/setup/variables",
			payload: "name=FOO&csrf=whatever",
			headers: { "content-type": "application/x-www-form-urlencoded" },
		});
		expect(res.statusCode).toBe(401);
	});

	it("rejects a mutation with a missing csrf token", async () => {
		const app = build({});
		const res = await app.inject({
			method: "POST",
			url: "/setup/variables",
			payload: "name=FOO",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"x-ms-client-principal-name": "alice@example.com",
			},
		});
		expect(res.statusCode).toBe(403);
	});

	it("rejects a csrf token issued for another principal", async () => {
		const { app, csrf } = buildWithCsrf({});
		const res = await app.inject({
			method: "POST",
			url: "/setup/variables",
			payload: `name=FOO&csrf=${encodeURIComponent(csrf.issue("bob@example.com"))}`,
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"x-ms-client-principal-name": "alice@example.com",
			},
		});
		expect(res.statusCode).toBe(403);
	});

	it("checks auth before csrf, so an anonymous request never reveals token state", async () => {
		const app = build({});
		const res = await app.inject({
			method: "POST",
			url: "/setup/variables",
			payload: "name=FOO&csrf=bogus",
			headers: { "content-type": "application/x-www-form-urlencoded" },
		});
		expect(res.statusCode).toBe(401);
	});
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** in `packages/router/src/setup/routes.ts`:

```ts
/**
 * Authenticate → CSRF → bootstrap, in that order.
 *
 * Order matters: checking CSRF first would let an unauthenticated caller probe
 * token validity, and the 403-before-401 also confuses the login redirect.
 */
async function requireMutation(
	deps: SetupRouteDeps,
	request: FastifyRequest,
): Promise<{ principal: SetupPrincipal } | { error: SetupAuthError }> {
	let principal: SetupPrincipal;
	try {
		principal = requireSetupPrincipal(request.headers, deps.auth);
	} catch (error) {
		if (error instanceof SetupAuthError) return { error };
		throw error;
	}

	const body = (request.body ?? {}) as Record<string, unknown>;
	const token = typeof body.csrf === "string" ? body.csrf : "";
	if (!deps.csrf.verify(principal.email, token)) {
		return {
			error: new SetupAuthError(
				403,
				"This page expired. Reload it and try again.",
			),
		};
	}

	try {
		await deps.bootstrap.ensure(principal);
	} catch (error) {
		if (error instanceof SetupAuthError) return { error };
		throw error;
	}
	return { principal };
}
```

Note for `DELETE`: htmx sends `hx-include="#csrf"` values as a **query string** on DELETE, not a body. Read the token from `request.body` *or* `request.query` so both verbs work:

```ts
const source = {
	...((request.query ?? {}) as Record<string, unknown>),
	...((request.body ?? {}) as Record<string, unknown>),
};
const token = typeof source.csrf === "string" ? source.csrf : "";
```

Use that version. Add a test covering the DELETE-with-query-string path explicitly — it is the exact thing that silently breaks if someone later "simplifies" the guard to body-only.

- [ ] **Step 4: Run — PASS. Commit.**

---

### Task 2: the add-variable form

- [ ] **Step 1: Write the failing test** (append to `setup-views.test.ts`)

```ts
describe("renderVariablesTable — add form", () => {
	it("renders an add form that posts to /setup/variables", () => {
		const html = renderVariablesTable(model);
		expect(html).toContain('hx-post="/setup/variables"');
		expect(html).toContain('name="name"');
		expect(html).toContain('hx-target="#variables"');
	});

	it("includes the csrf token in the add form", () => {
		expect(renderVariablesTable(model)).toContain('value="tok.123"');
	});
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** Append inside the `#variables` div in `renderVariablesTable`, after the `</table>`:

```ts
`	<form hx-post="/setup/variables" hx-target="#variables" hx-swap="outerHTML">
		<input type="hidden" name="csrf" value="${escapeHtml(model.csrfToken)}">
		<fieldset role="group">
			<input type="text" name="name" placeholder="NEW_VARIABLE_NAME"
				pattern="[A-Za-z_][A-Za-z0-9_]*" required
				autocomplete="off" spellcheck="false"
				aria-label="New variable name">
			<button type="submit">Add variable</button>
		</fieldset>
		<small>Uppercase letters, digits and underscores. The value is set below, then saved.</small>
	</form>`
```

The `pattern` attribute is a convenience only — it mirrors `VALID_ENV_NAME_RE` for instant feedback. The server never relies on it. Add a comment saying so, because a future reader will otherwise assume it is the validation.

The hidden `#csrf` input from NOR-271 stays for the delete buttons' `hx-include`; this form carries its own copy because htmx form posts include only the form's own fields.

- [ ] **Step 4: Run — PASS. Commit.**

---

### Task 3: `POST /setup/variables`

- [ ] **Step 1: Write the failing tests**

```ts
describe("POST /setup/variables", () => {
	async function add(app, csrf, name: string, email = "alice@example.com") {
		return app.inject({
			method: "POST",
			url: "/setup/variables",
			payload: `name=${encodeURIComponent(name)}&csrf=${encodeURIComponent(csrf.issue(email))}`,
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"x-ms-client-principal-name": email,
			},
		});
	}

	it("adds an optional variable with an empty value", async () => {
		const { app, csrf, secrets } = buildWithCsrf({});
		const res = await add(app, csrf, "MY_TOOL_KEY");
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain("MY_TOOL_KEY");
		expect(await secrets.get("alice@example.com")).toMatchObject({
			MY_TOOL_KEY: "",
		});
	});

	it("returns the whole table fragment, not a row", async () => {
		const { app, csrf } = buildWithCsrf({});
		const res = await add(app, csrf, "MY_TOOL_KEY");
		expect(res.body).toContain('id="variables"');
		expect(res.body).toContain("CLAUDE_CODE_OAUTH_TOKEN");
	});

	it("rejects a reserved env name with the store's own message", async () => {
		const { app, csrf, secrets } = buildWithCsrf({});
		const res = await add(app, csrf, "CYRUS_DEVICE_TOKEN");
		expect(res.statusCode).toBe(400);
		expect(res.body).toMatch(/reserved/i);
		expect(await secrets.get("alice@example.com")).not.toHaveProperty(
			"CYRUS_DEVICE_TOKEN",
		);
	});

	it("rejects an invalid env name", async () => {
		const { app, csrf } = buildWithCsrf({});
		const res = await add(app, csrf, "not-a-valid-name");
		expect(res.statusCode).toBe(400);
		expect(res.body).toMatch(/environment variable name/i);
	});

	it("rejects an empty name", async () => {
		const { app, csrf } = buildWithCsrf({});
		const res = await add(app, csrf, "");
		expect(res.statusCode).toBe(400);
	});

	it("normalizes a legacy name instead of creating a duplicate row", async () => {
		const { app, csrf, secrets } = buildWithCsrf({});
		await add(app, csrf, "githubPat");
		const bundle = await secrets.get("alice@example.com");
		expect(bundle).toHaveProperty("GIT_TOKEN");
		expect(bundle).not.toHaveProperty("githubPat");
	});

	it("reports a duplicate without clobbering the stored value", async () => {
		const { app, csrf, secrets } = buildWithCsrf({});
		await secrets.set("alice@example.com", "MY_TOOL_KEY", "existing");
		const res = await add(app, csrf, "MY_TOOL_KEY");
		expect(res.statusCode).toBe(400);
		expect(res.body).toMatch(/already/i);
		expect(await secrets.get("alice@example.com")).toMatchObject({
			MY_TOOL_KEY: "existing",
		});
	});

	it("re-renders with a fresh csrf token after an error", async () => {
		const { app, csrf } = buildWithCsrf({});
		const res = await add(app, csrf, "PATH");
		expect(res.body).toMatch(/name="csrf" value="[^"]+"/);
	});

	it("does not leak values in the error re-render", async () => {
		const { app, csrf, secrets } = buildWithCsrf({});
		await secrets.set("alice@example.com", "MY_TOOL_KEY", "ghp_secret");
		const res = await add(app, csrf, "MY_TOOL_KEY");
		expect(res.body).not.toContain("ghp_secret");
	});
});
```

The "re-renders with a fresh csrf token after an error" case is load-bearing: the fragment replaces itself on every swap, so an error response that forgot the token would leave the page unable to perform any further mutation until a manual reload.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** in `routes.ts`:

```ts
fastify.post("/setup/variables", async (request, reply) => {
	const guard = await requireMutation(deps, request);
	if ("error" in guard) {
		return secureHtml(reply)
			.status(guard.error.status)
			.send(renderError(guard.error));
	}

	const body = (request.body ?? {}) as Record<string, unknown>;
	const raw = typeof body.name === "string" ? body.name.trim() : "";

	let name: string;
	try {
		if (!raw) throw new Error("Enter a variable name.");
		// The single source of truth for reserved names, the env-name regex,
		// and legacy-name mapping. Its messages are already user-facing.
		name = normalizeSecretKey(raw);
	} catch (error) {
		return respond(reply, deps, guard.principal, 400, {
			kind: "error",
			text: (error as Error).message,
		});
	}

	const bundle = await deps.secrets.get(guard.principal.email);
	if (Object.hasOwn(bundle, name)) {
		return respond(reply, deps, guard.principal, 400, {
			kind: "error",
			text: `${name} already exists. Set its value below and save.`,
		});
	}

	// Empty on creation: the value is entered in the table and committed by the
	// save flow (NOR-273), so adding a variable never posts a secret.
	await deps.secrets.set(guard.principal.email, name, "");
	return respond(reply, deps, guard.principal, 200, {
		kind: "ok",
		text: `Added ${name}. Enter its value and save.`,
	});
});

/** Re-renders the fragment with a fresh CSRF token and a status message. */
async function respond(
	reply: FastifyReply,
	deps: SetupRouteDeps,
	principal: SetupPrincipal,
	status: number,
	message: SetupMessage,
): Promise<FastifyReply> {
	const model = await buildModel(deps, principal, message);
	return secureHtml(reply)
		.status(status)
		.send(`${renderMessage(model.message)}${renderVariablesTable(model)}`);
}
```

Export `renderMessage` from `views.ts` for this (it is currently private). The message is prepended to the fragment and lands inside the `#variables` swap, so it clears on the next successful action without extra bookkeeping.

- [ ] **Step 4: Run — PASS. Commit.**

---

### Task 4: `DELETE /setup/variables/:name`

- [ ] **Step 1: Write the failing tests**

```ts
describe("DELETE /setup/variables/:name", () => {
	async function del(app, csrf, name: string, email = "alice@example.com") {
		return app.inject({
			method: "DELETE",
			url: `/setup/variables/${encodeURIComponent(name)}?csrf=${encodeURIComponent(csrf.issue(email))}`,
			headers: { "x-ms-client-principal-name": email },
		});
	}

	it("removes an optional variable", async () => {
		const { app, csrf, secrets } = buildWithCsrf({});
		await secrets.set("alice@example.com", "MY_TOOL_KEY", "v");
		const res = await del(app, csrf, "MY_TOOL_KEY");
		expect(res.statusCode).toBe(200);
		expect(await secrets.get("alice@example.com")).not.toHaveProperty(
			"MY_TOOL_KEY",
		);
	});

	it("refuses to delete a required variable even though the UI hides the button", async () => {
		const { app, csrf, secrets } = buildWithCsrf({});
		await secrets.set("alice@example.com", "CLAUDE_CODE_OAUTH_TOKEN", "v");
		const res = await del(app, csrf, "CLAUDE_CODE_OAUTH_TOKEN");
		expect(res.statusCode).toBe(400);
		expect(res.body).toMatch(/required/i);
		expect(await secrets.get("alice@example.com")).toMatchObject({
			CLAUDE_CODE_OAUTH_TOKEN: "v",
		});
	});

	it("is idempotent for a variable that is already gone", async () => {
		const { app, csrf } = buildWithCsrf({});
		expect((await del(app, csrf, "NEVER_EXISTED")).statusCode).toBe(200);
	});

	it("requires the csrf token from the query string", async () => {
		const app = build({});
		const res = await app.inject({
			method: "DELETE",
			url: "/setup/variables/MY_TOOL_KEY",
			headers: { "x-ms-client-principal-name": "alice@example.com" },
		});
		expect(res.statusCode).toBe(403);
	});

	it("does not let one user delete another's variable", async () => {
		const { app, csrf, secrets } = buildWithCsrf({});
		await secrets.set("bob@example.com", "BOBS_KEY", "v");
		await del(app, csrf, "BOBS_KEY", "alice@example.com");
		expect(await secrets.get("bob@example.com")).toMatchObject({
			BOBS_KEY: "v",
		});
	});

	it("handles a URL-encoded name", async () => {
		const { app, csrf, secrets } = buildWithCsrf({});
		await secrets.set("alice@example.com", "A_B_C", "v");
		expect((await del(app, csrf, "A_B_C")).statusCode).toBe(200);
		expect(await secrets.get("alice@example.com")).not.toHaveProperty("A_B_C");
	});
});
```

The cross-user test is worth writing even though the route derives the email from the principal and never from input — it pins the property so a later refactor that threads an email through the URL fails loudly.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement**:

```ts
fastify.delete<{ Params: { name: string } }>(
	"/setup/variables/:name",
	async (request, reply) => {
		const guard = await requireMutation(deps, request);
		if ("error" in guard) {
			return secureHtml(reply)
				.status(guard.error.status)
				.send(renderError(guard.error));
		}

		let name: string;
		try {
			name = normalizeSecretKey(decodeURIComponent(request.params.name));
		} catch (error) {
			return respond(reply, deps, guard.principal, 400, {
				kind: "error",
				text: (error as Error).message,
			});
		}

		// The row renders without a delete button, but the route is reachable
		// by hand. Removing a required key makes ContainerTargets.buildEnv throw
		// "not fully authenticated" on the next boot, so refuse it server-side.
		if (deps.requiredKeys.includes(name)) {
			return respond(reply, deps, guard.principal, 400, {
				kind: "error",
				text: `${name} is required and cannot be deleted. Clear its value instead.`,
			});
		}

		// Always keyed by the signed-in principal — never by anything the
		// request supplied beyond the variable name.
		await deps.secrets.set(guard.principal.email, name, undefined);
		return respond(reply, deps, guard.principal, 200, {
			kind: "ok",
			text: `Removed ${name}.`,
		});
	},
);
```

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Manual check with htmx in a browser** (dev recipe on NOR-267): add a variable, watch the table swap; delete it, watch it swap back; add `PATH` and confirm the error banner; reload and confirm state persisted.

- [ ] **Step 6: Commit**

```bash
pnpm --filter cyrus-router test:run && pnpm typecheck && pnpm lint
git add packages/router/src/setup packages/router/test/setup-*.test.ts
git commit -m "feat(router): add and delete optional setup variables"
```

---

### Definition of done

1. `pnpm --filter cyrus-router test:run`, `pnpm typecheck`, `pnpm lint` pass.
2. Reserved and invalid names rejected server-side, with `normalizeSecretKey`'s own message shown.
3. Required variables cannot be deleted through the route, not only through the UI.
4. Every response — including every error path — carries a usable CSRF token.
5. No response body contains a stored value (test asserted).





---

# NOR-273: Persist setup changes from the UI

**State:** Backlog | **Priority:** --- | **Assignee:** Unassigned | **Project:** Cyrus | **Milestone:** First multi-user release

Implement the save flow that persists environment variable changes from the setup management UI back to the server. Cover loading current values, validating edits as needed, and writing updates through the new storage layer.

## Parent

- **NOR-267**: Build setup management UI _[Backlog]_


## Comments

### Comment

## Implementation plan — persist setup changes from the UI

Last of the UI chain. Builds on NOR-271 (`views.ts`, `routes.ts`, `buildModel`), NOR-272 (`requireMutation`, `respond`), and NOR-269's `getRecord` / `putRecord` / `SetupConflictError`.

**Files**
* Modify: `packages/router/src/setup/routes.ts` (`POST /setup/save`, `applyEdits`)
* Modify: `packages/router/src/setup/views.ts` (save button, clear buttons, rotation notice)
* Modify: `packages/router/test/setup-routes.test.ts`, `setup-views.test.ts`
* Modify: `docs/ROUTER.md`, `infra/azure/README.md`, `CHANGELOG.md`

---

### The save contract

This is the part that is easy to get subtly wrong, so state it precisely:

| Submitted field | Meaning | Action |
| --- | --- | --- |
| `value:NAME` non-empty | new value | write it |
| `value:NAME` empty | **unchanged** | leave the stored value alone |
| `clear:NAME` present | explicit clear | write `""` |
| `value:NAME` for an unknown name | stale form or tampering | ignore, warn in the log |
| `value:NAME` for a reserved/invalid name | tampering | reject the whole save with 400 |

"Empty means unchanged" is what lets the page render every input blank (D5 on NOR-265) — the browser never receives a value, so it cannot echo one back, so blank has to mean "no change". The consequence is that clearing needs its own control, which is the `clear:NAME` checkbox for required variables and the existing delete button for optional ones.

`clear` beats `value` when both are present: a user who typed a value *and* ticked clear most likely changed their mind about the typing, and clearing is the safe direction (a missing required value blocks a boot loudly; a wrong value fails opaquely inside a session).

### Concurrency

Two tabs, or a tab plus an `az containerapp exec` admin, can save simultaneously. On the Table backend:

1. `getRecord()` → `{ bundle, etag }`
2. apply the edits in memory
3. `putRecord(email, next, etag)` → `SetupConflictError` on HTTP 412

On a conflict, **re-read and re-render with the current server state** and a `conflict` message; do not retry, and do not merge. A blind retry would resurrect exactly the overwrite the ETag exists to prevent, and an auto-merge would silently combine two people's intentions. The user sees what is actually stored and re-enters what they meant.

The file and Key Vault backends have no `getRecord`, so they fall back to sequential `set()` calls with last-write-wins — the behaviour they already have today via `cyrus router secrets set`. Feature-detect via `supportsRecords()`; do not `instanceof`.

### Rotation semantics

`CLAUDE.md` item 12: a rotated per-user secret is picked up only by the **next create-from-image**. A running, suspended, or snapshot-restored sandbox keeps its baked environment. The success message must say this, with the remedy — otherwise the first support question after launch is "I updated my token and it still fails".

---

### Task 1: view changes

- [ ] **Step 1: Write the failing tests** (append to `setup-views.test.ts`)

```ts
describe("renderVariablesTable — save controls", () => {
	it("renders a clear checkbox for a set required variable", () => {
		const html = renderVariablesTable(model);
		expect(html).toMatch(/CLAUDE_CODE_OAUTH_TOKEN[\s\S]{0,600}clear:CLAUDE_CODE_OAUTH_TOKEN/);
	});

	it("does not offer to clear a variable that is already unset", () => {
		const html = renderVariablesTable(model); // GIT_TOKEN is unset
		expect(html).not.toContain("clear:GIT_TOKEN");
	});

	it("wraps the table in a form that posts to /setup/save", () => {
		const html = renderVariablesTable(model);
		expect(html).toContain('hx-post="/setup/save"');
		expect(html).toContain('hx-target="#variables"');
	});

	it("names value inputs with the value: prefix", () => {
		expect(renderVariablesTable(model)).toContain('name="value:GIT_TOKEN"');
	});

	it("explains when changes take effect", () => {
		expect(renderPage(model)).toMatch(/next.*session|new session/i);
	});
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** In `renderRow`, add a fourth cell before the delete cell:

```ts
`		<td>${
			variable.isSet
				? `<label><input type="checkbox" name="clear:${name}"> Clear</label>`
				: ""
		}</td>`
```

Wrap the table and the save button in the save form (the add-variable form from NOR-272 stays a sibling — nested forms are invalid HTML):

```ts
export function renderVariablesTable(model: SetupPageModel): string {
	const rows = model.variables.map(renderRow).join("");
	return `<div id="variables">
	<input type="hidden" id="csrf" name="csrf" value="${escapeHtml(model.csrfToken)}">
	<form hx-post="/setup/save" hx-target="#variables" hx-swap="outerHTML">
		<input type="hidden" name="csrf" value="${escapeHtml(model.csrfToken)}">
		<table>
			<thead><tr><th>Variable</th><th>Status</th><th>New value</th><th></th><th></th></tr></thead>
			<tbody>${rows}</tbody>
		</table>
		<button type="submit">Save changes</button>
	</form>
	<form hx-post="/setup/variables" hx-target="#variables" hx-swap="outerHTML">
		<!-- add-variable form from NOR-272 -->
	</form>
</div>`;
}
```

Add the rotation notice to `renderPage`, under the intro paragraph:

```ts
`<p><small>Saved values are injected when a session's container is created. A session that is already running keeps the values it started with — ask an administrator to recreate it if you need a change to apply immediately.</small></p>`
```

- [ ] **Step 4: Run — PASS. Commit.**

---

### Task 2: `applyEdits` — the pure part

Extract the decision logic from the route so it is testable without HTTP.

- [ ] **Step 1: Write the failing tests**

New file `packages/router/test/setup-apply-edits.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyEdits } from "../src/setup/routes.js";

const REQUIRED = ["CLAUDE_CODE_OAUTH_TOKEN"] as const;
const current = { CLAUDE_CODE_OAUTH_TOKEN: "old", MY_TOOL_KEY: "keep" };

describe("applyEdits", () => {
	it("writes a non-empty value", () => {
		expect(
			applyEdits(current, { "value:MY_TOOL_KEY": "new" }, REQUIRED).next,
		).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "old", MY_TOOL_KEY: "new" });
	});

	it("leaves an empty value unchanged", () => {
		expect(applyEdits(current, { "value:MY_TOOL_KEY": "" }, REQUIRED).next).toEqual(
			current,
		);
	});

	it("treats a whitespace-only submission as a real value, not as blank", () => {
		// A leading/trailing-space token is a real (if unusual) credential; only
		// a genuinely empty string means "unchanged".
		expect(
			applyEdits(current, { "value:MY_TOOL_KEY": "  " }, REQUIRED).next
				.MY_TOOL_KEY,
		).toBe("  ");
	});

	it("clears when the clear checkbox is set", () => {
		expect(
			applyEdits(current, { "clear:MY_TOOL_KEY": "on" }, REQUIRED).next,
		).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "old", MY_TOOL_KEY: "" });
	});

	it("lets clear win over a simultaneously submitted value", () => {
		expect(
			applyEdits(
				current,
				{ "value:MY_TOOL_KEY": "typed", "clear:MY_TOOL_KEY": "on" },
				REQUIRED,
			).next.MY_TOOL_KEY,
		).toBe("");
	});

	it("keeps a cleared required key present rather than deleting it", () => {
		const { next } = applyEdits(
			current,
			{ "clear:CLAUDE_CODE_OAUTH_TOKEN": "on" },
			REQUIRED,
		);
		expect(Object.hasOwn(next, "CLAUDE_CODE_OAUTH_TOKEN")).toBe(true);
		expect(next.CLAUDE_CODE_OAUTH_TOKEN).toBe("");
	});

	it("ignores a field for a variable that no longer exists", () => {
		const { next, ignored } = applyEdits(
			current,
			{ "value:GONE": "x" },
			REQUIRED,
		);
		expect(next).toEqual(current);
		expect(ignored).toEqual(["GONE"]);
	});

	it("rejects a reserved name outright", () => {
		expect(() =>
			applyEdits(current, { "value:PATH": "/evil" }, REQUIRED),
		).toThrow(/reserved/);
	});

	it("rejects an invalid env name outright", () => {
		expect(() =>
			applyEdits(current, { "value:not-valid": "x" }, REQUIRED),
		).toThrow(/environment variable name/);
	});

	it("ignores non-prefixed fields such as csrf", () => {
		expect(applyEdits(current, { csrf: "tok" }, REQUIRED).next).toEqual(current);
	});

	it("takes the last value when a field is duplicated", () => {
		expect(
			applyEdits(current, { "value:MY_TOOL_KEY": ["a", "b"] }, REQUIRED).next
				.MY_TOOL_KEY,
		).toBe("b");
	});

	it("reports whether anything actually changed", () => {
		expect(applyEdits(current, {}, REQUIRED).changed).toBe(false);
		expect(
			applyEdits(current, { "value:MY_TOOL_KEY": "new" }, REQUIRED).changed,
		).toBe(true);
	});
});
```

Two of those encode real decisions worth flagging in review: whitespace is a value (trimming a credential would corrupt it), and clearing a *required* key sets `""` rather than deleting the row — the row must stay so the page keeps rendering it and `isFullyAuthenticated` keeps reporting it as missing.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** in `routes.ts` (exported for the test):

```ts
const VALUE_PREFIX = "value:";
const CLEAR_PREFIX = "clear:";

export interface AppliedEdits {
	next: UserSecretBundle;
	changed: boolean;
	/** Submitted for variables the record no longer has — a stale form. */
	ignored: string[];
}

/** A urlencoded field is a string, or an array when the name repeats. */
function lastValue(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		const last = value.at(-1);
		return typeof last === "string" ? last : undefined;
	}
	return undefined;
}

/**
 * Folds a submitted form over the stored bundle.
 *
 * An empty `value:` field means "unchanged", not "clear" — the page renders
 * every input blank (values are never sent to the browser), so blank is the
 * default state of an untouched field. Clearing is therefore an explicit
 * `clear:` checkbox for required variables, and the delete button for optional
 * ones.
 *
 * Throws on a reserved or malformed name rather than skipping it: a name that
 * did not come from a rendered row means the form was tampered with, and
 * silently dropping it would make an attack look like a successful save.
 */
export function applyEdits(
	current: UserSecretBundle,
	fields: Record<string, unknown>,
	requiredKeys: readonly string[],
): AppliedEdits {
	const next = { ...current };
	const ignored: string[] = [];
	let changed = false;

	const edits = new Map<string, { value?: string; clear: boolean }>();
	for (const [field, raw] of Object.entries(fields)) {
		const isValue = field.startsWith(VALUE_PREFIX);
		const isClear = field.startsWith(CLEAR_PREFIX);
		if (!isValue && !isClear) continue;

		const name = normalizeSecretKey(
			field.slice(isValue ? VALUE_PREFIX.length : CLEAR_PREFIX.length),
		);
		const entry = edits.get(name) ?? { clear: false };
		if (isClear) entry.clear = true;
		else entry.value = lastValue(raw);
		edits.set(name, entry);
	}

	for (const [name, edit] of edits) {
		if (!Object.hasOwn(next, name)) {
			ignored.push(name);
			continue;
		}
		if (edit.clear) {
			// Empty, not deleted: required rows must keep rendering, and
			// isFullyAuthenticated already treats "" as missing.
			if (next[name] !== "") changed = true;
			next[name] = "";
			continue;
		}
		if (edit.value === undefined || edit.value === "") continue;
		if (next[name] !== edit.value) changed = true;
		next[name] = edit.value;
	}

	// requiredKeys is not consulted for the clear/delete decision above — every
	// clear is a set-to-empty regardless — but keep it in the signature so a
	// future divergence in required-key handling has an obvious home.
	void requiredKeys;
	return { next, changed, ignored };
}
```

- [ ] **Step 4: Run — PASS. Commit.**

---

### Task 3: `POST /setup/save`

- [ ] **Step 1: Write the failing tests** (append to `setup-routes.test.ts`)

```ts
describe("POST /setup/save", () => {
	async function save(app, csrf, body: string, email = "alice@example.com") {
		return app.inject({
			method: "POST",
			url: "/setup/save",
			payload: `${body}&csrf=${encodeURIComponent(csrf.issue(email))}`,
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"x-ms-client-principal-name": email,
			},
		});
	}

	it("stores a submitted value", async () => {
		const { app, csrf, secrets } = buildWithCsrf({});
		await secrets.set("alice@example.com", "CLAUDE_CODE_OAUTH_TOKEN", "");
		const res = await save(app, csrf, "value:CLAUDE_CODE_OAUTH_TOKEN=sk-ant-new");
		expect(res.statusCode).toBe(200);
		expect(await secrets.get("alice@example.com")).toMatchObject({
			CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-new",
		});
	});

	it("leaves a stored value alone when the field is blank", async () => {
		const { app, csrf, secrets } = buildWithCsrf({});
		await secrets.set("alice@example.com", "CLAUDE_CODE_OAUTH_TOKEN", "keep");
		await save(app, csrf, "value:CLAUDE_CODE_OAUTH_TOKEN=");
		expect(await secrets.get("alice@example.com")).toMatchObject({
			CLAUDE_CODE_OAUTH_TOKEN: "keep",
		});
	});

	it("clears a value when the clear box is ticked", async () => {
		const { app, csrf, secrets } = buildWithCsrf({});
		await secrets.set("alice@example.com", "CLAUDE_CODE_OAUTH_TOKEN", "old");
		await save(app, csrf, "clear:CLAUDE_CODE_OAUTH_TOKEN=on");
		expect(await secrets.get("alice@example.com")).toMatchObject({
			CLAUDE_CODE_OAUTH_TOKEN: "",
		});
	});

	it("never echoes the submitted value back", async () => {
		const { app, csrf } = buildWithCsrf({});
		const res = await save(app, csrf, "value:CLAUDE_CODE_OAUTH_TOKEN=sk-ant-topsecret");
		expect(res.body).not.toContain("sk-ant-topsecret");
	});

	it("clears the missing-required banner once the value is set", async () => {
		const { app, csrf } = buildWithCsrf({});
		const res = await save(app, csrf, "value:CLAUDE_CODE_OAUTH_TOKEN=sk-ant-new");
		expect(res.body).not.toMatch(/not ready/i);
	});

	it("tells the user when changes take effect", async () => {
		const { app, csrf } = buildWithCsrf({});
		const res = await save(app, csrf, "value:CLAUDE_CODE_OAUTH_TOKEN=sk-ant-new");
		expect(res.body).toMatch(/next.*session|new session/i);
	});

	it("rejects a tampered field name and writes nothing", async () => {
		const { app, csrf, secrets } = buildWithCsrf({});
		const res = await save(app, csrf, "value:PATH=%2Fevil");
		expect(res.statusCode).toBe(400);
		expect(await secrets.get("alice@example.com")).not.toHaveProperty("PATH");
	});

	it("reports a no-op save without writing", async () => {
		const { app, csrf, secrets } = buildWithCsrf({});
		const before = await secrets.get("alice@example.com");
		const res = await save(app, csrf, "value:CLAUDE_CODE_OAUTH_TOKEN=");
		expect(res.body).toMatch(/no changes/i);
		expect(await secrets.get("alice@example.com")).toEqual(before);
	});

	it("re-renders with a conflict message when the record changed underneath", async () => {
		const { app, csrf, secrets } = buildWithConflictingStore();
		const res = await save(app, csrf, "value:CLAUDE_CODE_OAUTH_TOKEN=sk-ant-new");
		expect(res.statusCode).toBe(409);
		expect(res.body).toMatch(/changed|conflict/i);
		// The conflicting write survives — the save did not overwrite it.
		expect(await secrets.get("alice@example.com")).toMatchObject({
			CLAUDE_CODE_OAUTH_TOKEN: "written-by-someone-else",
		});
	});

	it("uses a single conditional write on a record-capable backend", async () => {
		const { app, csrf, putRecord } = buildWithRecordSpy();
		await save(
			app,
			csrf,
			"value:CLAUDE_CODE_OAUTH_TOKEN=a&value:MY_TOOL_KEY=b",
		);
		expect(putRecord).toHaveBeenCalledTimes(1);
		expect(putRecord.mock.calls[0]![2]).toBeTruthy(); // ifMatch etag
	});

	it("falls back to per-key writes on a backend without records", async () => {
		const { app, csrf, setSpy } = buildWithFileStoreSpy();
		await save(
			app,
			csrf,
			"value:CLAUDE_CODE_OAUTH_TOKEN=a&value:MY_TOOL_KEY=b",
		);
		expect(setSpy).toHaveBeenCalledTimes(2);
	});

	it("requires csrf", async () => {
		const app = build({});
		const res = await app.inject({
			method: "POST",
			url: "/setup/save",
			payload: "value:CLAUDE_CODE_OAUTH_TOKEN=x",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"x-ms-client-principal-name": "alice@example.com",
			},
		});
		expect(res.statusCode).toBe(403);
	});
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement**:

```ts
/** Backends that expose the whole-record surface from NOR-269. */
interface RecordCapableStore extends SecretStoreBackend {
	supportsRecords(): boolean;
	getRecord(
		email: string,
	): Promise<{ bundle: UserSecretBundle; etag: string } | undefined>;
	putRecord(
		email: string,
		bundle: UserSecretBundle,
		ifMatch?: string,
	): Promise<{ etag: string }>;
}

function asRecordStore(
	store: SecretStoreBackend,
): RecordCapableStore | undefined {
	const candidate = store as Partial<RecordCapableStore>;
	return typeof candidate.supportsRecords === "function" &&
		candidate.supportsRecords()
		? (store as RecordCapableStore)
		: undefined;
}

fastify.post("/setup/save", async (request, reply) => {
	const guard = await requireMutation(deps, request);
	if ("error" in guard) {
		return secureHtml(reply)
			.status(guard.error.status)
			.send(renderError(guard.error));
	}

	const email = guard.principal.email;
	const fields = (request.body ?? {}) as Record<string, unknown>;
	const recordStore = asRecordStore(deps.secrets);

	const existing = recordStore ? await recordStore.getRecord(email) : undefined;
	const current = existing?.bundle ?? (await deps.secrets.get(email));

	let applied: AppliedEdits;
	try {
		applied = applyEdits(current, fields, deps.requiredKeys);
	} catch (error) {
		// A name that never appeared on a rendered row. Fail the whole save
		// rather than partially applying a tampered form.
		return respond(reply, deps, guard.principal, 400, {
			kind: "error",
			text: (error as Error).message,
		});
	}

	if (applied.ignored.length > 0) {
		deps.logger.warn(
			`Ignoring stale setup fields for ${email}: ${applied.ignored.join(", ")}`,
		);
	}

	if (!applied.changed) {
		return respond(reply, deps, guard.principal, 200, {
			kind: "ok",
			text: "No changes to save.",
		});
	}

	try {
		if (recordStore) {
			// One conditional write for the whole form: atomic, and the ETag is
			// what turns a concurrent edit into a visible conflict instead of a
			// silent overwrite.
			await recordStore.putRecord(email, applied.next, existing?.etag);
		} else {
			// File / Key Vault backends have no record surface. Sequential writes,
			// last-write-wins — the same semantics `cyrus router secrets set` has
			// always had on these backends.
			for (const [name, value] of Object.entries(applied.next)) {
				if (current[name] === value) continue;
				await deps.secrets.set(email, name, value);
			}
		}
	} catch (error) {
		if (error instanceof SetupConflictError) {
			// Deliberately no retry and no merge: re-reading and re-rendering shows
			// the user what is actually stored. A retry would reinstate exactly the
			// overwrite the ETag exists to prevent.
			return respond(reply, deps, guard.principal, 409, {
				kind: "conflict",
				text: "Your settings were changed somewhere else while you were editing. The current values are shown below — re-enter your changes and save again.",
			});
		}
		throw error;
	}

	return respond(reply, deps, guard.principal, 200, {
		kind: "ok",
		text: "Saved. New values apply to the next session that starts; a session already running keeps the values it started with.",
	});
});
```

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Full suite + lint + typecheck**

```bash
pnpm --filter cyrus-router test:run && pnpm typecheck && pnpm lint && pnpm build
```

- [ ] **Step 6: Commit**

```bash
git add packages/router/src/setup packages/router/test/setup-*.test.ts
git commit -m "feat(router): persist setup changes from the UI"
```

---

### Task 4: docs and changelog

- [ ] **Step 1: `docs/ROUTER.md`** — replace the "Key Vault and Entra operations" guidance that tells operators to shell in. New order: (1) teammate opens `https://<router-fqdn>/setup`; (2) `cyrus router secrets set` via `az containerapp exec` remains as break-glass; (3) the rotation caveat stays, now cross-referenced from the UI copy.

- [ ] **Step 2: `infra/azure/README.md` §9** — rewrite "Register an ACA user and their secrets" around the UI. Keep the CLI block, demoted to a "break-glass / automation" subsection. Add `setup_ui_url` to the post-deploy output list.

- [ ] **Step 3: `CHANGELOG.md`** under `## [Unreleased]` → `### Added` — user-facing, so the main changelog, not the internal one:

```markdown
### Added
- Teammates can now manage their own session environment variables from a web page at `/setup` on the router, instead of an administrator running CLI commands inside the container. Sign-in uses your organization's Microsoft account. Values are never displayed back to you — leave a field blank to keep what is stored. ([#NNN](https://github.com/ceedaragents/cyrus/pull/NNN))
```

Create the PR first, then fill in the number, commit, push — per the `CLAUDE.md` workflow.

- [ ] **Step 4: `docker/worker/README.md`** — the per-user credentials section currently documents only `cyrus router secrets set`; add the UI as the primary path for ACA deployments.

---

### Task 5: end-to-end acceptance

- [ ] **Step 1: F1 test drive.** `CLAUDE.md` mandates this for the testing and validation stage of major work. Cover: sign in → set `CLAUDE_CODE_OAUTH_TOKEN` → add an optional variable → save → delegate a Linear issue → confirm the worker boots and the optional variable is present in its environment.

- [ ] **Step 2: Manual conflict check on dev.** Two browser tabs, both loaded, both save. The second must show the conflict banner and must **not** have overwritten the first.

- [ ] **Step 3: Browser check.** Chrome devtools: no console errors, no network requests to any host but the router, and confirm no value appears in any response body (search the Network tab for a known token substring).

### Definition of done

1. `pnpm --filter cyrus-router test:run`, `pnpm typecheck`, `pnpm lint`, `pnpm build` all pass.
2. Blank input never overwrites a stored value (test asserted).
3. Concurrent save produces a 409 and no data loss (test asserted **and** manually verified on dev).
4. No response body ever contains a submitted or stored value (test asserted).
5. Success copy states the rotation semantics.
6. F1 test drive recorded on this issue.



