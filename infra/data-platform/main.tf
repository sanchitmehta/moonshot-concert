terraform {
  required_version = ">= 1.9"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 5.12" }
    aws     = { source = "hashicorp/aws", version = "~> 6.72" }
    archive = { source = "hashicorp/archive", version = "~> 2.7" }
  }
  backend "azurerm" {}
}

locals {
  environment    = jsondecode(file("${path.module}/../environment.json"))
  resource_group = local.environment.resourceGroups.dataplatform
  location       = local.environment.location
  identity       = local.environment.runtimeIdentities.dataplatform
  api            = local.environment.dataPlatformApi
  tags           = { product = "moonshot-fest", managedBy = "terraform", team = "dataplatform" }
}

provider "azurerm" {
  features {}
  subscription_id                 = local.environment.subscriptionId
  resource_provider_registrations = "none"
}

# Team-owned monitoring for the data platform.
resource "azurerm_log_analytics_workspace" "main" {
  name                = "log-moonshot-dataplatform"
  resource_group_name = local.resource_group
  location            = local.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.tags
}

resource "azurerm_application_insights" "main" {
  name                = "appi-moonshot-dataplatform"
  resource_group_name = local.resource_group
  location            = local.location
  workspace_id        = azurerm_log_analytics_workspace.main.id
  application_type    = "Node.JS"
  tags                = local.tags
}

# Festival and pass catalog. Serverless; only Microsoft Entra identities can read or write data.
resource "azurerm_cosmosdb_account" "catalog" {
  name                          = "cosmos-moonshot-catalog"
  resource_group_name           = local.resource_group
  location                      = local.location
  offer_type                    = "Standard"
  kind                          = "GlobalDocumentDB"
  local_authentication_enabled  = false
  public_network_access_enabled = true
  tags                          = local.tags

  capabilities {
    name = "EnableServerless"
  }

  consistency_policy {
    consistency_level = "Session"
  }

  geo_location {
    location          = local.location
    failover_priority = 0
  }
}

resource "azurerm_cosmosdb_sql_database" "moonshot" {
  name                = "moonshot"
  resource_group_name = local.resource_group
  account_name        = azurerm_cosmosdb_account.catalog.name
}

resource "azurerm_cosmosdb_sql_container" "catalog" {
  name                = "catalog"
  resource_group_name = local.resource_group
  account_name        = azurerm_cosmosdb_account.catalog.name
  database_name       = azurerm_cosmosdb_sql_database.moonshot.name
  partition_key_paths = ["/kind"]
}

# Built-in Cosmos DB Data Contributor.
resource "azurerm_cosmosdb_sql_role_assignment" "api" {
  resource_group_name = local.resource_group
  account_name        = azurerm_cosmosdb_account.catalog.name
  role_definition_id  = "${azurerm_cosmosdb_account.catalog.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002"
  principal_id        = local.identity.principalId
  scope               = azurerm_cosmosdb_account.catalog.id
}

# Availability cache and waiting-room queues. Access keys are disabled; the API signs in with its identity.
resource "azurerm_managed_redis" "cache" {
  name                      = "redis-moonshot-cache"
  resource_group_name       = local.resource_group
  location                  = local.location
  sku_name                  = "Balanced_B0"
  high_availability_enabled = false
  public_network_access     = "Enabled"
  tags                      = local.tags

  default_database {
    access_keys_authentication_enabled = false
    client_protocol                    = "Encrypted"
    # A single endpoint for non-cluster-aware clients.
    clustering_policy = "EnterpriseCluster"
    eviction_policy   = "VolatileLRU"
  }
}

resource "azurerm_managed_redis_access_policy_assignment" "api" {
  managed_redis_id = azurerm_managed_redis.cache.id
  object_id        = local.identity.principalId
}

resource "azurerm_service_plan" "main" {
  name                = "asp-moonshot-dataplatform"
  resource_group_name = local.resource_group
  location            = local.location
  os_type             = "Linux"
  sku_name            = "B1"
  tags                = local.tags
}

resource "azurerm_linux_web_app" "api" {
  name                                           = "app-moonshot-dataplatform-api"
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
    app_command_line                  = "node --import ./src/instrumentation.ts src/server.ts"

    application_stack {
      node_version = "24-lts"
    }
  }

  app_settings = {
    HOST                      = "0.0.0.0"
    AUTH_MODE                 = "entra"
    ENTRA_TENANT_ID           = local.environment.tenantId
    ENTRA_AUDIENCES           = "${local.api.clientId},${local.api.audience}"
    ENTRA_REQUIRED_ROLE       = local.api.requiredRole
    AZURE_CLIENT_ID           = local.identity.clientId
    DATABASE_URL              = "postgres://${local.rds_user}@${aws_db_instance.core.address}:5432/${aws_db_instance.core.db_name}?sslmode=require"
    DATABASE_AUTH             = "aws-iam"
    DATABASE_CA_FILE          = "certs/rds-global-bundle.pem"
    DATABASE_ADMIN_SECRET_ARN = aws_db_instance.core.master_user_secret[0].secret_arn
    AWS_REGION                = local.aws.region
    AWS_ROLE_ARN              = local.aws.dataPlatformRuntimeRole
    AWS_FEDERATION_RESOURCE   = local.aws.federationResource
    ADMISSION_MINUTES         = "10"
    BILLING_FUNCTION          = aws_lambda_function.billing.function_name
    BILLING_DATABASE_USER     = local.billing_db_user
    ADMISSION_QUEUES          = jsonencode(["waitingroom-standard"])
    # Keep the existing allowance for certificate updates and dependency authentication.
    WEBSITES_CONTAINER_START_TIME_LIMIT   = "600"
    COSMOS_ENDPOINT                       = azurerm_cosmosdb_account.catalog.endpoint
    COSMOS_DATABASE                       = azurerm_cosmosdb_sql_database.moonshot.name
    COSMOS_CREATE                         = "false"
    REDIS_URL                             = "rediss://${azurerm_managed_redis.cache.hostname}:10000"
    REDIS_AUTH                            = "entra"
    APPLICATIONINSIGHTS_CONNECTION_STRING = azurerm_application_insights.main.connection_string
    OTEL_SERVICE_NAME                     = "data-platform-api"
    SCM_DO_BUILD_DURING_DEPLOYMENT        = "false"
    WEBSITE_RUN_FROM_PACKAGE              = "1"
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

  depends_on = [
    azurerm_cosmosdb_sql_role_assignment.api,
    aws_iam_role_policy.api_core,
    aws_iam_role_policy.api_billing,
    azurerm_managed_redis_access_policy_assignment.api,
  ]
}

resource "azurerm_monitor_diagnostic_setting" "api" {
  name                       = "to-log-moonshot"
  target_resource_id         = azurerm_linux_web_app.api.id
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

# The retired Azure PostgreSQL server's Entra administrator owns that server's objects and cannot be
# dropped on its own; deleting the server removes it, so Terraform only forgets it.
removed {
  from = azurerm_postgresql_flexible_server_active_directory_administrator.api

  lifecycle {
    destroy = false
  }
}
output "api_url" {
  value = "https://${azurerm_linux_web_app.api.default_hostname}"
}
