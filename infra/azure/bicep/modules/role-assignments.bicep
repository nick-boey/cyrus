// All runtime RBAC for one Cyrus resource group.
//
// This module deliberately references existing resources by the stack's stable
// names. That gives it two callers without duplicating any grant logic:
//
//   1. main.bicep, during a fresh/full deployment when
//      manageRoleAssignments=true; and
//   2. bootstrap-role-assignments.bicep, run interactively by an operator whose
//      constrained Azure role permits assigning these non-administrator roles.
//
// Routine CD can then set manageRoleAssignments=false and run with Contributor
// only. ARM Incremental mode retains the assignments created by bootstrap.

@description('Resource name root, <project>-<environment>.')
@minLength(4)
param namePrefix string

@description('Resource name root with dashes removed, for resources that disallow them.')
@minLength(3)
param flatNamePrefix string

@description('Whether the stack has an Azure Container Registry requiring router and sandbox-group AcrPull grants.')
param enableAcr bool

@description('Whether the setup Table and KEK exist and require their two router grants.')
param enableSetupSecretStore bool

@description('Principal id of the existing router user-assigned identity.')
param routerPrincipalId string

@description('Optional Entra principal id granted break-glass Storage Blob Data Contributor on router-backups.')
param operatorPrincipalId string

@description('Optional Entra principal/group object ids granted Log Analytics Reader at the workspace scope, so an authorized fleet operator can query the advertised log source with their own credential. Deliberately SEPARATE from the router-side fleet roles: the Entra app role decides what the router will answer, this Azure data-plane role decides what the operator can read directly, and neither implies the other. Empty grants nothing.')
param logAnalyticsReaderPrincipalIds array = []

@description('Role-definition GUID for Container Apps SandboxGroup Data Owner.')
param sandboxGroupDataOwnerRoleId string

var roleIds = {
  keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
  keyVaultSecretsOfficer: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
  keyVaultCryptoUser: '12338af0-0e69-4776-bea7-57ae8d297424'
  storageBlobDataContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
  storageTableDataContributor: '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d'
  logAnalyticsReader: '73c42c96-874c-492b-b04d-ab87d138a893'
}

var routerBackupsContainerName = 'router-backups'
var setupTableName = 'cyrussetup'

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: 'kv-${namePrefix}'
}

resource routerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: 'id-${namePrefix}-router'
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: 'log-${namePrefix}'
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: 'st${flatNamePrefix}'
}

resource blobServices 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}

resource routerBackups 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = {
  parent: blobServices
  name: routerBackupsContainerName
}

resource tableServices 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' existing = if (enableSetupSecretStore) {
  parent: storage
  name: 'default'
}

resource setupTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' existing = if (enableSetupSecretStore) {
  parent: tableServices
  name: setupTableName
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = if (enableAcr) {
  name: 'acr${flatNamePrefix}'
}

// BCP081: the preview sandbox-group type is not in Bicep's type index.
#disable-next-line BCP081
resource sandboxGroup 'Microsoft.App/sandboxGroups@2026-02-01-preview' existing = {
  name: '${namePrefix}-sandbox-grp'
}

resource routerKvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, routerIdentity.id, roleIds.keyVaultSecretsUser)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIds.keyVaultSecretsUser)
    principalId: routerPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Secrets Officer as well as Secrets User: the router writes rotated Linear
// refresh tokens and, on the Key Vault backend, per-user secret records.
resource routerKvSecretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, routerIdentity.id, roleIds.keyVaultSecretsOfficer)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIds.keyVaultSecretsOfficer)
    principalId: routerPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Container-scoped, not account-scoped.
resource routerBackupsBlobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(routerBackups.id, routerIdentity.id, roleIds.storageBlobDataContributor)
  scope: routerBackups
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIds.storageBlobDataContributor)
    principalId: routerPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// principalType is deliberately omitted: the break-glass principal may be a
// user, group, or service principal.
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
    principalId: routerPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Table-scoped, not storage-account-scoped.
resource routerTableDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableSetupSecretStore) {
  name: guid(setupTable.id, routerIdentity.id, roleIds.storageTableDataContributor)
  scope: setupTable
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIds.storageTableDataContributor)
    principalId: routerPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource routerKvCryptoUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableSetupSecretStore) {
  name: guid(keyVault.id, routerIdentity.id, roleIds.keyVaultCryptoUser)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIds.keyVaultCryptoUser)
    principalId: routerPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource routerSandboxGroupDataOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(sandboxGroup.id, routerPrincipalId, sandboxGroupDataOwnerRoleId)
  scope: sandboxGroup
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      sandboxGroupDataOwnerRoleId
    )
    principalId: routerPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource sandboxGroupAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableAcr) {
  name: guid(acr.id, sandboxGroup.id, 'AcrPull')
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIds.acrPull)
    principalId: sandboxGroup.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Workspace-scoped, not subscription-scoped, and principalType is omitted for
// the same reason as the break-glass grant above: an operator may be a user, a
// group, or a service principal.
// `union(..., [])` deduplicates: the assignment name is a guid() of the
// principal id, so listing the same principal twice — easy to do when a person
// is added again years later — would declare one resource twice and fail the
// whole deployment on a name collision rather than on anything meaningful.
resource operatorLogAnalyticsReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in union(logAnalyticsReaderPrincipalIds, []): {
    name: guid(logAnalytics.id, principalId, roleIds.logAnalyticsReader)
    scope: logAnalytics
    properties: {
      roleDefinitionId: subscriptionResourceId(
        'Microsoft.Authorization/roleDefinitions',
        roleIds.logAnalyticsReader
      )
      principalId: principalId
    }
  }
]
