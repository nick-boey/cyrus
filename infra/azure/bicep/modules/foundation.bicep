// Foundation: everything in the resource group except the sandbox group, the
// router Container App, its auth child, and monitoring.
//
// Mirrors what main.tf plus the storage half of setup_ui.tf used to hold:
// Log Analytics, Key Vault (RBAC mode) and its seeded secrets, the router
// user-assigned identity, the storage account and its three children, the
// Container Apps environment and its Azure Files link, the optional ACR, every
// role assignment, and the opt-in per-user secret store (Table + KEK).

@description('Resource name root, <project>-<environment>.')
@minLength(4)
param namePrefix string

@description('Resource name root with dashes removed, for resources that disallow them.')
@minLength(3)
param flatNamePrefix string

param location string
param tags object

@description('Provision an Azure Container Registry and grant the router identity AcrPull on it.')
param enableAcr bool

@description('Optional Entra principal id granted break-glass Storage Blob Data Contributor on the router-backups container. Empty to skip.')
param operatorPrincipalId string

param linearWorkspaceId string

@secure()
param linearWorkspaceToken string

@secure()
param linearWorkspaceRefreshToken string

@secure()
param linearWebhookSecret string

@secure()
param linearClientId string

@secure()
param linearClientSecret string

@description('Stage 1 of the /setup rollout: seed the Entra client secret and create the token-store container and its SAS secret.')
param enableSetupAuth bool

@secure()
param setupUiClientSecret string

param setupUiTokenStoreSasStart string
param setupUiTokenStoreSasExpiry string

@description('Create the Azure Table, the envelope-encryption KEK, and the router\'s two additional role assignments.')
param enableSetupSecretStore bool

////////////////////////////////////////////////////////////////////////////////
// Built-in role definition ids
//
// Built-in roles carry the same GUID in every tenant, which is why they are
// written as constants here. Bicep has no equivalent of Terraform's
// `data.azurerm_role_definition` name lookup. Verify any of them with:
//   az role definition list --name "<display name>" --query "[].name" -o tsv
////////////////////////////////////////////////////////////////////////////////

var roleIds = {
  keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
  keyVaultSecretsOfficer: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
  keyVaultCryptoUser: '12338af0-0e69-4776-bea7-57ae8d297424'
  storageBlobDataContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
  storageTableDataContributor: '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d'
}

// Fixed names. Both are referenced by the rendered router config and by the
// decommissioning runbook, so they are constants rather than parameters:
// renaming either one is a data migration, not a configuration change.
var setupTableNameValue = 'cyrussetup'
var setupKekName = 'cyrus-setup-kek'
var tokenStoreContainerName = 'setup-ui-token-store'
var routerBackupsContainerName = 'router-backups'
var artifactsShareName = 'artifacts'

////////////////////////////////////////////////////////////////////////////////
// Log Analytics (router Container Apps environment diagnostics)
////////////////////////////////////////////////////////////////////////////////

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${namePrefix}'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

////////////////////////////////////////////////////////////////////////////////
// Key Vault (RBAC mode, no purge protection for dev ergonomics)
////////////////////////////////////////////////////////////////////////////////

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'kv-${namePrefix}'
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    // `enablePurgeProtection` is deliberately ABSENT rather than false. ARM
    // rejects an explicit `false` on this property once a vault exists, and
    // rejects turning it off at all — so writing `false` would make the template
    // undeployable rather than expressing "off".
    softDeleteRetentionInDays: 7
    // Open network for dev. The spike created the vault with default_action
    // Allow. Tighten to your VNet/IP list in prod.
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

////////////////////////////////////////////////////////////////////////////////
// Router managed identity
////////////////////////////////////////////////////////////////////////////////

resource routerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${namePrefix}-router'
  location: location
  tags: tags
}

////////////////////////////////////////////////////////////////////////////////
// Storage: Azure Files share (artifacts), blob container (router-backups),
// optional token-store container, optional per-user secret Table
////////////////////////////////////////////////////////////////////////////////

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'st${flatNamePrefix}'
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    // Shared-key access must stay ON: the Container Apps Azure Files link and
    // the token-store service SAS are both keyed on the account key.
    allowSharedKeyAccess: true
  }
}

resource fileServices 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource artifactsShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileServices
  name: artifactsShareName
  properties: {
    shareQuota: 50
  }
}

resource blobServices 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource routerBackups 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobServices
  name: routerBackupsContainerName
  properties: {
    publicAccess: 'None'
  }
}

// STAGE 1 — token store.
//
// `entra-token` is the router's auth mode here: it cryptographically verifies
// the ID token the sidecar forwards in `X-MS-TOKEN-AAD-ID-TOKEN`, so a forged
// `X-MS-CLIENT-PRINCIPAL-*` header is ignored no matter what sits in front of
// the process. That header is only forwarded when the ACA token store is
// enabled, which is why this container exists.
//
// Unlike the Table and the KEK below, this container is safe to delete: it holds
// only cached OAuth session/refresh tokens. Losing it signs everyone out of
// /setup and nothing else.
resource tokenStore 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = if (enableSetupAuth) {
  parent: blobServices
  name: tokenStoreContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource tableServices 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = if (enableSetupSecretStore) {
  parent: storage
  name: 'default'
}

resource setupTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = if (enableSetupSecretStore) {
  parent: tableServices
  name: setupTableNameValue
}

////////////////////////////////////////////////////////////////////////////////
// Container Apps environment
////////////////////////////////////////////////////////////////////////////////

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${namePrefix}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

resource artifactsEnvironmentStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: containerAppsEnvironment
  name: artifactsShareName
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage.listKeys().keys[0].value
      shareName: artifactsShare.name
      accessMode: 'ReadWrite'
    }
  }
}

////////////////////////////////////////////////////////////////////////////////
// Optional Azure Container Registry (private worker/router images)
////////////////////////////////////////////////////////////////////////////////

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = if (enableAcr) {
  name: 'acr${flatNamePrefix}'
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
  }
}

////////////////////////////////////////////////////////////////////////////////
// Key Vault seed secrets
//
// Seeded on first deploy and operator-owned thereafter — re-deploying with a
// stale parameter value OVERWRITES an operator rotation. Rotate via
// `az keyvault secret set` and update the parameter file in the same change.
//
// No expiry is set on any of them: an expiry derived from utcNow() would
// re-evaluate on every deployment and produce a new secret version — and
// therefore a new router revision — each time.
////////////////////////////////////////////////////////////////////////////////

resource linearWorkspaceTokenSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'linear-workspace-token'
  tags: tags
  properties: {
    value: linearWorkspaceToken
  }
}

resource linearWorkspacesJsonSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'linear-workspaces-json'
  tags: tags
  properties: {
    value: string({
      '${linearWorkspaceId}': {
        linearToken: linearWorkspaceToken
        linearRefreshToken: linearWorkspaceRefreshToken
      }
    })
  }
}

resource linearWebhookSecretSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'linear-webhook-secret'
  tags: tags
  properties: {
    value: linearWebhookSecret
  }
}

resource linearClientIdSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'linear-client-id'
  tags: tags
  properties: {
    value: linearClientId
  }
}

resource linearClientSecretSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'linear-client-secret'
  tags: tags
  properties: {
    value: linearClientSecret
  }
}

// STAGE 1 — the two secrets the EasyAuth SIDECAR consumes. Neither is exposed to
// the router container as an env var; `authConfigs` resolves
// clientSecretSettingName / sasUrlSettingName against the Container App's
// `secrets` collection by name, which is why the matching secret entries in
// router-app.bicep are gated on the same flag.
resource setupUiClientSecretSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (enableSetupAuth) {
  parent: keyVault
  name: 'setup-ui-client-secret'
  tags: tags
  properties: {
    value: setupUiClientSecret
  }
}

// `Microsoft.App/containerApps/authConfigs@2024-03-01` models
// `BlobStorageTokenStore` with exactly one property — `sasUrlSettingName`
// (required). There is no managed-identity token store on ANY shipped
// Microsoft.App authConfigs API version, so a SAS is not a shortcut here, it is
// the only shape the resource accepts.
//
// `listServiceSas` is deterministic for a fixed window and account key, so this
// secret does not churn between deployments — which is exactly why the window is
// explicit operator input rather than something derived from utcNow().
var tokenStoreSasToken = enableSetupAuth
  ? storage.listServiceSas('2023-05-01', {
      canonicalizedResource: '/blob/${storage.name}/${tokenStoreContainerName}'
      signedResource: 'c'
      // Canonical order (racwdxltmeop); Azure rejects any other ordering.
      signedPermission: 'racwdl'
      signedProtocol: 'https'
      signedStart: setupUiTokenStoreSasStart
      signedExpiry: setupUiTokenStoreSasExpiry
    }).serviceSasToken
  : ''

resource setupUiTokenStoreSasSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (enableSetupAuth) {
  parent: keyVault
  name: 'setup-ui-token-store-sas'
  tags: tags
  properties: {
    value: 'https://${storage.name}.blob.${az.environment().suffixes.storage}/${tokenStoreContainerName}?${tokenStoreSasToken}'
  }
  dependsOn: [
    tokenStore
  ]
}

// RSA key used ONLY to wrap/unwrap the per-record AES-256-GCM data encryption
// keys — it never sees a plaintext secret. `keyOps` is minimal on purpose.
//
// Rotating the KEK does NOT re-wrap existing rows: each record stores the KEK
// VERSION it was wrapped with (never a URL — D4') and unwraps against that
// version, with the vault and key name taken exclusively from
// `containers.tableStore.keyId`. Old key versions must therefore stay ENABLED
// until a re-wrap pass has run.
resource setupKek 'Microsoft.KeyVault/vaults/keys@2023-07-01' = if (enableSetupSecretStore) {
  parent: keyVault
  name: setupKekName
  tags: tags
  properties: {
    kty: 'RSA'
    keySize: 2048
    keyOps: [
      'wrapKey'
      'unwrapKey'
    ]
  }
}

////////////////////////////////////////////////////////////////////////////////
// RBAC
////////////////////////////////////////////////////////////////////////////////

resource routerKvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, routerIdentity.id, roleIds.keyVaultSecretsUser)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIds.keyVaultSecretsUser)
    principalId: routerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Secrets Officer as well as Secrets User: the router WRITES
// `cyrus-linear-refresh-<workspaceId>` when Linear rotates a refresh token, and
// (on the Key Vault secret backend) each user's per-user secret record.
resource routerKvSecretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, routerIdentity.id, roleIds.keyVaultSecretsOfficer)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIds.keyVaultSecretsOfficer)
    principalId: routerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Container-scoped, not account-scoped.
resource routerBackupsBlobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(routerBackups.id, routerIdentity.id, roleIds.storageBlobDataContributor)
  scope: routerBackups
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIds.storageBlobDataContributor)
    principalId: routerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Operator break-glass (M2). WITHOUT this, an operator cannot delete a corrupt
// `router.db` blob to unwedge a fatal-restore CrashLoopBackOff.
//
// principalType is omitted here on purpose: the operator principal may be a
// user, a group, or a service principal, and asserting the wrong one makes the
// assignment fail. Omitting it costs a small chance of a replication race on a
// brand-new principal, which a redeploy fixes.
resource operatorBackupsBreakglass 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(operatorPrincipalId)) {
  name: guid(routerBackups.id, operatorPrincipalId, roleIds.storageBlobDataContributor)
  scope: routerBackups
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIds.storageBlobDataContributor)
    principalId: operatorPrincipalId
  }
}

resource routerAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableAcr) {
  name: guid(acr.id, routerIdentity.id, roleIds.acrPull)
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIds.acrPull)
    principalId: routerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Table-scoped, not account-scoped: this grant must not reach the
// router-backups blob container or the artifacts share.
resource routerTableDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableSetupSecretStore) {
  name: guid(setupTable.id, routerIdentity.id, roleIds.storageTableDataContributor)
  scope: setupTable
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIds.storageTableDataContributor)
    principalId: routerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Vault-scoped. "Key Vault Crypto User" grants wrapKey/unwrapKey and is a
// DIFFERENT role from the Secrets User + Secrets Officer assignments above,
// neither of which permits any key operation.
resource routerKvCryptoUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableSetupSecretStore) {
  name: guid(keyVault.id, routerIdentity.id, roleIds.keyVaultCryptoUser)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIds.keyVaultCryptoUser)
    principalId: routerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

////////////////////////////////////////////////////////////////////////////////
// Outputs
////////////////////////////////////////////////////////////////////////////////

output logAnalyticsWorkspaceName string = logAnalytics.name
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
output routerIdentityId string = routerIdentity.id
output routerIdentityClientId string = routerIdentity.properties.clientId
output routerPrincipalId string = routerIdentity.properties.principalId
output storageAccountName string = storage.name
output routerBackupsContainerName string = routerBackupsContainerName
output tableEndpoint string = storage.properties.primaryEndpoints.table
output containerAppsEnvironmentId string = containerAppsEnvironment.id
output containerAppsEnvironmentDefaultDomain string = containerAppsEnvironment.properties.defaultDomain
output containerAppsEnvironmentStorageName string = artifactsEnvironmentStorage.name
output acrName string = enableAcr ? acr.name : ''
// The ternary guards are the same flags that gate the resources, and ARM's
// `if()` evaluates only the branch it returns — so the null branch is never
// reached. BCP318 cannot see that.
#disable-next-line BCP318
output acrLoginServer string = enableAcr ? acr.properties.loginServer : ''
output setupTableName string = enableSetupSecretStore ? setupTableNameValue : ''
#disable-next-line BCP318
output setupKekVersionedKeyId string = enableSetupSecretStore ? setupKek.properties.keyUriWithVersion : ''
