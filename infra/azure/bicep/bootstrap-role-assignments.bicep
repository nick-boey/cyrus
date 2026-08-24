// One-time/manual RBAC bootstrap for an existing Cyrus stack.
//
// This template contains no application resources. It calls the same deep RBAC
// module as main.bicep so routine CD can set manageRoleAssignments=false and use
// a Contributor-only deployment identity without letting the two paths drift.

targetScope = 'resourceGroup'

@description('Short project prefix used by the existing Cyrus stack.')
@minLength(2)
@maxLength(10)
param project string

@description('Existing deployment environment suffix.')
@minLength(1)
@maxLength(9)
param environment string = 'dev'

@description('Whether the existing stack includes its Azure Container Registry.')
param enableAcr bool = false

@description('Whether the existing stack includes the setup Table and KEK.')
param enableSetupSecretStore bool = false

@description('Optional Entra principal id granted break-glass Storage Blob Data Contributor on router-backups.')
param operatorPrincipalId string = ''

@description('Role-definition GUID for Container Apps SandboxGroup Data Owner.')
param sandboxGroupDataOwnerRoleId string = 'c24cf47c-5077-412d-a19c-45202126392c'

var namePrefix = '${project}-${environment}'
var flatNamePrefix = replace(namePrefix, '-', '')

resource routerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: 'id-${namePrefix}-router'
}

module roleAssignments 'modules/role-assignments.bicep' = {
  name: 'cyrus-role-assignments'
  params: {
    namePrefix: namePrefix
    flatNamePrefix: flatNamePrefix
    enableAcr: enableAcr
    enableSetupSecretStore: enableSetupSecretStore
    routerPrincipalId: routerIdentity.properties.principalId
    operatorPrincipalId: operatorPrincipalId
    sandboxGroupDataOwnerRoleId: sandboxGroupDataOwnerRoleId
  }
}
