variable "sre_agent_principal_ids" {
  description = "Existing Entra Agent ID object IDs keyed by team, not the agents' or apps' managed identities. Configure only after the agents and web apps exist."
  type        = map(string)
  default     = {}
  nullable    = false

  validation {
    condition = alltrue([
      for team, principal_id in var.sre_agent_principal_ids :
      contains(["storefront", "dataplatform"], team) &&
      can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", principal_id))
    ]) && length(distinct([for id in values(var.sre_agent_principal_ids) : lower(id)])) == length(var.sre_agent_principal_ids)
    error_message = "Use storefront and/or dataplatform keys with distinct Agent ID object IDs in GUID format."
  }
}

locals {
  sre_agent_apps = {
    storefront = {
      name            = "app-moonshot-storefront"
      assignment_name = "2023586a-91e7-5a64-ae5f-18664ec4119e"
    }
    dataplatform = {
      name            = "app-moonshot-dataplatform-api"
      assignment_name = "a654ba1a-fe7b-5fa0-b2b5-ebbd6cd7ee26"
    }
  }
}

resource "azurerm_role_definition" "sre_agent_app_settings" {
  role_definition_id = "a232b207-4786-5e2a-becf-9f8c78999ead"
  name               = "SRE Agent App Service Settings Reader"
  scope              = "/subscriptions/${var.subscription_id}"
  description        = "Read App Service sensitive configuration values. Assign only at each SRE Agent's own web app scope. Does not grant configuration writes."

  permissions {
    actions          = ["Microsoft.Web/sites/config/list/action"]
    not_actions      = []
    data_actions     = []
    not_data_actions = []
  }

  assignable_scopes = [
    for team in ["storefront", "dataplatform"] : azurerm_resource_group.team[team].id
  ]
}

resource "azurerm_role_assignment" "sre_agent_app_settings" {
  for_each           = var.sre_agent_principal_ids
  name               = local.sre_agent_apps[each.key].assignment_name
  scope              = "${azurerm_resource_group.team[each.key].id}/providers/Microsoft.Web/sites/${local.sre_agent_apps[each.key].name}"
  role_definition_id = azurerm_role_definition.sre_agent_app_settings.role_definition_resource_id
  principal_id       = each.value
  principal_type     = "ServicePrincipal"
  description        = "Read only this agent's own App Service configuration values."
}
