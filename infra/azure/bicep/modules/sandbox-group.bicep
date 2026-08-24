// ACA Sandbox Group (Microsoft.App/sandboxGroups@2026-02-01-preview).
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

@description('ARM-emitted regional data-plane host for the group (for example https://management.australiaeast.azuredevcompute.io).')
output managementEndpoint string = sandboxGroup.properties.managementEndpoint

output principalId string = sandboxGroup.identity.principalId
output provisioningState string = sandboxGroup.properties.provisioningState
