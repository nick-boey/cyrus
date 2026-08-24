# `infra/azure/bicep` — the Azure deploy path

This directory **is** the deployment. It replaced a Terraform stack that used to
live in `../terraform`; that directory is gone, and so is its state storage
account, its state resource group, its `bootstrap-tfstate.sh`, its
`backend.dev.hcl`, and the ARM-parity gate that existed only to keep two copies
of the sandbox-group shape in step.

Start from [`../README.md`](../README.md) for the end-to-end runbook. This file
covers the template layout and the things that are specific to Bicep.

## Layout

```
main.bicep                        subscription scope: parameters, validation,
                                  resource group, module orchestration, outputs
main.bicepparam.example           complete operator checklist — copy, fill, chmod 600
modules/
  foundation.bicep                Log Analytics, Key Vault + opt-in secret writes,
                                  router identity, storage + Files share + blob
                                  containers + optional Table/KEK, Container Apps
                                  environment + Files link, optional ACR, all RBAC
  sandbox-group.bicep             Microsoft.App/sandboxGroups (properties: {}) +
                                  Data Owner RBAC + the group identity's AcrPull
  router-app.bicep                the router Container App
  router-auth.bicep               the authConfigs child (stage 1 of /setup)
  monitoring.bicep                saved KQL searches + action group + alert rules
  sandbox-group-vnet.bicep        DEFERRED reference; not called by main.bicep
```

## Deploying

```bash
cp infra/azure/bicep/main.bicepparam.example infra/azure/bicep/main.bicepparam
chmod 600 infra/azure/bicep/main.bicepparam
# fill in the environment identifiers and immutable images, then:
./scripts/deploy-azure.sh            # what-if preview
./scripts/deploy-azure.sh --apply    # deploy
```

The steady-state parameter file contains no secret values. A first deployment or
deliberate rotation temporarily sets `writeLinearSecrets = true`, supplies all
five Linear values, and adds `--allow-secret-writes` to both commands. Clear the
values and restore the flag to `false` immediately afterwards.

Private deployment automation can keep its environment file outside this public
checkout and select the public build without rewriting either file:

```bash
./scripts/deploy-azure.sh \
  --params /private/deploy/main.bicepparam \
  --router-image ghcr.io/cyrusagents/cyrus@sha256:<64-hex-digest> \
  --apply
```

`scripts/deploy-azure.sh` is the documented entry point and does three things the
template cannot — see [Where enforcement lives](#where-enforcement-lives).

Compile everything locally before pushing:

```bash
./scripts/check-bicep.sh
```

It builds every template, type-checks `main.bicepparam.example` against
`main.bicep`, and **treats warnings as failures**. CI runs the same script.

## Why Bicep, in one paragraph

The deployment is now **stateless**. There is no state file to store, lock,
migrate, or leak; ARM holds the state, and `az deployment sub what-if` reads the
real resources rather than a recorded belief about them. Three concrete
consequences:

- **A wrong `key` in a backend config can no longer make a live stack look
  absent.** That failure mode — a plan proposing to create every resource from
  scratch — does not exist without a state file.
- **`prevent_destroy` is unnecessary.** Incremental deployments never delete a
  resource that leaves the template, so the per-user secret store's Table and KEK
  survive their feature flag being cleared. Under Terraform that required
  `prevent_destroy`, a deliberately asymmetric flag, and a `terraform state rm`
  step in the decommissioning runbook. All three are gone.
- **The `routerUrlForContainers` two-apply dance is gone.** The router's ingress
  FQDN is `<app>.<managedEnvironment.defaultDomain>`, and the environment is a
  separate resource from the app, so the URL can be computed in the same
  deployment that creates the app without a dependency cycle.

The one new footgun: **never deploy with `--mode Complete`.** Complete mode is
what would delete the Table and the KEK — the key that unwraps every stored
per-user secret. `scripts/deploy-azure.sh` does not offer it.

## Where enforcement lives

Three guarantees need help outside Bicep. The deploy script supplies that help,
and it is worth knowing exactly where, because the trust basis changed slightly.

### The image tag policy

`routerImage` and `workerImage` must be pinned to an immutable reference. The
check is split:

| Layer | Checks | Bypassable by |
| --- | --- | --- |
| `main.bicep` | ref **shape**: `@sha256:` + 64 chars, `sha-` + 7–40 chars, or `v?X.Y.Z` with decimal-leading components | nothing — it fails template evaluation |
| `scripts/deploy-azure.sh` | the full character-level regex (64 **hex**, 7–40 **hex**, decimal components) | running `az deployment` by hand |

ARM has no regex engine. Expressing character classes in-template would mean
either a 16-deep `replace` chain per image or a user-defined function, and the
latter pushes the emitted template onto ARM `languageVersion 2.0` — a change of
template dialect that a validation nicety does not justify. The shape check
alone already rejects every mutable tag anyone has actually used here, including
`deploy-aca-disk-fix`.

Note the policy narrowed in one respect: a **bare hex tag** (`repo:a1b2c3d`, no
`sha-` prefix) was accepted by the Terraform regex and is rejected now. Nothing
regresses — `.github/workflows/docker-router.yml` only ever publishes
`sha-<sha>` and `v<semver>`.

### The `/setup` stage ordering

Reaching a live `/setup` takes two deployments, and the second must not happen
until the first is live. Terraform proved this at plan time with a data source
that read the deployed `authConfigs` child out of Azure — evidence about
deployment history that no input value could fake.

Bicep has no plan phase and no equivalent "does this resource exist" read. The
same question is now asked by `scripts/deploy-azure.sh`, which calls
`az containerapp auth show` and refuses a stage-2 deployment unless the auth
child exists **and** reports `platform.enabled` and
`identityProviders.azureActiveDirectory.enabled`. That is still an answer from
ARM about real remote state, not a boolean an operator typed — but it can be
bypassed by invoking `az deployment sub create` directly. Don't. The full
runbook, including the behavioural checks that no automated read can perform, is
[`../README.md` §11](../README.md#11-optional-the-setup-management-ui-setup).

### Secret writes require two keys

Routine deployments must not need secret values and must not overwrite a secret
rotated directly in Key Vault. The five Linear secrets and the two `/setup`
secrets are therefore omitted from the ARM template unless their corresponding
`writeLinearSecrets` or `writeSetupAuthSecrets` parameter is `true`. Because the
deployment is Incremental, omitting those child resources preserves the existing
secret versions. The router continues to use fixed, versionless Key Vault URIs.
Both the template validation and deploy script also reject populated secret
fields while the corresponding write flag is false, so routine CD does not even
transmit stale bootstrap values to ARM.

A write also requires the independent `--allow-secret-writes` command-line
switch. The Bicep flag makes the intended resource part of the template; the
script switch proves that the operator knowingly entered a bootstrap or rotation
operation. Either control alone is insufficient when using the documented deploy
path. Calling `az deployment` directly bypasses the script half of this guard.

This is also the private-CD seam: its routine job needs Azure identity,
environment parameters, and immutable image refs, but receives no Linear or
`/setup` secret values. Seed or rotate those values in a separately authorized
manual operation.

### Cross-parameter invariants

Bicep's `@allowed` / `@minValue` / `@minLength` decorators cover
single-parameter constraints, and every one of them in this stack is expressed
that way. They cannot express a rule spanning two parameters, which most of the
interesting rules are (`enableSetupUi` requires `enableSetupAuth`;
`setupUiAutoProvisionUsers` requires a membership gate; and so on).

Those live in `main.bicep` as a `parameterViolations` array plus a
`parameterGuard` variable. The guard indexes `{ valid: {} }` with `'valid'` when
every rule holds and with the **violation text** when one does not — a key ARM
cannot resolve, so the deployment fails before touching a resource and the error
message names the broken rule. The guard is folded into `defaultTags` via
`union(…, {})` because a variable nothing reads is not guaranteed to be
evaluated, and a validation that might not run is not a validation.

The alternative is an `assert` statement, which is gated behind an experimental
feature flag and emits `languageVersion: 2.1-experimental` — which the Bicep
compiler itself warns against using in production. This idiom compiles to plain
`2019-04-01` ARM.

## Role definition GUIDs

Bicep cannot resolve a role definition by display name. Built-in roles carry the
same GUID in every tenant, so `modules/foundation.bicep` names them as
constants. Verify any of them with:

```bash
az role definition list --name "Key Vault Secrets User" --query "[].name" -o tsv
```

`Container Apps SandboxGroup Data Owner` is the one exception worth checking in a
new tenant, because it is a preview role: it is a parameter
(`sandboxGroupDataOwnerRoleId`) rather than a constant, defaulting to the
spike-S6-verified `c24cf47c-5077-412d-a19c-45202126392c`.

## Why the sandbox group's shape is so small

The original plan assumed the sandbox-group resource took `defaultCpu`,
`defaultMemory`, `defaultDisk`, and `maxSandboxCount`. **It does not.** Spike
finding ("Other facts"): the ARM resource created successfully with
`properties: {}`, and the server returns only `allowedLocations`, `connections`,
`managementEndpoint`, `provisioningState`. Per-sandbox sizing and egress are set
on each `PUT /sandboxes` create body by the router, not on the group.
`maxSandboxCount` is therefore **not** a usable cost guard — see
[`../README.md` → "maxSandboxCount does NOT exist as a cost guard"](../README.md#maxsandboxcount-does-not-exist-as-a-cost-guard).

See `docs/superpowers/specs/2026-07-25-aca-sandboxes-spike-findings.md` for the
full spike record.

## Deploying a module standalone

`modules/sandbox-group-vnet.bicep` is a deferred reference for VNet isolation and
is not called by `main.bicep`. Its subnet property name was not exercised in the
spike; validate it against a live deploy before relying on it.

```bash
az deployment group create -g <rg> \
  -f infra/azure/bicep/modules/sandbox-group-vnet.bicep \
  -p sandboxGroupName=<group> subnetId=<subnet-resource-id>
```
