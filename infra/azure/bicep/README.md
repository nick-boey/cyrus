# `infra/azure/bicep` — reference shape (NOT the deploy path)

**Terraform is the deploy path.** The files in this directory are the canonical
ARM shape the Terraform AzAPI body in `../terraform/sandbox.tf` must mirror.
They exist so a property-order-insensitive diff (`scripts/check-aca-arm-parity.sh`)
can prevent drift between the maintained stack and the native-ARM reference
(plan D8 / M5). Do not deploy from Bicep in production unless you have a
specific reason (e.g. an operator Alice who only knows Bicep and needs a
one-off).

## Files

- `sandbox-group.bicep` — `Microsoft.App/sandboxGroups@2026-02-01-preview`
  with `properties: {}`, `SystemAssigned` identity, and the
  `managementEndpoint` output. **Mirrors `../terraform/sandbox.tf`'s
  `azapi_resource.sandbox_group` location, body, identity, and tags.**
- `sandbox-group-rbac.bicep` — Data Owner role assignment for a given
  principal scoped to an existing group. The role definition GUID is the
  spike-S6-verified default and is overridable via parameter.
- `sandbox-group-vnet.bicep` — **deferred/optional** `vnetConnections` child.
  Not wired into Terraform; the subnet reference shape was not exercised in the
  spike and must be confirmed against a live deploy before relied on.
- `sandbox-group.bicepparam.example` — sample parameter file.

## Why the shape is so small (spike override)

The original plan assumed the sandbox-group resource took `defaultCpu`,
`defaultMemory`, `defaultDisk`, and `maxSandboxCount`. **It does not.** Spike
finding ("Other facts"): the ARM resource created successfully with
`properties: {}`, and the server returns only `allowedLocations`,
`connections`, `managementEndpoint`, `provisioningState`. Per-sandbox
sizing/egress is set on each `PUT /sandboxes` create body by the router, not
on the group. `maxSandboxCount` is therefore NOT a usable cost guard — see
`../README.md` → "maxSandboxCount does NOT exist as a cost guard".

See `docs/superpowers/specs/2026-07-25-aca-sandboxes-spike-findings.md` for the
full spike record.

## Standalone deploy

```bash
cp sandbox-group.bicepparam.example sandbox-group.bicepparam
az deployment group create \
  -g rg-cyrus-dev \
  -f sandbox-group.bicep \
  -p sandbox-group.bicepparam
```

Or inline parameters:

```bash
az deployment group create -g rg-cyrus-dev -f sandbox-group.bicep \
  -p name=cyrus-dev-sandbox-grp location=australiaeast
```

The role-assignment module deploys separately (it references the group
`existing`):

```bash
az deployment group create -g rg-cyrus-dev -f sandbox-group-rbac.bicep \
  -p sandboxGroupName=cyrus-dev-sandbox-grp \
     principalId=<router-UAI-principal-id>
```

## Parity gate (M5)

Run from the repo root:

```bash
./scripts/check-aca-arm-parity.sh
```

It:

1. Builds `infra/azure/bicep/sandbox-group.bicep` to ARM JSON with
   `bicep build --stdout`, then extracts location, identity, properties, and
   tags.
2. Parses the `azapi_resource.sandbox_group` `body = { properties = {} }`
   block from `infra/azure/terraform/sandbox.tf` heuristically with Python
   (UTF-8-aware, brace-balanced extraction) and `jsonencode`s the captured
   HCL object literal into JSON.
3. Normalizes equivalent parameter references and verifies the complete JSON
   values are order-insensitively equal. Fails (non-zero) on any key or value
   difference.

Dependencies: `bicep`, `python3`, `jq`.

### Wiring into CI

The root `.github/workflows/ci.yml` runs this as the separate `aca-parity` job:

```yaml
  aca-parity:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: azure/setup-bicep@v2
      - run: ./scripts/check-aca-arm-parity.sh
```

The script is heuristic, not a real Terraform parser. If `sandbox.tf` changes
its `body = { ... }` layout substantially the extraction step may need an
update — the script calls this out in a top-of-file comment.
