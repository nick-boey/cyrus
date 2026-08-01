################################################################################
# Project / naming
################################################################################

variable "project" {
  description = "Short project prefix used as the name root for every resource (e.g. 'cyrus'). Must be lowercase, start with a letter, and be unique within the subscription."
  type        = string
}

variable "environment" {
  description = "Deployment environment suffix appended to resource names (e.g. 'dev', 'prod'). Defaults to 'dev'."
  type        = string
  default     = "dev"
}

variable "resource_group_name" {
  description = "Optional exact resource group name. Defaults to rg-<project>-<environment>."
  type        = string
  default     = null
}

variable "tags" {
  description = "Azure resource tags applied to every resource. Merged with a `cyrus-managed=true` tag."
  type        = map(string)
  default     = {}
}

################################################################################
# Location
################################################################################

variable "location" {
  description = "Azure region for every regional resource. ACA sandbox groups are supported in 35 regions (spike S7); the spike-verified default for this tenant is 'australiaeast'."
  type        = string
  default     = "australiaeast"
}

################################################################################
# Container images
#
# DURABLE-ENVIRONMENT RULE: both image inputs below must be pinned to an
# IMMUTABLE reference — a digest (`@sha256:<64 hex>`), a release tag (`v1.2.3`),
# or a git-SHA tag (`sha-a1b2c3d`). A mutable/floating tag (`:latest`,
# `:deploy`, a branch name, or an ad-hoc hotfix tag such as
# `:deploy-aca-disk-fix`) does NOT identify a build: the registry can re-point it
# at any time, so the next `terraform apply` can silently roll a running router
# BACKWARDS onto an older image while Terraform reports no change (the tag string
# in state is identical). That is exactly how the private-disk fix nearly got
# lost — the live Container App ran `:deploy-aca-disk-fix` while dev.tfvars said
# `:deploy`.
#
# `.github/workflows/docker-router.yml` publishes `sha-<short-sha>` on every
# push and `v<semver>` on every release tag precisely so there is always an
# immutable ref to pin. See README → "Router image tag policy".
################################################################################

variable "router_image" {
  description = "Fully-qualified container image for the router, pinned to an IMMUTABLE reference — a digest ('ghcr.io/ceedaragents/cyrus-router@sha256:<64 hex>'), a release tag ('…/cyrus-router:v1.2.3'), or a git-SHA tag ('…/cyrus-router:sha-a1b2c3d'). Mutable tags (':latest', ':deploy', any branch or ad-hoc hotfix tag) are REJECTED, because the next apply would silently redeploy whatever that tag points at then — set `allow_mutable_image_tags = true` to override in a throwaway stack. Pullable anonymously or, for private registries, via the router's user-assigned identity after `enable_acr = true`."
  type        = string

  validation {
    condition = (
      var.allow_mutable_image_tags ||
      can(regex("@sha256:[0-9a-f]{64}$", var.router_image)) ||
      can(regex(":v?[0-9]+[.][0-9]+[.][0-9]+([-+.][0-9A-Za-z.-]+)?$", var.router_image)) ||
      can(regex(":(sha-)?[0-9a-f]{7,40}$", var.router_image))
    )
    error_message = "router_image must be pinned to an immutable reference: a digest ('repo@sha256:<64 hex>'), a release tag ('repo:v1.2.3'), or a git-SHA tag ('repo:sha-a1b2c3d' / 'repo:a1b2c3d'). Mutable tags such as ':latest', ':deploy', or a branch/hotfix tag let the next apply silently change the deployed build. Build and push an immutable tag first (README step 4), or set allow_mutable_image_tags = true for a throwaway stack."
  }
}

variable "allow_mutable_image_tags" {
  description = "ESCAPE HATCH — leave false. When true, `router_image` and `worker_image` may carry mutable tags (':latest', ':deploy', a branch or ad-hoc hotfix tag). Only set this in a throwaway/scratch stack you are willing to have silently rolled backwards, because a floating tag means the next apply deploys whatever the registry points it at THEN, not the build you tested. It must stay false in any durable environment; the non-default value is deliberately visible in the tfvars diff."
  type        = bool
  default     = false
}

variable "router_url_for_containers" {
  description = "WSS URL containers dial to reach the router (e.g. 'wss://app-cyrus-dev-router.<hash>.australiaeast.azurecontainerapps.io'). The router Container App's real ingress FQDN (`latest_revision_fqdn`) is only known AFTER first apply, so embedding it in the router's own env creates a Terraform dependency cycle. TWO-APPLY FLOW: set null on first apply (router boots with a placeholder, containers won't connect yet), then `terraform output router_wss_url`, paste that value into this var, and re-apply. See README → 'routerUrlForContainers two-apply flow'."
  type        = string
  default     = null
}

variable "worker_image" {
  description = "Fully-qualified OCI image for the Cyrus worker, pinned to an IMMUTABLE reference (digest, 'v1.2.3', or 'sha-a1b2c3d') for the same reason as `router_image`. This image is NOT pulled by the router — it is registered as a group-scoped ACA disk image OUT OF BAND (`aca sandboxgroup disk create --image <worker_image>`). The disk image *name* that the group knows it by is `var.aca_disk_name`. Pass the raw image ref here purely so the router can embed it in `CYRUS_ROUTER_CONTAINERS_JSON` for display/diagnostic purposes. Because the disk image is registered out of band, a floating tag here also makes it impossible to tell which build a registered disk was cut from."
  type        = string

  validation {
    condition = (
      var.allow_mutable_image_tags ||
      can(regex("@sha256:[0-9a-f]{64}$", var.worker_image)) ||
      can(regex(":v?[0-9]+[.][0-9]+[.][0-9]+([-+.][0-9A-Za-z.-]+)?$", var.worker_image)) ||
      can(regex(":(sha-)?[0-9a-f]{7,40}$", var.worker_image))
    )
    error_message = "worker_image must be pinned to an immutable reference: a digest ('repo@sha256:<64 hex>'), a release tag ('repo:v1.2.3'), or a git-SHA tag ('repo:sha-a1b2c3d' / 'repo:a1b2c3d'). Mutable tags such as ':latest', ':deploy', or a branch/hotfix tag make the registered ACA disk image untraceable to a build. Build and push an immutable tag first (README step 4), or set allow_mutable_image_tags = true for a throwaway stack."
  }
}

variable "aca_disk_name" {
  description = "Name of the pre-registered ACA group disk image (created out of band from `var.worker_image`). This is the value the provider passes to `sourcesRef.diskImage.name` on sandbox create."
  type        = string
}

################################################################################
# ACA sandbox group compute defaults
################################################################################

# NOTE: These are passed to the *provider* / router config (CYRUS_ROUTER_CONTAINERS_JSON)
# and consumed on a per-sandbox `create` body. The ARM `Microsoft.App/sandboxGroups`
# resource itself accepts NONE of these — spike finding under "Other facts":
# "The ARM sandboxGroups resource takes almost no properties. Created
# successfully with properties: {}." See sandbox.tf and README → "maxSandboxCount
# does not exist" warning.

variable "aca_cpu" {
  description = "Default vCPU request per sandbox. Passed to the router config; ACA normalises server-side (e.g. '4000m' → 4 cores). XL tier is the plan's suggested default (4 vCPU / 8 GiB / 80 GiB) but is the most expensive — set consciously."
  type        = string
  default     = "4000m"
}

variable "aca_memory" {
  description = "Default memory request per sandbox (e.g. '8192Mi'). Server-normalised; see aca_cpu."
  type        = string
  default     = "8192Mi"
}

variable "aca_auto_suspend_seconds" {
  description = "ACA-side auto-suspend interval in seconds. 0 = DISABLED (the Cyrus default, spike N5 / F2). ACA-side suspend has NO session-affinity gate and can freeze a live session mid-task; the router's affinity-aware `idleStopMs` is the sole idle controller. Leave this at 0."
  type        = number
  default     = 0

  validation {
    condition     = var.aca_auto_suspend_seconds >= 0
    error_message = "aca_auto_suspend_seconds must be >= 0 (0 disables ACA-side auto-suspend)."
  }
}

variable "aca_egress_default_action" {
  description = "Default egress action per sandbox. 'Deny' is the secure default (D7); the router injects the full D7 allowlist per-sandbox on create. Set 'Allow' only for isolated air-gap-free test sandboxes."
  type        = string
  default     = "Deny"

  validation {
    condition     = contains(["Allow", "Deny"], var.aca_egress_default_action)
    error_message = "aca_egress_default_action must be either 'Allow' or 'Deny'."
  }
}

variable "aca_egress_traffic_inspection" {
  description = "Egress inspection mode. 'Full' enforces deny rules AND blocks non-HTTP TCP/UDP (so git+ssh:// is unsupported — document the HTTPS-only limitation). 'Partial' relaxes that. 'None' applies no inspection. Spike S4 confirmed WSS through 'Full' works, so the 'Partial' fallback is not required."
  type        = string
  default     = "Full"

  validation {
    condition     = contains(["Legacy", "Full", "Partial", "None"], var.aca_egress_traffic_inspection)
    error_message = "aca_egress_traffic_inspection must be Legacy, Full, Partial, or None."
  }
}

variable "aca_egress_host_rules" {
  description = "Optional explicit ACA egress host rules. Leave null to retain the router provider's built-in host allowlist (including the router WSS host); when set, this list replaces that default."
  type = list(object({
    pattern = string
    action  = string
  }))
  default = null

  validation {
    condition = var.aca_egress_host_rules == null ? true : alltrue([
      for rule in var.aca_egress_host_rules : trimspace(rule.pattern) != "" && contains(["Allow", "Deny"], rule.action)
    ])
    error_message = "aca_egress_host_rules patterns must be non-empty and actions must be either 'Allow' or 'Deny'."
  }
}

variable "aca_keep_snapshots" {
  description = "Retention count for the per-issue explicit labeled snapshots the provider prunes on the create path (`keepSnapshots` in router config). Snapshots are never GC'd by Azure; this defaults to 2 newest."
  type        = number
  default     = 2

  validation {
    condition     = var.aca_keep_snapshots >= 0 && floor(var.aca_keep_snapshots) == var.aca_keep_snapshots
    error_message = "aca_keep_snapshots must be a nonnegative integer."
  }
}

variable "aca_disconnected_recreate_ms" {
  description = "Milliseconds an ACA worker may remain disconnected from router WSS before ensureRunning replaces it."
  type        = number
  default     = 120000

  validation {
    condition     = var.aca_disconnected_recreate_ms >= 0
    error_message = "aca_disconnected_recreate_ms must be >= 0."
  }
}

################################################################################
# Linear integration secrets (seeded into Key Vault)
################################################################################

variable "linear_workspace_id" {
  description = "Linear organization UUID returned by OAuth workspace discovery. Use the UUID, not the workspace slug. NOT secret; shipped as a plain env var to the router."
  type        = string
}

variable "linear_workspace_token" {
  description = "Linear workspace API token used by the router to read/mutate issues. Seeded into Key Vault secret 'linear-workspace-token'. Rotate via Key Vault after first deploy (see README → secret rotation)."
  type        = string
  sensitive   = true
}

variable "linear_workspace_refresh_token" {
  description = "Linear OAuth refresh token used to rotate the workspace access token. Seeded into the secret workspace configuration."
  type        = string
  sensitive   = true
}

variable "linear_webhook_secret" {
  description = "HMAC secret shared between Linear and the router for verifying webhook signatures. Seeded into Key Vault secret 'linear-webhook-secret'."
  type        = string
  sensitive   = true
}

variable "linear_client_id" {
  description = "Linear OAuth client id (router-mode OAuth app). Seeded into Key Vault secret 'linear-client-id'."
  type        = string
  sensitive   = true
}

variable "linear_client_secret" {
  description = "Linear OAuth client secret. Seeded into Key Vault secret 'linear-client-secret'."
  type        = string
  sensitive   = true
}

################################################################################
# RBAC
################################################################################

variable "sandboxgroup_data_owner_role_id" {
  description = "Optional role-definition id for 'Container Apps SandboxGroup Data Owner'. When unset, the stack resolves it via a `data.azurerm_role_definition` lookup by name. Spike S6 confirmed the documented GUID `c24cf47c-5077-412d-a19c-45202126392c` resolves in-tenant; this variable is the VERIFIED FALLBACK (do not hardcode the GUID as the primary path). A second undocumented role 'Container Apps SandboxGroup Contributor' (`11b23f7a-6229-4518-88db-0576f10dd2a0`) exists for least-privilege readers."
  type        = string
  default     = null
}

variable "operator_principal_id" {
  description = "Optional Entra principal id (object id of a user/group/SP) granted break-glass 'Storage Blob Data Contributor' on the router-backups container. WITHOUT this, an operator cannot delete a corrupt `router.db` blob to unwedge a fatal-restore CrashLoopBackOff (M2). Leave null in pure-CI environments."
  type        = string
  default     = null
}

################################################################################
# Cyrus repositories
################################################################################

variable "cyrus_repositories" {
  description = "Repositories the router is allowed to spin workers up for. Rendered into `CYRUS_ROUTER_CONTAINERS_JSON.repositories`."
  type = list(object({
    name                = string
    github_slug         = string
    linear_workspace_id = string
    base_branch         = optional(string)
  }))
  default = []
}

################################################################################
# Optional feature flags
################################################################################

variable "enable_acr" {
  description = "When true, provisions an Azure Container Registry, grants both the router UAI and sandbox-group identity AcrPull, and configures the router Container App registry identity. Not needed for anonymous public registries."
  type        = bool
  default     = false
}

variable "enable_custom_domain" {
  description = "When true, provisions a `azurerm_container_app_custom_domain` against `var.custom_domain_name`. The default `*.azurecontainerapps.io` FQDN is stable and fine for webhooks + WSS — only enable if you need a branded hostname."
  type        = bool
  default     = false
}

variable "custom_domain_name" {
  description = "Apex custom hostname to bind to the router ingress (e.g. 'router.example.com'). Requires a DNS TXT/CNAME you control; see README."
  type        = string
  default     = null
}

variable "custom_domain_certificate_zone_id" {
  description = "Resource id of an existing Azure DNS zone used for the managed custom-domain certificate. Required when `enable_custom_domain = true`."
  type        = string
  default     = null
}

variable "entra_tenant_id" {
  description = "Optional Entra tenant id used to validate router enrollment tokens. Must be set together with entra_audience; leave both null to disable Entra-gated enrollment."
  type        = string
  default     = null

  validation {
    condition = (
      (var.entra_tenant_id == null && var.entra_audience == null && var.entra_allowed_domain == null) ||
      (var.entra_tenant_id != null && var.entra_audience != null)
    )
    error_message = "entra_tenant_id and entra_audience must both be set to enable Entra enrollment; entra_allowed_domain may only be set when they are enabled."
  }
}

variable "entra_audience" {
  description = "Optional exact Entra token audience (the router app registration's Application ID URI). Must be set together with entra_tenant_id."
  type        = string
  default     = null
}

variable "entra_allowed_domain" {
  description = "Optional email domain allowed to enroll when Entra authentication is enabled (for example, 'example.com')."
  type        = string
  default     = null
}

################################################################################
# Setup management UI (/setup) — STAGED ROLLOUT (D7)
#
# Reaching a live `/setup` takes TWO separate `terraform apply`s, and that is
# the security property, not an inconvenience:
#
#   Stage 1   enable_setup_auth = true
#             → Entra client secret, ACA built-in auth (EasyAuth) sidecar,
#               token store. `/setup` still 404s, so there is nothing to
#               impersonate.
#
#   ┌── HARD GATE ────────────────────────────────────────────────────────────┐
#   │ ENFORCED, NOT ATTESTED (R2-01). A precondition on                       │
#   │ azurerm_container_app.router reads the DEPLOYED authConfigs child out   │
#   │ of Azure (data.azapi_resource.setup_auth_existing, setup_ui.tf) and     │
#   │ refuses stage 2 unless a PREVIOUS apply created it and it is live.      │
#   │ Setting all the flags true in one tfvars edit therefore fails at plan   │
#   │ time — no boolean can satisfy it.                                       │
#   │                                                                         │
#   │ Separately, run the machine-route regression check from README §11 step │
#   │ 4 against the LIVE app and record the result in                         │
#   │ `setup_auth_stage1_verified`. That is a human observation of behaviour  │
#   │ no data source can see; it is defence in depth, not the gate.           │
#   └─────────────────────────────────────────────────────────────────────────┘
#
#   Stage 2   enable_setup_ui = true
#             → CYRUS_ROUTER_SETUP_UI_* env vars, which is what makes the
#               router register the routes.
#
# Why not one flag: `authConfigs` is a CHILD of the Container App. Terraform
# must create the app (and therefore publish the revision that serves /setup)
# before it can attach the auth sidecar. A single flag guarantees a window in
# which an unauthenticated `/setup` is on the public internet. No post-apply
# check can close a window that opens mid-apply.
#
# Rollback reverses the order: clear `enable_setup_ui`, apply, confirm /setup
# 404s, and only then clear `enable_setup_auth`.
################################################################################

variable "enable_setup_auth" {
  description = "STAGE 1 of the staged /setup rollout. Attaches the ACA built-in auth (EasyAuth) sidecar to the router Container App: seeds the Entra client secret into Key Vault, creates the token-store blob container + SAS, and creates the `authConfigs` child resource. Does NOT enable any /setup route — that is `enable_setup_ui`, applied separately AFTER the live verification gate. Apply this ALONE first."
  type        = bool
  default     = false

  validation {
    condition = (
      !var.enable_setup_auth ||
      (var.setup_ui_client_id != null && var.setup_ui_client_secret != null)
    )
    error_message = "enable_setup_auth requires setup_ui_client_id and setup_ui_client_secret. Create them on the EXISTING router app registration (README §11 step 2) rather than minting a second one — 'one app registration/audience per router deployment' is a standing invariant."
  }

  validation {
    condition     = !var.enable_setup_auth || var.entra_tenant_id != null
    error_message = "enable_setup_auth requires entra_tenant_id: the sidecar's openIdIssuer is https://login.microsoftonline.com/<tenant>/v2.0. Setting entra_tenant_id also requires entra_audience, which is intended — the same app registration serves both /enroll access tokens and /setup sign-in."
  }

  validation {
    condition = (
      !var.enable_setup_auth ||
      (var.setup_ui_token_store_sas_start != null && var.setup_ui_token_store_sas_expiry != null)
    )
    error_message = "enable_setup_auth requires setup_ui_token_store_sas_start and setup_ui_token_store_sas_expiry. Microsoft.App/containerApps/authConfigs@2024-03-01 models the token store as a SAS URL only (`sasUrlSettingName` is its single, required property), so the SAS window is explicit operator input. Do not derive it from timestamp() — that re-evaluates every plan and would roll a new router revision on every apply."
  }
}

variable "setup_ui_client_id" {
  description = "Client id (bare GUID) of the EXISTING router Entra app registration, reused by the auth sidecar. Required when enable_setup_auth is true. This is also the audience of the ID token the sidecar forwards — distinct from `entra_audience`, which is the `api://<client-id>` Application ID URI carried by ACCESS tokens on /enroll."
  type        = string
  default     = null
}

variable "setup_ui_client_secret" {
  description = "Client secret for setup_ui_client_id, generated with `az ad app credential reset`. Seeded into the Key Vault secret 'setup-ui-client-secret' and referenced by the Container App as a secret; never rendered into an output. Rotate in Entra first, then `az keyvault secret set` — the Container App references it by versionless id, so a rotation lands on the next revision without a Terraform apply."
  type        = string
  default     = null
  sensitive   = true
}

variable "setup_ui_token_store_sas_start" {
  description = "RFC 3339 UTC start of the token-store SAS window (for example '2026-01-01T00:00:00Z'). Required when enable_setup_auth is true. Static by design: deriving it from timestamp() re-evaluates on every plan, producing a permanent diff and a needless router revision roll each apply."
  type        = string
  default     = null
}

variable "setup_ui_token_store_sas_expiry" {
  description = "RFC 3339 UTC expiry of the token-store SAS window (for example '2027-01-01T00:00:00Z'). Required when enable_setup_auth is true. EXPIRY IS A LIVE FAILURE: once past, the sidecar can no longer persist sessions and sign-in breaks. Diarise the renewal — bump this value and apply. See README → 'Rotating the setup UI secrets'."
  type        = string
  default     = null
}

variable "setup_ui_allowed_group_object_ids" {
  description = "Entra GROUP object ids allowed to authenticate to the app, rendered into authConfigs `defaultAuthorizationPolicy.allowedPrincipals.groups`. Empty (the default) sends no policy at all — an empty policy is not the same as an absent one. Populating this, or attesting to an Entra assignment requirement via setup_ui_assignment_required_verified, is a HARD PREREQUISITE for setup_ui_auto_provision_users (F5): otherwise any account in the tenant can sign in and provision itself a Cyrus user with a secret store."
  type        = list(string)
  default     = []
}

variable "setup_ui_allowed_principal_object_ids" {
  description = "Entra USER/service-principal object ids allowed to authenticate to the app, rendered into authConfigs `defaultAuthorizationPolicy.allowedPrincipals.identities`. Prefer setup_ui_allowed_group_object_ids — a group is one policy edit instead of a Terraform apply per joiner/leaver."
  type        = list(string)
  default     = []
}

variable "setup_auth_stage1_verified" {
  description = "ATTESTATION, not a switch, and NO LONGER THE ORDERING GATE. Terraform now proves the ordering itself: `azurerm_container_app.router` carries preconditions over `data.azapi_resource.setup_auth_existing`, which reads the already-deployed authConfigs child from Azure, so stage 2 cannot plan until a PREVIOUS apply actually created it. What a data source cannot observe is whether a human ran the behavioural checks, which is what this flag still records: (a) the machine-route regression check — /healthz, /linear-webhook and a worker WSS reconnect still work and do NOT 302 to /.auth/login/aad; and (b) sign-in through /.auth/login/aad succeeds while /setup still 404s. Paste the command output into the change record."
  type        = bool
  default     = false
}

variable "enable_setup_ui" {
  description = "STAGE 2 of the staged /setup rollout. Sets the CYRUS_ROUTER_SETUP_UI_* environment variables, which is what makes the router register the /setup* routes. Apply this ONLY in a separate, later apply, after enable_setup_auth is live and verified. Setting it in the same plan as enable_setup_auth is refused by a precondition on the Container App that reads the deployed authConfigs child from Azure — the variable validations below are a fast, friendly first line, not the enforcement. Rolling back is safe and comes FIRST in a rollback: clear this, apply, confirm /setup 404s, then clear enable_setup_auth."
  type        = bool
  default     = false

  validation {
    condition     = !var.enable_setup_ui || var.enable_setup_auth
    error_message = "enable_setup_ui requires enable_setup_auth. Enabling the routes without the auth sidecar publishes an unauthenticated /setup; the router will refuse to start in that state, so the practical result is an outage rather than a breach — but do not rely on that as the control."
  }

  validation {
    condition     = !var.enable_setup_ui || var.setup_auth_stage1_verified
    error_message = "enable_setup_ui requires setup_auth_stage1_verified = true. Stage 1 must be applied on its own and verified live (README §11 step 4) BEFORE the routes exist. Note this check is only an early, readable failure: even with this flag set, the plan is still refused unless the authConfigs child already exists in Azure."
  }
}

variable "setup_ui_auth_mode" {
  description = "How the router establishes identity on /setup*. TERRAFORM-MANAGED DEPLOYMENTS MAY ONLY USE 'entra-token', which cryptographically verifies the ID token the sidecar forwards in X-MS-TOKEN-AAD-ID-TOKEN and therefore ignores a forged X-MS-CLIENT-PRINCIPAL-* header regardless of ingress topology; it requires the token store, which enable_setup_auth configures. The router also implements 'easyauth-headers', but this stack refuses it — see the validation below. The variable is kept (rather than hardcoded in router.tf) so that adding a second cryptographically verifiable mode later is a one-line change here."
  type        = string
  default     = "entra-token"

  validation {
    condition     = var.setup_ui_auth_mode == "entra-token"
    error_message = "setup_ui_auth_mode must be 'entra-token' in a Terraform-managed deployment. 'easyauth-headers' is refused here even though the router supports it: its trust boundary is the proxy topology in front of the process — that client-supplied X-MS-CLIENT-PRINCIPAL* headers are stripped before they reach the container — and that is a property of the deployed ingress which THIS CONFIGURATION CANNOT VERIFY. The previous design substituted an operator boolean (setup_ui_verified_header_strip) for that verification, which is an attestation, not a control. 'entra-token' verifies a signature and is independent of proxy topology, so it is correct by construction here. The mode remains supported in the application for self-hosted deployments that are not behind ACA and can reason about their own front door; it is only unreachable from this stack. The router's third mode, 'dev-insecure-headers', reads headers with no verification, is refused on any non-loopback bind host, and is likewise not reachable here."
  }

  # Conditioned on `enable_setup_ui`. This variable has a non-null DEFAULT, so
  # an unconditional rule referencing other setup inputs would fire on every
  # stack that has never touched the setup UI — turning "the feature is off"
  # into a failed plan. The mode is inert until stage 2 enables the routes.
  #
  # The `!= "entra-token"` clause is currently unreachable (the rule above
  # admits nothing else) and is kept for two reasons: Terraform REQUIRES every
  # validation condition to reference its own variable, and this keeps the rule
  # correct if a second verifiable mode with different inputs is added later.
  validation {
    condition = (
      !var.enable_setup_ui ||
      var.setup_ui_auth_mode != "entra-token" ||
      var.setup_ui_id_token_audience != null ||
      var.setup_ui_client_id != null
    )
    error_message = "setup_ui_auth_mode = 'entra-token' needs an ID token audience: set setup_ui_client_id (the audience defaults to it) or override setup_ui_id_token_audience explicitly."
  }
}

variable "setup_ui_id_token_audience" {
  description = "Override for the expected `aud` of the ID token verified in 'entra-token' mode. Defaults to setup_ui_client_id, which is correct for Entra: an ID token carries the BARE CLIENT-ID GUID, not the `api://<client-id>` Application ID URI in `entra_audience` (that is the access-token audience). Set this only if your identity provider issues something else."
  type        = string
  default     = null
}

# REMOVED (R2-01): `setup_ui_verified_header_strip`.
#
# It existed only to satisfy `setup_ui_auth_mode = "easyauth-headers"`, and it
# was a boolean an operator typed — an attestation standing in for a property of
# the deployed ingress. Now that this stack refuses the header mode outright,
# the flag has nothing to gate, and reintroducing it would be reintroducing the
# substitution. If `easyauth-headers` is ever wanted here, the answer is a live
# probe executed as part of the pipeline whose result is an externally produced
# artifact, not another `bool` in tfvars.
#
# Removing a variable is not a state change: nothing references it, and stale
# `setup_ui_verified_header_strip = false` lines in a tfvars file will simply be
# rejected as an undeclared variable. Delete the line.

variable "setup_ui_allowed_domain" {
  description = "Optional email domain allowlist enforced IN THE ROUTER on /setup* (for example, 'example.com'). Defence in depth on top of the app registration's own assignment requirement, not a substitute for it: a domain check cannot distinguish an assigned teammate from any other account in the same tenant."
  type        = string
  default     = null
}

variable "setup_ui_auto_provision_users" {
  description = "Create a router user record on a teammate's first successful /setup sign-in. Defaults FALSE (F5): auto-provisioning converts 'can obtain a token for this app' into 'is a Cyrus user with a secret store', which is only safe once app access is genuinely restricted. Terraform therefore refuses to set this true unless membership is constrained — either an authConfigs allowedPrincipals policy (setup_ui_allowed_group_object_ids / setup_ui_allowed_principal_object_ids) or an attested Entra assignment requirement (setup_ui_assignment_required_verified)."
  type        = bool
  default     = false

  validation {
    condition = (
      !var.setup_ui_auto_provision_users ||
      var.setup_ui_assignment_required_verified ||
      length(var.setup_ui_allowed_group_object_ids) > 0 ||
      length(var.setup_ui_allowed_principal_object_ids) > 0
    )
    error_message = "setup_ui_auto_provision_users = true requires a membership gate: populate setup_ui_allowed_group_object_ids (or setup_ui_allowed_principal_object_ids), or run the Entra assignment commands in README §11 step 3 and set setup_ui_assignment_required_verified = true. Without one of these, ANY account in the tenant can sign in and self-provision a Cyrus user — 'Assignment required' is not on by default, and setup_ui_allowed_domain does not provide it."
  }
}

variable "setup_ui_assignment_required_verified" {
  description = "ATTESTATION that the app registration's service principal has appRoleAssignmentRequired = true AND the Cyrus users group is actually assigned to it — BOTH, verified with the `az ad sp show` / `az rest` readback in README §11 step 3. Setting appRoleAssignmentRequired without performing the assignment locks everyone out; performing the assignment without setting the flag restricts nobody. This is the alternative to an authConfigs allowedPrincipals policy for satisfying the setup_ui_auto_provision_users prerequisite."
  type        = bool
  default     = false
}

################################################################################
# Per-user secret storage backend (D6')
#
# TWO SEPARATE CONTROLS, and conflating them is the mistake to avoid:
#
#   enable_setup_secret_store  — CREATE the Table, the KEK and the two role
#                                assignments. Default FALSE, so a stack that
#                                does not want the feature gets no diff at all
#                                (R2-06). ONE-WAY BY CONVENTION: see below.
#
#   enable_setup_table_backend — SELECT the Table as the router's secret
#                                backend by rendering `containers.tableStore`.
#                                Fully reversible in both directions. This is
#                                the rollback control.
################################################################################

variable "enable_setup_secret_store" {
  description = "CREATE the per-user secret storage infrastructure: the Azure Table, the envelope-encryption KEK, and the router's Storage Table Data Contributor + Key Vault Crypto User role assignments. Default FALSE so that a deployment enabling neither the setup UI nor the Table backend plans no changes and needs no key permissions on the vault. ONE-WAY BY CONVENTION: the KEK and Table carry prevent_destroy, so setting this back to false after they exist produces a hard plan error naming the protected resource rather than destroying the key that unwraps every stored secret. That refusal is intended — it is not the rollback path. To roll the FEATURE back, clear enable_setup_table_backend instead; to genuinely remove the infrastructure, follow README → 'Decommissioning the per-user secret store'."
  type        = bool
  default     = false
}

variable "enable_setup_table_backend" {
  description = "SELECT the Azure Table secret backend by adding `containers.tableStore` to CYRUS_ROUTER_CONTAINERS_JSON. This is the ONLY reversible control over the feature: clearing it drops the router back to the Key Vault backend on the next revision, with no destroy and no data loss. Enable it only AFTER enable_setup_secret_store has been applied AND `cyrus router secrets migrate` has run and been verified (README → 'Key Vault to Table migration')."
  type        = bool
  default     = false

  validation {
    condition     = !var.enable_setup_table_backend || var.enable_setup_secret_store
    error_message = "enable_setup_table_backend requires enable_setup_secret_store = true. The selector points the router at a Table and a KEK that the creation flag is responsible for provisioning; without it there is nothing to select, and the rendered config would name resources that do not exist."
  }
}

variable "router_default_executor" {
  description = "Provider that users whose stored executor is the explicit `{\"type\":\"default\"}` sentinel inherit, rendered as `containers.defaultExecutor`. DEFAULTS TO NULL, which omits the field entirely (R2-06): a non-null default would change CYRUS_ROUTER_CONTAINERS_JSON — and so roll the single router replica — on every existing stack that never asked for the setting. Set 'aca' to opt in; it matches this stack, whose sandbox group is always provisioned. SAFE BY CONSTRUCTION even then: a NULL/absent stored executor still means 'physical device' and is never captured by this default (F11), so users deliberately left on a device do not silently move to cloud sandboxes."
  type        = string
  default     = null

  validation {
    condition     = var.router_default_executor == null || contains(["aca", "docker"], coalesce(var.router_default_executor, "aca"))
    error_message = "router_default_executor must be a container provider name ('aca' or 'docker'), or null to omit it. 'device' and 'default' are rejected: neither is a provider, and the router would degrade every affected user to a physical device with a warning."
  }
}
