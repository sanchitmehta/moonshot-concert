terraform {
  required_version = ">= 1.9"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 5.12" }
  }
  backend "azurerm" {}
}

locals {
  environment    = jsondecode(file("${path.module}/../environment.json"))
  resource_group = local.environment.resourceGroups.shared
  tags           = { product = "moonshot-fest", managedBy = "terraform", team = "shared" }
}

provider "azurerm" {
  features {}
  subscription_id                 = local.environment.subscriptionId
  resource_provider_registrations = "none"
}

resource "azurerm_log_analytics_workspace" "main" {
  name                = "log-moonshot"
  resource_group_name = local.resource_group
  location            = local.environment.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.tags
}

resource "azurerm_application_insights" "main" {
  name                = "appi-moonshot"
  resource_group_name = local.resource_group
  location            = local.environment.location
  workspace_id        = azurerm_log_analytics_workspace.main.id
  application_type    = "Node.JS"
  tags                = local.tags
}

output "log_analytics_workspace_id" {
  value = azurerm_log_analytics_workspace.main.id
}

output "application_insights_connection_string" {
  value     = azurerm_application_insights.main.connection_string
  sensitive = true
}
