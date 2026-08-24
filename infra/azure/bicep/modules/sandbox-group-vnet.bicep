// OPTIONAL / DEFERRED — reference shape for the vnetConnections child resource
// of a sandbox group. NOT called by main.bicep. Kept so an operator who needs
// VNet isolation later has the canonical ARM shape to start from; VNet /
// private endpoints are out of scope for v1.
//
// The `subnetId` parameter is deferred: pick (or create) the subnet in a
// separate deployment and pass its id in. Do not create the VNet inside the
// sandbox group template — sandbox group VNet connections reference an
// existing delegated subnet.
//
// Deploy standalone at the resource group scope that contains the sandbox group:
//   az deployment group create -g <rg> \
//     -f infra/azure/bicep/modules/sandbox-group-vnet.bicep \
//     -p sandboxGroupName=<group> subnetId=<subnet-resource-id>

param sandboxGroupName string
param location string = 'australiaeast'

@description('Resource id of an existing subnet delegated to Microsoft.App/sandboxGroups (or the vnet-connection equivalent for this api-version). Pass via parameter file at deploy time.')
param subnetId string

@description('Name of the VNet connection. Defaults to a derived name.')
param vnetConnectionName string = 'default'

// BCP081 on both resources below: these preview types are not in Bicep's type
// index, so property validation happens server-side. Expected for a preview API.
@description('Existing parent sandbox group, referenced by name (deployment RG scope).')
#disable-next-line BCP081
resource sandboxGroup 'Microsoft.App/sandboxGroups@2026-02-01-preview' existing = {
  name: sandboxGroupName
}

@description('Deferred/optional vnetConnections child. Property shape matches the delegated-subnet form advertised in the spike (S7: Microsoft.App/sandboxGroups/vnetConnections@2026-02-01-preview is advertised). Treat as reference — validate against a live deploy before relying on it; the exact property name for the subnet reference in this preview API was NOT exercised in the spike.')
#disable-next-line BCP081
resource vnetConnection 'Microsoft.App/sandboxGroups/vnetConnections@2026-02-01-preview' = {
  name: vnetConnectionName
  parent: sandboxGroup
  location: location
  properties: {
    subnetId: subnetId
  }
}

output vnetConnectionId string = vnetConnection.id