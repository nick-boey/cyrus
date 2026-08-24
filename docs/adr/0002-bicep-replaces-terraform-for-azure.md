---
status: accepted
---

# Bicep replaces Terraform for the Azure deployment

The Azure footprint that hosts the router and its ACA sandbox group was deployed
by a Terraform stack under `infra/azure/terraform`, backed by a remote state blob
in its own resource group. It is now a Bicep stack under `infra/azure/bicep`,
applied with `scripts/deploy-azure.sh`. The Terraform directory, the state
storage account, `scripts/bootstrap-tfstate.sh`, the `backend.dev.hcl` mechanism,
and `scripts/check-aca-arm-parity.sh` are all deleted.

The decisive property is **statelessness**. The Terraform stack's most dangerous
failure mode had nothing to do with Azure: a wrong `key` in the partial backend
config produced a plan that proposed creating every resource from scratch against
a stack that demonstrably existed — the README had to warn about this explicitly.
A state file is a second, independently corruptible record of what is deployed,
it needs its own storage account in its own resource group precisely because
`terraform destroy` would otherwise delete the container holding the file it is
mid-write to, and it embeds the Linear client secret and both OAuth tokens in
plaintext regardless of `sensitive = true`. ARM already knows what is deployed.
`az deployment sub what-if` reads the resources; there is nothing to lock,
migrate, leak, or get wrong.

Three concrete simplifications fell out, none of them the reason for the change
but each worth more than the conversion cost:

**`prevent_destroy` is unnecessary.** ARM incremental deployments do not delete a
resource that leaves the template. The per-user secret store's Table and KEK
therefore survive `enableSetupSecretStore` being cleared, which is exactly the
behaviour Terraform needed `prevent_destroy` to approximate — at the cost of a
deliberately asymmetric flag whose "off" position failed the plan, and a
`terraform state rm` step in the decommissioning runbook. All three are gone.

**The `routerUrlForContainers` two-apply flow is gone.** Terraform could only get
the router's ingress FQDN from the Container App resource itself, and embedding
it in that same resource's environment was a dependency cycle — hence a first
apply with a placeholder and a second with the real value pasted into tfvars.
The FQDN is `<app>.<managedEnvironment.defaultDomain>`, and the environment is a
separate resource, so Bicep computes it in the deployment that creates the app.

**No import step.** Incremental deployments adopt resources that already exist
with a matching name and type, so the ACR bootstrap the router image needs is two
`az` commands rather than a `-target`ed apply, and a resource created by hand is
converged onto rather than collided with.

## Considered options

**Keep Terraform.** Rejected on the state file alone. The remaining reasons to
prefer it here were weak: no module registry was in use, no multi-cloud
resources, and the one genuinely Terraform-shaped resource — the ACA sandbox
group on a preview API — was already being maintained *twice*, once as an AzAPI
body and once as a Bicep reference file, with a bespoke Python HCL parser in CI
to keep the two in step. Deleting Terraform deleted that whole apparatus.

**Terraform for the stack, Bicep only for the sandbox group.** This was the
status quo, and it is what produced the parity gate. Two copies of one ARM shape
is a standing tax paid to a heuristic diff.

**ARM JSON directly.** Rejected: Bicep compiles to it, and the JSON is
unreviewable at this size.

## Consequences

Three guarantees could not be expressed completely in the template and moved into
`scripts/deploy-azure.sh`. This is the real cost of the change and is stated
plainly rather than glossed.

**The `/setup` stage ordering.** Reaching a live `/setup` takes two deployments,
and the second must not precede the first — otherwise the Container App publishes
a revision serving `/setup` before the EasyAuth child attaches, which is an
unauthenticated page on the public internet. Terraform enforced this at plan time
with a data source that read the deployed `authConfigs` child out of Azure:
evidence about deployment history that no input value could fake, and strictly
better than the operator boolean it replaced. Bicep has no plan phase and no
equivalent "does this resource exist" read. The check now runs in the deploy
script via `az containerapp auth show`, which is the same *class* of evidence —
ARM answering a question about real remote state — but is bypassable by invoking
`az deployment sub create` by hand. The parameter-level checks
(`enableSetupUi` requires `enableSetupAuth` and `setupAuthStage1Verified`) remain
as a fast first line, and they remain attestations rather than controls.

**The character-level half of the image tag policy.** ARM has no regex engine.
`main.bicep` checks the ref *shape* — `@sha256:` plus 64 characters, `sha-` plus
7–40, or `v?X.Y.Z` with decimal-leading components — and the deploy script checks
that those characters are actually hex or decimal. Expressing character classes
in-template would mean either a sixteen-deep `replace` chain per image or a
user-defined function, and the latter pushes the emitted template onto ARM
`languageVersion 2.0` — a change of template dialect that a validation nicety
does not justify. One narrowing came with this: a bare hex tag (`repo:a1b2c3d`,
no `sha-` prefix) was accepted by the Terraform regex and is rejected now. The
repo's own workflow only publishes `sha-<sha>` and `v<semver>`, so nothing in
practice regresses, and narrowing a positive allowlist is safe in the direction
that matters.

**Secret writes require independent consent.** Routine deployments must neither
receive Linear or `/setup` secret values nor restore stale values over versions
rotated directly in Key Vault. `writeLinearSecrets` and
`writeSetupAuthSecrets` default to `false`; when false, the Bicep modules omit
the corresponding Key Vault child resources. Incremental mode preserves the
existing versions and the router continues to use their fixed, versionless
URIs. Validation also requires every value field to be empty when its write flag
is false, preventing routine CD from transmitting stale bootstrap inputs to ARM.
A deliberate bootstrap or rotation must both enable the relevant template flag
and invoke the deploy script with `--allow-secret-writes`. The template
flag determines the ARM shape, while the independent command-line switch makes
the exceptional operation visible at the deployment boundary. As with the two
checks above, calling `az deployment` directly bypasses the script half of the
guard.

Cross-parameter invariants — `enableSetupTableBackend` requires
`enableSetupSecretStore`, `setupUiAutoProvisionUsers` requires a membership gate,
and so on — did stay in the template. Bicep's decorators cover only
single-parameter constraints, so these are collected into a `parameterViolations`
array and enforced by indexing an object with the violation text, a key ARM
cannot resolve. The guard is folded into `defaultTags` through `union(x, {})`
because a variable nothing reads is not guaranteed to be evaluated, and a
validation that might not run is not a validation. The obvious alternative,
an `assert` statement, is gated behind an experimental feature flag and emits
`languageVersion: 2.1-experimental`, which the Bicep compiler itself warns
against using in production.

`--mode Complete` is now the stack's sharpest edge, and it is new. Complete mode
*would* delete the Table and the KEK, and losing the KEK makes every wrapped
per-user secret permanently unreadable. `deploy-azure.sh` does not offer the
flag and the README says so in three places, but a hand-run `az deployment` can
still reach it — which is the same shape of exposure as the two gates above, and
the same mitigation: use the script.

Two smaller behavioural differences are worth knowing. An explicitly enabled
Key Vault secret write is now a management-plane write
(`Microsoft.KeyVault/vaults/secrets`), so the deploying principal no longer
needs *Key Vault Secrets Officer*, and creating the `/setup` KEK no longer needs
*Key Vault Crypto Officer*; Contributor covers both. Every optional secret
parameter is `@secure()` so its value is not persisted into ARM deployment
history. And Bicep cannot resolve a role definition by display name
the way `data.azurerm_role_definition` did, so built-in role GUIDs are constants
in `modules/foundation.bicep` — safe, since built-in roles carry the same GUID in
every tenant, with the preview *Container Apps SandboxGroup Data Owner* role kept
as an overridable parameter because that assumption is weaker for a preview role.

Finally, one pre-existing inconsistency was resolved rather than carried over.
`setup_ui_auto_provision_users` defaulted to `true` in `variables.tf` while its
own README documented `false` and claimed an enforcement — "Terraform enforces
it: `setup_ui_auto_provision_users = true` fails validation unless a membership
gate is in place" — that was never written. The Bicep parameter implements the
documented, stricter contract: default `false`, and the membership gate is
genuinely required by `parameterViolations`.
