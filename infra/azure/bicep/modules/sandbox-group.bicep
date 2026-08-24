// ACA Sandbox Group (Microsoft.App/sandboxGroups@2026-02-01-preview) plus the
// role assignments the router and the group itself need.
//
// SPIKE-DRIVEN SHAPE:
// The ARM resource accepts ALMOST NO PROPERTIES — created successfully with
// `properties: {}` (spike finding under "Other facts"). The server returns
// `allowedLocations`, `connections`, `managementEndpoint`, `provisioningState`.
// The original plan's assumed `defaultCpu` / `defaultMemory` / `defaultDisk` /
// `maxSandboxCount` properties DO NOT EXIST on this resource. Per-sandbox
// CPU/memory/disk and egress policy are passed in the `PUT /sandboxes` create
// body by the router.
//
// `maxSandboxCount` therefore CANNOT be relied on as a cost guard — see
// ../../README.md → "maxSandboxCount does NOT exist as a cost guard".
//
// The data-plane host IS returned by this resource as
// `properties.managementEndpoint` — output it rather than string-templating
// `https://management.{region}.azuredevcompute.io` (the ACA client has a
// region+baseUrl fallback, but the router config prefers the ARM-emitted value).
//
// Until this change there were two copies of this shape — this file and an
// AzAPI body in terraform/sandbox.tf — kept in step by a dedicated CI parity
// gate. There is now one copy, and the gate is gone with the duplication.

@description('Sandbox group name. Keep it stable — the router embeds this in CYRUS_ROUTER_CONTAINERS_JSON; renaming it once workers exist strands them.')
@minLength(1)
param name string

param location string
param tags object

@description('Principal id of the router identity, granted Container Apps SandboxGroup Data Owner on the group.')
param routerPrincipalId string

@description('Role definition GUID for Container Apps SandboxGroup Data Owner.')
param dataOwnerRoleDefinitionId string

@description('Name of the ACR the group must pull a private worker disk image from, or empty. The group\'s SYSTEM-ASSIGNED identity is what performs that pull, so it needs AcrPull in its own right — this is a different identity and a different grant from the router\'s own image pull.')
param acrName string = ''

// BCP081: this preview type is not in Bicep's type index, so property validation
// happens server-side. That is expected for a preview API and does not block the
// deployment — the body is `properties: {}` precisely because the spike proved
// the resource accepts nothing else.
#disable-next-line BCP081
resource sandboxGroup 'Microsoft.App/sandboxGroups@2026-02-01-preview' = {
  name: name
  location: location
  tags: tags
  properties: {}
  identity: {
    type: 'SystemAssigned'
  }
}

resource dataOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(sandboxGroup.id, routerPrincipalId, dataOwnerRoleDefinitionId)
  scope: sandboxGroup
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      dataOwnerRoleDefinitionId
    )
    principalId: routerPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = if (!empty(acrName)) {
  name: acrName
}

resource sandboxGroupAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(acrName)) {
  name: guid(acr.id, sandboxGroup.id, 'AcrPull')
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '7f951dda-4ed3-4680-a7ca-43fe172d538d'
    )
    principalId: sandboxGroup.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

@description('ARM-emitted regional data-plane host for the group (for example https://management.australiaeast.azuredevcompute.io).')
output managementEndpoint string = sandboxGroup.properties.managementEndpoint

output principalId string = sandboxGroup.identity.principalId
output provisioningState string = sandboxGroup.properties.provisioningState
