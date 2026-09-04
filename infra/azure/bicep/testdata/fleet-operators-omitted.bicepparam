// Every fleet-operator parameter OMITTED — not set empty, omitted.
//
// This is the acceptance criterion "existing deployments remain valid with every
// new parameter omitted", and it is a different test from setting them to `[]`:
// a parameter that lost its default would still type-check in a file that
// assigns one.
using '../main.bicep'

param project = 'fixture'
param location = 'australiaeast'
param routerImage = 'ghcr.io/cyrusagents/cyrus:v1.2.3'
param workerImage = 'ghcr.io/cyrusagents/cyrus-worker:v1.2.3'
param acaDiskName = 'cyrus-worker-v1-2-3'
param linearWorkspaceId = '00000000-0000-0000-0000-000000000000'
