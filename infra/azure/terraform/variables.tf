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
################################################################################

variable "router_image" {
  description = "Fully-qualified container image for the router (e.g. 'ghcr.io/ceedaragents/cyrus-router:latest'). Pullable anonymously or, for private registries, via the group's managed identity after `enable_acr = true`."
  type        = string
}

variable "router_url_for_containers" {
  description = "WSS URL containers dial to reach the router (e.g. 'wss://app-cyrus-dev-router.<hash>.australiaeast.azurecontainerapps.io'). The router Container App's real ingress FQDN (`latest_revision_fqdn`) is only known AFTER first apply, so embedding it in the router's own env creates a Terraform dependency cycle. TWO-APPLY FLOW: set null on first apply (router boots with a placeholder, containers won't connect yet), then `terraform output router_wss_url`, paste that value into this var, and re-apply. See README → 'routerUrlForContainers two-apply flow'."
  type        = string
  default     = null
}

variable "worker_image" {
  description = "Fully-qualified OCI image for the Cyrus worker. This image is NOT pulled by the router — it is registered as a group-scoped ACA disk image OUT OF BAND (`aca sandboxgroup disk create --image <worker_image>`). The disk image *name* that the group knows it by is `var.aca_disk_name`. Pass the raw image ref here purely so the router can embed it in `CYRUS_ROUTER_CONTAINERS_JSON` for display/diagnostic purposes."
  type        = string
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
