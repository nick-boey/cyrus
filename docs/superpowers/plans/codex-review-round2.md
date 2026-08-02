# Final implementation review — `/setup` management UI (round 2)

**Diff reviewed:** `0ddf8adc..bb2de1b8` (current branch tip)  
**Disposition:** **Do not ship yet.** The `entra-token` authentication path and the original stored-KEK SSRF are repaired, but the header-mode Terraform ordering hole is still reproducible. I also found an authorization bypass that lets an authenticated but unregistered user create and manage a secret record, a broken/leaky HTMX delete flow, an unusable documented migration sequence, and feature-off Terraform changes.

Targeted tests were run directly with the repository's installed Vitest binary: **350 passed** across the principal, envelope, Table store, bootstrap, routes, views, form parser, and executor suites. `setup-id-token-verifier.test.ts` could not run in this review sandbox because its local JWKS server was denied `listen(127.0.0.1)` (`EPERM`); that is an environment limitation, not a product test failure. The test itself was inspected line by line.

+++ Part 1 — Round-1 finding verification

## 1. CRITICAL — `devTrustHeaders` gated nothing: **FIXED**

The implementation replaced the boolean with a required discriminated auth strategy (`principal.ts:67-98`). `requireSetupPrincipal` calls the ID-token verifier only for `entra-token`; `parseEasyAuthPrincipal` is reachable only in the two explicit header modes (`principal.ts:260-283`). Startup rejects missing/unknown auth, header trust without the literal attestation, and non-loopback development header mode (`principal.ts:326-374`); this happens before the store or routes are constructed (`RouterServer.ts:337-352`). The Docker entrypoint also requires the strategy and audience/attestation (`docker/router/entrypoint.mjs:230-275`). If a verifier is accidentally absent in token mode, requests fail with 500 rather than falling back to headers (`principal.ts:230-250`).

The claimed mutation test is meaningful: supplying forged `X-MS-CLIENT-PRINCIPAL-*` headers without a token must return 401 and make zero verifier calls, while a request with both sources must use the verifier's different identity (`setup-principal.test.ts:318-366`). Changing the `entra-token` switch arm to `parseEasyAuthPrincipal` would fail both cases. The JWT suite uses signed tokens and checks exact audience, both accepted issuers, expiration, and an unknown signing key (`setup-id-token-verifier.test.ts:20-47`, `:77-112`, `:135-145`).

## 2. CRITICAL — Terraform could publish `/setup` before auth: **PARTIALLY-FIXED**

There are now separate `enable_setup_auth` and `enable_setup_ui` resources/inputs (`setup_ui.tf:18-27`, `setup_ui.tf:175-250`), and `/setup` environment variables are limited to stage 2 (`router.tf:270-319`). That enables a safe two-apply procedure.

It does **not enforce** two applies. `setup_auth_stage1_verified` is a caller-supplied boolean (`variables.tf:418-422`), and the validation checks only that the same plan has `enable_setup_auth = true` and the attestation boolean true (`variables.tf:424-437`). An operator can set all three true in the first apply. Because `router_auth` depends on the Container App (`setup_ui.tf:244-250`), that apply can publish the `/setup` revision before attaching the auth child. In `easyauth-headers` mode, `setup_ui_verified_header_strip` is another freely supplied boolean (`variables.tf:440-460`, `:480-483`). This exactly reproduces the original public impersonation window. See new finding R2-01.

## 3. CRITICAL — stored `KekKeyId` could SSRF a Key Vault bearer token: **FIXED**

Rows now store only a 32-character lowercase-hex key version, validated by `assertKekVersion` (`envelope.ts:24-29`, `:81-89`). `openBundle` performs that check before invoking the wrapper (`envelope.ts:160-171`), and `KeyVaultKeyWrapper` builds every URL from the configured HTTPS vault origin and key name plus the validated version (`envelope.ts:424-459`, `:492-520`). The echoed `kid` is compared to that same constructed URL and is never followed (`envelope.ts:536-547`). No stored string can select the scheme, host, key name, query, or retry destination.

The mutation coverage is real for this property: hostile versions make zero wrapper calls (`setup-envelope.test.ts:255-274`), zero real-wrapper fetches, and zero token-provider calls (`setup-envelope.test.ts:334-344`); the Table-path test mutates an actual stored row and asserts no additional vault URL or token call (`TableSecretStore.test.ts:676-700`). Moving version validation below token acquisition or URL construction would fail these tests. Non-version envelope fields are still insufficiently validated before an authenticated request; that separate, non-SSRF issue is R2-09.

## 4. HIGH — EasyAuth header trust exceeded the verified boundary: **PARTIALLY-FIXED**

The default production mode now verifies a signed ID token and ignores injected identity headers (`principal.ts:230-275`, `idTokenVerifier.ts:49-69`), which removes proxy-header trust from the recommended path. The header mode remains supported based only on `verifiedHeaderStrip: true` (`principal.ts:339-346`), and the live runbook probes only the public FQDN (`infra/azure/README.md:645-659`). It still does not verify app-name/internal-FQDN traffic, direct target-port access, or WebSocket topology. Whether ACA guarantees stripping on those paths **needs verification**. Prefer removing production header mode; otherwise test every reachable hop and make the result machine-enforced.

## 5. HIGH — auto-provisioning preceded an enforceable membership gate; email was the identity: **PARTIALLY-FIXED**

Auto-provisioning now defaults false in both application and Terraform (`RouterServer.ts:460-468`, `variables.tf:492-505`), and Terraform can render an `allowedPrincipals` policy (`setup_ui.tf:215-238`). However, the alternative assignment gate is still a self-attested boolean (`variables.tf:497-511`), and the router itself has no membership-policy validation. More importantly, routes other than `/setup/provision` bypass the bootstrap gate entirely (R2-02). Identity and secret ownership remain lowercased email; a changed Entra `oid` is logged but access continues and the old binding is not overwritten (`bootstrap.ts:282-317`). A reassigned address therefore still reattaches the previous user's router state and secrets. Re-key authorization and storage on `(tenantId, oid)` and reject mismatches.

## 6. HIGH — Azure Table REST headers and `Edm.Int64` encoding were wrong: **FIXED**

Requests now include `x-ms-version`, `DataServiceVersion`, `MaxDataServiceVersion`, and `x-ms-date` (`TableSecretStore.ts:478-506`). Crypto properties are annotated `Edm.Binary`; `UpdatedMs` is annotated `Edm.Int64` and serialized as a decimal string (`TableSecretStore.ts:420-444`). The tests are mocked, so a disposable live-Azure smoke is still required before treating this as service-contract proof.

## 7. HIGH — ETags were absent and writes were unconditional: **PARTIALLY-FIXED**

Create is now POST/409 and update is PUT with a nonempty, non-wildcard `If-Match`; 412 is terminal (`TableSecretStore.ts:237-285`). Missing ETags fail closed (`TableSecretStore.ts:457-476`). However, point reads still demand an `ETag` **response header** (`TableSecretStore.ts:366-386`) while the fake service always invents one (`TableSecretStore.test.ts:99-106`). Azure's [Query Entities response contract](https://learn.microsoft.com/en-us/rest/api/storageservices/query-entities) does not document that header for an entity GET, and the selected `minimalmetadata` payload is not inspected for `odata.etag`. Whether the real service happens to emit the header **needs verification**; if it does not, every existing-record read fails. See R2-05.

## 8. HIGH — save read the current ETag instead of using the page's ETag: **FIXED**

The page receives a signed, principal-bound token containing the render-time ETag (`routes.ts:176-218`, `:240-268`), and save passes the recovered value directly to `putRecord` (`routes.ts:690-713`, `:749-771`). The two-tab test loads both pages before either save, expects the second write to 409, and confirms the first value survives (`setup-routes.test.ts:882-944`). Re-reading the ETag immediately before write would make that test fail.

## 9. HIGH — migration could not discover both source and inactive destination: **NOT-FIXED**

The command comment says the target must remain out of active config, then immediately requires `containers.tableStore` in that same config (`RouterCommand.ts:1254-1265`, `:1304-1327`). Router and break-glass CLI precedence select Table whenever that block exists (`RouterServer.ts:650-670`, `RouterCommand.ts:457-477`). There is still no distinct migration-only target configuration or injectable backend selection. The runbook additionally invokes `secrets migrate` without the command's mandatory `--from keyvault --to table` flags (`infra/azure/README.md:716-725`, `RouterCommand.ts:1289-1302`). See R2-04.

## 10. HIGH — Key Vault retention was not rollback protection: **NOT-FIXED**

Migration is one-way from Key Vault to Table (`RouterCommand.ts:1289-1363`). After cutover, all UI writes go only to the selected Table backend (`RouterServer.ts:650-670`); there is no dual-write, reverse migration, or export/import path. Yet the runbook says flipping back to Key Vault is safe at any time (`infra/azure/README.md:724-735`). That restores a stale snapshot and can resurrect rotated/revoked credentials. See R2-04.

## 11. HIGH — default executor captured historical NULL/device users: **FIXED**

`resolveExecutor` maps NULL, blank, corrupt JSON, non-object JSON, missing types, and the explicit device sentinel to physical device; only `{"type":"default"}` inherits (`bootstrap.ts:64-118`). `ContainerTargetService.executorFor` uses that function (`ContainerTargets.ts:116-137`), and the migration merely adds a nullable column (`RouterStore.ts:355-370`). Auto-provisioned **new** users alone receive the explicit default sentinel (`bootstrap.ts:241-279`). Tests cover every resolution row and the service integration (`setup-bootstrap.test.ts:559-664`, `ContainerTargets.test.ts:456-477`).

## 12. HIGH — HTMX discarded planned 4xx fragments: **FIXED**

The page registers `htmx:beforeSwap` and opts 400/403/409 into swapping (`views.ts:136-150`, `:164-190`). The test only asserts generated script text and nonce placement (`setup-views.test.ts:236-254`), not browser execution, so it is useful mutation coverage but not browser-contract proof. The separate DELETE transport defect in R2-03 is not a regression of this particular handler.

## 13. HIGH — readiness banner was outside the swap target: **FIXED**

`renderVariablesTable` renders the missing-required banner inside `#variables` (`views.ts:63-79`, `:117-133`), and the full page embeds exactly that fragment (`views.ts:193-200`).

## 14. HIGH — the proposed dependency graph was false: **FIXED**

The implemented graph is coherent: the Table store imports envelope primitives (`TableSecretStore.ts:1-19`); routes import Table conflict types, envelope limits, auth, form parsing, and views (`routes.ts:1-33`); the router imports bootstrap/auth/routes and registers them only after constructing the secret backend (`RouterServer.ts:33-49`, `:435-480`). The amendment corrected the plan; the code no longer relies on the impossible order from round 1.

## 15. HIGH — production regression gate used fake webhook/WSS checks: **NOT-FIXED**

The webhook check is still an unsigned empty POST whose only acceptance criterion is “4xx, not 302” (`infra/azure/README.md:629-637`). The purported WSS reconnect says “bounce the revision” but runs only `az containerapp exec`, then observes an already-connected worker row (`infra/azure/README.md:639-643`). It neither forces a new socket nor proves a fresh hello/heartbeat. Replace these with a signed representative webhook and an actual worker disconnect/reconnect observed through a new handshake and heartbeat.

## 16. MEDIUM — Azure Table capacity was overstated: **FIXED**

The plaintext bundle is capped at 32 KiB before encryption (`envelope.ts:20-22`, `:91-115`), and binary fields use `Edm.Binary` (`TableSecretStore.ts:420-444`). Tests exercise exact byte boundaries and multibyte UTF-8 (`setup-envelope.test.ts:201-236`).

## 17. MEDIUM — Azure calls had no deadlines/retries: **PARTIALLY-FIXED**

HTTP fetches now have per-attempt abort deadlines, bounded 408/429/5xx retries, capped `Retry-After`, and terminal 412 handling (`envelope.ts:242-365`). But both clients await token acquisition **before** entering that deadline (`TableSecretStore.ts:488-506`, `envelope.ts:507-530`), so a hung `DefaultAzureCredential.getToken` remains unbounded (`TableSecretStore.ts:96-109`). See R2-08.

## 18. MEDIUM — CSRF was mislabeled, leaked in URLs, and protected a state-changing GET: **PARTIALLY-FIXED**

GET `/setup` is now read-only and provisioning moved to an authenticated, CSRF-protected POST (`routes.ts:554-612`). The server deliberately accepts mutation tokens only from body/header (`routes.ts:367-404`). But the generated HTMX DELETE causes HTMX to put the included token in the query string, so deletion both leaks the token and fails the server guard (R2-03). Tokens and version tokens are also bound only to mutable email, despite `objectId` being available (`principal.ts:59-65`, `routes.ts:186-218`, `:240-268`).

## 19. MEDIUM — `enable_setup_table` was not reversible: **PARTIALLY-FIXED**

The backend selector is now reversible without destroying the KEK (`variables.tf:527-530`, `router.tf:65-70`). The storage resources themselves were made unconditional (`setup_ui.tf:253-328`), which avoids a `prevent_destroy` flag trap but violates the required strict no-diff behavior when the feature is off. See R2-06.

## 20. MEDIUM — assigning `readonly secretBackendKind` in a helper would not compile: **FIXED**

`buildContainerTargets` returns the kind, and the constructor assigns the readonly field (`RouterServer.ts:387-398`).

## 21. MEDIUM — Docker `anyProvided` omitted new inputs / local recipe contradicted startup: **PARTIALLY-FIXED**

The entrypoint now includes `CYRUS_ROUTER_SETUP_UI_ENABLED` in `anyProvided` (`docker/router/entrypoint.mjs:90-105`) and maps the setup configuration (`docker/router/entrypoint.mjs:230-275`). It still omits every other new setup variable from the gate, and the test proves only the enabled variable (`entrypoint.test.mjs:182-188`). A standalone attempt to change only auth mode, audience, domain, or auto-provisioning while an old config file exists is silently ignored. Include all setup inputs in `anyProvided` and test each one.

## 22. LOW — view tests contradicted the required/optional clear contract: **FIXED**

Required set values get “clear”; required unset values do not; optional rows get delete instead (`views.ts:81-107`). The rendered password inputs never contain stored values (`views.ts:96-105`).

## 23. LOW — “values never travel to the browser” was false: **FIXED**

The UI now says only that **stored** values are never displayed (`views.ts:157-162`, `:193-200`), and tests reject the broader wording (`setup-views.test.ts:283-295`).

+++

+++ Part 2 — New and remaining implementation findings

## R2-01 — CRITICAL — The staged Terraform gate is an honor-system boolean and can reproduce the public impersonation window

**Defect.** The configuration validates present input values, not deployment history. It cannot establish that auth was applied and observed before the route-bearing revision.

**Evidence.** `setup_auth_stage1_verified` is an ordinary boolean (`infra/azure/terraform/variables.tf:418-422`); `enable_setup_ui` merely checks that it and `enable_setup_auth` are true (`variables.tf:424-437`). Header-strip verification is another boolean (`variables.tf:440-460`, `:480-483`). Meanwhile the auth child is explicitly ordered after the Container App (`setup_ui.tf:244-250`), and the route-bearing environment variables are part of that app revision (`router.tf:270-319`).

**Failure scenario.** An operator or CI supplies `enable_setup_auth=true`, `setup_auth_stage1_verified=true`, `enable_setup_ui=true`, `setup_ui_auth_mode="easyauth-headers"`, and `setup_ui_verified_header_strip=true` in one apply. Terraform accepts it. The Container App revision starts serving `/setup` and trusts attacker-supplied identity headers before `router_auth` attaches. An unauthenticated internet client impersonates any email and reads/changes that user's secret bundle. The default token mode would fail closed during this interval, but the supported header mode does not.

**Recommended fix.** Remove production `easyauth-headers` and support only cryptographic token verification, or split stage 2 into a separate root/module/state whose input is an externally produced, immutable verification artifact tied to the deployed auth resource ID/revision. At minimum, add a resource precondition that reads the already-existing auth child and its live properties through a data source; a boolean in the same plan is not an enforceable ordering gate.

## R2-02 — HIGH — Authenticated unregistered users bypass `/setup/provision` and create secret records directly

**Defect.** Only `POST /setup/provision` calls `SetupBootstrap.ensure`; every other mutation checks authentication and CSRF but never verifies that the principal is a registered router user.

**Evidence.** GET `/setup` gives an unknown user a valid CSRF token (`routes.ts:559-570`). The shared mutation guard intentionally excludes bootstrap/registration (`routes.ts:367-404`). `POST /setup/variables` then writes directly to `deps.secrets` (`routes.ts:614-645`); delete and save have the same missing user gate (`routes.ts:647-688`, `:690-789`). Page state considers a user “provisioned” solely when their secret bundle has any key (`routes.ts:170-173`, `:563-574`). By contrast, the 403 for an unknown user exists only inside `SetupBootstrap.ensureUser` (`bootstrap.ts:241-253`). Route tests exercise the unknown-user denial only through `/setup/provision` (`setup-routes.test.ts:396-440`) and provision the harness before every add test (`setup-routes.test.ts:534-545`).

**Failure scenario.** With auto-provisioning disabled, any tenant principal admitted by EasyAuth loads `/setup`, extracts its CSRF token, and POSTs `name=FOO` to `/setup/variables`. The backend creates an encrypted record. Subsequent GETs treat that record as provisioned and expose the full management UI, despite no SQLite user existing. If an administrator later registers the email, the attacker-prepared values are already attached to it. This also bypasses the intended membership/approval workflow and permits storage consumption by every admitted tenant principal.

**Recommended fix.** Make the shared mutation guard verify the RouterStore user and stable Entra identity before any secret read/write. Alternatively, route all mutations through a bootstrap authorization method that distinguishes “may use an existing user” from “may auto-provision.” Determine page readiness from both the SQLite user and the secret record, not the bundle alone. Add negative tests for every mutating route with an authenticated unregistered principal and `autoProvisionUsers=false`.

## R2-03 — HIGH — The real HTMX DELETE sends CSRF in the URL, so delete leaks the token and always receives 403

**Defect.** HTMX treats DELETE like GET for parameter placement. The view includes `#csrf`, so HTMX appends it to the URL; the server intentionally refuses query-string CSRF.

**Evidence.** The generated button uses `hx-delete` plus `hx-include="#csrf"` and no CSRF header (`views.ts:81-95`). The vendored HTMX configuration says `methodsThatUseUrlParams:["get","delete"]` (`vendor/htmx.ts:5`). `requireMutation` reads only body or `X-CSRF-Token` (`routes.ts:376-404`). The test explicitly proves query CSRF is rejected (`setup-routes.test.ts:506-516`), but its delete helper injects an artificial DELETE body (`setup-routes.test.ts:616-624`), which is not what the vendored browser code sends. Thus the test passes for the wrong transport assumption.

**Failure scenario.** Clicking Delete requests `/setup/variables/FOO?csrf=<8-hour-token>`. Reverse proxies/access logs/browser history can retain the token, and the router returns 403 without deleting anything. The before-swap handler makes the error visible but cannot make the operation succeed.

**Recommended fix.** Send the token via `X-CSRF-Token` using `hx-headers`, or use a POST action for deletion. Add a DOM/browser-level test using the vendored HTMX asset that captures the actual request method, URL, headers, and body; assert the URL never contains `csrf`.

## R2-04 — HIGH — The documented Key Vault → Table migration cannot run in the documented safe state, and rollback restores stale credentials

**Defect.** The one configuration block is simultaneously treated as the inactive migration target and the active backend selector. The runbook also omits mandatory CLI flags. Once cut over, there is no synchronization back to Key Vault.

**Evidence.** `secretsMigrate` requires `containers.keyVaultUrl` and `containers.tableStore` from the active config (`RouterCommand.ts:1289-1327`), while both the router and ordinary CLI select Table whenever `tableStore` exists (`RouterServer.ts:650-670`, `RouterCommand.ts:457-477`). The runbook says Table must remain inactive, then runs `cyrus router secrets migrate` without `--from keyvault --to table` (`infra/azure/README.md:716-725`), although the parser rejects that invocation (`RouterCommand.ts:1294-1302`). No migration-command test exists; only Key Vault enumeration is tested (`KeyVaultSecretStore.test.ts:259-330`). After cutover, writes target only Table, while rollback simply drops the selector and declares the old Key Vault safe (`infra/azure/README.md:724-735`).

**Failure scenario.** Following the runbook either fails immediately for missing flags/target config, or adding `tableStore` rolls/restarts the router onto an empty Table before migration. If an operator works around that and later rolls back after users rotate tokens in the UI, workers boot using old Key Vault values—including credentials the user believed replaced or revoked.

**Recommended fix.** Add a distinct inactive `tableMigrationTarget` (or explicit CLI endpoint/key arguments) that does not affect runtime backend selection, and make the documented commands match the parser. Add end-to-end command tests with separate source/target fakes. For rollback, implement dual-write with monitored parity, or a reverse sync/export step that must complete before the selector can return to Key Vault; never call an unsynchronized backend “safe at any time.”

## R2-05 — HIGH — **Needs verification:** Table point reads rely on an undocumented response-header ETag

**Defect.** All existing-record reads fail closed unless Azure supplies an `ETag` response header. The unit fake supplies that header by construction, so the suite does not prove the Azure contract.

**Evidence.** `readRecord` requires the header before parsing the entity (`TableSecretStore.ts:356-386`, `:463-476`), with `Accept: application/json;odata=minimalmetadata` (`TableSecretStore.ts:27-34`, `:493-500`). The fake GET always adds `ETag` (`TableSecretStore.test.ts:99-106`); the “missing ETag” test merely confirms the chosen failure mode (`TableSecretStore.test.ts:485-505`). Microsoft's [Query Entities documentation](https://learn.microsoft.com/en-us/rest/api/storageservices/query-entities) lists point-query response headers without an entity ETag, while its examples place concurrency metadata in the entity depending on OData metadata level. Whether Azure additionally emits the header in this exact bearer-auth/minimalmetadata request **needs verification**.

**Failure scenario.** The first insert succeeds, but the next GET of that user's row throws “no ETag header.” `/setup`, container boot, saves, and migration verification all fail for every nonempty record. Mocked tests remain green.

**Recommended fix.** Run a disposable live-Azure contract test for GET/POST/conditional PUT/412. Parse the documented entity ETag field for the selected metadata mode (or select a mode that guarantees it), with the response header only as a compatible fallback. Do not ship based solely on the fake service.

## R2-06 — HIGH — A feature-off Terraform stack still creates storage/crypto/RBAC resources and changes router configuration

**Defect.** The change violates the required “strict no” behavior for deployments that do not enable `setupUi` or `tableStore`.

**Evidence.** The Table, KEK, Table Data Contributor assignment, and vault-scoped Crypto User assignment are unconditional (`setup_ui.tf:253-328`), even though all feature flags default false (`variables.tf:418-427`, `:492-495`, `:527-530`). The new `router_default_executor` also defaults to `"aca"` (`variables.tf:533-540`) and is unconditionally merged into the router containers JSON when non-null (`router.tf:50-63`), causing a Container App revision/config diff even with setup disabled. At runtime every existing database is also migrated with `entra_object_id` regardless of setup configuration (`RouterStore.ts:355-371`). The route itself is correctly absent when `setupUi` is unset (`RouterServer.ts:435-484`), but that is narrower than no behavioral/infrastructure change.

**Failure scenario.** An existing production stack applies an unrelated change without setting any setup variables. Terraform now attempts to create a Table and RSA key and grant the router additional Table/vault crypto privileges; the apply can fail if the applying principal lacks key permissions, and the default-executor JSON change rolls the single router replica. This is neither inert nor no-diff.

**Recommended fix.** Gate all new infrastructure and default-executor rendering behind an explicit feature lifecycle that is false by default. Preserve KEKs on disable by separating “create/manage resources” from “select backend” and using retained resources/state, not by forcing every stack to create them. Default `router_default_executor` to null unless the operator opts in. Gate or separately migrate `entra_object_id` if byte-for-byte off behavior is a hard compatibility requirement.

## R2-07 — HIGH — Email reuse still grants a different Entra object the previous user's secrets

**Defect.** The code detects a stable-object-ID mismatch but deliberately continues authorizing the new object as the old email identity.

**Evidence.** `SetupPrincipal` carries `objectId` (`principal.ts:59-65`), but route storage/version/CSRF keys use only email (`routes.ts:186-218`, `:240-268`, `:388-403`). Bootstrap says a different `oid` means old state was reattached to a new principal, logs both IDs, and explicitly does not block (`bootstrap.ts:282-317`). The Table partition is also a hash of lowercased email (`TableSecretStore.ts:53-56`).

**Failure scenario.** A former employee's UPN/email is reassigned. The new Entra object signs in with a valid token and immediately reads the old bundle's key/status metadata, replaces secrets, and can cause future sessions for that router user to run with attacker-controlled credentials. Outstanding CSRF/version tokens are likewise valid for the new object because they are email-bound; logout or password change does not revoke them, although every mutation still requires current authentication.

**Recommended fix.** Make `(tenantId, oid)` the authorization and storage identity, require `oid` in token mode, and treat a mismatch as a hard 403 pending an explicit administrator-approved rebind/migration. Bind CSRF and version tokens to that stable key (and, if session revocation is required, to a session identifier or shorter lifetime).

## R2-08 — MEDIUM — Azure request deadlines exclude credential acquisition

**Defect.** The 30-second deadline begins only after the bearer token promise resolves.

**Evidence.** Table awaits `tokenProvider()` while constructing headers before calling `azureRequest` (`TableSecretStore.ts:478-506`); Key Vault does the same (`envelope.ts:507-530`). The shared deadline wraps only `fetchFn` (`envelope.ts:309-343`). The default Table provider awaits dynamic import and `DefaultAzureCredential.getToken` with no signal/deadline (`TableSecretStore.ts:96-109`). Existing timeout tests replace the token provider with an immediate fake and hang only fetch (`TableSecretStore.test.ts:640-655`).

**Failure scenario.** Managed identity/DNS/credential-chain resolution hangs during boot or setup. The request timeout never starts, leaving a user request or container boot indefinitely pending despite the advertised bounded policy.

**Recommended fix.** Put token acquisition and HTTP dispatch under one overall operation deadline, or race each token provider against the same abort/deadline and pass the signal where the Azure Identity API supports it. Add a test with a never-resolving token provider.

## R2-09 — MEDIUM — Malformed stored envelope fields reach Key Vault before structural/base64 validation

**Defect.** Only `KekVersion` is validated before unwrap. Node's base64 decoder is permissive, and the wrapped DEK, IV, tag, and ciphertext have no canonical-encoding or exact-length checks before the authenticated Key Vault call.

**Evidence.** Table validates those columns only as nonempty strings (`TableSecretStore.ts:389-417`). `openBundle` immediately decodes `wrappedDek` and invokes `wrapper.unwrap`, then decodes the IV/tag/ciphertext afterward (`envelope.ts:160-183`). `KeyVaultKeyWrapper.unwrap` obtains a token and sends the attacker-controlled wrapped bytes to the fixed Key Vault URL (`envelope.ts:492-530`). The hostile-record tests mutate only `KekVersion` (`TableSecretStore.test.ts:676-689`); they do not mutate the encodings or assert zero token/network calls for structurally invalid fields.

**Failure scenario.** A principal with Table Data write access stores a very large or malformed `WrappedDek` and invalid IV/tag. Every read still acquires a vault token and sends an unwrap request that cannot succeed, creating avoidable Key Vault load/log noise and delaying failure. This does **not** restore the SSRF/token-exfiltration path because the destination remains fixed.

**Recommended fix.** Before token/network use, strictly decode canonical standard base64; require a 12-byte IV, 16-byte GCM tag, ciphertext within the bundle ceiling, and wrapped-DEK length matching the configured RSA modulus (256 bytes for RSA-2048). Add mutation tests for each field that assert zero token and fetch calls.

## R2-10 — MEDIUM — Production validation and test claims overstate what is actually exercised

**Defect.** Several load-bearing contracts are checked by substitutes that cannot exhibit the production behavior.

**Evidence.** The Table fake fabricates GET ETags (`TableSecretStore.test.ts:99-106`) and therefore cannot validate Azure's REST/OData response shape. The HTMX test only searches generated JavaScript text (`setup-views.test.ts:236-254`), while route DELETE tests inject a body the vendored client does not send (`setup-routes.test.ts:616-624`). The auth rollout's webhook/WSS “gate” does not produce a signed webhook or new socket handshake (`infra/azure/README.md:629-643`). There is no migration command test; the only related coverage is backend enumeration (`KeyVaultSecretStore.test.ts:259-330`).

**Failure scenario.** CI remains green while delete is broken, Table reads may be incompatible with Azure, the documented migration is rejected by its own CLI, and the auth sidecar can regress worker/webhook traffic without the runbook detecting it.

**Recommended fix.** Add three layers: a real-browser HTMX test, a disposable real-Azure Table/Key Vault contract smoke, and a production-like staged-auth/F1 drive with a signed webhook plus forced fresh WSS hello/heartbeat. Add CLI migration tests that execute the exact README commands. Keep mocked tests as unit tests, but label them accordingly.

## R2-11 — MEDIUM — The diff publishes internal organization and tracker identifiers

**Defect.** The public-repository hygiene requirement is not met.

**Evidence.** The added plan contains the real-looking Linear workspace/company slug `<workspace>` in issue URLs (`docs/superpowers/plans/2026-08-01-setup-management-ui.md:488-495`), a personal username and raw Linear thread UUIDs (`:514-520`, `:657-663`, `:831-837`), and repeated internal `NOR-*` issue identifiers in those same sections. Placeholder Azure GUIDs in tests/docs and public Azure role/application IDs are not findings.

**Failure scenario.** Publishing the branch discloses the organization's tracker namespace, employee handle, issue inventory, and durable thread identifiers even though the feature code itself contains no real tenant/client/subscription GUID or secret.

**Recommended fix.** Remove the exported Linear transcript from the public diff or redact the workspace/company slug, personal handles, thread UUIDs, and internal issue links before merge. Run a diff-only secret/identifier scan in CI.

+++

+++ Areas reviewed with no additional defect found

- **Envelope crypto:** every write generates a fresh 256-bit DEK and 12-byte IV, binds AES-GCM to the hashed-row/row-key/schema AAD, emits standard base64 to Table and base64url to Key Vault, zeroes DEKs in `finally`, and throws on tag/AAD/JSON/type failure (`envelope.ts:118-205`, `TableSecretStore.ts:427-449`). Read failures other than an actual Table 404 are thrown rather than converted to `{}` (`TableSecretStore.ts:356-387`, `:508-516`), so a corrupt/encrypted-row failure does not boot a worker with an empty credential bundle.
- **Token verification:** `jwtVerify` pins signature, exact configured audience, and v1/v2 tenant issuers; a second check rejects multi-audience arrays (`idTokenVerifier.ts:49-69`). Forged identity headers cannot influence token mode (`principal.ts:260-283`). Auth failures exposed to the user are generic (`principal.ts:244-250`).
- **Mutating-route auth shape:** every declared mutation calls the shared principal-then-CSRF guard (`routes.ts:591-616`, `:647-651`, `:690-692`). The missing registration check is R2-02, not an absent authentication/CSRF call.
- **Form parsing:** the parser applies a byte ceiling, returns a null-prototype map, retains repeated values, and drops decoded `__proto__`, `constructor`, and `prototype` keys (`formbody.ts:20-85`). I found no prototype-pollution path through it.
- **Secret disclosure:** rendered models expose only names/set-state, never stored values (`routes.ts:240-268`, `views.ts:96-105`); mutation logs contain email and field names but not submitted values (`routes.ts:728-731`). Error bodies can expose service errors, but Table carries only ciphertext and Key Vault wrap/unwrap payloads carry DEKs, not plaintext bundle values (`TableSecretStore.ts:508-514`, `envelope.ts:520-534`).
- **Executor invariant:** NULL/absent/corrupt remains physical device and only explicit `{"type":"default"}` inherits, end to end (`bootstrap.ts:64-118`, `ContainerTargets.ts:116-137`, `RouterStore.ts:355-370`, `:960-964`).

+++
