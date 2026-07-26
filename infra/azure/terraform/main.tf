locals {
  name_prefix = "${var.project}-${var.environment}"

  default_tags = merge({
    "cyrus-managed" = "true"
    "environment"   = var.environment
    "project"       = var.project
  }, var.tags)

  resource_group_name = "rg-${local.name_prefix}"
}

################################################################################
# Resource group
################################################################################

resource "azurerm_resource_group" "this" {
  name     = local.resource_group_name
  location = var.location
  tags     = local.default_tags
}

################################################################################
# Log Analytics (router CAE diagnostics + any future ACA-side logs)
################################################################################

resource "azurerm_log_analytics_workspace" "this" {
  name                = "log-${local.name_prefix}"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.default_tags
}

################################################################################
# Key Vault (RBAC mode, no purge protection for dev ergonomics)
################################################################################

resource "azurerm_key_vault" "this" {
  name                       = "kv-${local.name_prefix}"
  resource_group_name        = azurerm_resource_group.this.name
  location                   = azurerm_resource_group.this.location
  tenant_id                   = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  enable_rbac_authorization  = true
  purge_protection_enabled   = false
  soft_delete_retention_days = 7
  # Open network for dev. The spike created the vault with default_action=Allow.
  # Tighten to your VNet/IP list in prod.
  network_acls {
    default_action = "Allow"
    bypass         = "AzureServices"
  }
  tags = local.default_tags
}

data "azurerm_client_config" "current" {}

################################################################################
# Router managed identity
################################################################################

resource "azurerm_user_assigned_identity" "router" {
  name                = "id-${local.name_prefix}-router"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  tags                = local.default_tags
}

################################################################################
# Storage: Azure Files share (artifacts) + blob container (router-backups)
################################################################################

resource "azurerm_storage_account" "this" {
  name                     = "st${replace(local.name_prefix, "-", "")}"
  resource_group_name      = azurerm_resource_group.this.name
  location                 = azurerm_resource_group.this.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  min_tls_version          = "TLS1_2"
  tags                     = local.default_tags
}

resource "azurerm_storage_share" "artifacts" {
  name                 = "artifacts"
  storage_account_name = azurerm_storage_account.this.name
  quota_gb             = 50
}

resource "azurerm_storage_container" "router_backups" {
  name                  = "router-backups"
  storage_account_name  = azurerm_storage_account.this.name
  container_access_type = "private"
}

################################################################################
# Container Apps environment
################################################################################

resource "azurerm_container_app_environment" "this" {
  name                       = "cae-${local.name_prefix}"
  resource_group_name        = azurerm_resource_group.this.name
  location                   = azurerm_resource_group.this.location
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id
  tags                       = local.default_tags
}

resource "azurerm_container_app_environment_storage" "artifacts" {
  name                         = "artifacts"
  container_app_environment_id = azurerm_container_app_environment.this.id
  account_name                 = azurerm_storage_account.this.name
  share_name                   = azurerm_storage_share.artifacts.name
  access_key                   = azurerm_storage_account.this.primary_access_key
  access_mode                  = "ReadWrite"
}

################################################################################
# RBAC: Container Apps SandboxGroup Data Owner lookup (spike S6)
################################################################################

# Primary path: resolve by name from the in-tenant tenant-wide role list.
# Spike S6 confirmed the documented GUID resolves in-tenant; the variable
# is the VERIFIED FALLBACK (never hardcode the GUID as the primary path — N2).
data "azurerm_role_definition" "sandboxgroup_data_owner" {
  name = "Container Apps SandboxGroup Data Owner"
}

locals {
  sandboxgroup_data_owner_role_id = var.sandboxgroup_data_owner_role_id != null ? var.sandboxgroup_data_owner_role_id : data.azurerm_role_definition.sandboxgroup_data_owner.id
}

################################################################################
# RBAC: router UAI → Key Vault Secrets User + Secrets Officer
################################################################################

resource "azurerm_role_assignment" "router_kv_secrets_user" {
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.router.principal_id
}

resource "azurerm_role_assignment" "router_kv_secrets_officer" {
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = azurerm_user_assigned_identity.router.principal_id
}

################################################################################
# RBAC: router UAI → Storage Blob Data Contributor (router-backups container)
################################################################################

resource "azurerm_role_assignment" "router_backups_blob_contributor" {
  scope                = azurerm_storage_container.router_backups.resource_manager_id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.router.principal_id
}

################################################################################
# RBAC: operator break-glass → Storage Blob Data Contributor on router-backups
# (M2) — WITHOUT this, an operator cannot delete a corrupt `router.db` blob to
# unwedge a fatal-restore CrashLoopBackOff. Guarded by count.
################################################################################

resource "azurerm_role_assignment" "operator_backups_breakglass" {
  count                = var.operator_principal_id != null ? 1 : 0
  scope                = azurerm_storage_container.router_backups.resource_manager_id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = var.operator_principal_id
}

################################################################################
# Key Vault seed secrets (migrated to operator-set after first deploy — README)
################################################################################

resource "azurerm_key_vault_secret" "linear_workspace_token" {
  name         = "linear-workspace-token"
  value        = var.linear_workspace_token
  key_vault_id = azurerm_key_vault.this.id
  # No expiry set — operators rotate via az keyvault secret set (README → secret
  # rotation). Setting expiration_date=timeadd(timestamp(),...) here would
  # cause perpetual plan diff noise (timestamp() re-evaluates every plan).
  tags = local.default_tags
}

resource "azurerm_key_vault_secret" "linear_webhook_secret" {
  name         = "linear-webhook-secret"
  value        = var.linear_webhook_secret
  key_vault_id = azurerm_key_vault.this.id
  tags         = local.default_tags
}

resource "azurerm_key_vault_secret" "linear_client_id" {
  name         = "linear-client-id"
  value        = var.linear_client_id
  key_vault_id = azurerm_key_vault.this.id
  tags         = local.default_tags
}

resource "azurerm_key_vault_secret" "linear_client_secret" {
  name         = "linear-client-secret"
  value        = var.linear_client_secret
  key_vault_id = azurerm_key_vault.this.id
  tags         = local.default_tags
}
