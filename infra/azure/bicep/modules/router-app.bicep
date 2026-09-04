// Router Container App — single replica (SQLite + in-memory WebSocket state).

@description('Container App name. Must stay app-<project>-<environment>-router: the authConfigs child in router-auth.bicep addresses the app by this name, and the monitoring queries scope themselves to it.')
@minLength(1)
param routerAppName string

param location string
param tags object

@description('Router image, pinned to an immutable reference. The shape check lives in main.bicep.')
param routerImage string

param containerAppsEnvironmentId string

@description('Name of the managedEnvironments/storages entry backing the artifacts Azure Files share.')
param artifactsStorageName string

param routerIdentityId string
param routerIdentityClientId string

@description('Key Vault URI, with its trailing slash, used to build versionless secret references. Versionless is deliberate: it lets ACA pick up a rotated value on the next revision without a deployment.')
param keyVaultUri string

param linearWorkspaceId string

@description('The complete, rendered CYRUS_ROUTER_CONTAINERS_JSON value.')
param routerContainersJson string

@description('The complete, rendered CYRUS_ROUTER_FLEET_OPERATIONS_JSON value, or empty to omit the variable entirely. Credential-free: Entra object ids, Linear workspace ids, and Log Analytics workspace identifiers. Absent, the router still serves discovery and still accepts device and locally minted operator tokens; there is simply no Entra grant table, so an operator JWT is refused.')
param fleetOperationsJson string = ''

param backupBlobUrl string

@description('ACR login server for a private router image, or empty for an anonymously pullable one.')
param acrLoginServer string = ''

@description('Custom domains bound to the ingress, passed through verbatim.')
param customDomains array = []

param entraTenantId string
param entraAudience string
param entraAllowedDomain string

@description('Stage 1 of the /setup rollout. Adds the two secret entries the EasyAuth sidecar resolves by name. Adds NO route.')
param enableSetupAuth bool

@description('Stage 2 of the /setup rollout. Adds the CYRUS_ROUTER_SETUP_UI_* env vars, which is the ONLY thing that makes the router register /setup*.')
param enableSetupUi bool

param setupUiAuthMode string
param setupUiIdTokenAudience string
param setupUiAllowedDomain string
param setupUiAutoProvisionUsers bool

param enableOtelLogs bool
param enableOtelTraces bool
param otelTracesSampleRatio string
param otelLogsLevel string
param deploymentEnvironment string

@secure()
param applicationInsightsConnectionString string

var entraEnabled = !empty(entraTenantId) && !empty(entraAudience)

// Omitted rather than set empty: `cyrus router start` re-parses this through a
// Zod schema, and an empty string is not valid JSON.
var fleetOperationsEnv = empty(fleetOperationsJson)
  ? []
  : [
      {
        name: 'CYRUS_ROUTER_FLEET_OPERATIONS_JSON'
        value: fleetOperationsJson
      }
    ]

// Linear secrets sourced from Key Vault via the router identity (Key Vault
// Secrets User + Secrets Officer granted in foundation.bicep).
var linearSecrets = [
  for secretName in [
    'linear-workspace-token'
    'linear-workspaces-json'
    'linear-webhook-secret'
    'linear-client-id'
    'linear-client-secret'
  ]: {
    name: secretName
    keyVaultUrl: '${keyVaultUri}secrets/${secretName}'
    identity: routerIdentityId
  }
]

// STAGE 1 of D7. Both are consumed by the EasyAuth SIDECAR, not by the router
// process — `authConfigs` resolves clientSecretSettingName and sasUrlSettingName
// against this collection by name, which is why they are declared here and gated
// on the same flag as the authConfigs resource. Neither is exposed to the
// container as an env var.
var setupAuthSecrets = enableSetupAuth
  ? [
      {
        name: 'setup-ui-client-secret'
        keyVaultUrl: '${keyVaultUri}secrets/setup-ui-client-secret'
        identity: routerIdentityId
      }
      {
        name: 'setup-ui-token-store-sas'
        keyVaultUrl: '${keyVaultUri}secrets/setup-ui-token-store-sas'
        identity: routerIdentityId
      }
    ]
  : []

// Inline ACA secret rather than a Key Vault round trip: this value is computed
// from a resource in the same deployment, not supplied or rotated by an operator.
var otelSecrets = enableOtelLogs
  ? [
      {
        name: 'appinsights-connection-string'
        value: applicationInsightsConnectionString
      }
    ]
  : []

var baseEnv = [
  {
    name: 'LINEAR_WORKSPACE_ID'
    value: linearWorkspaceId
  }
  {
    name: 'LINEAR_WORKSPACE_TOKEN'
    secretRef: 'linear-workspace-token'
  }
  {
    name: 'CYRUS_ROUTER_WORKSPACES_JSON'
    secretRef: 'linear-workspaces-json'
  }
  {
    name: 'LINEAR_WEBHOOK_SECRET'
    secretRef: 'linear-webhook-secret'
  }
  {
    name: 'LINEAR_CLIENT_ID'
    secretRef: 'linear-client-id'
  }
  {
    name: 'LINEAR_CLIENT_SECRET'
    secretRef: 'linear-client-secret'
  }
  {
    name: 'CYRUS_ROUTER_CONTAINERS_JSON'
    value: routerContainersJson
  }
  {
    name: 'CYRUS_ROUTER_BACKUP_BLOB_URL'
    value: backupBlobUrl
  }
  {
    // Emit one JSON object per log line instead of interpolated prose. The
    // Container Apps environment already ships the router's stdout to the Log
    // Analytics workspace; this is what makes those records queryable by field
    // rather than only greppable as free text, and every saved search and alert
    // rule in monitoring.bicep depends on it.
    name: 'CYRUS_LOG_FORMAT'
    value: 'json'
  }
  {
    // Durable store for rotated Linear OAuth tokens. `/data` is wiped on every
    // deploy, so without this the router replays the seeded refresh token after
    // each restart — a token Linear has already consumed and rotated, which
    // fails permanently with HTTP 400 (the 2026-07-30 outage). The router
    // identity already holds Key Vault Secrets User + Secrets Officer, which is
    // what reading and writing `cyrus-linear-refresh-<workspaceId>` needs.
    name: 'CYRUS_ROUTER_LINEAR_TOKEN_STORE_KEY_VAULT_URL'
    value: keyVaultUri
  }
  {
    name: 'AZURE_CLIENT_ID'
    value: routerIdentityClientId
  }
]

var otelEnv = concat(
  [
    {
      name: 'CYRUS_OTEL_LOGS_ENABLED'
      value: string(enableOtelLogs)
    }
    {
      name: 'CYRUS_OTEL_LOGS_LEVEL'
      value: otelLogsLevel
    }
    {
      // Read by the router AND propagated verbatim into every sandbox it boots
      // (ContainerTargets.buildEnv). The two must move together: a deployment
      // where the router traces and the worker does not produces traces with a
      // hole where the agent session should be.
      name: 'CYRUS_OTEL_TRACES_ENABLED'
      value: string(enableOtelTraces)
    }
    {
      name: 'CYRUS_OTEL_TRACES_SAMPLE_RATIO'
      value: otelTracesSampleRatio
    }
    {
      name: 'CYRUS_OTEL_DEPLOYMENT_ENV'
      value: deploymentEnvironment
    }
    {
      name: 'CYRUS_OTEL_CLOUD_REGION'
      value: location
    }
  ],
  enableOtelLogs
    ? [
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          secretRef: 'appinsights-connection-string'
        }
      ]
    : []
)

// Entra env is optional and uses the canonical entrypoint/Zod names. It governs
// enrollment bearer tokens for /enroll and says nothing about setup identity.
var entraEnv = entraEnabled
  ? concat(
      [
        {
          name: 'CYRUS_ROUTER_ENTRA_TENANT_ID'
          value: entraTenantId
        }
        {
          name: 'CYRUS_ROUTER_ENTRA_AUDIENCE'
          value: entraAudience
        }
      ],
      empty(entraAllowedDomain)
        ? []
        : [
            {
              name: 'CYRUS_ROUTER_ENTRA_ALLOWED_DOMAIN'
              value: entraAllowedDomain
            }
          ]
    )
  : []

// STAGE 2 of D7. Everything here is gated on enableSetupUi, which is deployed in
// its own deployment AFTER stage 1 is live and verified. Until then the router
// registers no /setup route and these vars are absent, so the revision published
// by stage 1 exposes nothing new.
//
// CYRUS_ROUTER_SETUP_UI_VERIFIED_HEADER_STRIP is intentionally absent: it is
// only meaningful for the `easyauth-headers` mode, which this stack refuses.
var setupUiEnv = enableSetupUi
  ? concat(
      [
        {
          name: 'CYRUS_ROUTER_SETUP_UI_ENABLED'
          value: 'true'
        }
        {
          // The router requires an explicit auth strategy when the UI is enabled
          // and refuses to start without one — it never infers identity handling
          // from the presence of Entra enrollment config.
          name: 'CYRUS_ROUTER_SETUP_UI_AUTH_MODE'
          value: setupUiAuthMode
        }
        {
          name: 'CYRUS_ROUTER_SETUP_UI_ID_TOKEN_AUDIENCE'
          value: setupUiIdTokenAudience
        }
        {
          name: 'CYRUS_ROUTER_SETUP_UI_AUTO_PROVISION'
          value: string(setupUiAutoProvisionUsers)
        }
      ],
      empty(setupUiAllowedDomain)
        ? []
        : [
            {
              name: 'CYRUS_ROUTER_SETUP_UI_ALLOWED_DOMAIN'
              value: setupUiAllowedDomain
            }
          ]
    )
  : []

resource routerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: routerAppName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${routerIdentityId}': {}
    }
  }
  properties: {
    environmentId: containerAppsEnvironmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8787
        // ACA ingress supports WebSocket upgrades; the router's WSS upgrade
        // end-to-end is verified (spike S4 → "WSS through Full inspection:
        // WORKS"). http transport carries the upgrade fine — there is no special
        // "ws" transport.
        transport: 'http'
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
        customDomains: customDomains
      }
      secrets: concat(linearSecrets, setupAuthSecrets, otelSecrets)
      registries: empty(acrLoginServer)
        ? []
        : [
            {
              server: acrLoginServer
              identity: routerIdentityId
            }
          ]
    }
    template: {
      containers: [
        {
          name: 'router'
          image: routerImage
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: concat(baseEnv, otelEnv, entraEnv, setupUiEnv, fleetOperationsEnv)
          volumeMounts: [
            {
              volumeName: 'artifacts'
              mountPath: '/data/artifacts'
            }
          ]
          // Rolling-update health gate. Single revision mode plus min/max
          // replicas of 1 keep exactly one router replica serving in steady
          // state, but they do NOT remove the rolling-overlap window: ACA starts
          // the new revision's replica while the old one is still serving.
          // Without a readiness probe ACA treats a merely-started container as
          // ready, so ingress can shift (and the old revision be deactivated)
          // before the router has opened its SQLite database and registered the
          // webhook route — which is how the 2026-07-26 emergency rollout ended
          // up with both revisions accepting the same work. This probe makes ACA
          // hold traffic on the previous revision until /healthz answers on the
          // new one, shortening (but never eliminating) that window.
          // Correctness across it comes from the router's own webhook
          // idempotency claim — see RouterStore.claimWebhookEvent.
          probes: [
            {
              type: 'Readiness'
              httpGet: {
                path: '/healthz'
                port: 8787
                scheme: 'HTTP'
              }
              periodSeconds: 5
              timeoutSeconds: 3
              failureThreshold: 6
              successThreshold: 1
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
      // Azure Files share bound to /data/artifacts — read/write; stores artifact
      // bundles (git worktree snapshots for cold restore). NOT used for SQLite:
      // the router keeps router.db on ephemeral container storage and backs it
      // up to the blob container, because Azure Files breaks SQLite WAL (D4).
      volumes: [
        {
          name: 'artifacts'
          storageType: 'AzureFile'
          storageName: artifactsStorageName
        }
      ]
    }
  }
}

output fqdn string = routerApp.properties.configuration.ingress.fqdn
output id string = routerApp.id
