terraform {
  required_version = ">= 1.9"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 5.12" }
  }
  backend "azurerm" {}
}

# Shared resources used by both teams (for example the SRE Agents) belong here. Monitoring lives in each
# team's own resource group, so each team's agent reads only its own telemetry.
locals {
  environment = jsondecode(file("${path.module}/../environment.json"))
}

provider "azurerm" {
  features {}
  subscription_id                 = local.environment.subscriptionId
  resource_provider_registrations = "none"
}

# On-call notifications for alerts and incidents across both teams. Receivers are added when the
# alerting and SRE Agent setup lands.
resource "azurerm_monitor_action_group" "oncall" {
  name                = "ag-moonshot-oncall"
  resource_group_name = local.environment.resourceGroups.shared
  short_name          = "msf-oncall"
  tags                = { product = "moonshot-fest", managedBy = "terraform", team = "shared" }
}