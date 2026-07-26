terraform {
  required_version = ">= 1.9.0"

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
  features {
    # The Key Vault in this stack is created WITHOUT purge protection for dev
    # ergonomics (see README → prereqs). azurerm's `prevent_purging_on_delete`
    # would otherwise leave hidden scheduled-purge blobs blocking re-deploys.
    key_vault {
      prevent_purging_on_delete = false
    }
  }
}

provider "azapi" {
  # tenant_id and subscription_id default to the ambient CLI credential
  # (`az login`). Override via env or tfvars when targeting multiple tenants.
}

# The `azuread` provider is configured here for completeness; it is inert until
# an `azuread_*` resource is added in a future task (Entra enrollment, Task 8).
provider "azuread" {}