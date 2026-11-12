# Data Platform alerts and alarms, owned by the Data Platform team.
#  - Azure: a log search alert on log-moonshot-dataplatform for reservation errors. It is disabled:
#    the storefront's alerts are the customer-facing signal, and two alerts on one failure start two
#    investigations. Enable it when the Data Platform needs its own page.
#  - AWS: CloudWatch alarms on the billing function and the core database. They notify no one; they
#    record state that the team and the SRE Agent read when investigating.

# Log search alerts keep the resource group's region (East US 2); it cannot change once a rule exists.
data "azurerm_resource_group" "dataplatform" {
  name = local.resource_group
}

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "reservation_errors" {
  name                    = "Reservation API errors"
  display_name            = "Reservation API errors"
  description             = "Reservation requests to the Data Platform API (POST /v1/reservations) are being answered with server errors."
  resource_group_name     = local.resource_group
  location                = data.azurerm_resource_group.dataplatform.location
  scopes                  = [azurerm_log_analytics_workspace.main.id]
  severity                = 2
  evaluation_frequency    = "PT1M"
  window_duration         = "PT5M"
  auto_mitigation_enabled = true
  enabled                 = false
  tags                    = merge(local.tags, { component = "monitoring" })

  criteria {
    query                   = "AppServiceHTTPLogs | where CsMethod == 'POST' and CsUriStem =~ '/v1/reservations' and ScStatus >= 500 | project TimeGenerated, _ResourceId, ScStatus"
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
  to = azurerm_monitor_scheduled_query_rules_alert_v2.reservation_errors
  id = "/subscriptions/cb47277e-5e03-40e1-a7b1-3db3d3940eab/resourceGroups/rg-moonshot-dataplatform/providers/Microsoft.Insights/scheduledQueryRules/Reservation API errors"
}

# Billing failed: the function threw (a refusal such as insufficient funds is a normal result, not an error).
resource "aws_cloudwatch_metric_alarm" "billing_errors" {
  alarm_name          = "fn-moonshot-billing-errors"
  alarm_description   = "fn-moonshot-billing invocations are failing. Reservations stay pending until billing succeeds."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.billing.function_name }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 2
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "billing_throttles" {
  alarm_name          = "fn-moonshot-billing-throttles"
  alarm_description   = "fn-moonshot-billing invocations are being throttled."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  dimensions          = { FunctionName = aws_lambda_function.billing.function_name }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 2
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "core_cpu" {
  alarm_name          = "rds-moonshot-core-cpu"
  alarm_description   = "rds-moonshot-core CPU has been above 80% for 10 minutes."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.core.identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  comparison_operator = "GreaterThanThreshold"
  threshold           = 80
  treat_missing_data  = "missing"
}

resource "aws_cloudwatch_metric_alarm" "core_free_storage" {
  alarm_name          = "rds-moonshot-core-free-storage"
  alarm_description   = "rds-moonshot-core has less than 2 GiB of free storage."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.core.identifier }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "LessThanThreshold"
  threshold           = 2147483648
  treat_missing_data  = "missing"
}
