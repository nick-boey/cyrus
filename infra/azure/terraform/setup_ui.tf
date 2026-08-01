################################################################################
# Setup management UI — ACA built-in auth (EasyAuth) + per-user secret storage
#
# This file holds BOTH halves of the /setup feature, because they are governed
# by opposite lifecycle rules and it is worth seeing that contrast in one place:
#
#   1. AUTHENTICATION (D7) is STAGED and REVERSIBLE. Two variables applied in
#      two separate applies — `enable_setup_auth` then `enable_setup_ui` — with
#      a live verification gate in between. Both roll back cleanly.
#
#   2. PER-USER SECRET STORAGE (D6') is CREATE-ONCE and PERSISTENT. The Table,
#      the KEK, and the two role assignments are NOT flag-gated at all. Rollback
#      is expressed only by dropping `containers.tableStore` from the rendered
#      router config (`enable_setup_table_backend = false`), never by destroying
#      the key that decrypts every stored secret.
################################################################################

locals {
  # Stage 1 of D7. Creates the sidecar and everything it needs. Deliberately
  # does NOT enable any /setup route.
  setup_auth_enabled = var.enable_setup_auth

  # Stage 2 of D7. Only sets CYRUS_ROUTER_SETUP_UI_* on the container, which is
  # what actually makes the router register /setup*. Gated by variable
  # validation on `enable_setup_auth` + `setup_auth_stage1_verified` so it
  # cannot legitimately be reached in the same apply as stage 1.
  setup_ui_enabled = var.enable_setup_ui

  # A2/D2′: an EasyAuth **ID** token carries the BARE CLIENT-ID GUID in `aud`,
  # not the `api://<client-id>` Application ID URI that `entra_audience` holds
  # (that is the *access* token audience used by /enroll). `entra-token` mode
  # verifies the ID token, so it must be told the client id. Defaulting here
  # keeps the two audiences from being conflated by hand.
  setup_ui_id_token_audience = (
    var.setup_ui_id_token_audience != null
    ? var.setup_ui_id_token_audience
    : var.setup_ui_client_id
  )

  setup_ui_token_store_container_name = "setup-ui-token-store"

  # Fixed names. Both are referenced by rendered router config and by the
  # decommissioning runbook, so they are locals rather than variables: renaming
  # either one is a data migration, not a configuration change.
  setup_table_name = "cyrussetup"
  setup_kek_name   = "cyrus-setup-kek"

  # F5: auto-provisioning turns "can obtain a token for this app" into "is a
  # Cyrus user with a secret store". That is only safe when membership is
  # actually restricted, which is either an authConfigs allowedPrincipals policy
  # (below) or an Entra assignment requirement + group assignment performed out
  # of band. `setup_ui_auto_provision_users` is validated against exactly this.
  setup_ui_allowed_principals_configured = (
    length(var.setup_ui_allowed_group_object_ids) > 0 ||
    length(var.setup_ui_allowed_principal_object_ids) > 0
  )
}

################################################################################
# STAGE 1 — Entra client secret for the auth sidecar
#
# The app registration itself (ID token issuance, the redirect URI, the client
# secret, "Assignment required", and the group assignment) is managed OUT OF
# BAND with `az ad` — see README §11. Terraform does not hold Entra directory
# write permissions in this stack, and widening the apply identity to get them
# would be a much larger blast radius than this feature justifies. The exact
# redirect URI to register is emitted as the `setup_ui_redirect_uri` output so
# the runbook can consume it with `terraform output -raw`.
################################################################################

resource "azurerm_key_vault_secret" "setup_ui_client_secret" {
  count        = local.setup_auth_enabled ? 1 : 0
  name         = "setup-ui-client-secret"
  value        = var.setup_ui_client_secret
  key_vault_id = azurerm_key_vault.this.id
  # No expiry — rotating this secret means rotating it in Entra first, then
  # `az keyvault secret set`. The Container App references it by
  # `versionless_id`, so a rotation reaches the sidecar on the next revision
  # without a Terraform apply. See README → "Rotating the setup UI secrets".
  tags = local.default_tags
}

################################################################################
# STAGE 1 — token store
#
# `entra-token` is the RECOMMENDED router auth mode (D1′): the app
# cryptographically verifies the ID token the sidecar forwards in
# `X-MS-TOKEN-AAD-ID-TOKEN`, so a forged `X-MS-CLIENT-PRINCIPAL-*` header is
# ignored no matter what sits in front of the process. That header is only
# forwarded when the ACA **token store** is enabled, which is why this container
# exists.
#
# The alternative router mode, `easyauth-headers`, trusts the injected identity
# headers instead. It ADDITIONALLY requires the live header-strip verification
# (README §11 step 4) to have been run and its result recorded in
# `setup_ui_verified_header_strip` — the router refuses to start otherwise. Even
# then it is the weaker posture, because its trust boundary is proxy topology
# rather than a signature.
#
# API-VERSION CONSTRAINT: `Microsoft.App/containerApps/authConfigs@2024-03-01`
# models `BlobStorageTokenStore` with exactly one property — `sasUrlSettingName`
# (required). There is no managed-identity token store (`blobContainerUri` /
# `managedIdentityResourceId`) on ANY Microsoft.App authConfigs API version
# available today, so a SAS is not a shortcut here, it is the only shape the
# resource accepts. The SAS window is therefore explicit operator input
# (`setup_ui_token_store_sas_start` / `_expiry`) rather than
# `timeadd(timestamp(), …)`, which would re-evaluate on every plan and produce
# permanent diff noise on a live router.
################################################################################

resource "azurerm_storage_container" "setup_ui_token_store" {
  count                 = local.setup_auth_enabled ? 1 : 0
  name                  = local.setup_ui_token_store_container_name
  storage_account_id    = azurerm_storage_account.this.id
  container_access_type = "private"

  # Unlike the Table and the KEK below, this container is safe to destroy: it
  # holds only cached OAuth session/refresh tokens. Losing it signs everyone out
  # of /setup and nothing else, which is why it is flag-gated and they are not.
}

data "azurerm_storage_account_blob_container_sas" "setup_ui_token_store" {
  count             = local.setup_auth_enabled ? 1 : 0
  connection_string = azurerm_storage_account.this.primary_connection_string
  container_name    = azurerm_storage_container.setup_ui_token_store[0].name
  https_only        = true

  start  = var.setup_ui_token_store_sas_start
  expiry = var.setup_ui_token_store_sas_expiry

  permissions {
    read   = true
    add    = true
    create = true
    write  = true
    delete = true
    list   = true
  }
}

resource "azurerm_key_vault_secret" "setup_ui_token_store_sas" {
  count = local.setup_auth_enabled ? 1 : 0
  name  = "setup-ui-token-store-sas"
  value = join("", [
    "https://${azurerm_storage_account.this.name}.blob.core.windows.net/${local.setup_ui_token_store_container_name}",
    data.azurerm_storage_account_blob_container_sas.setup_ui_token_store[0].sas,
  ])
  key_vault_id = azurerm_key_vault.this.id
  tags         = local.default_tags
}

################################################################################
# STAGE 1 — the authConfigs child resource
#
# `unauthenticatedClientAction = "AllowAnonymous"` is DELIBERATE, not an
# oversight. The router serves machine routes on the same ingress: artifact and
# teardown routes with dynamic path segments
# (/artifacts/issues/:issueKey/bundle, /containers/issues/:issueKey/
# teardown-complete), a WebSocket upgrade at /device, the Linear webhook at
# /linear-webhook, and the /healthz endpoint that ACA's own readiness probe
# depends on. `globalValidation.excludedPaths` is a plain path list with no
# documented wildcard semantics, so a default-deny posture would 302 webhook
# deliveries and every worker's WSS reconnect to a login page — an outage, not a
# hardening. Authentication for /setup* is enforced INSIDE the router instead,
# per D1′, where the strategy is explicit and testable.
#
# What the sidecar still does under AllowAnonymous: it runs the sign-in flow at
# /.auth/*, and for a request that carries a valid session it injects the
# identity headers and (with the token store on) the ID token. A request that
# fails `defaultAuthorizationPolicy` gets no identity — so the policy below is a
# real control even with anonymous pass-through, because the router then sees no
# principal and answers 401.
################################################################################

resource "azapi_resource" "router_auth" {
  count = local.setup_auth_enabled ? 1 : 0
  type  = "Microsoft.App/containerApps/authConfigs@2024-03-01"
  # "current" is the ONLY name this child resource accepts.
  name      = "current"
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
        routes = {
          apiPrefix = "/.auth"
        }
      }
      login = {
        tokenStore = {
          enabled = true
          azureBlobStorage = {
            # Resolves against the Container App's `secrets` collection, which
            # is why the matching `secret {}` block in router.tf is gated on the
            # same variable.
            sasUrlSettingName = "setup-ui-token-store-sas"
          }
        }
      }
      identityProviders = {
        azureActiveDirectory = {
          enabled = true
          registration = {
            openIdIssuer            = "https://login.microsoftonline.com/${var.entra_tenant_id}/v2.0"
            clientId                = var.setup_ui_client_id
            clientSecretSettingName = "setup-ui-client-secret"
          }
          validation = merge(
            {
              # The bare client id is the ID token audience (A2). The
              # `api://<client-id>` Application ID URI is the ACCESS token
              # audience already used by /enroll; including both lets the one
              # app registration serve sign-in and enrollment (D2).
              allowedAudiences = compact([
                var.setup_ui_client_id,
                var.entra_audience,
              ])
            },
            # Omitted entirely when neither list is populated: sending an empty
            # allowedPrincipals is not the same as sending none, and the safe
            # reading of "unset" is "the Entra assignment requirement is the
            # gate" — which `setup_ui_assignment_required_verified` attests to.
            local.setup_ui_allowed_principals_configured ? {
              defaultAuthorizationPolicy = {
                allowedPrincipals = {
                  groups     = var.setup_ui_allowed_group_object_ids
                  identities = var.setup_ui_allowed_principal_object_ids
                }
              }
            } : {},
          )
        }
      }
    }
  }

  # The sidecar resolves `clientSecretSettingName` / `sasUrlSettingName` against
  # the Container App's secrets, so the app (and its secret blocks) must exist
  # first. The Container App does NOT depend on this resource, so there is no
  # cycle — and that asymmetry is exactly why D7 needs two applies rather than
  # one: a single flag would necessarily publish the /setup revision before this
  # resource could attach.
  depends_on = [azurerm_container_app.router]
}

################################################################################
# PER-USER SECRET STORAGE (NOR-269 / D6′) — CREATE-ONCE AND PERSISTENT
#
# Read this before adding a `count` to anything below.
#
# These four resources are deliberately NOT flag-gated. An earlier design gated
# them on `enable_setup_table` while carrying `prevent_destroy = true` on the
# KEK, which turns "flip the flag back" into a guaranteed plan failure dressed
# up as a feature flag. Worse, if the guard were ever removed to make the flag
# "work", flipping it would delete the key that unwraps every stored per-user
# secret — unrecoverably, since the wrapped DEKs are useless without it.
#
# So: the Table, the KEK, and the two role assignments are created once and kept.
# They are cheap (an empty Table and an unused RSA key cost effectively nothing)
# and inert until something reads them.
#
# Rollback of the FEATURE is `enable_setup_table_backend = false`, which removes
# `containers.tableStore` from the rendered router config and drops the router
# straight back to the Key Vault backend. No destroy, no data loss, one revision.
#
# DECOMMISSIONING is a separate, explicit, gated workflow — export and verify,
# disable the backend, retire key versions, then remove the resources and their
# state entries by hand. It is written up in README → "Decommissioning the
# per-user secret store". `prevent_destroy` below is what forces that path.
################################################################################

resource "azurerm_storage_table" "setup" {
  name               = local.setup_table_name
  storage_account_id = azurerm_storage_account.this.id

  lifecycle {
    prevent_destroy = true
  }
}

# RSA key used ONLY to wrap/unwrap the per-record AES-256-GCM data encryption
# keys — it never sees a plaintext secret. `key_opts` is minimal on purpose.
#
# Creating this requires the APPLYING principal to hold "Key Vault Crypto
# Officer" on the vault. The stack's existing Secrets User / Secrets Officer
# grants are for the ROUTER identity and cover secrets only, not key operations;
# neither one lets you create a key. See README → "Setup UI prerequisites".
resource "azurerm_key_vault_key" "setup_kek" {
  name         = local.setup_kek_name
  key_vault_id = azurerm_key_vault.this.id
  key_type     = "RSA"
  key_size     = 2048
  key_opts     = ["wrapKey", "unwrapKey"]
  tags         = local.default_tags

  # Rotating the KEK does NOT re-wrap existing rows: each record stores the
  # 32-hex KEK *version* it was wrapped with (never a URL — D4′) and unwraps
  # against that version, with the vault and key name taken exclusively from
  # `containers.tableStore.keyId` below. Old key versions must therefore stay
  # ENABLED until a re-wrap pass has run.
  lifecycle {
    prevent_destroy = true
  }
}

# Table-scoped, not account-scoped: this grant must not reach the router-backups
# blob container or the artifacts share.
resource "azurerm_role_assignment" "router_table_data_contributor" {
  scope                = azurerm_storage_table.setup.resource_manager_id
  role_definition_name = "Storage Table Data Contributor"
  principal_id         = azurerm_user_assigned_identity.router.principal_id
}

# Vault-scoped. "Key Vault Crypto User" grants wrapKey/unwrapKey and is a
# DIFFERENT role from the Secrets User + Secrets Officer assignments in main.tf,
# neither of which permits any key operation.
resource "azurerm_role_assignment" "router_kv_crypto_user" {
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Crypto User"
  principal_id         = azurerm_user_assigned_identity.router.principal_id
}
