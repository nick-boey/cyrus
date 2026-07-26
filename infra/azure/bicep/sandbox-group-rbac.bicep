// Role assignment: Container Apps SandboxGroup Data Owner for a given
// principal, scoped to a sandbox group.
//
// Deploy at the resource group scope that contains the sandbox group:
//   az deployment group create -g <rg> -f sandbox-group-rbac.bicep \
//     -p sandboxGroupName=<group> principalId=<router-UAI-principal-id>
//
// Role definition GUID `c24cf47c-5077-412d-a19c-45202126392c` was verified
// in-tenant in spike S6. Operators in a DIFFERENT tenant should confirm with:
//   az role definition list --name "Container Apps SandboxGroup Data Owner" \
//     --query "[].id"
// and override the `roleDefinitionGuid` parameter from the command output.
//
// A second, undocumented role exists — `Container Apps SandboxGroup
// Contributor` (`11b23f7a-6229-4518-88db-0576f10dd2a0`) — for least-privilege
// readers who only need to *interact* with sandboxes (not manage the group
// itself); do NOT assign this to the router (the router needs Data Owner).

@description('Name of the existing sandbox group to scope the assignment to. Must already exist in the deployment resource group.')
param sandboxGroupName string

@description('Principal id (object id) of the identity receiving the role.')
param principalId string

@description('Role definition GUID for Container Apps SandboxGroup Data Owner. Verified in spike S6 (tenant c9857cc6-…). Confirm in your own tenant with `az role definition list --name "Container Apps SandboxGroup Data Owner" --query "[].id"`. Do not assume the documented constant.')
param roleDefinitionGuid string = 'c24cf47c-5077-412d-a19c-45202126392c'

@description('Existing sandbox group — referenced for its id (the role-assignment scope).')
resource sandboxGroup 'Microsoft.App/sandboxGroups@2026-02-01-preview' existing = {
  name: sandboxGroupName
}

@description('Data Owner role assignment scoped to the sandbox group.')
resource roleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(sandboxGroup.id, principalId, roleDefinitionGuid)
  scope: sandboxGroup
  properties: {
    roleDefinitionId: resourceId('Microsoft.Authorization/roleDefinitions', roleDefinitionGuid)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

output roleAssignmentId string = roleAssignment.id