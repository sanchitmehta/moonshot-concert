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

# Team-owned monitoring: this team's SRE Agent reads only its own resource group.
resource "azurerm_log_analytics_workspace" "main" {
  name                = "log-moonshot-storefront"
  resource_group_name = local.resource_group
  location            = local.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.tags
}

resource "azurerm_application_insights" "main" {
  name                = "appi-moonshot-storefront"
  resource_group_name = local.resource_group
  location            = local.location
  workspace_id        = azurerm_log_analytics_workspace.main.id
  application_type    = "Node.JS"
  tags                = local.tags
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
    HOST                      = "0.0.0.0"
    AZURE_CLIENT_ID           = local.identity.clientId
    DATA_PLATFORM_API_URL     = var.data_platform_api_url
    DATA_PLATFORM_API_SCOPE   = "${local.environment.dataPlatformApi.audience}/.default"
    LIVE_AVAILABILITY_ENABLED = "true"
    # Which waiting-room queue each sale type joins, and how many guests each queue admits (admitCount every everySeconds).
    WAITING_ROOM_POLICY = jsonencode([
      { queue = "waitingroom-standard", saleType = "STANDARD", admitCount = 10, everySeconds = 5 },
      { queue = "waitingroom-drops", saleType = "LIMITED_DROP", admitCount = 5, everySeconds = 10 },
    ])
    # App Service unpacks compressed node_modules before the API listens on its port.
    WEBSITES_CONTAINER_START_TIME_LIMIT   = "600"
    WEB_DIST_DIR                          = "web"
    APPLICATIONINSIGHTS_CONNECTION_STRING = azurerm_application_insights.main.connection_string
    OTEL_SERVICE_NAME                     = "storefront-api"
    SCM_DO_BUILD_DURING_DEPLOYMENT        = "false"
  }

  logs {
    application_logs {
      file_system_level = "Information"
    }
    http_logs {
      file_system {
        retention_in_days = 3
        retention_in_mb   = 35
      }
    }
  }

  lifecycle {
    # Approved mitigations may change this operational switch without a Terraform run.
    ignore_changes = [app_settings["LIVE_AVAILABILITY_ENABLED"]]
  }
}

resource "azurerm_monitor_diagnostic_setting" "storefront" {
  name                       = "to-log-moonshot"
  target_resource_id         = azurerm_linux_web_app.storefront.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

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
