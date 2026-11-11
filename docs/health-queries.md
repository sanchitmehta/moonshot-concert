# Health queries

Queries both teams use to check how Moonshot Fest is running. [architecture.html](architecture.html)
shows how the services connect, and [service-map.md](service-map.md) lists the log lines, metrics
and error codes these queries read.

## Where the signals are

| Service | Signals | Where |
| --- | --- | --- |
| storefront-api (`app-moonshot-storefront`) | Requests, outbound calls, log lines and metrics; App Service HTTP, console and platform logs | Log Analytics workspace `log-moonshot-storefront` in `rg-moonshot-storefront` |
| data-platform-api (`app-moonshot-dataplatform-api`) | The same | Log Analytics workspace `log-moonshot-dataplatform` in `rg-moonshot-dataplatform` |
| Billing (`fn-moonshot-billing`) | Log lines for every invocation and charge; Lambda metrics | CloudWatch in `us-east-1`: log group `/aws/lambda/fn-moonshot-billing`, namespace `AWS/Lambda` |
| Core database (`rds-moonshot-core`) | PostgreSQL log, including every statement slower than 500 ms; instance metrics | CloudWatch in `us-east-1`: log group `/aws/rds/instance/rds-moonshot-core/postgresql`, namespace `AWS/RDS` |

Both workspaces have the same tables. Run a query in the workspace of the service you are asking
about: in the Azure portal (the workspace, then **Logs**) or from the CLI.

```bash
az monitor log-analytics workspace show --resource-group rg-moonshot-dataplatform \
  --workspace-name log-moonshot-dataplatform --query customerId --output tsv
az monitor log-analytics query --workspace <workspace ID> --analytics-query "<query>"
```

## Reading the tables

| Table | Holds | Read it like this |
| --- | --- | --- |
| `AppRequests` | Requests the API handled | Sampled when traffic is heavy: total with `sum(ItemCount)`, not `count()` |
| `AppDependencies` | Calls the API made: HTTP, PostgreSQL, Redis | Sampled the same way |
| `AppTraces` | Log lines | The line is `Message`; its fields are in `Properties` |
| `AppExceptions` | Log lines that carry an error | The line is `Properties.msg`; the error is `ExceptionType` and `OuterMessage`; the stack is `Details` |
| `AppMetrics` | The services' own metrics | `Name` is the metric and `Properties` its attributes. A counter has one row a minute with the increase in `Sum`; a gauge has its value in `Sum` |
| `AppServiceHTTPLogs` | Every request App Service received | Not sampled. `ScStatus` is the status and `TimeTaken` the milliseconds. Rows arrive a few minutes after the request |
| `AppServiceConsoleLogs` | The service's console output | One JSON log line per row, in `ResultDescription` |
| `AppServicePlatformLogs` | Container starts and stops | |

Each query covers the last hour; change `ago(1h)` to look further back. Times are UTC. Property
names are case-sensitive (`Properties.confirmationCode`, not `Properties.ConfirmationCode`).

## Either service

Run these in `log-moonshot-storefront` or in `log-moonshot-dataplatform`.

### Requests and server errors per minute

```kusto
AppServiceHTTPLogs
| where TimeGenerated > ago(1h)
| summarize Requests = count(), ServerErrors = countif(ScStatus >= 500) by bin(TimeGenerated, 1m)
| render timechart
```

### Requests by route

IDs in the path are replaced, so that every request to a route counts in one row.

```kusto
AppServiceHTTPLogs
| where TimeGenerated > ago(1h)
| where CsUriStem startswith "/api/" or CsUriStem startswith "/v1/"
| extend Route = replace_regex(CsUriStem, @"/(offers|reservations|waiting-room|entries)/[^/]+", @"/\1/{id}")
| summarize Requests = count(), ClientErrors = countif(ScStatus between (400 .. 499)),
    ServerErrors = countif(ScStatus >= 500), P95Ms = percentile(TimeTaken, 95) by CsMethod, Route
| order by ServerErrors desc, Requests desc
```

### Response time

```kusto
AppServiceHTTPLogs
| where TimeGenerated > ago(1h)
| summarize P50Ms = percentile(TimeTaken, 50), P95Ms = percentile(TimeTaken, 95) by bin(TimeGenerated, 1m)
| render timechart
```

### Outbound calls

In the storefront workspace these are the calls to the data-platform-api. In the data platform
workspace they are the calls to PostgreSQL, Redis, Cosmos DB and billing.

```kusto
AppDependencies
| where TimeGenerated > ago(1h)
| summarize Calls = sum(ItemCount), Failed = sumif(ItemCount, Success == false), AvgMs = round(avg(DurationMs))
    by DependencyType, Target, ResultCode
| order by Calls desc
```

### Log lines by severity

`SeverityLevel` is 1 for information, 2 for a warning and 3 for an error.

```kusto
AppTraces
| where TimeGenerated > ago(1h)
| summarize Lines = count(), Last = max(TimeGenerated) by SeverityLevel, Message
| order by SeverityLevel desc, Lines desc
```

### Errors logged

One row per log line and error, with the first frame of the stack that is in this repository.
Confirmation codes are masked, so that the same error counts in one row.

```kusto
AppExceptions
| where TimeGenerated > ago(1h)
| extend LogLine = tostring(Properties.msg), Code = tostring(Properties.code),
    Error = replace_regex(OuterMessage, @"MSF-[A-Z0-9]{4}-[A-Z0-9]{4}", "MSF-…"),
    Frame = extract(@"src/[\w/.-]+\.ts(:\d+)?", 0, tostring(Details))
| summarize Count = count(), First = min(TimeGenerated), Last = max(TimeGenerated)
    by LogLine, Code, ExceptionType, Error, Frame
| order by Count desc
```

### Requests refused

Requests the service answered with a 4xx, by error code.

```kusto
AppTraces
| where TimeGenerated > ago(1h) and Message == "Request refused"
| summarize Requests = count() by Code = tostring(Properties.code), Status = tostring(Properties.status)
| order by Requests desc
```

### Starts and restarts

A deployment or a change to the app's settings restarts the container.

```kusto
AppServicePlatformLogs
| where TimeGenerated > ago(24h)
| project TimeGenerated, Level, Message, DeploymentId, ContainerId
| order by TimeGenerated desc
```

### What each start logged

A service's first line after a start says what is on sale. `Service started` follows, with the
deployed commit and the settings the service read.

```kusto
AppTraces
| where TimeGenerated > ago(24h)
| where Message in ("Sale is live", "No passes are on sale", "Service started")
| project TimeGenerated, Message, Properties
| order by TimeGenerated desc
```

## Storefront

Run these in `log-moonshot-storefront`.

### Admission worker

The worker's requests to admit guests and the guests it admitted, for each queue.

```kusto
AppMetrics
| where TimeGenerated > ago(1h) and Name in ("waitingroom.admission_calls", "waitingroom.admitted")
| summarize Total = sum(Sum) by bin(TimeGenerated, 1m), Series = strcat(Name, " ", tostring(Properties.queue))
| render timechart
```

### Admission requests that failed

```kusto
AppMetrics
| where TimeGenerated > ago(1h) and Name == "waitingroom.admission_failures"
| summarize Failures = sum(Sum) by bin(TimeGenerated, 5m), Queue = tostring(Properties.queue),
    Status = tostring(Properties.upstreamStatus), Code = tostring(Properties.upstreamCode)
| order by TimeGenerated desc
```

### Live availability

```kusto
AppMetrics
| where TimeGenerated > ago(1h) and Name == "storefront.live_availability.requests"
| summarize Requests = sum(Sum) by bin(TimeGenerated, 1m), Outcome = tostring(Properties.outcome)
| render timechart
```

### Reservations by outcome

How each `POST /api/reservations` ended.

```kusto
AppTraces
| where TimeGenerated > ago(1h)
| where Message in ("Reservation confirmed", "Reservation refused", "Reservation not confirmed")
| summarize Reservations = count() by bin(TimeGenerated, 1m), Message
| render timechart
```

### Reservations by code

The storefront's error code for each reservation that was refused or not confirmed, and what the
data-platform-api answered.

```kusto
AppTraces
| where TimeGenerated > ago(1h) and Message in ("Reservation refused", "Reservation not confirmed")
| summarize Reservations = count(), P95Ms = percentile(todouble(Properties.durationMs), 95)
    by Message, Code = tostring(Properties.code), UpstreamStatus = tostring(Properties.upstreamStatus),
    UpstreamCode = tostring(Properties.upstreamCode)
| order by Reservations desc
```

## Data platform

Run these in `log-moonshot-dataplatform`.

### Waiting room: guests joining and admitted

```kusto
AppMetrics
| where TimeGenerated > ago(1h) and Name in ("waitingroom.joined", "waitingroom.admitted")
| summarize Guests = sum(Sum) by bin(TimeGenerated, 1m), Series = strcat(Name, " ", tostring(Properties.queue))
| render timechart
```

### Waiting room: guests in line

```kusto
AppMetrics
| where TimeGenerated > ago(1h) and Name == "waitingroom.waiting"
| summarize Waiting = max(Sum) by bin(TimeGenerated, 1m), Queue = tostring(Properties.queue)
| render timechart
```

### Checkout outcomes

Reservations per minute for each line the checkout logs when it finishes.

```kusto
union AppTraces, AppExceptions
| where TimeGenerated > ago(1h)
| extend Line = coalesce(tostring(Properties.msg), Message)
| where Line in ("Reservation paid", "Payment refused; reservation cancelled",
    "Billing unavailable; reservation left pending", "Payment taken but reservation not confirmed")
| summarize Reservations = dcount(tostring(Properties.confirmationCode)) by bin(TimeGenerated, 1m), Line
| render timechart
```

### Checkout steps

The lines a checkout writes on its way to `Reservation paid`, counted by reservation.

```kusto
AppTraces
| where TimeGenerated > ago(1h)
| where Message in ("Passes held", "Retry resumed a pending reservation", "Retry returned a confirmed reservation",
    "Payment confirmed by billing", "Reservation paid")
| summarize Reservations = dcount(tostring(Properties.confirmationCode)), Lines = count() by Message
| order by Reservations desc
```

### One reservation, line by line

Every line the data-platform-api wrote for one confirmation code. As written it follows the most
recent one; set `code` to any confirmation code to follow another.

```kusto
let code = toscalar(union AppTraces, AppExceptions
    | where TimeGenerated > ago(1h) and isnotempty(tostring(Properties.confirmationCode))
    | top 1 by TimeGenerated desc
    | project tostring(Properties.confirmationCode));
union AppTraces, AppExceptions
| where TimeGenerated > ago(1h) and tostring(Properties.confirmationCode) == code
| project TimeGenerated, Line = coalesce(tostring(Properties.msg), Message), SeverityLevel, Error = OuterMessage, Properties
| order by TimeGenerated asc
```

### Availability reads

Reads of remaining stock, by freshness (`SNAPSHOT`, `LIVE`) and cache result (`hit`, `miss`,
`error`, `bypass`).

```kusto
AppMetrics
| where TimeGenerated > ago(1h) and Name == "availability.reads"
| summarize Reads = sum(Sum) by bin(TimeGenerated, 1m),
    Series = strcat(tostring(Properties.freshness), " ", tostring(Properties.cache))
| render timechart
```

## One request through both services

A call from the storefront-api to the data-platform-api continues the same trace, so both services
record it under one `OperationId`. Run this in `log-moonshot-storefront`; it reads the data platform
workspace too, so it needs read access to both. As written it follows the most recent storefront
request that ended in a server error. Set `op` to any `OperationId` to follow another request.

```kusto
let op = toscalar(AppRequests
    | where TimeGenerated > ago(1h) and toint(ResultCode) >= 500
    | top 1 by TimeGenerated desc
    | project OperationId);
union AppRequests, AppDependencies, AppExceptions, AppTraces,
    workspace("log-moonshot-dataplatform").AppRequests, workspace("log-moonshot-dataplatform").AppDependencies,
    workspace("log-moonshot-dataplatform").AppExceptions, workspace("log-moonshot-dataplatform").AppTraces
| where TimeGenerated > ago(1h) and OperationId == op
| project TimeGenerated, Service = AppRoleName, Kind = Type,
    What = coalesce(tostring(Properties.msg), Message, strcat(Name, " ", iff(Type == "AppRequests", Url, Target))),
    Result = ResultCode, Error = OuterMessage, DurationMs
| order by TimeGenerated asc
```

## Billing and the core database (AWS)

Run these in CloudWatch Logs Insights, region `us-east-1`. Billing's log group uses Lambda's text
format, so each JSON line has a timestamp and request ID in front of it and the queries pick the
fields out of the text.

### Billing requests by action and outcome

Log group `/aws/lambda/fn-moonshot-billing`.

```
filter @message like /"message":"Billing request"/
| parse @message /"action":"(?<action>[A-Za-z]+)"/
| parse @message /"outcome":"(?<outcome>[a-z]+)"/
| stats count(*) as requests by bin(1m), action, outcome
```

### Reservations charged

For a charge, `reference` is the reservation's confirmation code (`MSF-XXXX-XXXX`), the same value
as `confirmationCode` in the data-platform-api's log lines. A repeated charge for one reservation
returns the original payment, so `requests` can be higher than `reservations`.

```
filter @message like /"message":"Billing request"/ and @message like /"action":"charge"/
| parse @message /"reference":"(?<reference>[^"]+)"/
| parse @message /"outcome":"(?<outcome>[a-z]+)"/
| stats count_distinct(reference) as reservations, count(*) as requests by bin(1m), outcome
```

### Charges: new and repeated

`Wallet charged` is a new charge. `Charge replayed` is a repeated charge that billing answered with
the reservation's original payment.

```
filter @message like /"message":"(Wallet charged|Charge replayed)"/
| parse @message /"message":"(?<line>[^"]+)"/
| parse @message /"reference":"(?<reference>[^"]+)"/
| stats count(*) as lines, count_distinct(reference) as reservations by bin(1m), line
```

### One reservation in billing

Replace the confirmation code with the reservation's.

```
filter @message like /MSF-XXXX-XXXX/
| display @timestamp, @message
| sort @timestamp asc
```

### Refusals by code

```
filter @message like /"message":"Billing request"/ and @message like /"outcome":"refused"/
| parse @message /"code":"(?<code>[A-Z_]+)"/
| stats count(*) as refusals by code
```

### Billing failures and timeouts

```
filter @message like /"message":"Billing request failed"/ or @message like /Task timed out/ or @message like /Runtime\./
| sort @timestamp desc
| limit 50
```

### Billing duration

```
filter @type = "REPORT"
| stats count(*) as invocations, avg(@duration) as avgMs, pct(@duration, 95) as p95Ms, max(@duration) as maxMs by bin(1m)
```

### Billing cold starts

`startMs` is how long the function took to connect to the core database and check its schema.

```
filter @message like /"message":"Billing ready"/
| parse @message /"startMs":(?<startMs>[0-9]+)/
| display @timestamp, startMs
| sort @timestamp desc
| limit 50
```

### Slow statements in the core database

Log group `/aws/rds/instance/rds-moonshot-core/postgresql`. PostgreSQL logs every statement that
takes 500 ms or longer.

```
filter @message like /duration: /
| parse @message /duration: (?<durationMs>[0-9.]+) ms/
| display @timestamp, durationMs, @message
| sort @timestamp desc
| limit 50
```

### Errors in the core database

```
filter @message like /ERROR:|FATAL:|PANIC:/
| sort @timestamp desc
| limit 50
```

### From the CLI

```bash
aws logs start-query --region us-east-1 --log-group-name /aws/lambda/fn-moonshot-billing \
  --start-time <epoch seconds> --end-time <epoch seconds> --query-string '<query>'
aws logs get-query-results --region us-east-1 --query-id <query ID>
```

## Platform metrics

| Resource | Metric | Statistic |
| --- | --- | --- |
| `app-moonshot-storefront`, `app-moonshot-dataplatform-api` | `Requests`, `Http2xx`, `Http4xx`, `Http5xx` | Total |
| The same | `HttpResponseTime` (seconds) | Average |
| The same | `HealthCheckStatus` (100 when every instance answers `/health/ready`) | Average |
| The same | `CpuTime`, `MemoryWorkingSet` | Total, Average |
| `fn-moonshot-billing` (`AWS/Lambda`, `FunctionName`) | `Invocations`, `Errors`, `Throttles` | Sum |
| The same | `Duration` | Average, p95 |
| `rds-moonshot-core` (`AWS/RDS`, `DBInstanceIdentifier`) | `DatabaseConnections`, `CPUUtilization`, `FreeableMemory` | Average |

Billing returns a refused payment as a normal response, so the Lambda `Errors` metric counts only
invocations that failed.

```bash
az monitor metrics list --resource <web app resource ID> --metric Http5xx --interval PT1M --aggregation Total

aws cloudwatch get-metric-statistics --region us-east-1 --namespace AWS/Lambda --metric-name Errors \
  --dimensions Name=FunctionName,Value=fn-moonshot-billing \
  --start-time <start, ISO 8601> --end-time <end, ISO 8601> --period 60 --statistics Sum
```

## Health endpoints

| Request | Answer |
| --- | --- |
| `GET https://app-moonshot-storefront.azurewebsites.net/health/ready` | 200 when the storefront-api can reach the data-platform-api; otherwise 503. The body names the check: `dataPlatform` |
| `GET https://app-moonshot-dataplatform-api.azurewebsites.net/health/ready` | 200 when PostgreSQL, Redis and Cosmos DB all answer; otherwise 503. The body names each check: `database`, `cache`, `catalog`, `queues` |
| `GET /version` on either host | The service, its version and the commit that is deployed |

App Service calls `/health/ready` on every instance and replaces an instance that fails it.

## If a query returns nothing

1. Check the workspace. The table names are the same in both, and each holds one service.
2. Widen the time range. If the portal's time picker does not say "Set in query", it is limiting
   the query as well.
3. Wait a few minutes. `AppServiceHTTPLogs`, `AppServiceConsoleLogs` and `AppServicePlatformLogs`
   arrive later than the Application Insights tables, and metrics are exported once a minute.
4. A metric has no rows until its first value: `waitingroom.admission_failures` is empty when
   no admission request has failed.
