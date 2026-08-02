// Reference shape for the ACA sandbox group.
//
// The AzAPI body in ../terraform/sandbox.tf MUST property-for-property mirror
// this file. Drift is enforced by scripts/check-aca-arm-parity.sh (M5).
//
// Spike findings (docs/superpowers/specs/2026-07-25-aca-sandboxes-spike-findings.md)
// override the original plan: the ARM `Microsoft.App/sandboxGroups@2026-02-01-preview`
// resource accepts ALMOST NO PROPERTIES — created successfully with
// `properties: {}`. The server returns `allowedLocations`, `connections`,
// `managementEndpoint`, `provisioningState`. The plan's assumed
// `defaultCpu`/`defaultMemory`/`defaultDisk`/`maxSandboxCount` DO NOT EXIST on
// this resource. Per-sandbox CPU/memory/disk/egress are set on each
// `PUT /sandboxes` create body by the router (NOT on the group).
//
// `maxSandboxCount` therefore cannot serve as a cost guard — see
// ../README.md → "maxSandboxCount does NOT exist as a cost guard".

param name string
param location string = 'australiaeast'
param tags object = {}

resource sandboxGroup 'Microsoft.App/sandboxGroups@2026-02-01-preview' = {
  name: name
  location: location
  properties: {}
  identity: {
    type: 'SystemAssigned'
  }
  tags: tags
}

// ARM-emitted regional data-plane host for the group (e.g.
// https://management.australiaeast.azuredevcompute.io). The router config
// prefers this over the client's region+baseUrl fallback (spike S2).
output managementEndpoint string = sandboxGroup.properties.managementEndpoint
output principalId string = sandboxGroup.identity.principalId
output provisioningState string = sandboxGroup.properties.provisioningState