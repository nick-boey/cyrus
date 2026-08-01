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
  router_containers_base = {
    image                  = var.worker_image
    routerUrlForContainers = var.router_url_for_containers != null ? var.router_url_for_containers : "wss://REPLACE-ME-set-router_url_for_containers-from-terraform-output"
    repositories = [
      for repository in var.cyrus_repositories : merge({
        name              = repository.name
        githubSlug        = repository.github_slug
        linearWorkspaceId = repository.linear_workspace_id
      }, repository.base_branch != null ? { baseBranch = repository.base_branch } : {})
    ]
    keyVaultUrl  = azurerm_key_vault.this.vault_uri
    artifactsDir = "/data/artifacts"
    aca = {
      subscriptionId     = data.azurerm_client_config.current.subscription_id
      resourceGroup      = azurerm_resource_group.this.name
      sandboxGroup       = azapi_resource.sandbox_group.name
      region             = var.location
      disk               = var.aca_disk_name
      cpu                = var.aca_cpu
      memory             = var.aca_memory
      autoSuspendSeconds = var.aca_auto_suspend_seconds
      egress = merge({
        defaultAction     = var.aca_egress_default_action
        trafficInspection = var.aca_egress_traffic_inspection
      }, var.aca_egress_host_rules != null ? { hostRules = var.aca_egress_host_rules } : {})
      keepSnapshots          = var.aca_keep_snapshots
      disconnectedRecreateMs = var.aca_disconnected_recreate_ms
      # The authoritative data-plane host is the ARM-emitted
      # `properties.managementEndpoint`; the router config prefers this over
      # the client's region+baseUrl fallback. Output as `management_endpoint`.
      managementEndpoint = azapi_resource.sandbox_group.output.properties.managementEndpoint
    }
    // The router's blob backup target (router.db). Plain URL — auth comes from
    // the router UAI's Storage Blob Data Contributor role assignment.
    backupBlobUrl = "https://${azurerm_storage_account.this.name}.blob.core.windows.net/${azurerm_storage_container.router_backups.name}"
  }

  # Optional `containers.*` fields are merged in rather than written inline with
  # a `null`, because the router config is re-parsed by `cyrus router start`
  # through a Zod schema that rejects an explicit null where it accepts an
  # absent key — a literal `"tableStore": null` would fail startup.
  router_containers_config = merge(
    local.router_containers_base,

    # F11: only users whose stored executor is the explicit `{"type":"default"}`
    # sentinel inherit this. NULL/absent still means physical device, so turning
    # this on cannot silently migrate a deliberately device-bound user onto ACA
    # sandboxes.
    var.router_default_executor != null ? {
      defaultExecutor = var.router_default_executor
    } : {},

    # D6′: the ONLY reversible expression of the Table secret backend. The Table,
    # KEK, and role assignments in setup_ui.tf are create-once and stay put;
    # clearing this flag drops the router back to the Key Vault backend on the
    # next revision without destroying anything.
    var.enable_setup_table_backend ? {
      tableStore = {
        endpoint  = "https://${azurerm_storage_account.this.name}.table.core.windows.net"
        tableName = azurerm_storage_table.setup.name
        # VERSIONED key id (`.id`, not `.versionless_id`). Each record stores the
        # bare version segment it was wrapped with and unwraps against that
        # version; vault and key name are taken exclusively from this configured
        # value and never from anything a row supplies (D4′).
        keyId = azurerm_key_vault_key.setup_kek.id
      }
    } : {},
  )

  router_env_non_secret = {
    LINEAR_WORKSPACE_ID          = var.linear_workspace_id
    CYRUS_ROUTER_CONTAINERS_JSON = jsonencode(local.router_containers_config)
    CYRUS_ROUTER_BACKUP_BLOB_URL = local.router_containers_config.backupBlobUrl
    # Durable store for rotated Linear OAuth tokens. `/data` is wiped on every
    # deploy, so without this the router replays the tfvars-seeded refresh token
    # after each restart — a token Linear has already consumed and rotated,
    # which fails permanently with HTTP 400 (the 2026-07-30 outage). The router
    # UAI already holds Key Vault Secrets User + Secrets Officer (main.tf), which
    # is what reading and writing `cyrus-linear-refresh-<workspaceId>` needs.
    CYRUS_ROUTER_LINEAR_TOKEN_STORE_KEY_VAULT_URL = azurerm_key_vault.this.vault_uri
    CYRUS_ROUTER_ENTRA_TENANT_ID                  = var.entra_tenant_id
    CYRUS_ROUTER_ENTRA_AUDIENCE                   = var.entra_audience
    CYRUS_ROUTER_ENTRA_ALLOWED_DOMAIN             = var.entra_allowed_domain

    # STAGE 2 of D7 (see variables.tf). These are the ONLY inputs that make the
    # router register /setup*; the auth sidecar attached in stage 1 does not by
    # itself create a route. `entra` above is unrelated — it governs enrollment
    # bearer tokens for /enroll and says nothing about setup identity (D1′).
    CYRUS_ROUTER_SETUP_UI_ENABLED               = "true"
    CYRUS_ROUTER_SETUP_UI_AUTH_MODE             = var.setup_ui_auth_mode
    CYRUS_ROUTER_SETUP_UI_ID_TOKEN_AUDIENCE     = local.setup_ui_id_token_audience
    CYRUS_ROUTER_SETUP_UI_VERIFIED_HEADER_STRIP = tostring(var.setup_ui_verified_header_strip)
    CYRUS_ROUTER_SETUP_UI_ALLOWED_DOMAIN        = var.setup_ui_allowed_domain
    CYRUS_ROUTER_SETUP_UI_AUTO_PROVISION        = tostring(var.setup_ui_auto_provision_users)
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
    name                = "linear-workspaces-json"
    identity            = azurerm_user_assigned_identity.router.id
    key_vault_secret_id = azurerm_key_vault_secret.linear_workspaces_json.versionless_id
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

  # STAGE 1 of D7. Both secrets are consumed by the EasyAuth SIDECAR, not by the
  # router process — `authConfigs` resolves `clientSecretSettingName` and
  # `sasUrlSettingName` against this collection by name, which is why they are
  # declared here and gated on the same variable as the authConfigs resource in
  # setup_ui.tf. Neither is exposed to the container as an env var.
  dynamic "secret" {
    for_each = local.setup_auth_enabled ? toset(["setup-ui"]) : toset([])
    content {
      name                = "setup-ui-client-secret"
      identity            = azurerm_user_assigned_identity.router.id
      key_vault_secret_id = azurerm_key_vault_secret.setup_ui_client_secret[0].versionless_id
    }
  }
  dynamic "secret" {
    for_each = local.setup_auth_enabled ? toset(["setup-ui-token-store"]) : toset([])
    content {
      name                = "setup-ui-token-store-sas"
      identity            = azurerm_user_assigned_identity.router.id
      key_vault_secret_id = azurerm_key_vault_secret.setup_ui_token_store_sas[0].versionless_id
    }
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
        secret_name = "linear-workspace-token"
      }
      env {
        name        = "CYRUS_ROUTER_WORKSPACES_JSON"
        secret_name = "linear-workspaces-json"
      }
      env {
        name        = "LINEAR_WEBHOOK_SECRET"
        secret_name = "linear-webhook-secret"
      }
      env {
        name        = "LINEAR_CLIENT_ID"
        secret_name = "linear-client-id"
      }
      env {
        name        = "LINEAR_CLIENT_SECRET"
        secret_name = "linear-client-secret"
      }
      env {
        name  = "CYRUS_ROUTER_CONTAINERS_JSON"
        value = local.router_env_non_secret.CYRUS_ROUTER_CONTAINERS_JSON
      }
      env {
        name  = "CYRUS_ROUTER_BACKUP_BLOB_URL"
        value = local.router_env_non_secret.CYRUS_ROUTER_BACKUP_BLOB_URL
      }
      env {
        name  = "CYRUS_ROUTER_LINEAR_TOKEN_STORE_KEY_VAULT_URL"
        value = local.router_env_non_secret.CYRUS_ROUTER_LINEAR_TOKEN_STORE_KEY_VAULT_URL
      }
      env {
        name  = "AZURE_CLIENT_ID"
        value = azurerm_user_assigned_identity.router.client_id
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

      # STAGE 2 of D7. Everything below is gated on `enable_setup_ui`, which is
      # applied in its own apply AFTER stage 1 is live and verified. Until then
      # the router registers no /setup route and these vars are absent, so the
      # revision published by stage 1 exposes nothing new.
      dynamic "env" {
        for_each = local.setup_ui_enabled ? toset(["setup-ui"]) : toset([])
        content {
          name  = "CYRUS_ROUTER_SETUP_UI_ENABLED"
          value = local.router_env_non_secret.CYRUS_ROUTER_SETUP_UI_ENABLED
        }
      }
      # The router requires an explicit auth strategy when the UI is enabled and
      # refuses to start without one — it never infers identity handling from
      # the presence of `entra`.
      dynamic "env" {
        for_each = local.setup_ui_enabled ? toset(["setup-ui-mode"]) : toset([])
        content {
          name  = "CYRUS_ROUTER_SETUP_UI_AUTH_MODE"
          value = local.router_env_non_secret.CYRUS_ROUTER_SETUP_UI_AUTH_MODE
        }
      }
      dynamic "env" {
        for_each = local.setup_ui_enabled && var.setup_ui_auth_mode == "entra-token" ? toset(["setup-ui-aud"]) : toset([])
        content {
          name  = "CYRUS_ROUTER_SETUP_UI_ID_TOKEN_AUDIENCE"
          value = local.router_env_non_secret.CYRUS_ROUTER_SETUP_UI_ID_TOKEN_AUDIENCE
        }
      }
      # Only emitted for easyauth-headers, and only ever as "true" — variable
      # validation refuses that mode unless the live probe has been recorded.
      dynamic "env" {
        for_each = local.setup_ui_enabled && var.setup_ui_auth_mode == "easyauth-headers" ? toset(["setup-ui-strip"]) : toset([])
        content {
          name  = "CYRUS_ROUTER_SETUP_UI_VERIFIED_HEADER_STRIP"
          value = local.router_env_non_secret.CYRUS_ROUTER_SETUP_UI_VERIFIED_HEADER_STRIP
        }
      }
      dynamic "env" {
        for_each = local.setup_ui_enabled && var.setup_ui_allowed_domain != null ? toset(["setup-ui-domain"]) : toset([])
        content {
          name  = "CYRUS_ROUTER_SETUP_UI_ALLOWED_DOMAIN"
          value = local.router_env_non_secret.CYRUS_ROUTER_SETUP_UI_ALLOWED_DOMAIN
        }
      }
      dynamic "env" {
        for_each = local.setup_ui_enabled ? toset(["setup-ui-provision"]) : toset([])
        content {
          name  = "CYRUS_ROUTER_SETUP_UI_AUTO_PROVISION"
          value = local.router_env_non_secret.CYRUS_ROUTER_SETUP_UI_AUTO_PROVISION
        }
      }

      volume_mounts {
        name = "artifacts"
        path = "/data/artifacts"
      }

      # Rolling-update health gate. `revision_mode = "Single"` plus
      # min/max_replicas = 1 (above) keep exactly one router replica serving in
      # steady state, but they do NOT remove the rolling-overlap window: ACA
      # starts the new revision's replica while the old one is still serving.
      # Without a readiness probe ACA treats a merely-started container as
      # ready, so ingress can shift (and the old revision be deactivated)
      # before the router has opened its SQLite database and registered the
      # webhook route — which is how the 2026-07-26 emergency rollout ended up
      # with both revisions accepting the same work. This probe makes ACA hold
      # traffic on the previous revision until /healthz answers on the new one,
      # shortening (but never eliminating) that window. Correctness across it
      # comes from the router's own webhook idempotency claim — see
      # RouterStore.claimWebhookEvent — not from this probe.
      readiness_probe {
        transport               = "HTTP"
        port                    = 8787
        path                    = "/healthz"
        interval_seconds        = 5
        timeout                 = 3
        failure_count_threshold = 6
        success_count_threshold = 1
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
    # The Table backend needs both of these at RUNTIME, and neither is implied
    # by a reference in this resource. Ordering them ahead of the revision gives
    # RBAC propagation a head start instead of letting the first /setup read
    # fail on a role that exists but has not landed yet.
    azurerm_role_assignment.router_table_data_contributor,
    azurerm_role_assignment.router_kv_crypto_user,
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
