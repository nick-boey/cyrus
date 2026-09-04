// Every fleet-operator shape an operator can write, in one file: a read-only
// principal, a read+recover principal, two DIFFERENT workspace grants, and the
// Log Analytics Reader list.
//
// `build-params` type-checks this against main.bicep, so it pins the parameter
// NAMES — and only those. `fleetOperatorGrants` is an untyped `array`, so the
// grant OBJECT shape is not checked here: main.bicep dereferences `grant.roles`
// unconditionally so a malformed grant fails at `az deployment sub what-if`,
// and the router's own Zod schema is the backstop behind that.
//
// build-params also does not evaluate the template, so it cannot see what the
// grants render to. The compiled-ARM assertions in scripts/check-bicep.sh cover
// the wiring; the rendered value itself is checked live at deploy time.
using '../main.bicep'

param project = 'fixture'
param location = 'australiaeast'
param routerImage = 'ghcr.io/cyrusagents/cyrus:v1.2.3'
param workerImage = 'ghcr.io/cyrusagents/cyrus-worker:v1.2.3'
param acaDiskName = 'cyrus-worker-v1-2-3'
param linearWorkspaceId = '11111111-1111-1111-1111-111111111111'

// Required by main.bicep's parameterViolations gate: a grant table with no
// tenant and no audience to check claims against would authorize nobody.
param entraTenantId = '22222222-2222-2222-2222-222222222222'
param entraAudience = 'api://33333333-3333-3333-3333-333333333333'

param fleetOperatorGrants = [
  {
    principalIds: ['44444444-4444-4444-4444-444444444444']
    roles: ['fleet.read']
    workspaceIds: ['11111111-1111-1111-1111-111111111111']
  }
  {
    principalIds: [
      '55555555-5555-5555-5555-555555555555'
      '66666666-6666-6666-6666-666666666666'
    ]
    roles: ['fleet.read', 'fleet.recover']
    workspaceIds: ['77777777-7777-7777-7777-777777777777']
  }
]
param enableFleetRecovery = true

param fleetOperatorLogReaderPrincipalIds = [
  '44444444-4444-4444-4444-444444444444'
  '55555555-5555-5555-5555-555555555555'
]
