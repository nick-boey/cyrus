# Test Drive: CYR-89 — Operator surface, pre-deployment pass

**Date**: 2026-09-10 (UTC)
**Issue**: CYR-89 — Verify the operator surface post-deployment, and decide the recovery rollout
**Consumes**: [CYR-78](2026-09-09-observability-commands.md) — its F1 matrix and read-only fleet drive are the prerequisite evidence
**Goal**: Close the half of CYR-78 that no test and no read-only drive could reach.

> **Read this line first.** CYR-89's four numbered scope items are all gated on a
> deployment change, and **that deployment has not happened**. What this drive
> did instead was establish — read-only, against the live subscription — that
> three of those four items were **unreachable as the template stood**, fix the
> template so they become reachable, and prove each fix against the real ARM
> evaluator without applying anything. The scope items themselves remain
> **unrun**, and are enumerated as such in
> [What this drive still could not reach](#what-this-drive-still-could-not-reach).
> Nothing on `rg-cyrus` was deployed, enabled, unlocked, destroyed or mutated.
> **Recovery remains disabled**, and this drive does not authorize enabling it.

## Environment

| Fact | Value |
| --- | --- |
| Commit under test | branch `cyr-89-verify`, base `main` @ `d1e75656` |
| Node | v22.20.0 |
| pnpm | 10.33.1 |
| Platform | darwin 25.6.0 (macOS) |
| Azure subscription | `1efb7cc3-4a62-4f9b-9c01-d9f532c0c526` (`dit-development`) |
| Signed in as | `adm-nick.boey@northrop.com.au`, oid `1d065ee6-5a8f-445a-9b5c-c3a0c99dbe1d` |
| Router under test | `app-cyrus-dev-router`, revision `--0000039`, image `ghcr.io/nick-boey/cyrus-router:sha-a51fcca` |
| Log Analytics | `7f02622b-26ce-47b0-8cd1-ded57e9053b4` (`log-cyrus-dev`), `ContainerAppConsoleLogs_CL` |
| Azure writes performed | **none** — every `deploy-azure.sh` invocation was a preview |

## Why the scope items were unreachable, and are now not

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

The deploy that phase 1 previews is `3 to create, 22 to modify`. The three
creates are `Cyrus-Disk-Image-Decisions`, `Cyrus-Disk-Image-GC` and
`Cyrus-Sandbox-Stranded-Reclaims` — CYR-84's saved searches, which is
independent confirmation that the pending deployment carries the `reclaimStranded`
that scope item 5 depends on.

## Pre-deploy snapshot of the two live faults

Captured before any deployment, so the post-deploy comparison scope item 5 asks
for has a baseline. Re-run this to compare:

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

**Fault 1 (NOR-402) is unresolved and has worsened.** CYR-78 measured 6.1 days;
it is now 6.87 and still firing every minute. It remains the exact target CYR-84's
`reclaimStranded` collects at 72 h quiet, and the router that would do so is
still not deployed.

**Fault 2 (PAR-200) has stopped firing.** Last event 2026-09-09T05:47Z, none in
the 24 h window's tail. That is consistent with the container having been
destroyed or the lock released, but this drive did **not** confirm which, and a
detector that stops firing is not by itself evidence that the lock was released —
`noteStranded` reaches neither shape once affinity is gone. Carried forward as
unconfirmed rather than reported resolved.

## Two faults found by this drive that CYR-89 did not anticipate

### A. Deployment CD had been broken since 2026-09-09T11:50Z (now fixed, by #79)

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

### B. The trusted skill registry names a repository this fork does not publish to

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
| 1. Advertise a log source, verify the client half end to end | **Unrun.** The template half is done and proven to render; every bullet in the item (records returned, network evidence, budgets refusing, redaction over real rows, measured lag, field-by-field comparison against `az monitor log-analytics query`) needs the deployed router and is untouched. |
| 2. Grant Entra operator access, verify the principal matrix live | **Unrun**, and two prerequisites are now known to be missing beyond the deploy — see below. |
| 3. Enable recovery, run it, disable it | **Unrun.** Was **unreachable** before this branch; is now reachable. |
| 4. Install the operator skill from a versioned release | **Advertising: done** (`fleetOperatorSkill`). **Install: out of scope**, by explicit decision, for the two reasons in fault B — no release exists to resolve against, and the trusted registry names a different repository. |
| Fault 1 — NOR-402 | **Carried forward, unresolved and worse** (6.87 days) as [#82](https://github.com/nick-boey/cyrus/issues/82), with the baseline captured for the post-deploy comparison. |
| Fault 2 — PAR-200 | **Carried forward as unconfirmed** in [#83](https://github.com/nick-boey/cyrus/issues/83). Detector silent since 2026-09-09T05:47Z; silence is not proof the lock was released. |
| The `runs`-visibility question | **Answered** — [ADR-0017](../../../docs/adr/0017-runs-observes-runs-not-containers.md), and the fleet-operator skill updated to match. |

### Two Entra prerequisites scope item 2 needs, which are not deployment parameters

Both established read-only against the directory, and neither is fixed by any
change on this branch.

An operator access token **is** obtainable today and carries what the router
needs — verified by minting one for `api://88f4bd8f-2967-4933-a82c-85569cefe96a`
and decoding it: `aud` matches, `tid = c9857cc6-…`, `oid = 1d065ee6-…`, `ver 1.0`,
no `idtyp`. `OperatorAuthorizer` accepts both issuer forms, so the v1 token is
fine. That is the row `cyrus connection add --auth entra` needs, and it should
work once a grant is deployed.

The two rows that will **not** work:

- **Group-keyed grants cannot match.** `az ad app show` reports
  `groupMembershipClaims: null`, and the minted token carries no `groups` claim
  at all. Every group-keyed grant will fail to match and the caller will see a
  403 — the same symptom as the groups OVERAGE `OperatorAuthorizer` warns about,
  arriving by a different route. Testing "group-keyed grants union correctly
  with an `oid`-keyed one" needs `groupMembershipClaims` set on the app
  registration, which is a Microsoft Graph change, not an ARM one.
- **The app-only 403 row needs a second identity.** `appRoles` is `[]` and no
  service principal holds client credentials for this audience, so there is
  nothing that can currently present a token with `idtyp: "app"`. Testing that
  row means creating a test app registration.

**Workspace ambiguity: explicitly OUT OF SCOPE.** CYR-89 requires a decision
here — "Either add a second workspace or mark this row explicitly out of scope;
do not report it as passing." It is marked out of scope. `rg-cyrus` serves the
single Linear workspace `75294f85-72ad-42ef-b9d7-c6ded611fc42`, so no principal
on it can be ambiguous, and the alternative — standing up a second Linear
workspace on the dev fleet — introduces a routing surface far larger than the
one row it would prove. The behaviour is covered by CYR-78's F1 matrix, whose
`runs list` row drives a principal authorized over two workspaces and asserts
the exit-2 diagnostic naming `--workspace`. This row is **not** reported as
passing on the fleet, and will not be until a deployment serves more than one
workspace for its own reasons.

## Cleanup

No Azure resource was created, modified or deleted. Every `deploy-azure.sh`
invocation ran without `--apply`; the two `az deployment sub validate` calls are
read-only and named `cyr89-guard-probe`, which ARM does not persist as a
deployment on failure.

**No credential was minted.** The only token obtained was a short-lived Entra
access token from `az account get-access-token`, which is the signed-in
operator's own and was never written to a file — so there is nothing to revoke,
and CYR-89's "every credential minted and its revocation" criterion is satisfied
vacuously rather than by a revocation step. No operator token was created on the
router, in contrast to CYR-78's drive, because nothing here talked to the router.

Six scratch parameter files (`infra/azure/bicep/.cyr89-*.bicepparam`) were
written next to `main.bicep` because a `.bicepparam` `using` clause cannot take
an absolute path. All are covered by `.gitignore`'s `*.bicepparam` rule —
verified with `git check-ignore -v` — and the four negative-case files were
deleted. The two phase files are kept for the deployment, and neither contains a
secret: the live parameter file is secretless by contract and the appended block
holds Entra object ids and Linear workspace ids only.

## Verification

```
./scripts/check-bicep.sh                  → 20 ok, 0 FAIL
bash scripts/deploy-worker-image.test.sh  → 50 ok, 1 pre-existing failure
pnpm typecheck                            → clean
pnpm test:packages:run                    → 20 packages, all pass
pnpm lint                                 → 15 warnings, all pre-existing
```

The one script-test failure is `env: timeout: No such file or directory` in case
21, which predates this branch: GNU `timeout` is not installed on this macOS
host. Case 21 is untouched here. The new case 23 — added for fault A — passes.

## CYR-89's acceptance evidence, item by item

- [x] **A test-drive document** under `apps/f1/test-drives/` with environment,
  image/revision, exact commands, expected vs actual, and cleanup — this file.
- [x] **Each numbered scope item passes with captured output or is explicitly
  marked out of scope with a reason** — with one honest caveat: items 1, 2 and 3
  are neither. They are **unrun**, which is a third state the criterion does not
  offer, because the deployment they depend on has not happened. Item 4's
  advertise half passes; its install half is marked out of scope with two
  reasons. Workspace ambiguity is marked out of scope explicitly.
- [x] **Both live faults confirmed resolved, or carried forward as their own
  issues** — carried forward as [#82](https://github.com/nick-boey/cyrus/issues/82)
  (NOR-402) and [#83](https://github.com/nick-boey/cyrus/issues/83) (PAR-200).
  Neither is resolved. [#81](https://github.com/nick-boey/cyrus/issues/81)
  carries the registry mismatch this drive found.
- [x] **The `runs`-visibility question answered in writing** —
  [ADR-0017](../../../docs/adr/0017-runs-observes-runs-not-containers.md).
- [x] **Any credential minted for the drive is revoked, and the revocation
  verified from outside the router** — satisfied vacuously: no credential was
  minted. See [Cleanup](#cleanup).
- [x] **No owner, date or estimate is invented** — none appears in this document,
  in the three issues, or in ADR-0017. The production recovery rollout remains
  unassigned and unscheduled.

**CYR-89 is not closeable on this evidence.** Its own goal is the post-deployment
verification, and that has not been performed.

## What this drive still could NOT reach

Everything CYR-89 actually asks for. The deployment has not happened, so items
1, 2 and 3 are unrun in full, and no assertion in this document depends on the
deployed router's behaviour. What changed is that the template no longer blocks
them:

| Blocker CYR-78 named | Status |
| --- | --- |
| `logSource` for logs | Renders. Was never actually blocked by the template — it rides on `fleetOperatorGrants`, which was simply unset. |
| `fleetOperatorGrants` for Entra | Renders. Two non-ARM prerequisites remain for two of its rows. |
| `enableFleetRecovery` for recovery | Renders **the router's switch**, which it did not before. This was a real blocker and was not visible from the parameter file. |

The deployment sequence this leaves ready is: land this branch on `main`; let
the pin follow, or dispatch manually — the three saved-search creates will trip
`Deploy Cyrus`'s gate 2, which is the healthy response to a template change, not
a breakage; apply phase 1; run scope items 1 and 2; apply phase 2; run scope item
3; revert to phase 1 immediately. `enableFleetRecovery = false` is the steady
state, and nothing in this drive authorizes leaving it on.

## Retrospective

The useful outcome here is not the fixes; it is that CYR-78's account of why it
was blocked was accurate about the symptom and wrong about the cause, in a way
that would have cost a deployment cycle to discover. "Set `enableFleetRecovery`
and drive recovery" would have produced a router that refused every recovery
request, and the refusal would have looked exactly like the one you get with
recovery correctly disabled — so the natural next step would have been to
re-check the grants, the token, and the capability list, none of which were
wrong.

The `parameterGuard` finding has the same shape and a wider blast radius. Fifteen
invariants were documented as gating deployment, one of them was even documented
as gating `what-if` by name, and none of them gated anything a preview would
show. That was found only because a new guard appeared not to work and the
honest next move was to test a rule that had been in the template for months
rather than assume the new one was at fault. A guard that has never been
observed to fire is indistinguishable from one that cannot.

Both were reachable read-only, from a laptop, against the real evaluator, before
any deployment — which is the argument for doing this pass before the deploy
rather than discovering it in the middle of one.
