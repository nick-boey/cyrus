################################################################################
# Router Container App — single replica (SQLite + in-memory WS state)
################################################################################

locals {
  # The containers JSON the router materializes into `config.containers`. Per
  # Task 1's N8 requirement this is the COMPLETE paste-ready value (not a
  # fragment) — exported unredacted as the `cyrus_router_containers_json`
  # output (no secret; image + routing config). The ingress FQDN is referenced
  # via the ACA app's `latest_revision_fqdn`, which Terraform resolves after
  # the revision exists. (README documents the self-reference ordering
  # constraint and the operator-copy fallback.)
  router_containers_config = {
    image                  = var.worker_image
    routerUrlForContainers = var.router_url_for_containers != null ? var.router_url_for_containers : "wss://REPLACE-ME-set-router_url_for_containers-from-terraform-output"
    repositories = [
      for repository in var.cyrus_repositories : merge({
        name              = repository.name
        githubSlug        = repository.github_slug
        linearWorkspaceId = repository.linear_workspace_id
      }, repository.base_branch != null ? { baseBranch = repository.base_branch } : {})
    ]
    keyVaultUrl            = azurerm_key_vault.this.vault_uri
    artifactsDir           = "/data/artifacts"
    aca = {
      subscriptionId          = data.azurerm_client_config.current.subscription_id
      resourceGroup           = azurerm_resource_group.this.name
      sandboxGroup            = azapi_resource.sandbox_group.name
      region                  = var.location
      disk                    = var.aca_disk_name
      cpu                     = var.aca_cpu
      memory                  = var.aca_memory
      autoSuspendSeconds      = var.aca_auto_suspend_seconds
      egress = merge({
        defaultAction     = var.aca_egress_default_action
        trafficInspection = var.aca_egress_traffic_inspection
      }, var.aca_egress_host_rules != null ? { hostRules = var.aca_egress_host_rules } : {})
      keepSnapshots           = var.aca_keep_snapshots
      disconnectedRecreateMs  = var.aca_disconnected_recreate_ms
      # The authoritative data-plane host is the ARM-emitted
      # `properties.managementEndpoint`; the router config prefers this over
      # the client's region+baseUrl fallback. Output as `management_endpoint`.
      managementEndpoint = azapi_resource.sandbox_group.output.properties.managementEndpoint
    }
    // The router's blob backup target (router.db). Plain URL — auth comes from
    // the router UAI's Storage Blob Data Contributor role assignment.
    backupBlobUrl = "https://${azurerm_storage_account.this.name}.blob.core.windows.net/${azurerm_storage_container.router_backups.name}"
  }

  router_env_non_secret = {
    LINEAR_WORKSPACE_ID               = var.linear_workspace_id
    CYRUS_ROUTER_CONTAINERS_JSON      = jsonencode(local.router_containers_config)
    CYRUS_ROUTER_BACKUP_BLOB_URL      = local.router_containers_config.backupBlobUrl
    CYRUS_ROUTER_ENTRA_TENANT_ID     = var.entra_tenant_id
    CYRUS_ROUTER_ENTRA_AUDIENCE       = var.entra_audience
    CYRUS_ROUTER_ENTRA_ALLOWED_DOMAIN = var.entra_allowed_domain
  }

  entra_enabled = var.entra_tenant_id != null && var.entra_audience != null
}

resource "azurerm_container_app" "router" {
  name                         = "app-${local.name_prefix}-router"
  resource_group_name          = azurerm_resource_group.this.name
  container_app_environment_id = azurerm_container_app_environment.this.id
  revision_mode                = "Single"
  tags                         = local.default_tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.router.id]
  }

  dynamic "registry" {
    for_each = var.enable_acr ? toset(["acr"]) : toset([])
    content {
      server   = azurerm_container_registry.this[0].login_server
      identity = azurerm_user_assigned_identity.router.id
    }
  }

  ingress {
    external_enabled = true
    target_port      = 8787
    transport        = "http"
    # ACA ingress supports WebSocket upgrades; the router's WSS upgrade
    # end-to-end is verified (spike S4 → "WSS through Full inspection: WORKS").
    # http+tcp transport carries the upgrade fine — no special "ws" transport.
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  # Linear secrets sourced from Key Vault via the router MI (Key Vault Secrets
  # User + Secrets Officer granted in main.tf). `versionless_id` lets ACA pick
  # up rotated values on the next revision without a TF apply.
  secret {
    name                = "linear-workspace-token"
    identity            = azurerm_user_assigned_identity.router.id
    key_vault_secret_id = azurerm_key_vault_secret.linear_workspace_token.versionless_id
  }
  secret {
    name                = "linear-webhook-secret"
    identity            = azurerm_user_assigned_identity.router.id
    key_vault_secret_id = azurerm_key_vault_secret.linear_webhook_secret.versionless_id
  }
  secret {
    name                = "linear-client-id"
    identity            = azurerm_user_assigned_identity.router.id
    key_vault_secret_id = azurerm_key_vault_secret.linear_client_id.versionless_id
  }
  secret {
    name                = "linear-client-secret"
    identity            = azurerm_user_assigned_identity.router.id
    key_vault_secret_id = azurerm_key_vault_secret.linear_client_secret.versionless_id
  }

  template {
    min_replicas = 1
    max_replicas = 1

    container {
      name   = "router"
      image  = var.router_image
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "LINEAR_WORKSPACE_ID"
        value = local.router_env_non_secret.LINEAR_WORKSPACE_ID
      }
      env {
        name        = "LINEAR_WORKSPACE_TOKEN"
        secret_ref = "linear-workspace-token"
      }
      env {
        name        = "LINEAR_WEBHOOK_SECRET"
        secret_ref = "linear-webhook-secret"
      }
      env {
        name        = "LINEAR_CLIENT_ID"
        secret_ref = "linear-client-id"
      }
      env {
        name        = "LINEAR_CLIENT_SECRET"
        secret_ref = "linear-client-secret"
      }
      env {
        name  = "CYRUS_ROUTER_CONTAINERS_JSON"
        value = local.router_env_non_secret.CYRUS_ROUTER_CONTAINERS_JSON
      }
      env {
        name  = "CYRUS_ROUTER_BACKUP_BLOB_URL"
        value = local.router_env_non_secret.CYRUS_ROUTER_BACKUP_BLOB_URL
      }

      # Entra env is optional and uses the canonical entrypoint/Zod names.
      dynamic "env" {
        for_each = local.entra_enabled ? toset(["entra"]) : toset([])
        content {
          name  = "CYRUS_ROUTER_ENTRA_TENANT_ID"
          value = local.router_env_non_secret.CYRUS_ROUTER_ENTRA_TENANT_ID
        }
      }
      dynamic "env" {
        for_each = local.entra_enabled ? toset(["entra"]) : toset([])
        content {
          name  = "CYRUS_ROUTER_ENTRA_AUDIENCE"
          value = local.router_env_non_secret.CYRUS_ROUTER_ENTRA_AUDIENCE
        }
      }
      dynamic "env" {
        for_each = local.entra_enabled && var.entra_allowed_domain != null ? toset(["entra-domain"]) : toset([])
        content {
          name  = "CYRUS_ROUTER_ENTRA_ALLOWED_DOMAIN"
          value = local.router_env_non_secret.CYRUS_ROUTER_ENTRA_ALLOWED_DOMAIN
        }
      }

      volume_mount {
        name       = "artifacts"
        mount_path = "/data/artifacts"
      }
    }

    # Azure Files share bound to /data/artifacts — read/write; stores artifact
    # bundles (git worktree snapshots for cold restore). NOT used for SQLite —
    # the router keeps router.db on ephemeral container storage and backs it up
    # to the blob container above (D4 warns Azure Files breaks SQLite WAL).
    volume {
      name         = "artifacts"
      storage_type = "AzureFile"
      storage_name = azurerm_container_app_environment_storage.artifacts.name
    }
  }

  # `latest_revision_fqdn` is computed after create; expose it both as part of
  # the containers JSON above (resolves to the same value) and as a top-level
  # output so operators can paste the canonical router WSS URL. ACA resolves
  # Key Vault references while creating the revision, so both role grants must
  # exist first (Azure RBAC propagation can still require a retry; see README).
  depends_on = [
    azurerm_role_assignment.router_acr_pull,
    azurerm_role_assignment.router_kv_secrets_user,
    azurerm_role_assignment.router_kv_secrets_officer,
  ]
}

################################################################################
# Optional custom domain (enable_custom_domain)
################################################################################

resource "azurerm_container_app_custom_domain" "this" {
  count            = var.enable_custom_domain ? 1 : 0
  container_app_id = azurerm_container_app.router.id
  name             = var.custom_domain_name

  # DNS verification and managed-certificate issuance happen out of band. ACA
  # fills these fields asynchronously, so keep them out of Terraform drift.
  lifecycle {
    ignore_changes = [
      certificate_binding_type,
      container_app_environment_certificate_id,
    ]
  }
}
