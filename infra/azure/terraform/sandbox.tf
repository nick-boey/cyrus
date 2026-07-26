################################################################################
# ACA Sandbox Group (Arm 2026-02-01-preview) — azapi_resource
################################################################################

# SPIKE-DRIVEN SHAPE:
# The ARM `Microsoft.App/sandboxGroups@2026-02-01-preview` resource accepts
# ALMOST NO PROPERTIES — created successfully with `properties: {}` (spike
# finding under "Other facts"). The server returns `allowedLocations`,
# `connections`, `managementEndpoint`, `provisioningState`. The plan's
# assumed `defaultCpu` / `defaultMemory` / `defaultDisk` / `maxSandboxCount`
# properties DO NOT EXIST on this resource. Per-sandbox CPU/memory/disk and
# egress policy are passed in the `PUT /sandboxes` create body by the router
# (provider config = `var.aca_*`).
#
# `maxSandboxCount` therefore CANNOT be relied on as a cost guard — see README
# → "maxSandboxCount does not exist / cost control" for rate-limit guidance.
#
# The data-plane host IS returned by this resource as
# `properties.managementEndpoint` — output it rather than string-templating
# `https://management.{region}.azuredevcompute.io` (the ACA client has a
# region+baseUrl fallback, but the router config prefers the ARM-emitted value).
#
# Property-for-property parity with infra/azure/bicep/sandbox-group.bicep is
# enforced by scripts/check-aca-arm-parity.sh (M5). Location, body, identity,
# and tags below MUST mirror that Bicep resource.

resource "azapi_resource" "sandbox_group" {
  name      = "${var.project}-${var.environment}-sandbox-grp"
  parent_id = azurerm_resource_group.this.id
  location  = var.location
  type      = "Microsoft.App/sandboxGroups@2026-02-01-preview"
  # Preview API — the provider's schema validation rejects unknown properties,
  # so disable it. The body is intentionally minimal.
  schema_validation_enabled = false

  body = {
    properties = {}
  }

  identity {
    type = "SystemAssigned"
  }

  tags = local.default_tags

  response_export_values = [
    "identity.principalId",
    "properties.allowedLocations",
    "properties.managementEndpoint",
    "properties.provisioningState",
  ]
}

################################################################################
# RBAC: router UAI → Container Apps SandboxGroup Data Owner scoped at the group
################################################################################

resource "azurerm_role_assignment" "router_sandboxgroup_data_owner" {
  scope              = azapi_resource.sandbox_group.id
  role_definition_id = local.sandboxgroup_data_owner_role_id
  principal_id       = azurerm_user_assigned_identity.router.principal_id
}

################################################################################
# Optional Azure Container Registry (enable_acr) — for private-registry worker
# images (N7). Gate with count.
################################################################################

resource "azurerm_container_registry" "this" {
  count               = var.enable_acr ? 1 : 0
  name                = "acr${replace(local.name_prefix, "-", "")}"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  sku                 = "Basic"
  admin_enabled       = false
  tags                = local.default_tags
}

# The sandbox group's SYSTEM-ASSIGNED identity needs AcrPull on the ACR for the
# group to pull a private worker disk image. azapi_resource does not currently
# expose the group's principal_id via a top-level attribute — pull it from the
# `identity` output block.
resource "azurerm_role_assignment" "sandboxgroup_acr_pull" {
  count                = var.enable_acr ? 1 : 0
  scope                = azurerm_container_registry.this[0].id
  role_definition_name = "AcrPull"
  principal_id         = azapi_resource.sandbox_group.output.identity.principalId
}

# The router Container App pulls its own private image with its UAI. This is a
# separate identity and grant from the sandbox group's worker-image pull path.
resource "azurerm_role_assignment" "router_acr_pull" {
  count                = var.enable_acr ? 1 : 0
  scope                = azurerm_container_registry.this[0].id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.router.principal_id
}
