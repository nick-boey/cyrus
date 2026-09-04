// Foundation: everything in the resource group except the sandbox group, the
// router Container App, its auth child, and monitoring.
//
// Mirrors what main.tf plus the storage half of setup_ui.tf used to hold:
// Log Analytics, Key Vault (RBAC mode) and its opt-in secret writes, the router
// user-assigned identity, the storage account and its three children, the
// Container Apps environment and its Azure Files link, the optional ACR, and the
// opt-in per-user secret store (Table + KEK). RBAC lives in the dedicated deep
// role-assignments module so a Contributor-only routine deploy can omit it.

@description('Resource name root, <project>-<environment>.')
@minLength(4)
param namePrefix string

@description('Resource name root with dashes removed, for resources that disallow them.')
@minLength(3)
param flatNamePrefix string

param location string
param tags object

@description('Provision an Azure Container Registry.')
param enableAcr bool

param linearWorkspaceId string

@description('Write all five Linear bootstrap secrets during this deployment. False for steady state.')
param writeLinearSecrets bool

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

@description('Stage 1 of the /setup rollout: create the token-store container and retain the existing Key Vault secret references.')
param enableSetupAuth bool

@description('Write the setup UI client secret and token-store SAS during this deployment. False for steady state.')
param writeSetupAuthSecrets bool

@secure()
param setupUiClientSecret string

param setupUiTokenStoreSasStart string
param setupUiTokenStoreSasExpiry string

@description('Create the Azure Table and the envelope-encryption KEK.')
param enableSetupSecretStore bool

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
// Key Vault bootstrap/rotation secret writes
//
// Every write is explicitly opt-in. In steady state these resources are omitted,
// ARM Incremental mode leaves their existing versions untouched, and the router
// keeps referencing their stable versionless URLs. Re-enable a write flag only
// for first bootstrap or a coordinated manual rotation; deploy-azure.sh requires
// separate --allow-secret-writes consent before it will invoke ARM in that mode.
//
// No expiry is set on any of them: an expiry derived from utcNow() would
// re-evaluate on every deployment and produce a new secret version — and
// therefore a new router revision — each time.
////////////////////////////////////////////////////////////////////////////////

resource linearWorkspaceTokenSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (writeLinearSecrets) {
  parent: keyVault
  name: 'linear-workspace-token'
  tags: tags
  properties: {
    value: linearWorkspaceToken
  }
}

resource linearWorkspacesJsonSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (writeLinearSecrets) {
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

resource linearWebhookSecretSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (writeLinearSecrets) {
  parent: keyVault
  name: 'linear-webhook-secret'
  tags: tags
  properties: {
    value: linearWebhookSecret
  }
}

resource linearClientIdSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (writeLinearSecrets) {
  parent: keyVault
  name: 'linear-client-id'
  tags: tags
  properties: {
    value: linearClientId
  }
}

resource linearClientSecretSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (writeLinearSecrets) {
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
// `secrets` collection by name. router-app.bicep keeps those versionless
// references whenever auth is enabled; this separate flag controls only whether
// this deployment writes new Key Vault secret versions behind the references.
resource setupUiClientSecretSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (writeSetupAuthSecrets) {
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
var tokenStoreSasToken = writeSetupAuthSecrets
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

resource setupUiTokenStoreSasSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (writeSetupAuthSecrets) {
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
// Outputs
////////////////////////////////////////////////////////////////////////////////

output logAnalyticsWorkspaceName string = logAnalytics.name

// The two identifiers LogSourceDescriptorV1 is built from. Neither is a
// credential: `customerId` is the workspace GUID a query is addressed to, and
// the ARM resource id is what an operator's client resolves for a
// resource-scoped query. Both are derived here rather than taken as parameters
// so a deployment cannot name a workspace it did not create.
output logAnalyticsCustomerId string = logAnalytics.properties.customerId
output logAnalyticsWorkspaceResourceId string = logAnalytics.id
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
