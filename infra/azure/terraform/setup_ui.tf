################################################################################
# Setup management UI — ACA built-in auth (EasyAuth) + per-user secret storage
#
# This file holds BOTH halves of the /setup feature, because they are governed
# by opposite lifecycle rules and it is worth seeing that contrast in one place:
#
#   1. AUTHENTICATION (D7) is STAGED and REVERSIBLE. Two variables applied in
#      two separate applies — `enable_setup_auth` then `enable_setup_ui` — and
#      the ordering is ENFORCED AGAINST REMOTE STATE, not attested. See
#      `data.azapi_resource.setup_auth_existing` below and the preconditions on
#      `azurerm_container_app.router`. Both stages roll back cleanly.
#
#   2. PER-USER SECRET STORAGE (D6') is CREATE-ONCE and PERSISTENT, but it is
#      OPT-IN: nothing here is created unless `enable_setup_secret_store` is
#      true, so a stack that wants neither /setup nor the Table backend gets a
#      strictly empty diff from this file. The flag is ONE-WAY BY CONVENTION —
#      flipping it back does not destroy the KEK or the Table; `prevent_destroy`
#      converts that attempt into a loud plan failure. Feature rollback is the
#      SELECTOR (`enable_setup_table_backend = false`), never a destroy.
################################################################################

locals {
  # Stage 1 of D7. Creates the sidecar and everything it needs. Deliberately
  # does NOT enable any /setup route.
  setup_auth_enabled = var.enable_setup_auth

  # Stage 2 of D7. Only sets CYRUS_ROUTER_SETUP_UI_* on the container, which is
  # what actually makes the router register /setup*.
  setup_ui_enabled = var.enable_setup_ui

  # Resource id of the authConfigs child, assembled from INPUT VARIABLES AND A
  # PROVIDER DATA SOURCE ONLY.
  #
  # DO NOT "simplify" this to
  #   "${azurerm_container_app.router.id}/authConfigs/current"
  # or to `azapi_resource.router_auth[0].id`, and do not swap the data source
  # below for `name`/`parent_id` fed from a managed resource. Every one of those
  # forms makes the id UNKNOWN at plan time on a fresh stack, which makes the
  # data source deferred, which makes the preconditions that consume it
  # deferred, which deletes the entire ordering guarantee — silently, and
  # precisely in the case (first apply of a brand-new stack) that the guarantee
  # is for. `local.router_app_name` (main.tf), `local.resource_group_name`
  # (main.tf) and `data.azurerm_client_config.current` are all resolvable
  # before any resource is touched, which is the whole point.
  setup_auth_config_resource_id = join("", [
    "/subscriptions/${data.azurerm_client_config.current.subscription_id}",
    "/resourceGroups/${local.resource_group_name}",
    "/providers/Microsoft.App/containerApps/${local.router_app_name}",
    "/authConfigs/current",
  ])

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
# The router ALSO implements `easyauth-headers`, which trusts the injected
# identity headers instead of verifying a signature. That mode is NOT reachable
# from this stack — `setup_ui_auth_mode` validation refuses it (see
# variables.tf). Its trust boundary is proxy topology, which is a property of
# the deployed ingress and cannot be established from configuration; a
# Terraform-managed ACA deployment therefore always uses the token mode. The
# mode remains supported in the application for self-hosted deployments that
# are not behind ACA and can reason about their own front door.
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
        # REQUIRED for /setup to be able to SAVE anything, not a redirect nicety.
        #
        # EasyAuth's built-in CSRF mitigation rejects a request when ALL of:
        #   1. it is a POST authenticated by the session cookie,
        #   2. the User-Agent says a real browser sent it,
        #   3. Origin/Referer is absent or not in THIS list, and
        #   4. Origin is absent or not in the ingress CORS origin list.
        # The /setup page's htmx save is 1 and 2 by construction, and with this
        # list empty it was also 3 and 4 — so the sidecar returned a BODYLESS
        # 403 before the router ever saw the request. The page rendered and read
        # correctly while every write died silently in front of the app, which
        # is why it looked like an application bug.
        #
        # Listing our own origin breaks condition 3. It widens nothing: this is
        # the origin EasyAuth already redirects back to after sign-in.
        # https://learn.microsoft.com/azure/app-service/overview-authentication-authorization
        allowedExternalRedirectUrls = [
          "https://${azurerm_container_app.router.ingress[0].fqdn}",
        ]
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
# STAGE-ORDERING ENFORCEMENT (R2-01)
#
# THIS DATA SOURCE IS THE GATE. Read the whole comment before editing it.
#
# The previous design gated stage 2 on `setup_auth_stage1_verified`, an operator
# boolean. A boolean supplied in the same plan cannot express "a PREVIOUS apply
# created the auth child", so nothing stopped `enable_setup_auth`,
# `setup_auth_stage1_verified` and `enable_setup_ui` all being set true at once
# — in CI, by a merge, or by an operator editing one tfvars file. Because
# `azapi_resource.router_auth` depends on the Container App, that single apply
# publishes a revision that serves /setup BEFORE the auth child attaches: the
# exact public window the staging exists to prevent.
#
# A data source is different in kind, not just in strictness. It is answered by
# ARM against REAL REMOTE STATE at plan time. `exists = false` is therefore a
# statement about deployment history that no combination of input values can
# fake. That is why the enforcement lives here and not in another validation.
#
# THREE PROPERTIES MUST BE PRESERVED BY ANY FUTURE EDIT:
#
#   1. `resource_id` must stay free of managed-resource references (see
#      `local.setup_auth_config_resource_id`). An unknown id defers the read,
#      and a deferred read defers the preconditions — the gate quietly becomes
#      a no-op on a fresh stack.
#   2. `ignore_not_found = true` must stay. Without it a missing auth child is a
#      raw ARM 404 from the provider; with it we get `exists` and can fail with
#      an error message that says what to do.
#   3. The consumers must be `precondition` blocks (hard failures), not `check`
#      blocks — a `check` warns and applies anyway.
#
# Reading LIVE PROPERTIES (not merely existence) is deliberate: an authConfigs
# child can exist with `platform.enabled = false`, or with the Entra identity
# provider disabled, in which case no identity is ever injected and /setup would
# again be reachable without authentication.
################################################################################

data "azapi_resource" "setup_auth_existing" {
  count = var.enable_setup_ui ? 1 : 0

  type        = "Microsoft.App/containerApps/authConfigs@2024-03-01"
  resource_id = local.setup_auth_config_resource_id

  # A stack that has never applied stage 1 — or a fresh stack where the Container
  # App itself does not exist yet — answers 404 here. That is a legitimate
  # (and expected) outcome, not a provider error, so it must not abort the plan
  # before the preconditions get a chance to explain it.
  ignore_not_found = true

  # Whole body. The preconditions traverse it with `try()`, so a shape change in
  # a future API version degrades to "gate refuses" rather than "gate crashes".
  response_export_values = ["*"]
}

################################################################################
# PER-USER SECRET STORAGE (D6′) — OPT-IN, THEN CREATE-ONCE
#
# Read this before changing the gating below. It reconciles two requirements
# that look contradictory and are not.
#
# REQUIREMENT A (R2-06). A deployment that enables neither `setupUi` nor the
# Table backend must produce a STRICTLY EMPTY diff. Creating these resources
# unconditionally failed that: an unrelated apply on an existing production
# stack would try to create an RSA key and grant the router two new roles, and
# would hard-fail outright if the applying principal lacked "Key Vault Crypto
# Officer". Hence `var.enable_setup_secret_store`, default FALSE.
#
# REQUIREMENT B (D6′). The KEK and the Table must NOT be destroyable by flipping
# a flag back. The wrapped DEKs are useless without the KEK, so destroying it
# destroys every stored secret irrecoverably.
#
# THE RECONCILIATION. `enable_setup_secret_store` is a CREATION flag and it is
# ONE-WAY BY CONVENTION. `prevent_destroy` on the Table and the KEK is what
# makes the convention enforceable: flipping the flag back to false does not
# destroy them, it produces a hard plan error naming the protected resource.
# That is the intended and documented behaviour, not a bug — the flag's job is
# to keep resources from being created, never to remove them once they hold
# key material.
#
# TRADEOFF, STATED PLAINLY. `count` + `prevent_destroy` means the flag is not
# symmetric: on -> off is refused at plan time. An operator who genuinely wants
# these gone must follow the decommissioning runbook (export and verify, disable
# the backend, retire key versions, `terraform state rm`, delete by hand). We
# accept an asymmetric flag over the alternative — a flag whose "off" position
# silently deletes the only key that can read the data.
#
# The two ROLE ASSIGNMENTS carry no `prevent_destroy`: they hold no state, and
# re-granting them is idempotent. They follow the flag in both directions so
# that turning the feature off before it was ever used leaves no privilege
# behind.
#
# ROLLBACK OF THE FEATURE remains `enable_setup_table_backend = false`, which
# removes `containers.tableStore` from the rendered router config and drops the
# router back to the Key Vault backend. No destroy, no data loss, one revision.
################################################################################

resource "azurerm_storage_table" "setup" {
  count              = var.enable_setup_secret_store ? 1 : 0
  name               = local.setup_table_name
  storage_account_id = azurerm_storage_account.this.id

  # Deliberately interacts with `count` as described above: setting
  # `enable_setup_secret_store = false` after this Table exists is REFUSED, not
  # silently destructive.
  lifecycle {
    prevent_destroy = true
  }
}

# RSA key used ONLY to wrap/unwrap the per-record AES-256-GCM data encryption
# keys — it never sees a plaintext secret. `key_opts` is minimal on purpose.
#
# Creating this requires the APPLYING principal to hold "Key Vault Crypto
# Officer" on the vault. Verified against main.tf: the only vault grants this
# stack makes are `router_kv_secrets_user` ("Key Vault Secrets User") and
# `router_kv_secrets_officer` ("Key Vault Secrets Officer"), both to the ROUTER
# identity, and both scoped to secrets — neither permits any key operation, and
# neither applies to the principal running `terraform apply`. That missing
# permission is exactly why this resource must not be created by a stack that
# never asked for the feature. See README → "Setup UI prerequisites".
resource "azurerm_key_vault_key" "setup_kek" {
  count        = var.enable_setup_secret_store ? 1 : 0
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
  #
  # And see the block comment above: this guard is what makes
  # `enable_setup_secret_store` one-way rather than data-destroying.
  lifecycle {
    prevent_destroy = true
  }
}

# Table-scoped, not account-scoped: this grant must not reach the router-backups
# blob container or the artifacts share.
resource "azurerm_role_assignment" "router_table_data_contributor" {
  count                = var.enable_setup_secret_store ? 1 : 0
  scope                = azurerm_storage_table.setup[0].resource_manager_id
  role_definition_name = "Storage Table Data Contributor"
  principal_id         = azurerm_user_assigned_identity.router.principal_id
}

# Vault-scoped. "Key Vault Crypto User" grants wrapKey/unwrapKey and is a
# DIFFERENT role from the Secrets User + Secrets Officer assignments in main.tf,
# neither of which permits any key operation (re-verified against main.tf when
# this gating was added).
resource "azurerm_role_assignment" "router_kv_crypto_user" {
  count                = var.enable_setup_secret_store ? 1 : 0
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Crypto User"
  principal_id         = azurerm_user_assigned_identity.router.principal_id
}
