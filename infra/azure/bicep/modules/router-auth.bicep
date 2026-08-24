// STAGE 1 — the authConfigs child of the router Container App (ACA built-in
// auth, "EasyAuth").
//
// `unauthenticatedClientAction = "AllowAnonymous"` is DELIBERATE, not an
// oversight. The router serves machine routes on the same ingress: artifact and
// teardown routes with dynamic path segments
// (/artifacts/issues/:issueKey/bundle,
// /containers/issues/:issueKey/teardown-complete), a WebSocket upgrade at
// /device, the Linear webhook at /linear-webhook, and the /healthz endpoint
// ACA's own readiness probe depends on. `globalValidation.excludedPaths` is a
// plain path list with no documented wildcard semantics, so a default-deny
// posture would 302 webhook deliveries and every worker's WSS reconnect to a
// login page — an outage, not a hardening. Authentication for /setup* is
// enforced INSIDE the router instead, where the strategy is explicit and
// testable.
//
// What the sidecar still does under AllowAnonymous: it runs the sign-in flow at
// /.auth/*, and for a request that carries a valid session it injects the
// identity headers and (with the token store on) the ID token. A request that
// fails `defaultAuthorizationPolicy` gets no identity — so the policy below is a
// real control even with anonymous pass-through, because the router then sees no
// principal and answers 401.

@description('Name of the existing router Container App this auth config attaches to.')
@minLength(1)
param routerAppName string

@description('Router ingress FQDN, used for the CSRF-mitigation redirect allowlist.')
param routerFqdn string

param entraTenantId string
param setupUiClientId string

@description('The api://<client-id> Application ID URI used by /enroll ACCESS tokens. Included alongside the bare client id so one app registration can serve both sign-in and enrollment. Empty to omit.')
param entraAudience string = ''

param allowedGroupObjectIds array = []
param allowedPrincipalObjectIds array = []

var allowedPrincipalsConfigured = !empty(allowedGroupObjectIds) || !empty(allowedPrincipalObjectIds)

resource routerApp 'Microsoft.App/containerApps@2024-03-01' existing = {
  name: routerAppName
}

resource authConfig 'Microsoft.App/containerApps/authConfigs@2024-03-01' = {
  parent: routerApp
  // "current" is the ONLY name this child resource accepts.
  name: 'current'
  properties: {
    platform: {
      enabled: true
    }
    globalValidation: {
      unauthenticatedClientAction: 'AllowAnonymous'
    }
    httpSettings: {
      requireHttps: true
      routes: {
        apiPrefix: '/.auth'
      }
    }
    login: {
      // REQUIRED for /setup to be able to SAVE anything, not a redirect nicety.
      //
      // EasyAuth's built-in CSRF mitigation rejects a request when ALL of:
      //   1. it is a POST authenticated by the session cookie,
      //   2. the User-Agent says a real browser sent it,
      //   3. Origin/Referer is absent or not in THIS list, and
      //   4. Origin is absent or not in the ingress CORS origin list.
      // The /setup page's htmx save is 1 and 2 by construction, and with this
      // list empty it was also 3 and 4 — so the sidecar returned a BODYLESS 403
      // before the router ever saw the request. The page rendered and read
      // correctly while every write died silently in front of the app, which is
      // why it looked like an application bug.
      //
      // Listing our own origin breaks condition 3. It widens nothing: this is
      // the origin EasyAuth already redirects back to after sign-in.
      allowedExternalRedirectUrls: [
        'https://${routerFqdn}'
      ]
      tokenStore: {
        enabled: true
        azureBlobStorage: {
          // Resolves against the Container App's `secrets` collection, which is
          // why the matching secret entry in router-app.bicep is gated on the
          // same flag as this module.
          sasUrlSettingName: 'setup-ui-token-store-sas'
        }
      }
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          openIdIssuer: '${az.environment().authentication.loginEndpoint}${entraTenantId}/v2.0'
          clientId: setupUiClientId
          clientSecretSettingName: 'setup-ui-client-secret'
        }
        validation: union(
          {
            // The bare client id is the ID token audience. The
            // api://<client-id> Application ID URI is the ACCESS token audience
            // already used by /enroll; including both lets the one app
            // registration serve sign-in and enrollment.
            allowedAudiences: empty(entraAudience)
              ? [setupUiClientId]
              : [
                  setupUiClientId
                  entraAudience
                ]
          },
          // Omitted entirely when neither list is populated: sending an empty
          // allowedPrincipals is not the same as sending none, and the safe
          // reading of "unset" is "the Entra assignment requirement is the
          // gate".
          allowedPrincipalsConfigured
            ? {
                defaultAuthorizationPolicy: {
                  allowedPrincipals: {
                    groups: allowedGroupObjectIds
                    identities: allowedPrincipalObjectIds
                  }
                }
              }
            : {}
        )
      }
    }
  }
}

output id string = authConfig.id
