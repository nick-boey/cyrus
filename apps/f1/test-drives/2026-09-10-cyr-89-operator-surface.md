# Test Drive: CYR-89 — Operator surface, post-deployment

**Date**: 2026-09-10 (UTC)
**Issue**: CYR-89 — Verify the operator surface post-deployment, and decide the recovery rollout
**Consumes**: [CYR-78](2026-09-09-observability-commands.md) — its F1 matrix and read-only fleet drive are the prerequisite evidence
**Pull requests**: [#80](https://github.com/nick-boey/cyrus/pull/80) (the template fixes this drive needed first)
**Goal**: Close the half of CYR-78 that no test and no read-only drive could reach.

> **Read the scope line first.** This drive has two halves and they happened in
> that order. The **pre-deployment** half found that three template defects made
> two of CYR-89's four scope items unreachable *even after* a deploy, fixed them
> in #80, and proved each fix against the real ARM evaluator without applying
> anything. The **post-deployment** half then deployed and ran scope items **1
> and 2 in full**. Scope item **3 is not run** — recovery remains **disabled**,
> and this drive does not authorize enabling it. Scope item **4's install half
> is out of scope**. Two rows inside item 1 and two inside item 2 could not be
> verified on this fleet and are marked as such rather than as passing.
>
> Three defects were found by running this, none of which a test could have
> found: the `/setup` allowlist gating the operator API, a `null` rendered as
> the string `"null"`, and CYR-89's own premise about the stranded-sandbox
> reclaim being wrong.

## Environment

| Fact | Value |
| --- | --- |
| Commit deployed | `6432f96d` (#80 on `main`) |
| Node | v22.20.0 |
| pnpm | 10.33.1 |
| Platform | darwin 25.6.0 (macOS) |
| Azure subscription | `1efb7cc3-4a62-4f9b-9c01-d9f532c0c526` (`dit-development`) |
| Router | `app-cyrus-dev-router`, revision **`--0000042`**, image `ghcr.io/nick-boey/cyrus-router:sha-6432f96` |
| Router before | revision `--0000039`, image `sha-a51fcca`, **no** `CYRUS_ROUTER_FLEET_OPERATIONS_JSON` |
| Log Analytics | `7f02622b-26ce-47b0-8cd1-ded57e9053b4` (`log-cyrus-dev`), `ContainerAppConsoleLogs_CL` |
| Operator principal | `nboey@northrop.com.au`, oid `0749550b-7a80-4175-93dc-f14d715e02ae` |
| Deployment repo | `cyrus-deploy` @ `3bf2eb7`, `cyrus.ref` `6432f96` |

### Why the operator principal is not the admin account

The drive began as `adm-nick.boey@` (subscription Owner) and had to move. Two
reasons, and the second is the more important one.

It was **forced**: the Easy Auth sidecar refuses `adm-nick.boey@` outright — see
[the /setup allowlist finding](#a-the-setup-ui-allowlist-silently-gates-the-fleet-operator-api).
No Entra row of scope item 2 could have been run as that account.

It was also **better**, and would have been the right choice anyway. Scope item 1
asks for evidence that the CLI reached Azure *with its own credentials*. A
subscription Owner succeeds at every step for reasons unrelated to any fleet
grant, so the separation ADR-0009 asserts — "neither role implies the other" —
is untestable with one. With a non-Owner principal both directions were measured:
`fleet.read` on the router yielded the `logs.query` capability and a **403 from
Azure**, and after Log Analytics Reader was granted the same account still could
not `az containerapp show` the router. A real fleet operator is not a
subscription Owner, and verifying with one validates a configuration nobody runs.

The rendered config on the deployed revision:

```json
{"logSource":{"schemaVersion":1,"kind":"azure-log-analytics",
  "displayName":"Cyrus cyrus-dev",
  "azure":{"workspaceId":"7f02622b-…","table":"ContainerAppConsoleLogs_CL","resourceId":"…/log-cyrus-dev"},
  "budgets":{"defaultLookbackSeconds":900,"maxRangeSeconds":86400,
             "maxRecords":5000,"minFollowIntervalSeconds":15}},
 "recovery":{"enabled":false},
 "access":{"entra":{"tenantId":"c9857cc6-…","audience":"api://88f4bd8f-…",
   "grants":[{"principalIds":["0749550b-…"],"roles":["fleet.read"],
              "workspaceIds":["75294f85-…"]}]}}}
```

`recovery.enabled` is present **because of #80**; it is the half
`enableFleetRecovery` never rendered. The router confirmed all three at startup:

```
Fleet Operations recovery is disabled; no recovery capability will be advertised
Fleet Operations Entra access enabled (tenant c9857cc6-…, audience api://88f4bd8f-…, 1 grant(s))
Fleet Operations log source configured (kind azure-log-analytics, workspace 7f02622b-…)
```

## Part one, pre-deployment: why two scope items were unreachable

CYR-78 concluded that steps 1, 2 and 5–9 were "blocked on a deployment change
(`fleetOperatorGrants` for Entra, a `logSource` for logs, `enableFleetRecovery`
for recovery)". That was right about the cause and incomplete about the remedy:
setting those parameters would not have produced the behaviour their names
promise. Three template defects sat behind them.

### 1. `enableFleetRecovery = true` did not enable recovery

`main.bicep` rendered `logSource` and `access` into
`CYRUS_ROUTER_FLEET_OPERATIONS_JSON` and nothing else. The router's own switch
is `fleetOperations.recovery.enabled` (`RouterServer.buildRecoveryService`,
`RouterServer.ts:1281`), and the template never emitted it.

The two halves are independent and both are required. `enableFleetRecovery`
governed only the grant strip — who could **ask** — while the router, seeing no
`recovery` key, built no `RecoveryService`, advertised no `recoveries.request`
capability, and refused every request. So the parameter would have authorized a
principal for a mutation the router had already declined to serve, and the
refusal an operator got would have been indistinguishable from the one they get
with recovery deliberately off. **Scope item 3 could not have been performed.**

Fixed: both halves now render from that one parameter. `recovery.enabled` is
emitted unconditionally rather than only when true, so `az containerapp show`
reports the posture explicitly — to the router an absent key and a false one are
the same, but only one of them is legible to the operator reading it back.

### 2. There was no way to advertise an operator skill

`fleetOperations.skill` exists in the router's config schema
(`RouterCommand.ts:458`) and in `FleetOperations.context()`. `main.bicep` had no
parameter for it — `grep -c skill main.bicep` returned 0 — so every Azure
deployment necessarily reported "no skill advertised", which is exactly what
CYR-78 observed and attributed to configuration. **Scope item 4 could not have
been performed.**

Fixed: `fleetOperatorSkill`, a typed release descriptor rendered into the same
block. It rides on `fleetOperatorGrants`, because the whole `fleetOperations`
block renders only when operators are configured; advertising a skill on its own
would be silently dropped, so the template refuses that combination instead.

### 3. `what-if` does not evaluate `parameterGuard` — so no cross-parameter rule gated CD

This one was found while testing the two guards added for item 2, and it is not
about them. `main.bicep` enforces fifteen cross-parameter invariants through the
`parameterGuard` idiom, and `infra/azure/bicep/README.md` and `CLAUDE.md` §12
both describe the deployment as failing "before touching a resource". The
comment on `fleetGrants` went further and named the gate: "Dereferencing
unconditionally moves that to `az deployment sub what-if`, which routine CD
always runs first."

That is not what happens. Measured against the live subscription, with the
**pre-existing** `enableOtelTraces requires enableOtelLogs` rule violated:

```
$ PARAMS=…/.cyr89-guardctl.bicepparam ./scripts/deploy-azure.sh
Resource changes: 8 to create, 22 to modify, 20 no change.
Review the change list above, then re-run the same command with --apply.
```

A clean, green, entirely ordinary preview. The same parameters through
`validate`:

```
$ az deployment sub validate --location australiaeast \
    --template-file main.bicep --parameters .cyr89-guardctl.bicepparam
ERROR: {"code": "InvalidTemplate", "message": "… The language expression property
'enableOtelTraces requires enableOtelLogs. …' doesn't exist, available properties
are 'valid'."}
```

So every one of the fifteen rules was invisible to the preview routine CD gates
on, and a violation surfaced only at apply. Fixed: `scripts/deploy-azure.sh` now
runs `az deployment sub validate` on the preview path **and** the apply path, and
`scripts/check-bicep.sh` asserts the call is still there — deleting it would
return all fifteen rules to "previews clean, fails at apply" without breaking a
single test. The two documentation claims are corrected.

## What was proved, and how

Every row below is `scripts/deploy-azure.sh` against the real subscription with
no `--apply`, so ARM evaluated the template for real. Parameters are the live
`env/northrop-dev.bicepparam` from the private deployment repository with the
CYR-89 grant block appended and `routerImage` pinned to `sha-d1e7565`.

"Phase 1" is the read-only grant with recovery off — what was subsequently
deployed. "Phase 2" adds `fleet.recover` and turns the switch on, and was
**previewed only, never applied**. The phase-1 grant is previewed here against
oid `1d065ee6-…`; it was later re-pointed to `0749550b-…` before deployment, for
the reason in [finding A](#a-the-setup-ui-allowlist-silently-gates-the-fleet-operator-api).

| Assertion | Expected | Actual |
| --- | --- | --- |
| Phase 1 renders a log source | descriptor names `log-cyrus-dev`, table `ContainerAppConsoleLogs_CL`, budgets 900/86400/5000/15 | ✅ exactly, workspace id resolved from the workspace reference rather than a parameter |
| Phase 1 renders recovery OFF | `'recovery', createObject('enabled', false())` | ✅ |
| Phase 1 renders one reader grant | `oid 1d065ee6-…`, `['fleet.read']`, workspace `75294f85-…` | ✅ |
| Phase 1 renders no skill key | `fleetOperatorSkill` omitted ⇒ no `skill` in the JSON | ✅ |
| Phase 2 renders recovery ON | `'recovery', createObject('enabled', true())` | ✅ — the defect above, fixed and measured |
| Phase 2 keeps `fleet.recover` | `'roles', createArray('fleet.read', 'fleet.recover')` | ✅ |
| Phase 2 renders the skill | all five fields verbatim | ✅ |
| Guard: skill without grants | refused, naming the rule | ✅ via `validate`; **not** caught by `what-if` |
| Guard: checksum not `sha256:` | refused, naming the rule | ✅ via `validate` |
| Guard: checksum wrong length | refused at COMPILE time | ✅ `BCP333`/`BCP332` from the `@minLength(71)`/`@maxLength(71)` decorators — earlier than the guard, which is the better failure |
| Guard: checksum UPPERCASE hex | refused, naming the rule | ✅ via `validate` |
| Guard: `releaseUrl` not a URL | refused, naming the rule | ✅ via `validate` |
| Pre-existing OTel guard | refused on the preview path | ✅ **after** the `validate` fix; green before it |

The uppercase and URL guards were added during review, and the reason is worth
recording: the first cut checked `startsWith(checksum, 'sha256:')` and a length
of 71 while claiming to front-run the router's schema, which is
`/^sha256:[0-9a-f]{64}$/` plus a real URL parse. An uppercase digest — what
`certutil` and PowerShell's `Get-FileHash` both emit — has the same prefix and
the same length, so it passed the template and would have crash-looped the
revision, which is precisely the failure the guard exists to move forward. A
guard weaker than the schema it fronts is worse than no guard, because it reads
as coverage.

The read-only grant deploy previews as `3 to create, 22 to modify`. The three
creates are `Cyrus-Disk-Image-Decisions`, `Cyrus-Disk-Image-GC` and
`Cyrus-Sandbox-Stranded-Reclaims` — CYR-84's saved searches, which is
independent confirmation that the deployment carries the `reclaimStranded`
CYR-89's fault 1 turns on. It does carry it — the saved searches exist on
`log-cyrus-dev` after the apply — and the reclaim still does not collect NOR-402,
for reasons that are about the container's state rather than the deployment. See
[finding B](#b-cyr-89s-premise-about-the-stranded-sandbox-is-wrong).

## Part two, post-deployment: scope item 1 — the log source, client half

`cyrus logs query --since 15m --json` → **exit 0, 1229 records**. The envelope
carries `schemaVersion, observedAt, workspace, source, range, records,
backendLatencyMs (905), ingestionLagMs (1692)`; each record carries `recordId,
timestamp, level, message, component, workspaceId, ownerUserId, issueKey, runId,
sessionId, attributes`.

`cyrus logs follow --since 2m --interval 15 --timeout 40 --json` → **exit 0**,
48s, 165 NDJSON `event:"record"` lines. It prints its own caveat unprompted:
*"This is a historical store polled on a delay, not a live router stream;
records appear once the backend has ingested them."*

### Network evidence: the router is not in the data path

Sockets opened by the CLI process during the successful query, sampled from
`lsof` against its own pid every 200ms:

| Endpoint | Resolves to | Role |
| --- | --- | --- |
| `20.92.172.35:443` | `app-cyrus-dev-router…azurecontainerapps.io` | the router — descriptor only |
| `20.37.198.117:443` | Azure | **where the query went** |
| `169.254.169.254:80` | IMDS | managed-identity probe |

The stronger proof is the **failure** that preceded it. Before Log Analytics
Reader was granted, the same command exited **5** with

> Azure Log Analytics refused the query (403): The provided credentials have
> insufficient access… may lack a `Log Analytics Reader` grant on this workspace.

A refusal from **Azure**, not from the router — and the router serves no
log-records route at all (CYR-78 established `/api/v1/logs` is a 404). The
router described where to look; the client went there itself and was told no.
That is the separation, observed rather than argued.

### Budgets refuse rather than truncate — PASS

Against the advertised `maxRangeSeconds: 86400` / `minFollowIntervalSeconds: 15`:

| Invocation | Result |
| --- | --- |
| `logs query --since 48h` | exit 2 — "allows a range of at most 24h, and 48h was requested", both ends of the window named |
| `logs query --since 25h` | exit 2 — same, one hour over the boundary |
| `logs follow --interval 5` | exit 2 — "allows a follow interval no faster than 15s, and 5s was requested" |

Refusals, not silent clamping. The 48h refusal opened no Azure socket at all —
though 200ms sampling can miss a short connection, so that absence is weaker
evidence than the presences above, and is reported as such.

### Ingestion lag matches — PASS

Measured directly over the same window: **p50 875ms, p95 1256ms** overall
(`sandbox` p50 727 / p95 1227; `router` p50 878 / p95 1881). CYR-78 measured p50
~0.8s / p95 ~1.2s, so the figure is stable across a week and a router upgrade.
The CLI's own reported `ingestionLagMs` of 1692 is the same order, above p95.

### Field-by-field against `az monitor log-analytics query` — PASS

One record (`recordId 8833eba168f958ed77fa24b61bf1f9a4`, `2026-09-10T02:32:20.730Z`)
read both ways. All nine correlation fields identical:

| CLI field | raw key | value |
| --- | --- | --- |
| `timestamp` | `timestamp` | `2026-09-10T02:32:20.730Z` |
| `level` | `level` | `info` |
| `message` | `message` | `event:session.message_emitted` |
| `component` | `component` | `sandbox/EdgeWorker` |
| `workspaceId` | `cyrus.workspace_id` | `75294f85-…` |
| `ownerUserId` | `cyrus.owner_id` | `1` |
| `issueKey` | `cyrus.issue_key` | `PAR-300` |
| `runId` | `cyrus.run_id` | `aa12a33d-…` |
| `sessionId` | `cyrus.session_id` | `11eeaa4b-…` |

The accounting is exact: **26 raw keys → 9 promoted to top level + 17
attributes**, with the five promoted `cyrus.*` keys correctly absent from
`attributes` rather than duplicated. CYR-72's canonical attribution set is
present and intact end to end.

It also surfaced a defect — see
[finding C](#c-a-json-null-attribute-is-rendered-as-the-string-null).

### Redaction over real rows — NOT VERIFIABLE ON THIS FLEET

CYR-89 asks for redaction "over REAL rows — not the fake adapter's seeded ones".
All 1229 returned records were scanned for redaction markers and for
secret-shaped strings (`Bearer …`, JWTs, `gh[psu]_`, `lin_api_`, `cyop_`,
`sig=`): none of either.

That result is ambiguous on its own, so the **source** was scanned too: the same
patterns over 24 hours of `ContainerAppConsoleLogs_CL` across the whole
workspace return **zero rows**. There is nothing to redact on this deployment,
so a clean output does not demonstrate that the redactor runs.

Deliberately **not** manufactured. Writing a credential-shaped string into the
telemetry backend to exercise the redactor would persist for the retention
period and is precisely the outcome the design exists to prevent. Marked NOT
VERIFIABLE rather than PASS; the unit suites in `apps/cli/src/remote/logs/*` are
the only evidence for it, which is what CYR-89 already said was insufficient.

## Part two, post-deployment: scope item 2 — Entra operator access

A clean before/after against the same router, hours apart:

| | Before (02:03Z) | After (02:35Z) |
| --- | --- | --- |
| discovery `authentication.methods` | `device-token, local-operator-token` | **`entra`**, `device-token`, `local-operator-token` |
| discovery `authentication.entra` | absent | `{tenantId, audience}` |
| anything scoped in discovery | none | **still none** |
| `connection add --auth entra` | **exit 2** — "Router cyrus-router does not accept entra authentication. It offers: device-token, local-operator-token." | **succeeds** |

The authenticated context, which the anonymous document still does not disclose:

```json
{"principalId":"0749550b-…","authMethod":"entra","displayName":"Nicholas Boey",
 "roles":["fleet.read"],
 "capabilities":["runs.list","runs.changes","logs.query"],
 "authorizedWorkspaces":[{"workspaceId":"75294f85-…"}],
 "logSource":{…}}
```

`recoveries.request` is **absent**, which is correct: `recovery.enabled` is
false. `logs.query` is **present**, which it was not for CYR-78 — that capability
appears only because a `logSource` is now configured.

### The credential chain resolves in the documented order — PASS

`cyrus connection show` reports `Auth: entra … (source: azure-cli)` — the last
link. The order itself was observed live, from the failure before the account
switch, which enumerated every attempt in sequence:

```
workload-identity: WorkloadIdentityCredential is unavailable. clientId is a required parameter…
managed-identity:  ManagedIdentityCredential: Network unreachable…
service-principal-env: EnvironmentCredential is unavailable…
Already refused by the router: azure-cli.
```

### Two rows that could not be run, and why

Both are Microsoft Graph state, not deployment parameters, and neither is fixed
by anything in #80.

**Group-keyed grants cannot match at all.** `az ad app show` reports
`groupMembershipClaims: null`, and a minted token carries no `groups` claim.
`OperatorAuthorizer` builds its candidate set from `oid` plus `groups`, so every
group-keyed grant fails to match and the caller sees a 403 — the same symptom
the groups-OVERAGE warning describes, reached by a different route. Testing
"group-keyed grants union correctly with an `oid`-keyed one" requires
`groupMembershipClaims` set on the app registration.

**The app-only 403 row has nothing to present a token.** `appRoles` is `[]` and
no service principal holds client credentials for this audience, so no caller
can currently produce `idtyp: "app"`. Testing it means creating a test app
registration.

**Workspace ambiguity: explicitly OUT OF SCOPE**, as CYR-89 requires — see
[below](#two-entra-prerequisites-scope-item-2-needs-which-are-not-deployment-parameters).

## The two live faults, before and after the deployment

The baseline was captured before any deployment so the comparison CYR-89 asks
for could be made against it. Re-run this to compare:

```bash
az monitor log-analytics query \
  --workspace 7f02622b-26ce-47b0-8cd1-ded57e9053b4 \
  --analytics-query "$(cat strand.kql)" -o table
```

```kusto
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(24h)
| extend p = parse_json(Log_s)
| where tostring(p["event"]) == "sandbox.stranded_session"
| summarize events = count(), firstSeen = min(TimeGenerated), lastSeen = max(TimeGenerated),
            maxNoProgressMs = max(tolong(p["cyrus.no_progress_for_ms"]))
    by issueKey = tostring(p["cyrus.issue_key"]), deviceId = tostring(p["cyrus.device_id"]),
       reason = tostring(p["cyrus.reason"]), state = tostring(p["cyrus.state"]),
       online = tostring(p["cyrus.online"])
| order by events desc
```

Note `cyrus.issue_key`, not `cyrus.issue` — the latter is the ACA sandbox label
and reads as null in a query rather than erroring, the trap CYR-78's drive hit
and CLAUDE.md §13 warns about. Result over 24 h to 2026-09-10T00:34Z:

| Issue | Device | Reason | State | Online | Events | Quiet for |
| --- | --- | --- | --- | --- | --- | --- |
| **NOR-402** | 151 | `no_progress` | running | true | 1394 | **593,074,152 ms = 6.87 days** |
| NOR-373 | 251 | `no_progress` | running | true | 222 | 84,695,189 ms |
| PAR-200 | 271 | `offline_pinned` | stopped | false | 28 | 2,434,070 ms |
| CAN-193 | 283 | `offline_pinned` | stopped | false | 4 | 830,579 ms |
| ORC-38 | 288 | `offline_pinned` | stopped | false | 3 | 1,181,704 ms |

**Fault 1 (NOR-402) is unresolved, has worsened, and will not resolve itself.**
CYR-78 measured 6.1 days; the baseline above is 6.87, and after the deployment it
was **6.90 days and still firing every minute**, with **zero**
`sandbox.stranded_reclaim` events fleet-wide against a healthy sweep (40
`sandbox.sweep_completed` in 40 minutes). The reclaim is deployed and declines
this container deliberately — see
[finding B](#b-cyr-89s-premise-about-the-stranded-sandbox-is-wrong).

**Fault 2 (PAR-200) has stopped firing.** Last event 2026-09-09T05:47Z, none in
the 24 h window's tail. That is consistent with the container having been
destroyed or the lock released, but this drive did **not** confirm which, and a
detector that stops firing is not by itself evidence that the lock was released —
`noteStranded` reaches neither shape once affinity is gone. Carried forward as
unconfirmed rather than reported resolved.

## Findings this drive made that CYR-89 did not anticipate

### A. The `/setup` UI allowlist silently gates the fleet-operator API

Filed as [#86](https://github.com/nick-boey/cyrus/issues/86). This blocked scope
item 2 and was worked around, not fixed.

An Entra principal named in `fleetOperatorGrants` is refused with an opaque
`403` unless it is **also** in `setupUiAllowedPrincipalObjectIds`. The Easy Auth
sidecar carries `defaultAuthorizationPolicy.allowedPrincipals.identities`
rendered from that /setup parameter, and `globalValidation.excludedPaths` is
`null`, so the policy gates every path including `/api/v1/operator/*`. The
request never reaches the router, so the grant table is never consulted and
nothing is logged.

The token was valid and the grant matched: `aud`, `tid`, `iss` and `oid` all
correct, `oid` identical to the deployed grant, the router having logged
`… 1 grant(s)`, and the granted workspace matching the router's only served
workspace (checked against the `linear-workspaces-json` Key Vault secret).
Still 403.

Four credentials against the same endpoint separate the two answerers:

| credential | status | content-type | body | answered by |
| --- | --- | --- | --- | --- |
| no `authorization` header | 401 | `application/json` | `{"error":"unauthorized"}` | router |
| **malformed** JWT | 401 | `application/json` | `{"error":"unauthorized"}` | router |
| local operator token | 200 | `application/json` | full context | router |
| **valid** Entra token, non-allowlisted oid | **403** | **none** | **empty** | **sidecar** |

**The sidecar blocks only tokens it can validate.** A malformed JWT reaches the
router; a genuine token from a principal the router would have authorized does
not. The control is weaker than it looks against anything hostile and stronger
than intended against a legitimate operator.

It also falsifies a stated assumption. `router-auth.bicep` says a request
failing the policy "gets no identity — so the policy below is a real control
even with anonymous pass-through, because the router then sees no principal and
**answers 401**". It does not answer 401; it never answers.

Consequence beyond this drive: `infra/azure/bicep/README.md` presents the two
authorizations as independent, and `fleetOperatorGrants` cannot express a
service principal at all, since one will never be on a UI sign-in allowlist.

**Worked around** by pointing the grant at `nboey@northrop.com.au`, which is
already on the /setup allowlist. That is recorded in the deployment parameter
file itself, not only here, because the next person to "correct" it back to the
admin account gets an opaque 403 with no way to tell it from a missing grant.

### B. CYR-89's premise about the stranded sandbox is wrong

CYR-89 says of NOR-402: *"Deploying current `main` **should collect it** — verify
that it does."* CYR-78 said the same. **It does not, and it never will.** Filed
as [#82](https://github.com/nick-boey/cyrus/issues/82), whose acceptance
criteria this replaces.

After the deploy carrying CYR-84 (revision `--0000042`), device 151 was still
firing `sandbox.stranded_session` every minute at 6.90 days quiet, with **zero**
`sandbox.stranded_reclaim` events fleet-wide and a healthy sweep (40
`sandbox.sweep_completed` in 40 minutes).

That is by design, and the design says so. `ContainerLifecycle.quietSinceOnRow`
includes `row.lastSeenMs`, and device 151 is `online=true` — a connected worker
restamps that every 30 seconds, so its quiet clock never leaves ~30s and cannot
approach the 72h threshold. From the source:

> A worker that is connected restamps `last_seen_ms` every 30s, so the
> `no_progress` shape — a live worker holding an issue it has stopped working on
> — is **never reclaimed here at all**, and stays **detection-only**.

The CHANGELOG entry for CYR-84 says it too: *"A sandbox whose worker is still
connected is never removed this way, however quiet it looks."* The reclaim
bounds the *leaked-affinity-on-an-offline-device* case; NOR-402 is the other
shape. It needs a deliberate act — a destroy or a recovery — not a wait.

### C. A JSON `null` attribute is rendered as the string `"null"`

Filed as [#85](https://github.com/nick-boey/cyrus/issues/85). Found by the
field-by-field comparison, which is exactly what that comparison is for.

| attribute | `az monitor log-analytics query` | `cyrus logs query` |
| --- | --- | --- |
| `cyrus.workspace_name` | `null` | `"null"` |
| `cyrus.project_id` | `null` | `"null"` |
| `cyrus.project_name` | `null` | `"null"` |
| `cyrus.model` | `null` | `"null"` |
| `cyrus.device_id` | `294` (number) | `"294"` |

The integer coercion is defensible — `attributes` is a string-valued map and the
value round-trips. The null is not: it fabricates a value where there was none,
is indistinguishable from a genuine string `"null"`, and is truthy everywhere an
operator or an orchestrating agent will filter. An operator asking which runs
recorded no model sees every record carrying one, and `cyrus.project_*` is null
on every issue outside a Linear project.

### D. Deployment CD had been broken since 2026-09-09T11:50Z (now fixed, by #79)

`Update Cyrus Pin` in the private deployment repository had failed **36
consecutive times** — every run since the last success at 11:30Z. So public
`main` was not reaching Azure at all, which is the mechanical reason the fleet
was still on `sha-a51fcca` while NOR-402 stayed stranded.

The reported error is a red herring:

```
==> digest sha256:eaa396d53ce85b2f950d0ff2a6c4852d07a0db39c927758d42de736fad4d2b2a
==> verifying manifest media type
error: could not read the manifest media type for acrcyrusdev.azurecr.io/cyrus-worker@sha256:eaa396d5…
```

That manifest reads correctly — `application/vnd.docker.distribution.manifest.v2+json`,
the expected value — from this machine. The worker image was built and pushed
successfully; `az acr manifest show` then failed for some other reason, and
`deploy-worker-image.sh:392` discarded its stderr with `2>/dev/null || true` and
attributed the empty stdout to the media type. At the time of writing the
genuine cause was unknown, which was precisely the point: the script threw away
the only evidence that would name it. It is known now — see below — and it was
in that stderr.

An initial hypothesis that the deploy identity lacked an ACR data-plane role was
checked and **disproved** — `AcrPull` grants `Microsoft.ContainerRegistry/registries/pull/read`
as a plain action, which the identity's subscription-scope `Contributor` covers
via `*`, and it is not in Contributor's `notActions`. The registry is also
publicly reachable with no network rule set. Recorded because the disproof is
worth as much as the hypothesis. Timing points at the runner instead: `az acr
manifest` is a preview command group and the failure began between two runs
twenty minutes apart with no repository change.

**Resolved while this branch was in review, and the cause was not what this
drive guessed.** [#79](https://github.com/nick-boey/cyrus/pull/79) landed on
`main` and found it: a GitHub Actions OIDC login goes stale about ten minutes
in, and the worker image no longer builds in ten minutes — so `az acr manifest
show` was running with an expired credential. It removed the same `2>/dev/null`
independently, and split the build from the registration so the second half
gets a fresh credential.

Two things are worth keeping from that. The guess recorded above — a preview
CLI change on the runner, argued from the timing — was **wrong**, and it was
argued from exactly the evidence that survived the discard; the real answer was
in the stderr all along, which is the entire point. And this branch's remaining
half still earns its place: #79 lets az's error through but leaves the message
naming the media type, so the reader is still pointed at the image. Both halves
are needed, and they were written independently, which is some evidence that
the misdirection was obvious once anyone looked.

### E. The trusted skill registry names a repository this fork does not publish to

`TrustedSkillRegistry.ts:6` hardcodes `RELEASE_REPOSITORY = "cyrusagents/cyrus"`
and builds every download URL from it, while `release-cli.yml:293` attaches the
`cyrus-fleet-operator-<version>.tar.gz` to a release in whichever repository the
workflow runs in — here `nick-boey/cyrus`. A skill advertised by this deployment
would therefore resolve to a URL that 404s. There is also no `v0.2.70` release,
so there is nothing to resolve against either way.

Not fixed. Filed as [#81](https://github.com/nick-boey/cyrus/issues/81), and it is the reason scope item 4's install half is out of scope.

## Scope item outcomes

| Item | Outcome |
| --- | --- |
| **1. Advertise a log source, verify the client half end to end** | **PASS**, with one row not verifiable. Records returned (1229), `follow` streams, network evidence places Azure in the data path and the router outside it, budgets refuse rather than truncate, `minFollowIntervalSeconds` enforced, lag matches the measured ~1s, field-by-field comparison exact over all nine correlation fields. **Redaction over real rows: NOT VERIFIABLE** — the source contains nothing redactable. |
| **2. Grant Entra operator access, verify the principal matrix live** | **PASS** for the rows this fleet can express. `connection add --auth entra` succeeds where it was refused; credential chain resolves in the documented order; roles, capabilities and workspaces narrow correctly. **Group-keyed union and the app-only 403 could not be run** — both need Microsoft Graph changes, not parameters. **Workspace ambiguity explicitly out of scope.** |
| **3. Enable recovery, run it, disable it** | **NOT RUN.** Was *unreachable* before #80 and is now reachable. Recovery remains disabled. Beyond the authorization, **the fleet currently contains no target**: of 52 runs, 46 `complete`, 4 `unknown` (terminal), 1 `error`, and the single `active` run is healthy and working. Nothing matches the strand shape, so enabling recovery today would have nothing to recover. |
| **4. Install the operator skill from a versioned release** | **Advertising: done** (`fleetOperatorSkill`, #80). **Install: OUT OF SCOPE** by explicit decision — no release exists to resolve against, and the trusted registry names a different repository ([finding E](#e-the-trusted-skill-registry-names-a-repository-this-fork-does-not-publish-to), [#81](https://github.com/nick-boey/cyrus/issues/81)). |
| **Fault 1 — NOR-402** | **Carried forward, and CYR-89's premise corrected.** Not collected by the reclaim, and never will be while its worker stays connected — see [finding B](#b-cyr-89s-premise-about-the-stranded-sandbox-is-wrong). [#82](https://github.com/nick-boey/cyrus/issues/82). |
| **Fault 2 — PAR-200** | **Carried forward as unconfirmed.** Detector silent since 2026-09-09T05:47Z; silence is not proof the lock was released, because `noteStranded` reaches neither shape once affinity is gone. [#83](https://github.com/nick-boey/cyrus/issues/83). |
| **The `runs`-visibility question** | **Answered** — [ADR-0017](../../../docs/adr/0017-runs-observes-runs-not-containers.md), with the fleet-operator skill updated to match. |

### Two Entra prerequisites scope item 2 needs, which are not deployment parameters

Established read-only against the directory; neither is fixed by anything on
this branch, and both are recorded above under scope item 2.

CYR-89 already marks **workspace ambiguity** unprovable on this fleet, and that
is now an explicit decision rather than a restatement: it is **OUT OF SCOPE**.
`rg-cyrus` serves the single Linear workspace `75294f85-…` — confirmed against
the router's own `linear-workspaces-json` secret — so no principal on it can be
ambiguous. Standing up a second Linear workspace introduces a routing surface far
larger than the one row it would prove, and the behaviour is already covered by
CYR-78's F1 matrix, whose `runs list` row drives a principal authorized over two
workspaces and asserts the exit-2 diagnostic naming `--workspace`. This row is
**not** reported as passing on the fleet and will not be until a deployment
serves more than one workspace for its own reasons.

## Cleanup

**Azure and the deployment.** Three deployments were applied, all through
`scripts/deploy-azure.sh`, all reviewed as a what-if first: the pin to `6432f96`,
the fleet-operator grant, and the grant re-point. The router now runs revision
`--0000042`. **`enableFleetRecovery` is `false` and was never turned on.** Nothing
was unlocked, no container was stopped or destroyed, and no issue lock was
released.

**Credentials.** No operator token was minted on the router — the pre-existing
`cyrus-dev` local token was used read-only for two commands and is not this
drive's to revoke. The only other credentials were short-lived Entra access
tokens from `az account get-access-token`, which are the signed-in operator's own
and were never written to a file, so there is nothing to revoke.

**Outstanding, and deliberately so: one standing Azure role assignment.**
`Log Analytics Reader` was granted to `0749550b-…` (`nboey@northrop.com.au`) on
`log-cyrus-dev`. It is **not revoked**, because it is what makes the fleet
operator's client half work at all, and it is now declared in
`env/northrop-dev.bicepparam` as `fleetOperatorLogReaderPrincipalIds` rather than
left as an undocumented hand-made assignment. Revoke it if the operator role is
withdrawn. Note the template does not apply it — `manageRoleAssignments` is
`false`, so `scripts/bootstrap-azure-role-assignments.sh` owns it.

**Local.** The `cyr89-entra` connection was written to `~/.cyrus/config.json` and
has been **removed**; `connection list` shows only the pre-existing `cyrus-dev`.
No token value ever entered this repository. Six scratch parameter files
(`infra/azure/bicep/.cyr89-*.bicepparam`) were written next to `main.bicep`
because a `.bicepparam` `using` clause cannot take an absolute path; all are
covered by `.gitignore`'s `*.bicepparam` (verified with `git check-ignore -v`)
and the negative-case ones were deleted.

**Not cleaned up, and worth stating:** the `cyrus-dev` local-token connection
reappeared in `~/.cyrus/config.json` despite CYR-78's drive recording it as
removed. Not this drive's doing and left alone.

## Verification

Repository checks, on the branch carrying this document:

```
./scripts/check-bicep.sh                  → 21 ok, 0 FAIL
bash scripts/deploy-worker-image.test.sh  → 55 ok, 1 pre-existing failure
pnpm typecheck                            → clean
pnpm test:packages:run                    → 20 packages, all pass
pnpm lint                                 → 15 warnings, all pre-existing
```

The one script-test failure is `env: timeout: No such file or directory` in case
21, which predates this work: GNU `timeout` is not installed on this macOS host.

Live commands, all against `app-cyrus-dev-router` revision `--0000042`:

```bash
curl -s $ROUTER/.well-known/cyrus
curl -s -H "authorization: Bearer $TOK" $ROUTER/api/v1/operator/context
cyrus connection add cyr89-entra $ROUTER --auth entra
cyrus connection show cyr89-entra
cyrus logs query  --connection cyr89-entra --since 15m --json
cyrus logs query  --connection cyr89-entra --since 48h --json     # budget refusal
cyrus logs query  --connection cyr89-entra --since 25h --json     # budget refusal
cyrus logs follow --connection cyr89-entra --interval 5 --timeout 5 --json   # interval refusal
cyrus logs follow --connection cyr89-entra --since 2m --interval 15 --timeout 40 --json
cyrus runs list --json
az monitor log-analytics query --workspace 7f02622b-… --analytics-query "$(cat …)"
```

Network evidence was gathered by sampling `lsof -nP -i -a -p <pid>` against the
CLI's own process tree every 200ms for the life of each command, then reverse
resolving each remote endpoint. That method proves **presence** of a connection
reliably and **absence** only weakly, which is stated wherever an absence is
relied on.

## CYR-89's acceptance evidence, item by item

- [x] **A test-drive document** with environment, image/revision, exact commands,
  timestamps, expected vs actual, and cleanup — this file.
- [x] **Each numbered scope item passes with captured output or is explicitly
  marked out of scope with a reason.** Items 1 and 2 pass with captured output,
  each naming the rows it could not run and why. Item 4's install half is out of
  scope with two reasons. Item 3 is **not run**, which is a third state the
  criterion does not offer — recovery stays disabled, and the fleet has no target
  to recover.
- [x] **Both live faults confirmed resolved, or carried forward as their own
  issues** — [#82](https://github.com/nick-boey/cyrus/issues/82) (NOR-402, with
  CYR-89's premise corrected) and
  [#83](https://github.com/nick-boey/cyrus/issues/83) (PAR-200, unconfirmed).
  Neither is resolved. Three further defects found here are filed as
  [#81](https://github.com/nick-boey/cyrus/issues/81),
  [#85](https://github.com/nick-boey/cyrus/issues/85) and
  [#86](https://github.com/nick-boey/cyrus/issues/86).
- [x] **The `runs`-visibility question answered in writing** —
  [ADR-0017](../../../docs/adr/0017-runs-observes-runs-not-containers.md).
- [x] **Any credential minted for the drive is revoked, and the revocation
  verified from outside the router** — no credential was minted, so this is
  satisfied vacuously. The one standing Azure role assignment is deliberately
  retained and declared; see [Cleanup](#cleanup).
- [x] **No owner, date or estimate is invented** — none appears in this document,
  in the five issues, or in ADR-0017. The production recovery rollout remains
  unassigned and unscheduled.

**CYR-89 is not closeable.** Scope item 3 is unrun, and it is the item the
issue's title names.

## What this drive still could NOT reach

**Scope item 3, which is the one CYR-89's title names.** Everything else it asks
for is done or explicitly out of scope.

Item 3 is now blocked on two separate things, and only the first was expected:

1. **Authorization.** `enableFleetRecovery = true` plus the router-side switch
   #80 added. That is a parameter flip and a deploy, and it is deliberately not
   done: recovery is the operator contract's one mutation, and enabling it is a
   separately authorized rollout.
2. **A target, which no longer exists.** CYR-89 states *"The target already
   exists and does not need constructing"*, naming PAR-200's run
   `4ddc55fd-…`. That run has aged out. Of the 52 runs the router now returns:
   46 `complete`, 4 `unknown` (terminal), 1 `error`, and the single `active` run
   is healthy — routed minutes earlier, worker online, publishing activities.
   Nothing matches the strand shape of a non-terminal run with a stopped
   container and an offline worker.

So enabling recovery today would have nothing to recover. The options are to wait
for the shape to occur naturally — it has occurred at least twice in a week, so
this is likely rather than speculative — or to construct one, which CYR-89
assumed would not be necessary. That assumption is the second of its premises
this drive found to be time-dependent rather than wrong-in-principle, the first
being the reclaim.

Two rows inside item 1 and two inside item 2 are also unreached, for reasons that
are not about this deployment's configuration: redaction has nothing to act on,
and the two Entra rows need Microsoft Graph changes. Each is enumerated in its
own section rather than summarized here.

## Retrospective

Three of this drive's findings could only have come from running it, and each has
the same shape: something everyone believed, stated in writing, that turned out
not to be how the system behaves.

**The template's own comment was wrong about `what-if`.** Fifteen
cross-parameter invariants were documented as gating deployment, one of them
naming `what-if` explicitly, and none of them gated anything a preview would
show. That was found only because a *new* guard appeared not to work and the
honest next move was to test a rule that had been in the template for months
rather than assume the new one was at fault. A guard that has never been observed
to fire is indistinguishable from one that cannot.

**`router-auth.bicep` was wrong about what a failed authorization policy does.**
It says the sidecar lets the request through and "the router then sees no
principal and answers 401". The router never answers. That single sentence is why
nobody expected the `/setup` allowlist to gate the operator API, and it cost the
better part of an hour to find — the 403 was empty, the token was valid, the
grant was loaded, and every layer looked correct. What resolved it was comparing
four credentials against one endpoint and noticing that the *content-type* header
differed. The perverse detail — that the sidecar blocks only tokens it can
validate, so a malformed JWT reaches the router and a genuine one does not — is
the kind of thing no test would assert because nobody would think to write it.

**CYR-89 and CYR-78 were both wrong about the reclaim.** Two documents, written a
day apart, predicted that deploying CYR-84 would collect NOR-402. The source says
plainly that it will not, and the CHANGELOG entry says it too; both were written
before either document. The prediction was never checked against the thing it was
predicting about.

The methodological point is narrower than "test in production". It is that the
pre-deployment half of this drive — proving the template renders what it claims,
read-only, against the real ARM evaluator from a laptop — caught two of the three
blockers before any deploy, and the third was reachable only by holding a real
credential. Splitting the work that way meant the deployment itself was
uneventful, which is the outcome you want from a deployment.

One thing this drive did **not** do is worth stating as plainly as what it did.
Redaction is unverified. The temptation to write a credential-shaped string into
the telemetry backend to exercise the redactor was real, and refusing it leaves a
row marked NOT VERIFIABLE that a less careful drive would have marked PASS on the
strength of a clean scan. A clean scan of rows that contain nothing to redact
demonstrates nothing at all.
