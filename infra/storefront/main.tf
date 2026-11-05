terraform {
  required_version = ">= 1.9"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 5.12" }
  }
  backend "azurerm" {}
}

locals {
  environment    = jsondecode(file("${path.module}/../environment.json"))
  resource_group = local.environment.resourceGroups.storefront
  location       = local.environment.location
  identity       = local.environment.runtimeIdentities.storefront
  tags           = { product = "moonshot-fest", managedBy = "terraform", team = "storefront" }
}

variable "data_platform_api_url" {
  description = "Base URL of the data-platform-api, published by the Data Platform team."
  type        = string
  default     = "https://app-moonshot-dataplatform-api.azurewebsites.net"
}

provider "azurerm" {
  features {}
  subscription_id                 = local.environment.subscriptionId
  resource_provider_registrations = "none"
}

data "terraform_remote_state" "shared" {
  backend = "azurerm"
  config = {
    storage_account_name = local.environment.stateStorageAccount
    container_name       = "tfstate-shared"
    key                  = "shared.tfstate"
    use_azuread_auth     = true
  }
}

resource "azurerm_service_plan" "main" {
  name                = "asp-moonshot-storefront"
  resource_group_name = local.resource_group
  location            = local.location
  os_type             = "Linux"
  sku_name            = "B1"
  tags                = local.tags
}

# Serves the website and its API from one origin.
resource "azurerm_linux_web_app" "storefront" {
  name                                           = "app-moonshot-storefront"
  resource_group_name                            = local.resource_group
  location                                       = local.location
  service_plan_id                                = azurerm_service_plan.main.id
  https_only                                     = true
  ftp_publish_basic_authentication_enabled       = false
  webdeploy_publish_basic_authentication_enabled = false
  key_vault_reference_identity_id                = local.identity.id
  tags                                           = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [local.identity.id]
  }

  site_config {
    always_on                         = true
    ftps_state                        = "Disabled"
    minimum_tls_version               = "1.2"
    health_check_path                 = "/health/ready"
    health_check_eviction_time_in_min = 2
    app_command_line                  = "npm start"

    application_stack {
      node_version = "24-lts"
    }
  }

  app_settings = {
    HOST                                  = "0.0.0.0"
    AZURE_CLIENT_ID                       = local.identity.clientId
    DATA_PLATFORM_API_URL                 = var.data_platform_api_url
    DATA_PLATFORM_API_SCOPE               = "${local.environment.dataPlatformApi.audience}/.default"
    LIVE_AVAILABILITY_ENABLED             = "true"
    WEB_DIST_DIR                          = "web"
    APPLICATIONINSIGHTS_CONNECTION_STRING = data.terraform_remote_state.shared.outputs.application_insights_connection_string
    OTEL_SERVICE_NAME                     = "storefront-api"
    SCM_DO_BUILD_DURING_DEPLOYMENT        = "false"
  }

  lifecycle {
    # BUILD_COMMIT is set by the deployment workflow. LIVE_AVAILABILITY_ENABLED is an operational
    # switch: approved mitigations may change it without a Terraform run.
    ignore_changes = [app_settings["BUILD_COMMIT"], app_settings["LIVE_AVAILABILITY_ENABLED"]]
  }
}

resource "azurerm_monitor_diagnostic_setting" "storefront" {
  name                       = "to-log-moonshot"
  target_resource_id         = azurerm_linux_web_app.storefront.id
  log_analytics_workspace_id = data.terraform_remote_state.shared.outputs.log_analytics_workspace_id

  enabled_log {
    category = "AppServiceConsoleLogs"
  }
  enabled_log {
    category = "AppServiceHTTPLogs"
  }
  enabled_log {
    category = "AppServicePlatformLogs"
  }
}

output "url" {
  value = "https://${azurerm_linux_web_app.storefront.default_hostname}"
}
