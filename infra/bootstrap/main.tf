terraform {
  required_version = ">= 1.9"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 5.12" }
    azuread = { source = "hashicorp/azuread", version = "~> 3.10" }
    random  = { source = "hashicorp/random", version = "~> 3.7" }
    local   = { source = "hashicorp/local", version = "~> 2.5" }
  }
  # First run: see infra/README.md (state starts local, then moves into the storage this root creates).
  backend "azurerm" {}
}

provider "azurerm" {
  features {}
  subscription_id                 = var.subscription_id
  storage_use_azuread             = true
  resource_provider_registrations = "none"
  resource_providers_to_register = [
    "Microsoft.Cache",
    "Microsoft.DBforPostgreSQL",
    "Microsoft.DocumentDB",
    "Microsoft.Insights",
    "Microsoft.ManagedIdentity",
    "Microsoft.OperationalInsights",
    "Microsoft.Storage",
    "Microsoft.Web",
  ]
}

provider "azuread" {}

data "azurerm_client_config" "current" {}

locals {
  teams = {
    shared       = "rg-moonshot-shared"
    storefront   = "rg-moonshot-storefront"
    dataplatform = "rg-moonshot-dataplatform"
  }
  tags = { product = "moonshot-fest", managedBy = "terraform", layer = "bootstrap" }
}

# Team boundaries: each team deploys only into its own resource group.
resource "azurerm_resource_group" "team" {
  for_each = local.teams
  name     = each.value
  location = var.location
  tags     = merge(local.tags, { team = each.key })
}

# Terraform state. One container per root so each team can only write its own state.
resource "azurerm_storage_account" "state" {
  name                            = var.state_storage_account_name
  resource_group_name             = azurerm_resource_group.team["shared"].name
  location                        = var.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  shared_access_key_enabled       = false
  allow_nested_items_to_be_public = false
  default_to_oauth_authentication = true
  tags                            = local.tags

  blob_properties {
    versioning_enabled = true
  }
}

resource "azurerm_storage_container" "state" {
  for_each           = toset(["bootstrap", "shared", "storefront", "dataplatform"])
  name               = "tfstate-${each.key}"
  storage_account_id = azurerm_storage_account.state.id
}

resource "azurerm_role_assignment" "operator_state" {
  scope                = azurerm_storage_account.state.id
  role_definition_name = "Storage Blob Data Owner"
  principal_id         = data.azurerm_client_config.current.object_id
}

# Runtime identities. The services sign in to Cosmos DB, PostgreSQL, Redis, and each other with these.
resource "azurerm_user_assigned_identity" "runtime" {
  for_each            = { storefront = "id-moonshot-storefront-api", dataplatform = "id-moonshot-dataplatform-api" }
  name                = each.value
  resource_group_name = azurerm_resource_group.team[each.key].name
  location            = var.location
  tags                = merge(local.tags, { team = each.key })
}

# GitHub Actions identities: one per Terraform root, trusted only for this repository's main branch.
resource "azurerm_user_assigned_identity" "github" {
  for_each            = local.teams
  name                = "id-moonshot-github-${each.key}"
  resource_group_name = azurerm_resource_group.team[each.key].name
  location            = var.location
  tags                = merge(local.tags, { team = each.key })
}

resource "azurerm_federated_identity_credential" "github" {
  for_each                  = local.teams
  name                      = "github-main"
  user_assigned_identity_id = azurerm_user_assigned_identity.github[each.key].id
  audience                  = ["api://AzureADTokenExchange"]
  issuer                    = "https://token.actions.githubusercontent.com"
  subject                   = "repo:${var.github_repository}:ref:refs/heads/main"
}

resource "azurerm_role_assignment" "github_team" {
  for_each             = local.teams
  scope                = azurerm_resource_group.team[each.key].id
  role_definition_name = "Contributor"
  principal_id         = azurerm_user_assigned_identity.github[each.key].principal_id
}

resource "azurerm_role_assignment" "github_state" {
  for_each             = local.teams
  scope                = azurerm_storage_container.state[each.key].id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.github[each.key].principal_id
}

# Team roots read the shared root's outputs (monitoring) but cannot change them.
resource "azurerm_role_assignment" "github_shared_state_read" {
  for_each             = toset(["storefront", "dataplatform"])
  scope                = azurerm_storage_container.state["shared"].id
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = azurerm_user_assigned_identity.github[each.key].principal_id
}

# Team roots send their resources' diagnostic logs to the shared Log Analytics workspace.
resource "azurerm_role_assignment" "github_shared_logs" {
  for_each             = toset(["storefront", "dataplatform"])
  scope                = azurerm_resource_group.team["shared"].id
  role_definition_name = "Log Analytics Contributor"
  principal_id         = azurerm_user_assigned_identity.github[each.key].principal_id
}

# The data-platform-api accepts only callers holding this app role.
resource "random_uuid" "data_platform_access_role" {}

resource "azuread_application" "data_platform_api" {
  display_name     = "Moonshot Fest Data Platform API"
  sign_in_audience = "AzureADMyOrg"
  owners           = [data.azurerm_client_config.current.object_id]

  api {
    requested_access_token_version = 2
  }

  app_role {
    allowed_member_types = ["Application"]
    description          = "Read the catalog and availability, and create and read reservations."
    display_name         = "Data Platform access"
    id                   = random_uuid.data_platform_access_role.result
    value                = "DataPlatform.Access"
    enabled              = true
  }
}

resource "azuread_application_identifier_uri" "data_platform_api" {
  application_id = azuread_application.data_platform_api.id
  identifier_uri = "api://${azuread_application.data_platform_api.client_id}"
}

resource "azuread_service_principal" "data_platform_api" {
  client_id                    = azuread_application.data_platform_api.client_id
  app_role_assignment_required = true
  owners                       = [data.azurerm_client_config.current.object_id]
}

resource "azuread_app_role_assignment" "storefront_to_data_platform" {
  app_role_id         = random_uuid.data_platform_access_role.result
  principal_object_id = azurerm_user_assigned_identity.runtime["storefront"].principal_id
  resource_object_id  = azuread_service_principal.data_platform_api.object_id
}

# Committed so that GitHub Actions and the team roots need no secrets or repository variables.
resource "local_file" "environment" {
  filename = "${path.module}/../environment.json"
  content = jsonencode({
    tenantId            = data.azurerm_client_config.current.tenant_id
    subscriptionId      = var.subscription_id
    location            = var.location
    stateStorageAccount = azurerm_storage_account.state.name
    stateResourceGroup  = azurerm_resource_group.team["shared"].name
    resourceGroups      = local.teams
    githubClientIds     = { for team, identity in azurerm_user_assigned_identity.github : team => identity.client_id }
    runtimeIdentities = {
      for team, identity in azurerm_user_assigned_identity.runtime : team => {
        id          = identity.id
        name        = identity.name
        clientId    = identity.client_id
        principalId = identity.principal_id
      }
    }
    dataPlatformApi = {
      clientId     = azuread_application.data_platform_api.client_id
      audience     = "api://${azuread_application.data_platform_api.client_id}"
      requiredRole = "DataPlatform.Access"
    }
  })
}
