# Storefront alerts, owned by the Storefront team. Both are log search alerts on log-moonshot-storefront,
# checked every minute over the last five minutes, raised on the resource in _ResourceId and resolved
# automatically. No action group: the SRE Agent reads Azure Monitor alerts itself.

# Log search alerts keep the resource group's region (East US 2); it cannot change once a rule exists.
data "azurerm_resource_group" "storefront" {
  name = local.resource_group
}

locals {
  alert_tags = merge(local.tags, { component = "monitoring" })
}

# The line has stopped moving: the storefront asks the Data Platform to admit guests from a queue, the
# Data Platform refuses with an error code, and nobody from that queue was admitted in the window.
# Failures without a code (network errors, an app restarting) are not refusals, so a deployment or
# restart does not fire it. One row per stalled queue, raised on the storefront's Application Insights.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "waiting_room_stalled" {
  name                    = "Waiting room stalled"
  display_name            = "Waiting room stalled"
  description             = "Guests are waiting in a storefront waiting-room queue, the Data Platform is refusing to admit them, and nobody from that queue has been admitted in the window."
  resource_group_name     = local.resource_group
  location                = data.azurerm_resource_group.storefront.location
  scopes                  = [azurerm_log_analytics_workspace.main.id]
  severity                = 2
  evaluation_frequency    = "PT1M"
  window_duration         = "PT5M"
  auto_mitigation_enabled = true
  enabled                 = true
  tags                    = local.alert_tags

  criteria {
    query                   = <<-KQL
      AppMetrics
      | where Name in ('waitingroom.admission_failures', 'waitingroom.admitted')
      | extend Queue = tostring(Properties.queue),
          Refused = Name == 'waitingroom.admission_failures' and tostring(Properties.upstreamCode) !in ('', 'undefined')
      | summarize Refusals = sumif(Sum, Refused), Admitted = sumif(Sum, Name == 'waitingroom.admitted') by Queue, _ResourceId
      | where Refusals > 0 and Admitted == 0
    KQL
    time_aggregation_method = "Count"
    operator                = "GreaterThanOrEqual"
    threshold               = 1
    resource_id_column      = "_ResourceId"

    failing_periods {
      number_of_evaluation_periods             = 1
      minimum_failing_periods_to_trigger_alert = 1
    }
  }
}

# Checkout is failing: the storefront answers POST /api/reservations with server errors. Read from
# App Service's own HTTP logs, which are exact and independent of the application's telemetry.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "checkout_failures" {
  name                    = "Storefront checkout failures"
  display_name            = "Storefront checkout failures"
  description             = "Checkout requests to the storefront (POST /api/reservations) are being answered with server errors."
  resource_group_name     = local.resource_group
  location                = data.azurerm_resource_group.storefront.location
  scopes                  = [azurerm_log_analytics_workspace.main.id]
  severity                = 2
  evaluation_frequency    = "PT1M"
  window_duration         = "PT5M"
  auto_mitigation_enabled = true
  enabled                 = true
  tags                    = local.alert_tags

  criteria {
    query                   = "AppServiceHTTPLogs | where CsMethod == 'POST' and CsUriStem =~ '/api/reservations' and ScStatus >= 500 | project TimeGenerated, _ResourceId, ScStatus"
    time_aggregation_method = "Count"
    operator                = "GreaterThanOrEqual"
    threshold               = 10
    resource_id_column      = "_ResourceId"

    failing_periods {
      number_of_evaluation_periods             = 1
      minimum_failing_periods_to_trigger_alert = 1
    }
  }
}

# This rule was first created outside Terraform; adopt it rather than recreate it.
import {
  to = azurerm_monitor_scheduled_query_rules_alert_v2.checkout_failures
  id = "/subscriptions/cb47277e-5e03-40e1-a7b1-3db3d3940eab/resourceGroups/rg-moonshot-storefront/providers/Microsoft.Insights/scheduledQueryRules/Storefront checkout failures"
}
