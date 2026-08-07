terraform {
  required_version = ">= 1.9.0"

  # PARTIAL backend config — every setting is supplied at init time:
  #
  #   terraform init -backend-config=env/backend.dev.hcl
  #
  # Deliberately empty rather than literal. A backend block cannot interpolate
  # variables, so naming the storage account here would publish an environment
  # identifier in a public repo (see 44665f32) and would hardcode a single
  # environment into a stack whose whole naming scheme is parameterised.
  #
  # The backing storage lives in its OWN resource group (`rg-cyrus-tfstate`),
  # created out of band by scripts/bootstrap-tfstate.sh and never present in
  # state. It cannot live in `azurerm_resource_group.this` (main.tf:28): that RG
  # is managed by this stack, so `terraform destroy` would delete the container
  # holding the state file it is mid-write to. See README → "Terraform state
  # backend".
  #
  # Locking is native — the azurerm backend takes a blob lease. There is no
  # separate lock table to provision.
  backend "azurerm" {}

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    azapi = {
      source  = "azure/azapi"
      version = "~> 2.0"
    }
    # Optional: AzureAD provider is only required when the operator chooses to
    # wire Entra-side app/SP objects through Terraform (e.g. for Task 8). It is
    # declared here so `terraform init` pulls it, but no resources bind to it
    # in this stack — keeping the deploy surface minimal.
    azuread = {
      source  = "hashicorp/azuread"
      version = "~> 3.0"
    }
  }
}

provider "azurerm" {
  features {}
}

provider "azapi" {
  # tenant_id and subscription_id default to the ambient CLI credential
  # (`az login`). Override via env or tfvars when targeting multiple tenants.
}

# The `azuread` provider is configured here for completeness; it is inert until
# an `azuread_*` resource is added in a future task (Entra enrollment, Task 8).
provider "azuread" {}
