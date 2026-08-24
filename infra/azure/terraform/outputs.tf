################################################################################
# Outputs (N8 — complete, paste-ready values, not fragments)
################################################################################

output "router_fqdn" {
  description = "Public ingress FQDN of the router Container App (e.g. '<app-name>.<env-hash>.<region>.azurecontainerapps.io'). Use this verbatim in your Linear webhook URL and as the public WSS host."
  value       = azurerm_container_app.router.ingress[0].fqdn
}

output "router_app_name" {
  description = "Name of the router Container App (e.g. 'app-<project>-<environment>-router'). Needed by the image-tag reconciliation runbook to read the image the live revision is actually serving (`az containerapp show … --query 'properties.template.containers[0].image'`) and to compare it against `var.router_image`. See README → 'Router image tag policy'."
  value       = azurerm_container_app.router.name
}

output "router_image" {
  description = "The router image reference this stack is pinned to (echo of `var.router_image`). Surfaced so an operator can diff the declared pin against the image the live revision serves without opening tfvars — a mismatch means someone hand-patched the Container App and the next apply will revert it."
  value       = var.router_image
}

output "router_wss_url" {
  description = "Canonical WSS URL for containers to dial back to the router (`wss://<router_fqdn>`). Embedded into CYRUS_ROUTER_CONTAINERS_JSON."
  value       = "wss://${azurerm_container_app.router.ingress[0].fqdn}"
}

output "key_vault_name" {
  description = "Name of the router Key Vault. Operators set/rotate secrets here via `az keyvault secret set` or `az containerapp exec`."
  value       = azurerm_key_vault.this.name
}

output "sandbox_group_name" {
  description = "Name of the ACA sandbox group. Use with the `aca` CLI: `aca sandboxgroup show --name <this>`."
  value       = azapi_resource.sandbox_group.name
}

output "management_endpoint" {
  description = "ARM-emitted regional data-plane host for the sandbox group (`properties.managementEndpoint`). The ACA provider config prefers this over the client's region+baseUrl fallback. Examples observed: 'https://management.australiaeast.azuredevcompute.io'."
  value       = azapi_resource.sandbox_group.output.properties.managementEndpoint
}

output "cyrus_router_backup_blob_url" {
  description = "Container URL the router uploads `router.db` backups to. Storage Blob Data Contributor is granted both to the router UAI and (optionally) the operator principal."
  value       = "https://${azurerm_storage_account.this.name}.blob.core.windows.net/${azurerm_storage_container.router_backups.name}"
}

output "cyrus_router_containers_json" {
  description = "COMPLETE render of CYRUS_ROUTER_CONTAINERS_JSON (paste-ready). Contains no secret — image refs, router WSS URL, repository routing, the full `aca` block (subscription/RG/group/region/disk/cpu/memory/autoSuspend/egress/keepSnapshots/managementEndpoint), keyVaultUrl, artifactsDir, backupBlobUrl. Marked non-sensitive intentionally so `terraform output` prints it."
  value       = jsonencode(local.router_containers_config)
  sensitive   = false
}

output "resource_group_name" {
  description = "Name of the resource group containing every regional resource."
  value       = azurerm_resource_group.this.name
}

output "router_identity_principal_id" {
  description = "Principal id of the router's user-assigned managed identity. Useful for ad-hoc role grants during ops."
  value       = azurerm_user_assigned_identity.router.principal_id
}

output "sandbox_group_identity_principal_id" {
  description = "Principal id of the sandbox group's system-assigned identity. Grant this AcrPull on a private registry to use a private worker image."
  value       = azapi_resource.sandbox_group.output.identity.principalId
}

################################################################################
# Setup management UI (/setup)
#
# Three URLs, deliberately gated on DIFFERENT flags, so `terraform output` shows
# exactly which stage of the D7 rollout the stack is in:
#
#   redirect URI  always      — needed to configure Entra BEFORE stage 1
#   sign-in URL   stage 1     — provable sign-in while /setup still 404s
#   /setup URL    stage 2     — the routes exist
#
# A stack showing a sign-in URL but no /setup URL is mid-rollout and correct.
################################################################################

output "setup_ui_redirect_uri" {
  description = "The web redirect URI to register on the router Entra app registration for EasyAuth sign-in. Emitted unconditionally because it must be configured BEFORE `enable_setup_auth` is applied. `az ad app update --web-redirect-uris` REPLACES the whole list, so re-send the existing URIs alongside this one or you will break enrollment sign-in — README §11 step 2 has the read-then-write form."
  value       = "https://${azurerm_container_app.router.ingress[0].fqdn}/.auth/login/aad/callback"
}

output "setup_ui_sign_in_url" {
  description = "Entra sign-in entry point served by the ACA built-in auth sidecar. Non-null once STAGE 1 (`enable_setup_auth`) is applied — which is what lets you prove sign-in works while `/setup` still returns 404, before stage 2 creates any route. `/.auth/logout` ends the session. These endpoints are handled entirely by the sidecar; the router never sees them."
  value       = var.enable_setup_auth ? "https://${azurerm_container_app.router.ingress[0].fqdn}/.auth/login/aad" : null
}

output "setup_ui_url" {
  description = "Where teammates manage their own container environment variables. Non-null only after STAGE 2 (`enable_setup_ui`) is applied. Null while the stack is at stage 1 or has the feature off."
  value       = var.enable_setup_ui ? "https://${azurerm_container_app.router.ingress[0].fqdn}/setup" : null
}

output "setup_table_name" {
  description = "Name of the Azure Table holding one envelope-encrypted record per user. NULL unless `enable_setup_secret_store` is true. Once created it is persistent (D6') and inert until `enable_setup_table_backend` points the router at it. Use with `az storage entity query --table-name <this> --auth-mode login`."
  value       = one(azurerm_storage_table.setup[*].name)
}

output "setup_table_endpoint" {
  description = "Table service endpoint of the storage account holding the per-user secret records, exactly as rendered into `containers.tableStore.endpoint`. NULL unless `enable_setup_secret_store` is true. Needed by `cyrus router secrets migrate --to-endpoint`, which names its target explicitly so the copy can run BEFORE `enable_setup_table_backend` points the router at the Table."
  value       = var.enable_setup_secret_store ? azurerm_storage_account.this.primary_table_endpoint : null
}

output "setup_kek_versioned_key_id" {
  description = "VERSIONED Key Vault key id of the envelope-encryption KEK, exactly as rendered into `containers.tableStore.keyId`. NULL unless `enable_setup_secret_store` is true. Not a secret — it names a public key handle, and every wrap/unwrap URL is rebuilt from this configured value rather than from anything a stored record supplies. Records pin the version segment they were wrapped with, so old versions must stay ENABLED until a re-wrap pass has run."
  value       = one(azurerm_key_vault_key.setup_kek[*].id)
}

output "otel_logs_app_insights_name" {
  description = "Name of the workspace-based Application Insights component the router exports OTLP logs to. NULL unless `enable_otel_logs` is true. Purely an OTLP endpoint — it stores nothing of its own; every record lands in the same Log Analytics workspace the Container Apps environment already ships router stdout to (see `log_analytics_workspace_name`)."
  value       = one(azurerm_application_insights.otel[*].name)
}

output "log_analytics_workspace_name" {
  description = "The single Log Analytics workspace behind every query in monitoring.tf. Both log paths land here: the router's stdout as ContainerAppConsoleLogs_CL (via the Container Apps environment) and, when `enable_otel_logs` is set, its OTLP records as AppTraces (via Application Insights)."
  value       = azurerm_log_analytics_workspace.this.name
}

output "otel_logs_query" {
  description = "Paste-ready KQL for the router's OTLP log stream. NULL unless `enable_otel_logs` is true. Note the table: OTLP records land in AppTraces, NOT the ContainerAppConsoleLogs_CL that every saved search in monitoring.tf reads — those queries are unaffected by this feature and do not see these records."
  value = var.enable_otel_logs ? join("\n", [
    "AppTraces",
    "| where AppRoleName == \"${local.router_app_name}\" or AppRoleName == \"cyrus-router\"",
    "| extend component = tostring(Properties.component), event = tostring(Properties.event)",
    "| project TimeGenerated, SeverityLevel, component, event, Message, Properties",
    "| order by TimeGenerated desc",
  ]) : null
}
