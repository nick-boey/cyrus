################################################################################
# Outputs (N8 — complete, paste-ready values, not fragments)
################################################################################

output "router_fqdn" {
  description = "Public ingress FQDN of the router Container App (e.g. 'app-cyrus-dev-router.kindocean-<hash>.australiaeast.azurecontainerapps.io'). Use this verbatim in your Linear webhook URL and as the public WSS host."
  value       = azurerm_container_app.router.latest_revision_fqdn
}

output "router_wss_url" {
  description = "Canonical WSS URL for containers to dial back to the router (`wss://<router_fqdn>`). Embedded into CYRUS_ROUTER_CONTAINERS_JSON."  
  value       = "wss://${azurerm_container_app.router.latest_revision_fqdn}"
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
