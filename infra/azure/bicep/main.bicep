// Cyrus on Azure — router hosting + ACA Sandboxes.
//
// THE DEPLOY PATH. This template replaces the Terraform stack that used to live
// in ../terraform. The move is what makes the deployment STATELESS: there is no
// state file, no state storage account, no state resource group, no blob lease
// to break, and no `terraform init` to get wrong. Azure Resource Manager holds
// the state, and the template is a description of the desired shape.
//
// Deploy with scripts/deploy-azure.sh (preferred — it enforces the image-tag
// policy and the /setup staging gate against live Azure), or directly:
//
//   az deployment sub create \
//     --name cyrus-dev \
//     --location <region> \
//     --template-file infra/azure/bicep/main.bicep \
//     --parameters infra/azure/bicep/main.bicepparam
//
// INCREMENTAL MODE ONLY. Subscription-scope deployments and the resource-group
// module deployments below all default to Incremental, which never deletes a
// resource merely because the template stopped mentioning it. Several safety
// properties in this stack depend on that (see "Deleting is not a flag" below);
// never deploy this template with `--mode Complete`.

targetScope = 'subscription'

////////////////////////////////////////////////////////////////////////////////
// Project / naming
////////////////////////////////////////////////////////////////////////////////

// The length caps are not arbitrary: the Key Vault name is `kv-<project>-<environment>`
// and Key Vault allows 24 characters, which is the tightest limit any resource
// in this stack imposes. 10 + 9 leaves it at 23. The Terraform stack had the
// same naming scheme and no such cap, so an over-long pair failed at create
// time instead of at validation.
@description('Short project prefix used as the name root for every resource (for example \'cyrus\'). Must be lowercase, start with a letter, and be unique within the subscription.')
@minLength(2)
@maxLength(10)
param project string

@description('Deployment environment suffix appended to resource names (for example \'dev\', \'prod\').')
@minLength(1)
@maxLength(9)
param environment string = 'dev'

@description('Optional exact resource group name. Empty means rg-<project>-<environment>.')
param resourceGroupName string = ''

@description('Azure resource tags applied to every resource. Merged with cyrus-managed=true, environment, and project.')
param tags object = {}

@description('Azure region for every regional resource. REQUIRED — deliberately has no default, so a stack cannot silently land in a region nobody chose. ACA sandbox groups are supported in 35 regions (spike S7) and \'australiaeast\' is the spike-verified value for this tenant; an unsupported region fails at sandbox-group create, not at validate, so check the spike findings before picking a new one.')
@minLength(3)
param location string

////////////////////////////////////////////////////////////////////////////////
// Container images
//
// DURABLE-ENVIRONMENT RULE: both image inputs must be pinned to an IMMUTABLE
// reference — a digest (`@sha256:<64 hex>`), a release tag (`v1.2.3`), or a
// git-SHA tag (`sha-a1b2c3d`). A mutable/floating tag (`:latest`, `:deploy`, a
// branch name, or an ad-hoc hotfix tag such as `:deploy-aca-disk-fix`) does NOT
// identify a build: the registry can re-point it at any time, so the next
// deployment can silently roll a running router BACKWARDS onto an older image
// while ARM reports the container spec as unchanged (the tag string is
// identical). That is exactly how the private-disk fix nearly got lost — the
// live Container App ran `:deploy-aca-disk-fix` while the deploy inputs said
// `:deploy`.
//
// `.github/workflows/docker-router.yml` publishes `sha-<short-sha>` on every
// push and `v<semver>` on every release tag precisely so there is always an
// immutable ref to pin. See README → "Router image tag policy".
//
// The check below is a POSITIVE ALLOWLIST of ref SHAPES, not a blocklist of
// known-bad tags — a blocklist would have missed `deploy-aca-disk-fix`. It is
// deliberately narrower than the Terraform regex it replaces: a bare hex tag
// (`repo:a1b2c3d`, no `sha-` prefix) is no longer accepted, because ARM has no
// regex and character-class validation cannot be expressed here without pushing
// the template onto an ARM language version this stack does not otherwise need.
// Nothing regresses in practice — the repo's own workflow only ever publishes
// `sha-<sha>` and `v<semver>`. scripts/deploy-azure.sh applies the full
// character-level regex on top of this.
////////////////////////////////////////////////////////////////////////////////

@description('Fully-qualified container image for the router, pinned to an IMMUTABLE reference — a digest (\'ghcr.io/ceedaragents/cyrus-router@sha256:<64 hex>\'), a release tag (\'…/cyrus-router:v1.2.3\'), or a git-SHA tag (\'…/cyrus-router:sha-a1b2c3d\'). Mutable tags (\':latest\', \':deploy\', any branch or ad-hoc hotfix tag) are REJECTED — set allowMutableImageTags=true to override in a throwaway stack. Pullable anonymously or, for private registries, via the router\'s user-assigned identity after enableAcr=true.')
@minLength(3)
param routerImage string

@description('Fully-qualified OCI image for the Cyrus worker, pinned to an IMMUTABLE reference for the same reason as routerImage. This image is NOT pulled by the router — it is registered as a group-scoped ACA disk image OUT OF BAND (`aca sandboxgroup disk create --image <workerImage>`), and the disk name the group knows it by is acaDiskName. It is passed here purely so the router can embed it in CYRUS_ROUTER_CONTAINERS_JSON. Because the disk image is registered out of band, a floating tag here also makes it impossible to tell which build a registered disk was cut from.')
@minLength(3)
param workerImage string

@description('ESCAPE HATCH — leave false. When true, routerImage and workerImage may carry mutable tags. Only set this in a throwaway stack you are willing to have silently rolled backwards; the non-default value is deliberately visible in the parameter-file diff.')
param allowMutableImageTags bool = false

@description('Optional override for the WSS URL containers dial to reach the router. Leave empty: unlike the Terraform stack, this template derives the value from the Container Apps environment\'s defaultDomain, which is a SEPARATE resource from the app and therefore introduces no dependency cycle. The two-apply flow the Terraform stack needed for this is gone.')
param routerUrlForContainers string = ''

@description('Name of the pre-registered ACA group disk image (created out of band from workerImage). This is the value the router passes to sourcesRef.diskImage on sandbox create.')
@minLength(1)
param acaDiskName string

////////////////////////////////////////////////////////////////////////////////
// ACA per-sandbox compute defaults
//
// These are passed to the ROUTER CONFIG (CYRUS_ROUTER_CONTAINERS_JSON) and
// consumed on a per-sandbox `create` body. The ARM Microsoft.App/sandboxGroups
// resource accepts NONE of them — spike finding: "The ARM sandboxGroups resource
// takes almost no properties. Created successfully with properties: {}". See
// modules/sandbox-group.bicep and README → "maxSandboxCount does NOT exist".
////////////////////////////////////////////////////////////////////////////////

@description('Default vCPU request per sandbox. Passed to the router config; ACA normalises server-side (\'4000m\' → 4 cores). XL tier is the suggested default (4 vCPU / 8 GiB / 80 GiB) but is the most expensive — set consciously.')
param acaCpu string = '4000m'

@description('Default memory request per sandbox (for example \'8192Mi\'). Server-normalised; see acaCpu.')
param acaMemory string = '8192Mi'

@description('How long a container may sit idle before the router suspends it (snapshot + memory-suspend; a later prompt resumes it warm). The sweep NEVER touches a device that holds session affinity, and a session only releases affinity when it finishes or parks, so this bounds idle cost without ever freezing work. Counts from the later of the last routed event and the park.')
@minValue(1)
param idleStopMs int = 300000

@description('ACA-side auto-suspend interval in seconds. 0 = DISABLED (the Cyrus default, spike N5/F2). ACA-side suspend has NO session-affinity gate and can freeze a live session mid-task; the router\'s affinity-aware idleStopMs is the sole idle controller. Leave this at 0.')
@minValue(0)
param acaAutoSuspendSeconds int = 0

@description('Default egress action per sandbox. \'Deny\' is the secure default (D7); the router injects the full D7 allowlist per-sandbox on create. Set \'Allow\' only for isolated test sandboxes.')
@allowed([
  'Allow'
  'Deny'
])
param acaEgressDefaultAction string = 'Deny'

@description('Egress inspection mode. \'Full\' enforces deny rules AND blocks non-HTTP TCP/UDP (so git+ssh:// is unsupported). \'Partial\' relaxes that. \'None\' applies no inspection. Spike S4 confirmed WSS through \'Full\' works, so the \'Partial\' fallback is not required.')
@allowed([
  'Legacy'
  'Full'
  'Partial'
  'None'
])
param acaEgressTrafficInspection string = 'Full'

@description('Optional explicit ACA egress host rules, each { pattern: string, action: \'Allow\' | \'Deny\' }. Leave EMPTY to retain the router provider\'s built-in host allowlist (including the router WSS host); a non-empty list REPLACES that default entirely.')
param acaEgressHostRules array = []

@description('Retention count for the per-issue explicit labeled snapshots the provider prunes on the create path (keepSnapshots in router config). Snapshots are never GC\'d by Azure; this defaults to the 2 newest.')
@minValue(0)
param acaKeepSnapshots int = 2

@description('Milliseconds an ACA worker may remain disconnected from router WSS before ensureRunning replaces it.')
@minValue(0)
param acaDisconnectedRecreateMs int = 120000

////////////////////////////////////////////////////////////////////////////////
// Linear integration secrets (seeded into Key Vault)
////////////////////////////////////////////////////////////////////////////////

@description('Linear organization UUID returned by OAuth workspace discovery. Use the UUID, not the workspace slug. NOT secret; shipped as a plain env var to the router.')
@minLength(1)
param linearWorkspaceId string

@description('Linear workspace API token used by the router to read/mutate issues. Seeded into Key Vault secret \'linear-workspace-token\'. Rotate via Key Vault after first deploy — re-deploying with the old parameter value overwrites an operator rotation.')
@secure()
param linearWorkspaceToken string

@description('Linear OAuth refresh token used to rotate the workspace access token. Seeded into the \'linear-workspaces-json\' secret.')
@secure()
param linearWorkspaceRefreshToken string

@description('HMAC secret shared between Linear and the router for verifying webhook signatures. Seeded into Key Vault secret \'linear-webhook-secret\'.')
@secure()
param linearWebhookSecret string

@description('Linear OAuth client id (router-mode OAuth app). Seeded into Key Vault secret \'linear-client-id\'.')
@secure()
param linearClientId string

@description('Linear OAuth client secret. Seeded into Key Vault secret \'linear-client-secret\'.')
@secure()
param linearClientSecret string

////////////////////////////////////////////////////////////////////////////////
// RBAC
////////////////////////////////////////////////////////////////////////////////

@description('Role-definition GUID for \'Container Apps SandboxGroup Data Owner\'. Bicep cannot resolve a role definition by display name the way the Terraform data source did, so the GUID is the primary path here. Spike S6 verified this value in-tenant. Confirm in your own tenant with `az role definition list --name "Container Apps SandboxGroup Data Owner" --query "[].name" -o tsv` and override if it differs. A second undocumented role, \'Container Apps SandboxGroup Contributor\' (11b23f7a-6229-4518-88db-0576f10dd2a0), exists for least-privilege readers — do NOT give the router that one.')
param sandboxGroupDataOwnerRoleId string = 'c24cf47c-5077-412d-a19c-45202126392c'

@description('Optional Entra principal id (object id of a user/group/SP) granted break-glass \'Storage Blob Data Contributor\' on the router-backups container. WITHOUT this, an operator cannot delete a corrupt router.db blob to unwedge a fatal-restore CrashLoopBackOff (M2). Leave empty in pure-CI environments.')
param operatorPrincipalId string = ''

////////////////////////////////////////////////////////////////////////////////
// Cyrus repositories
////////////////////////////////////////////////////////////////////////////////

@description('Repositories the router is allowed to spin workers up for, passed VERBATIM into CYRUS_ROUTER_CONTAINERS_JSON.repositories. Each entry is the router\'s own repository shape — { name, githubSlug, linearWorkspaceId } plus optional { baseBranch, projectKeys, teamKeys }. Passing it through unmapped (the Terraform stack re-mapped three snake_case fields and silently dropped the rest) is what makes projectKeys/teamKeys routing reachable from this stack.')
param cyrusRepositories array = []

////////////////////////////////////////////////////////////////////////////////
// Optional feature flags
////////////////////////////////////////////////////////////////////////////////

@description('When true, provisions an Azure Container Registry, grants both the router identity and the sandbox-group identity AcrPull, and configures the router Container App registry identity. Not needed for anonymous public registries.')
param enableAcr bool = false

@description('Optional custom domains bound to the router ingress, passed straight into configuration.ingress.customDomains. Each entry is { name, certificateId, bindingType }. Certificate issuance and DNS validation happen out of band; supply the resulting certificate resource id. Leave EMPTY unless you need a branded hostname — the default *.azurecontainerapps.io FQDN is stable and fine for webhooks and WSS. Because ARM owns the whole ingress object, a hostname added out of band with `az containerapp hostname add` is REMOVED by the next deployment; list it here instead.')
param routerCustomDomains array = []

@description('Optional Entra tenant id used to validate router enrollment tokens. Must be set together with entraAudience; leave both empty to disable Entra-gated enrollment.')
param entraTenantId string = ''

@description('Optional exact Entra token audience (the router app registration\'s Application ID URI). Must be set together with entraTenantId.')
param entraAudience string = ''

@description('Optional email domain allowed to enroll when Entra authentication is enabled (for example \'example.com\').')
param entraAllowedDomain string = ''

////////////////////////////////////////////////////////////////////////////////
// Setup management UI (/setup) — STAGED ROLLOUT (D7)
//
// Reaching a live `/setup` takes TWO separate deployments, and that is the
// security property, not an inconvenience:
//
//   Stage 1   enableSetupAuth = true
//             → Entra client secret, ACA built-in auth (EasyAuth) sidecar,
//               token store. `/setup` still 404s, so there is nothing to
//               impersonate.
//
//   ┌── GATE ─────────────────────────────────────────────────────────────────┐
//   │ Run the README §11 step 5 checks against the LIVE app, then record the  │
//   │ result in setupAuthStage1Verified.                                     │
//   │                                                                        │
//   │ WHERE THE ORDERING IS ENFORCED HAS MOVED. Terraform proved it at plan   │
//   │ time with a data source that read the deployed authConfigs child out of │
//   │ Azure. Bicep has no plan phase and no equivalent read, so the           │
//   │ equivalent live check now runs in scripts/deploy-azure.sh, which calls  │
//   │ `az containerapp auth show` and REFUSES a stage-2 deployment until the  │
//   │ auth child exists AND reports platform.enabled and                     │
//   │ identityProviders.azureActiveDirectory.enabled. That is the same class  │
//   │ of evidence — a question answered by ARM about real remote state, not a │
//   │ boolean an operator typed. Its weakness is different: it can be         │
//   │ bypassed by invoking `az deployment sub create` directly. Do not.       │
//   └────────────────────────────────────────────────────────────────────────┘
//
//   Stage 2   enableSetupUi = true
//             → CYRUS_ROUTER_SETUP_UI_* env vars, which is what makes the
//               router register the routes.
//
// Why not one flag: `authConfigs` is a CHILD of the Container App. ARM must
// create the app — and therefore publish the revision that serves /setup —
// before it can attach the auth sidecar. A single flag guarantees a window in
// which an unauthenticated /setup is on the public internet, and no post-deploy
// check can close a window that opens mid-deployment.
//
// Rollback reverses the order: clear enableSetupUi, deploy, confirm /setup
// 404s, and only then clear enableSetupAuth.
////////////////////////////////////////////////////////////////////////////////

@description('STAGE 1 of the staged /setup rollout. Attaches the ACA built-in auth (EasyAuth) sidecar to the router Container App: seeds the Entra client secret into Key Vault, creates the token-store blob container + SAS, and creates the authConfigs child. Does NOT enable any /setup route — that is enableSetupUi, deployed separately AFTER the live verification gate. Deploy this ALONE first.')
param enableSetupAuth bool = false

@description('Client id (bare GUID) of the EXISTING router Entra app registration, reused by the auth sidecar. Required when enableSetupAuth is true. This is also the audience of the ID token the sidecar forwards — distinct from entraAudience, which is the api://<client-id> Application ID URI carried by ACCESS tokens on /enroll.')
param setupUiClientId string = ''

@description('Client secret for setupUiClientId, generated with `az ad app credential reset`. Seeded into Key Vault secret \'setup-ui-client-secret\' and referenced by the Container App as a secret; never emitted as an output. Rotate in Entra first, then `az keyvault secret set` — the Container App references it by versionless URI, so a rotation reaches the sidecar on the next revision without a deployment.')
@secure()
param setupUiClientSecret string = ''

@description('RFC 3339 UTC start of the token-store SAS window (for example \'2026-01-01T00:00:00Z\'). Required when enableSetupAuth is true. Static by design: a value derived from utcNow() would produce a different SAS — and therefore a new Key Vault secret version and a new router revision — on every deployment.')
param setupUiTokenStoreSasStart string = ''

@description('RFC 3339 UTC expiry of the token-store SAS window (for example \'2027-01-01T00:00:00Z\'). Required when enableSetupAuth is true. EXPIRY IS A LIVE FAILURE: once past, the sidecar can no longer persist sessions and sign-in breaks. Diarise the renewal — bump this value and deploy.')
param setupUiTokenStoreSasExpiry string = ''

@description('Entra GROUP object ids allowed to authenticate to the app, rendered into authConfigs defaultAuthorizationPolicy.allowedPrincipals.groups. Empty (the default) sends no policy at all — an empty policy is not the same as an absent one, so do not read [] as "deny everyone".')
param setupUiAllowedGroupObjectIds array = []

@description('Entra USER/service-principal object ids allowed to authenticate to the app, rendered into authConfigs defaultAuthorizationPolicy.allowedPrincipals.identities. Prefer setupUiAllowedGroupObjectIds — a group is one policy edit instead of a deployment per joiner/leaver.')
param setupUiAllowedPrincipalObjectIds array = []

@description('ATTESTATION, not a switch. Records that a human ran the README §11 step 5 behavioural checks against the live app: (a) machine routes — /healthz, /linear-webhook, and a worker WSS reconnect — still work and do NOT 302 to /.auth/login/aad; and (b) sign-in through /.auth/login/aad succeeds while /setup still 404s. Paste the command output into the change record. The ordering itself is enforced by scripts/deploy-azure.sh against live Azure, not by this flag.')
param setupAuthStage1Verified bool = false

@description('STAGE 2 of the staged /setup rollout. Sets the CYRUS_ROUTER_SETUP_UI_* environment variables, which is what makes the router register the /setup* routes. Deploy this ONLY in a separate, later deployment, after enableSetupAuth is live and verified. Rolling back is safe and comes FIRST in a rollback: clear this, deploy, confirm /setup 404s, then clear enableSetupAuth.')
param enableSetupUi bool = false

@description('How the router establishes identity on /setup*. This stack allows ONLY \'entra-token\', which cryptographically verifies the ID token the sidecar forwards in X-MS-TOKEN-AAD-ID-TOKEN and therefore ignores a forged X-MS-CLIENT-PRINCIPAL-* header regardless of ingress topology. The router also implements \'easyauth-headers\', but its trust boundary is the proxy topology in front of the process — a property of the deployed ingress that THIS TEMPLATE CANNOT VERIFY — so it is refused here. The parameter is kept (rather than hardcoded) so that adding a second cryptographically verifiable mode later is a one-line change.')
@allowed([
  'entra-token'
])
param setupUiAuthMode string = 'entra-token'

@description('Override for the expected `aud` of the ID token verified in \'entra-token\' mode. Empty means setupUiClientId, which is correct for Entra: an ID token carries the BARE CLIENT-ID GUID, not the api://<client-id> Application ID URI in entraAudience (that is the access-token audience).')
param setupUiIdTokenAudience string = ''

@description('Optional email domain allowlist enforced IN THE ROUTER on /setup* (for example \'example.com\'). Defence in depth on top of the app registration\'s own assignment requirement, not a substitute for it: a domain check cannot distinguish an assigned teammate from any other account in the same tenant.')
param setupUiAllowedDomain string = ''

@description('Create a router user record on a teammate\'s first successful /setup sign-in. Defaults FALSE. What it grants is narrow — a user row and an EMPTY secret record, no credentials — but it turns "can obtain a token for this app" into "is a Cyrus user", which is only safe when app membership is actually restricted. Enabling it therefore REQUIRES either an authConfigs allowedPrincipals policy (setupUiAllowedGroupObjectIds / setupUiAllowedPrincipalObjectIds) or an attested Entra assignment requirement (setupUiAssignmentRequiredVerified).')
param setupUiAutoProvisionUsers bool = false

@description('ATTESTATION that the app registration\'s service principal has appRoleAssignmentRequired = true AND the Cyrus users group is actually assigned to it — BOTH, verified with the `az ad sp show` / `az rest` readback in README §11 step 3. Setting appRoleAssignmentRequired without performing the assignment locks everyone out; performing the assignment without setting the flag restricts nobody.')
param setupUiAssignmentRequiredVerified bool = false

////////////////////////////////////////////////////////////////////////////////
// Per-user secret storage backend (D6')
//
// TWO SEPARATE CONTROLS, and conflating them is the mistake to avoid:
//
//   enableSetupSecretStore  — CREATE the Table, the KEK and the two role
//                             assignments.
//   enableSetupTableBackend — SELECT the Table as the router's secret backend
//                             by rendering `containers.tableStore`.
//
// DELETING IS NOT A FLAG, AND NO LONGER NEEDS TO BE REFUSED. Under Terraform
// these two carried `prevent_destroy` and the creation flag was one-way: turning
// it back off produced a hard plan error, because otherwise it would have
// destroyed the only key that can unwrap every stored per-user secret. ARM
// incremental deployments do not delete a resource that leaves the template, so
// clearing enableSetupSecretStore simply stops managing the Table and the KEK —
// they keep existing, keep their data, and can be re-adopted by setting the flag
// again. Nothing to refuse, nothing to state-rm.
//
// The corollary is the one new footgun: `--mode Complete` WOULD delete them.
// Never use it. Deliberate removal is `az keyvault key delete` /
// `az storage table delete` after the export-and-verify runbook in
// README → "Decommissioning the per-user secret store".
////////////////////////////////////////////////////////////////////////////////

@description('CREATE the per-user secret storage infrastructure: the Azure Table, the envelope-encryption KEK, and the router\'s Storage Table Data Contributor + Key Vault Crypto User role assignments. Default FALSE so a deployment that wants neither the setup UI nor the Table backend creates nothing and needs no key permissions on the vault. Clearing it later does NOT delete the Table or the KEK (see the block comment above).')
param enableSetupSecretStore bool = false

@description('SELECT the Azure Table secret backend by adding containers.tableStore to CYRUS_ROUTER_CONTAINERS_JSON. This is the reversible control over the feature: clearing it drops the router back to the Key Vault backend on the next revision, with no deletion and no data loss. Enable it only AFTER enableSetupSecretStore has been deployed AND `cyrus router secrets migrate` has run and been verified.')
param enableSetupTableBackend bool = false

@description('Provider that users whose stored executor is the explicit {"type":"default"} sentinel inherit, rendered as containers.defaultExecutor. EMPTY omits the field entirely: a non-empty default would change CYRUS_ROUTER_CONTAINERS_JSON — and so roll the single router replica — on every existing stack that never asked for the setting. Set \'aca\' to opt in. SAFE BY CONSTRUCTION even then: a null/absent stored executor still means "physical device" and is never captured by this default (F11).')
@allowed([
  ''
  'aca'
  'docker'
])
param routerDefaultExecutor string = ''

////////////////////////////////////////////////////////////////////////////////
// Monitoring
////////////////////////////////////////////////////////////////////////////////

@description('Create the Azure Monitor scheduled-query alert rules over the router\'s JSON log stream (long-running sandbox, stalled lifecycle sweep, sandbox boot failures). Defaults TRUE: these resources touch nothing the router reads, so enabling them cannot roll the single router replica. The saved KQL searches are created regardless of this flag; they are free and evaluate nothing until an operator opens them.')
param enableMonitoringAlerts bool = true

@description('Email addresses to notify when an alert rule fires. Empty (the default) still creates the alert rules and still records fired alerts in Azure Monitor — it just creates no action group, so nothing is emailed.')
param alertEmailReceivers array = []

@description('Continuous-uptime threshold, in hours, for the long-running-sandbox alert. Measured from devices.running_since_ms (the current run), NOT the device row\'s age, so a sandbox that has been idle-stopped and resumed repeatedly never accumulates toward it. The default of 6 is calibrated against idleStopMs (5 minutes): a sandbox only reaches six continuous hours by holding session affinity for essentially that whole period.')
@minValue(1)
param sandboxUptimeAlertHours int = 6

@description('Ship the router\'s ILogger output to the existing Log Analytics workspace over OTLP, in addition to its JSON stdout stream. Creates a workspace-based Application Insights component as the ingestion endpoint and sets CYRUS_OTEL_LOGS_ENABLED plus APPLICATIONINSIGHTS_CONNECTION_STRING on the router app. Defaults TRUE because this is additive telemetry, though changing it rolls the single router replica. Records land in AppTraces, not ContainerAppConsoleLogs_CL.')
param enableOtelLogs bool = true

@description('Minimum level exported over OTLP. Independent of CYRUS_LOG_LEVEL, which governs only container stdout; this controls billed export volume. Named event() records bypass the threshold by contract.')
@allowed([
  'DEBUG'
  'INFO'
  'WARN'
  'ERROR'
  'SILENT'
])
param otelLogsLevel string = 'INFO'

////////////////////////////////////////////////////////////////////////////////
// Naming
////////////////////////////////////////////////////////////////////////////////

var namePrefix = '${project}-${environment}'
var flatNamePrefix = replace(namePrefix, '-', '')
var effectiveResourceGroupName = empty(resourceGroupName) ? 'rg-${namePrefix}' : resourceGroupName
var routerAppName = 'app-${namePrefix}-router'
var sandboxGroupName = '${namePrefix}-sandbox-grp'

////////////////////////////////////////////////////////////////////////////////
// Immutable-image-ref shape check (positive allowlist — see the block comment
// above routerImage)
//
// Every intermediate is written as a ternary rather than `&&`, because ARM's
// `if()` is documented to evaluate only the branch it returns while its `and()`
// makes no such promise — and `substring()` on an empty string is a hard error,
// not a false.
////////////////////////////////////////////////////////////////////////////////

var digestDelimiter = '@sha256:'

// routerImage
var routerDigestParts = split(routerImage, digestDelimiter)
var routerIsDigest = length(routerDigestParts) == 2 ? length(routerDigestParts[1]) == 64 : false
var routerLastSegment = last(split(routerImage, '/'))
var routerTag = contains(routerLastSegment, ':') ? last(split(routerLastSegment, ':')) : ''
// `sha-` + 7..40 characters.
var routerIsShaTag = startsWith(routerTag, 'sha-') ? (length(routerTag) >= 11 ? length(routerTag) <= 44 : false) : false
var routerSemverBody = startsWith(routerTag, 'v') ? skip(routerTag, 1) : routerTag
var routerSemverParts = split(routerSemverBody, '.')
var routerIsSemver = length(routerSemverParts) >= 3 ? (empty(routerSemverParts[0]) || empty(routerSemverParts[1]) ? false : contains('0123456789', substring(routerSemverParts[0], 0, 1)) && contains('0123456789', substring(routerSemverParts[1], 0, 1))) : false
var routerImageIsImmutable = routerIsDigest || routerIsShaTag || routerIsSemver

// workerImage
var workerDigestParts = split(workerImage, digestDelimiter)
var workerIsDigest = length(workerDigestParts) == 2 ? length(workerDigestParts[1]) == 64 : false
var workerLastSegment = last(split(workerImage, '/'))
var workerTag = contains(workerLastSegment, ':') ? last(split(workerLastSegment, ':')) : ''
var workerIsShaTag = startsWith(workerTag, 'sha-') ? (length(workerTag) >= 11 ? length(workerTag) <= 44 : false) : false
var workerSemverBody = startsWith(workerTag, 'v') ? skip(workerTag, 1) : workerTag
var workerSemverParts = split(workerSemverBody, '.')
var workerIsSemver = length(workerSemverParts) >= 3 ? (empty(workerSemverParts[0]) || empty(workerSemverParts[1]) ? false : contains('0123456789', substring(workerSemverParts[0], 0, 1)) && contains('0123456789', substring(workerSemverParts[1], 0, 1))) : false
var workerImageIsImmutable = workerIsDigest || workerIsShaTag || workerIsSemver

////////////////////////////////////////////////////////////////////////////////
// Cross-parameter invariants
//
// Bicep's decorators (@allowed, @minValue, @minLength) cover single-parameter
// constraints, and every one of them above is expressed that way. They cannot
// express a rule that spans two parameters, which is what most of the
// interesting rules in this stack are.
//
// So the rules are collected into `parameterViolations` and enforced by
// `parameterGuard`, whose only trick is that indexing an object with a key it
// does not have is a hard template error. When every rule holds, the index is
// 'valid' and the guard is an empty object; when one is violated, the index is
// the violation TEXT, ARM fails to resolve it, and the deployment stops with
// that text in the error — before a single resource is touched.
//
// The guard is folded into `defaultTags`, which every resource consumes. That is
// load-bearing: a variable nothing reads is not guaranteed to be evaluated, and
// a validation that might not run is not a validation. `union(x, {})` is `x`, so
// it contributes nothing to the tags themselves.
//
// The alternative — an `assert` statement — pushes the emitted template onto ARM
// language version 2.1-experimental, which the Bicep compiler itself warns not
// to use in production. This idiom compiles to plain 2019-04-01 ARM.
////////////////////////////////////////////////////////////////////////////////

var setupUiAllowedPrincipalsConfigured = !empty(setupUiAllowedGroupObjectIds) || !empty(setupUiAllowedPrincipalObjectIds)

var parameterViolations = concat(
  allowMutableImageTags || routerImageIsImmutable ? [] : ['routerImage must be pinned to an immutable reference: a digest (repo@sha256:<64 hex>), a release tag (repo:v1.2.3), or a git-SHA tag (repo:sha-a1b2c3d). Mutable tags such as :latest, :deploy, or a branch/hotfix tag let the next deployment silently change the deployed build. Build and push an immutable tag first (README step 4), or set allowMutableImageTags=true for a throwaway stack.'],
  allowMutableImageTags || workerImageIsImmutable ? [] : ['workerImage must be pinned to an immutable reference: a digest, a release tag, or a sha- git-SHA tag. Mutable tags make the registered ACA disk image untraceable to a build.'],
  (empty(entraTenantId) && empty(entraAudience) && empty(entraAllowedDomain)) || (!empty(entraTenantId) && !empty(entraAudience)) ? [] : ['entraTenantId and entraAudience must both be set to enable Entra enrollment, and entraAllowedDomain may only be set when they are.'],
  !enableSetupAuth || (!empty(setupUiClientId) && !empty(setupUiClientSecret)) ? [] : ['enableSetupAuth requires setupUiClientId and setupUiClientSecret. Create them on the EXISTING router app registration (README section 11 step 2) rather than minting a second one — one app registration/audience per router deployment is a standing invariant.'],
  !enableSetupAuth || !empty(entraTenantId) ? [] : ['enableSetupAuth requires entraTenantId: the sidecar openIdIssuer is the tenant\'s v2.0 OIDC endpoint on the cloud login authority. Setting entraTenantId also requires entraAudience, which is intended — the same app registration serves both /enroll access tokens and /setup sign-in.'],
  !enableSetupAuth || (!empty(setupUiTokenStoreSasStart) && !empty(setupUiTokenStoreSasExpiry)) ? [] : ['enableSetupAuth requires setupUiTokenStoreSasStart and setupUiTokenStoreSasExpiry. Microsoft.App/containerApps/authConfigs@2024-03-01 models the token store as a SAS URL only, so the SAS window is explicit operator input.'],
  !enableSetupUi || enableSetupAuth ? [] : ['enableSetupUi requires enableSetupAuth. Enabling the routes without the auth sidecar publishes an unauthenticated /setup.'],
  !enableSetupUi || setupAuthStage1Verified ? [] : ['enableSetupUi requires setupAuthStage1Verified=true. Stage 1 must be deployed on its own and verified live (README section 11 step 5) BEFORE the routes exist.'],
  !enableSetupUi || setupUiAuthMode != 'entra-token' || !empty(setupUiIdTokenAudience) || !empty(setupUiClientId) ? [] : ['setupUiAuthMode=entra-token needs an ID token audience: set setupUiClientId (the audience defaults to it) or override setupUiIdTokenAudience explicitly.'],
  !enableSetupTableBackend || enableSetupSecretStore ? [] : ['enableSetupTableBackend requires enableSetupSecretStore=true. The selector points the router at a Table and a KEK that the creation flag provisions; without it the rendered config would name resources that do not exist.'],
  !setupUiAutoProvisionUsers || setupUiAllowedPrincipalsConfigured || setupUiAssignmentRequiredVerified ? [] : ['setupUiAutoProvisionUsers=true requires a membership gate: populate setupUiAllowedGroupObjectIds / setupUiAllowedPrincipalObjectIds, or perform the Entra assignment steps in README section 11 step 3 and set setupUiAssignmentRequiredVerified=true. By default ANY account in the tenant can obtain a token for the app, and setupUiAllowedDomain cannot tell an assigned teammate from any other account in the same tenant.']
)

var parameterGuard = { valid: {} }[empty(parameterViolations) ? 'valid' : parameterViolations[0]]

var defaultTags = union(
  {
    'cyrus-managed': 'true'
    environment: environment
    project: project
  },
  tags,
  parameterGuard
)

////////////////////////////////////////////////////////////////////////////////
// Resource group
////////////////////////////////////////////////////////////////////////////////

resource rg 'Microsoft.Resources/resourceGroups@2021-04-01' = {
  name: effectiveResourceGroupName
  location: location
  tags: defaultTags
}

////////////////////////////////////////////////////////////////////////////////
// Foundation: Log Analytics, Key Vault + seed secrets, identity, storage,
// Container Apps environment, optional ACR, RBAC, optional per-user secret store
////////////////////////////////////////////////////////////////////////////////

module foundation 'modules/foundation.bicep' = {
  scope: rg
  name: 'cyrus-foundation'
  params: {
    namePrefix: namePrefix
    flatNamePrefix: flatNamePrefix
    location: location
    tags: defaultTags
    enableAcr: enableAcr
    operatorPrincipalId: operatorPrincipalId
    linearWorkspaceId: linearWorkspaceId
    linearWorkspaceToken: linearWorkspaceToken
    linearWorkspaceRefreshToken: linearWorkspaceRefreshToken
    linearWebhookSecret: linearWebhookSecret
    linearClientId: linearClientId
    linearClientSecret: linearClientSecret
    enableSetupAuth: enableSetupAuth
    setupUiClientSecret: setupUiClientSecret
    setupUiTokenStoreSasStart: setupUiTokenStoreSasStart
    setupUiTokenStoreSasExpiry: setupUiTokenStoreSasExpiry
    enableSetupSecretStore: enableSetupSecretStore
  }
}

////////////////////////////////////////////////////////////////////////////////
// ACA sandbox group + its RBAC
////////////////////////////////////////////////////////////////////////////////

module sandboxGroup 'modules/sandbox-group.bicep' = {
  scope: rg
  name: 'cyrus-sandbox-group'
  params: {
    name: sandboxGroupName
    location: location
    tags: defaultTags
    routerPrincipalId: foundation.outputs.routerPrincipalId
    dataOwnerRoleDefinitionId: sandboxGroupDataOwnerRoleId
    acrName: enableAcr ? foundation.outputs.acrName : ''
  }
}

////////////////////////////////////////////////////////////////////////////////
// Router config (CYRUS_ROUTER_CONTAINERS_JSON)
//
// The COMPLETE paste-ready value, not a fragment — exported unredacted as the
// `cyrusRouterContainersJson` output (it holds no secret: image refs, routing
// config, and resource names only).
//
// Optional fields are merged in with `union` rather than written inline with a
// null, because `cyrus router start` re-parses this through a Zod schema that
// rejects an explicit null where it accepts an absent key — a literal
// `"tableStore": null` would fail startup.
////////////////////////////////////////////////////////////////////////////////

// `<app>.<managedEnvironment.defaultDomain>` is the ingress FQDN of an
// external-ingress Container App. The environment is a separate resource from
// the app, so deriving the URL this way is not self-referential — which is what
// retires the Terraform stack's two-apply routerUrlForContainers dance.
var routerFqdn = '${routerAppName}.${foundation.outputs.containerAppsEnvironmentDefaultDomain}'
var routerWssUrl = 'wss://${routerFqdn}'
var effectiveRouterUrlForContainers = empty(routerUrlForContainers) ? routerWssUrl : routerUrlForContainers

var backupBlobUrl = 'https://${foundation.outputs.storageAccountName}.blob.${az.environment().suffixes.storage}/${foundation.outputs.routerBackupsContainerName}'

var acaEgress = union(
  {
    defaultAction: acaEgressDefaultAction
    trafficInspection: acaEgressTrafficInspection
  },
  empty(acaEgressHostRules) ? {} : { hostRules: acaEgressHostRules }
)

var routerContainersConfig = union(
  {
    image: workerImage
    routerUrlForContainers: effectiveRouterUrlForContainers
    repositories: cyrusRepositories
    keyVaultUrl: foundation.outputs.keyVaultUri
    artifactsDir: '/data/artifacts'
    // Stated explicitly rather than left to the router's default: this is the
    // knob that bounds idle sandbox cost, so the deployed value should be
    // visible here rather than tracking whatever the image happens to default
    // to. The router's sweep is affinity-aware and park-aware, so this never
    // suspends a session that is working or has background work in flight.
    idleStopMs: idleStopMs
    aca: {
      subscriptionId: subscription().subscriptionId
      resourceGroup: effectiveResourceGroupName
      sandboxGroup: sandboxGroupName
      region: location
      disk: acaDiskName
      cpu: acaCpu
      memory: acaMemory
      autoSuspendSeconds: acaAutoSuspendSeconds
      egress: acaEgress
      keepSnapshots: acaKeepSnapshots
      disconnectedRecreateMs: acaDisconnectedRecreateMs
      // The authoritative data-plane host is the ARM-emitted
      // properties.managementEndpoint; the router config prefers this over the
      // client's region+baseUrl fallback.
      managementEndpoint: sandboxGroup.outputs.managementEndpoint
    }
    // The router's blob backup target (router.db). Plain URL — auth comes from
    // the router identity's Storage Blob Data Contributor role assignment.
    backupBlobUrl: backupBlobUrl
  },
  empty(routerDefaultExecutor) ? {} : { defaultExecutor: routerDefaultExecutor },
  enableSetupTableBackend
    ? {
        tableStore: {
          endpoint: foundation.outputs.tableEndpoint
          tableName: foundation.outputs.setupTableName
          // VERSIONED key id. Each record stores the bare version segment it was
          // wrapped with and unwraps against that version; vault and key name
          // are taken exclusively from this configured value and never from
          // anything a row supplies (D4').
          keyId: foundation.outputs.setupKekVersionedKeyId
        }
      }
    : {}
)

////////////////////////////////////////////////////////////////////////////////
// Router Container App
////////////////////////////////////////////////////////////////////////////////

module routerApp 'modules/router-app.bicep' = {
  scope: rg
  name: 'cyrus-router-app'
  params: {
    routerAppName: routerAppName
    location: location
    tags: defaultTags
    routerImage: routerImage
    containerAppsEnvironmentId: foundation.outputs.containerAppsEnvironmentId
    artifactsStorageName: foundation.outputs.containerAppsEnvironmentStorageName
    routerIdentityId: foundation.outputs.routerIdentityId
    routerIdentityClientId: foundation.outputs.routerIdentityClientId
    keyVaultUri: foundation.outputs.keyVaultUri
    linearWorkspaceId: linearWorkspaceId
    routerContainersJson: string(routerContainersConfig)
    backupBlobUrl: backupBlobUrl
    acrLoginServer: enableAcr ? foundation.outputs.acrLoginServer : ''
    customDomains: routerCustomDomains
    entraTenantId: entraTenantId
    entraAudience: entraAudience
    entraAllowedDomain: entraAllowedDomain
    enableSetupAuth: enableSetupAuth
    enableSetupUi: enableSetupUi
    setupUiAuthMode: setupUiAuthMode
    setupUiIdTokenAudience: empty(setupUiIdTokenAudience) ? setupUiClientId : setupUiIdTokenAudience
    setupUiAllowedDomain: setupUiAllowedDomain
    setupUiAutoProvisionUsers: setupUiAutoProvisionUsers
    enableOtelLogs: enableOtelLogs
    otelLogsLevel: otelLogsLevel
    deploymentEnvironment: environment
    applicationInsightsConnectionString: monitoring.outputs.applicationInsightsConnectionString
  }
  // ACA resolves Key Vault secret references while creating the revision, so
  // both vault role grants must exist first; the Table backend needs its two
  // grants at RUNTIME and neither is implied by a reference in the app. No
  // explicit dependsOn is needed for either: this module consumes foundation
  // outputs, and a module is not complete until every resource in it — including
  // all five role assignments — has been created. Azure RBAC PROPAGATION is a
  // separate matter and can still require a retry; see README.
}

////////////////////////////////////////////////////////////////////////////////
// STAGE 1 — the authConfigs child
//
// A separate module rather than a resource in router-app.bicep so the
// dependency direction is unambiguous: the sidecar resolves
// clientSecretSettingName / sasUrlSettingName against the app's `secrets`
// collection, so the app must exist first. The app does NOT depend on this
// resource — and that asymmetry is exactly why D7 needs two deployments rather
// than one.
////////////////////////////////////////////////////////////////////////////////

module routerAuth 'modules/router-auth.bicep' = if (enableSetupAuth) {
  scope: rg
  name: 'cyrus-router-auth'
  params: {
    routerAppName: routerAppName
    routerFqdn: routerFqdn
    entraTenantId: entraTenantId
    setupUiClientId: setupUiClientId
    entraAudience: entraAudience
    allowedGroupObjectIds: setupUiAllowedGroupObjectIds
    allowedPrincipalObjectIds: setupUiAllowedPrincipalObjectIds
  }
  dependsOn: [
    routerApp
  ]
}

////////////////////////////////////////////////////////////////////////////////
// Monitoring
////////////////////////////////////////////////////////////////////////////////

module monitoring 'modules/monitoring.bicep' = {
  scope: rg
  name: 'cyrus-monitoring'
  params: {
    namePrefix: namePrefix
    flatNamePrefix: flatNamePrefix
    location: location
    tags: defaultTags
    logAnalyticsWorkspaceName: foundation.outputs.logAnalyticsWorkspaceName
    routerAppName: routerAppName
    enableAlerts: enableMonitoringAlerts
    alertEmailReceivers: alertEmailReceivers
    sandboxUptimeAlertHours: sandboxUptimeAlertHours
    enableOtelLogs: enableOtelLogs
  }
}

////////////////////////////////////////////////////////////////////////////////
// Outputs — complete, paste-ready values, not fragments
////////////////////////////////////////////////////////////////////////////////

@description('Name of the resource group containing every regional resource.')
output resourceGroupName string = effectiveResourceGroupName

@description('Public ingress FQDN of the router Container App. Use this verbatim in your Linear webhook URL (https://<fqdn>/linear-webhook) and as the public WSS host.')
output routerFqdn string = routerApp.outputs.fqdn

@description('Name of the router Container App. Needed by the image-tag reconciliation runbook to read the image the live revision is actually serving and compare it against routerImage.')
output routerAppName string = routerAppName

@description('The router image reference this stack is pinned to (echo of the routerImage parameter). Surfaced so an operator can diff the declared pin against the image the live revision serves without opening the parameter file — a mismatch means someone hand-patched the Container App and the next deployment will revert it.')
output routerImageRef string = routerImage

@description('Canonical WSS URL for containers to dial back to the router. Embedded into CYRUS_ROUTER_CONTAINERS_JSON.')
output routerWssUrl string = routerWssUrl

@description('Name of the router Key Vault. Operators set/rotate secrets here via `az keyvault secret set` or `az containerapp exec`.')
output keyVaultName string = foundation.outputs.keyVaultName

@description('Name of the ACA sandbox group. Use with the `aca` CLI: `aca sandboxgroup show --name <this>`.')
output sandboxGroupName string = sandboxGroupName

@description('ARM-emitted regional data-plane host for the sandbox group (properties.managementEndpoint). The ACA provider config prefers this over the client\'s region+baseUrl fallback.')
output managementEndpoint string = sandboxGroup.outputs.managementEndpoint

@description('Container URL the router uploads router.db backups to. Storage Blob Data Contributor is granted both to the router identity and (optionally) the operator principal.')
output cyrusRouterBackupBlobUrl string = backupBlobUrl

@description('COMPLETE render of CYRUS_ROUTER_CONTAINERS_JSON (paste-ready). Contains no secret — image refs, router WSS URL, repository routing, the full `aca` block, keyVaultUrl, artifactsDir, backupBlobUrl.')
output cyrusRouterContainersJson string = string(routerContainersConfig)

@description('Principal id of the router\'s user-assigned managed identity. Useful for ad-hoc role grants during ops.')
output routerIdentityPrincipalId string = foundation.outputs.routerPrincipalId

@description('Principal id of the sandbox group\'s system-assigned identity. Grant this AcrPull on a private registry to use a private worker image.')
output sandboxGroupIdentityPrincipalId string = sandboxGroup.outputs.principalId

@description('Login server of the optional Azure Container Registry, or empty when enableAcr is false.')
output acrLoginServer string = enableAcr ? foundation.outputs.acrLoginServer : ''

// Three URLs, deliberately gated on DIFFERENT flags, so the outputs show which
// stage of the D7 rollout the stack is in:
//   redirect URI  always      — needed to configure Entra BEFORE stage 1
//   sign-in URL   stage 1     — provable sign-in while /setup still 404s
//   /setup URL    stage 2     — the routes exist
// A stack showing a sign-in URL but no /setup URL is mid-rollout and correct.

@description('The web redirect URI to register on the router Entra app registration for EasyAuth sign-in. Emitted unconditionally because it must be configured BEFORE enableSetupAuth is deployed. `az ad app update --web-redirect-uris` REPLACES the whole list, so re-send the existing URIs alongside this one or you will break enrollment sign-in.')
output setupUiRedirectUri string = 'https://${routerFqdn}/.auth/login/aad/callback'

@description('Entra sign-in entry point served by the ACA built-in auth sidecar. Non-empty once STAGE 1 (enableSetupAuth) is deployed — which is what lets you prove sign-in works while /setup still returns 404. /.auth/logout ends the session; both endpoints are handled entirely by the sidecar.')
output setupUiSignInUrl string = enableSetupAuth ? 'https://${routerFqdn}/.auth/login/aad' : ''

@description('Where teammates manage their own container environment variables. Non-empty only after STAGE 2 (enableSetupUi) is deployed.')
output setupUiUrl string = enableSetupUi ? 'https://${routerFqdn}/setup' : ''

@description('Name of the Azure Table holding one envelope-encrypted record per user. Empty unless enableSetupSecretStore is true.')
output setupTableName string = enableSetupSecretStore ? foundation.outputs.setupTableName : ''

@description('Table service endpoint of the storage account holding the per-user secret records, exactly as rendered into containers.tableStore.endpoint. Empty unless enableSetupSecretStore is true. Needed by `cyrus router secrets migrate --to-endpoint`, which names its target explicitly so the copy can run BEFORE enableSetupTableBackend points the router at the Table.')
output setupTableEndpoint string = enableSetupSecretStore ? foundation.outputs.tableEndpoint : ''

@description('VERSIONED Key Vault key id of the envelope-encryption KEK, exactly as rendered into containers.tableStore.keyId. Empty unless enableSetupSecretStore is true. Not a secret — it names a public key handle. Records pin the version segment they were wrapped with, so old versions must stay ENABLED until a re-wrap pass has run.')
output setupKekVersionedKeyId string = enableSetupSecretStore ? foundation.outputs.setupKekVersionedKeyId : ''

@description('Name of the workspace-based Application Insights component used as the router\'s OTLP endpoint. Empty when enableOtelLogs is false.')
output otelLogsApplicationInsightsName string = monitoring.outputs.applicationInsightsName

@description('The single Log Analytics workspace receiving both router stdout in ContainerAppConsoleLogs_CL and OTLP records in AppTraces.')
output logAnalyticsWorkspaceName string = foundation.outputs.logAnalyticsWorkspaceName

@description('Paste-ready KQL for the router\'s OTLP stream. Empty when enableOtelLogs is false.')
output otelLogsQuery string = enableOtelLogs
  ? join([
      'AppTraces'
      '| where AppRoleName == "${routerAppName}" or AppRoleName == "cyrus-router"'
      '| extend component = tostring(Properties.component), event = tostring(Properties.event)'
      '| project TimeGenerated, SeverityLevel, component, event, Message, Properties'
      '| order by TimeGenerated desc'
    ], '\n')
  : ''
