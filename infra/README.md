# Moonshot Fest infrastructure

Everything in Azure and AWS is defined here in Terraform (plus one CloudFormation template for
the AWS trust) and deployed by GitHub Actions. Each team owns one resource group and one
Terraform root, and can change nothing outside it.

[Topology](#topology) |
[Resource groups](#resource-groups) |
[Identities and access](#identities-and-access) |
[AWS](#aws-data-platform) |
[Deploying](#deploying) |
[Bootstrap](#bootstrap) |
[Change the AWS account](#change-the-aws-account) |
[Change the Azure subscription](#change-the-azure-subscription) |
[Troubleshooting](#troubleshooting)

## Topology

```text
                         Festival attendee (browser)
                                    │ HTTPS
                                    ▼
┌─ rg-moonshot-storefront ─────────────── Storefront team ──────────────┐
│                                                                       │
│   app-moonshot-storefront  (App Service, P1v3 x2, West US 3)         │
│   ├─ website (React, built)                                           │
│   └─ storefront-api ── signs in as id-moonshot-storefront-api         │
│                                                                       │
│   log-moonshot-storefront ◄── appi-moonshot-storefront  (telemetry)   │
│   id-moonshot-github-storefront  (GitHub deploys this RG only)        │
└───────────────────────────────────┬───────────────────────────────────┘
                                    │ HTTPS + Entra token
                                    │ (app role DataPlatform.Access)
                                    ▼
┌─ rg-moonshot-dataplatform ──────────── Data Platform team ────────────┐
│                                                                       │
│   app-moonshot-dataplatform-api  (App Service, P1v3 x2, West US 3)   │
│        signs in as id-moonshot-dataplatform-api                       │
│        │                  │                     │                     │
│        │ Entra token      │ Entra token         │ AWS IAM token       │
│        ▼                  ▼                     │ (see AWS below)     │
│   cosmos-moonshot-   redis-moonshot-cache       │                     │
│   catalog            (availability snapshots,   │                     │
│   (festival, passes)  waiting-room queues)      │                     │
│                                                                       │
│   log-moonshot-dataplatform ◄── appi-moonshot-dataplatform            │
│   id-moonshot-github-dataplatform  (GitHub deploys this RG only)      │
└────────────────────────────────────────────────┼──────────────────────┘
                                                 ▼
┌─ AWS account (us-east-1) ───────────── Data Platform team ────────────┐
│   rds-moonshot-core  (RDS PostgreSQL 16; database core: prices,       │
│                       stock, reservations; schema billing)            │
│   sg-moonshot-core   (PostgreSQL from the API's outbound IPs only)    │
│   fn-moonshot-billing  (Lambda: wallets, payments, invoices; invoked  │
│                         by the API's AWS role only)                   │
│   role moonshot-billing-fn  (billing's execution role)                │
│   role moonshot-dataplatform-api  (assumed with the API's Entra token) │
│   role moonshot-github-dataplatform  (GitHub deploys AWS resources)   │
└───────────────────────────────────────────────────────────────────────┘

┌─ rg-moonshot-shared ────────────────── both teams ────────────────────┐
│   stmoonshottfstate      Terraform state (one container per root)     │
│   ag-moonshot-oncall     on-call action group                         │
│   id-moonshot-github-shared                                           │
└───────────────────────────────────────────────────────────────────────┘

 GitHub Actions (OIDC, no secrets)          Owner, locally (rarely)
 ├─ CI: tests + Terraform plans on push     └─ bootstrap: RGs, identities,
 ├─ Deploy shared                              state storage, Entra app role
 ├─ Deploy data platform (infra + api)
 └─ Deploy storefront (infra + web/api)

 Apps: West US 3 · Azure data/monitoring: South Central US
 RGs, identities, state: East US 2
 No keys or passwords anywhere: every hop uses Entra or AWS IAM tokens.
```

Web apps run in **West US 3**. Each team's `local.app_location` controls only its
web app and App Service plan. Azure data stores and monitoring stay in
**South Central US**, using `environment.json`'s existing location. Do not change
that shared location to migrate web apps. Resource groups, identities and state
stay in **East US 2**; a resource group's region only records where its metadata lives.

## Resource groups

Each resource group is a team boundary. Monitoring is per team, so each team
reads its own telemetry.

### `rg-moonshot-storefront`: Storefront team

| Resource | Name | Notes |
| --- | --- | --- |
| App Service plan | `asp-moonshot-storefront` | West US 3, Linux P1v3, zone-redundant, two instances; production and staging share capacity |
| Web app | `app-moonshot-storefront` | Website and storefront-api on one origin, Node 24, health check `/health/ready` |
| Deployment slot | `staging` | Same runtime identity and dependencies as production; admission worker disabled |
| Managed identity | `id-moonshot-storefront-api` | The app's identity; holds the `DataPlatform.Access` app role |
| Log Analytics | `log-moonshot-storefront` | App Service console, HTTP and platform logs |
| Application Insights | `appi-moonshot-storefront` | Traces, metrics and logs from the storefront-api |
| Log search alerts | `Waiting room stalled`, `Storefront checkout failures`, `Storefront on-call drill` | `monitoring.tf`; see [alerts](../docs/service-map.md#alerts) |
| Managed identity | `id-moonshot-github-storefront` | GitHub Actions deployments for this group |

### `rg-moonshot-dataplatform`: Data Platform team

| Resource | Name | Notes |
| --- | --- | --- |
| App Service plan | `asp-moonshot-dataplatform` | West US 3, Linux P1v3, zone-redundant, two instances; production and staging share capacity |
| Deployment slot | `staging` | Same runtime identity and dependencies as production |
| Web app | `app-moonshot-dataplatform-api` | Starts the API directly; database setup is a separate manual step |
| Cosmos DB | `cosmos-moonshot-catalog` | Serverless; database `moonshot`, container `catalog`; key access disabled |
| Managed Redis | `redis-moonshot-cache` | Balanced B0, port 10000; availability snapshots and waiting-room queues; access keys disabled |
| Managed identity | `id-moonshot-dataplatform-api` | The app's identity; the only identity allowed into the Data Platform's stores, including RDS through its AWS role |
| Log Analytics | `log-moonshot-dataplatform` | App Service logs |
| Application Insights | `appi-moonshot-dataplatform` | Traces, metrics and logs from the data-platform-api |
| Log search alert | `Reservation API errors` (disabled) | `monitoring.tf`; see [alerts](../docs/service-map.md#alerts) |
| Managed identity | `id-moonshot-github-dataplatform` | GitHub Actions deployments for this group |

### `rg-moonshot-shared`: both teams

| Resource | Name | Notes |
| --- | --- | --- |
| Storage account | `stmoonshottfstate` | Terraform state, one container per root, shared keys disabled, versioned |
| Action group | `ag-moonshot-oncall` | On-call notifications for people; no alert uses it yet (the SRE Agents read alerts directly) |
| Managed identity | `id-moonshot-github-shared` | GitHub Actions deployments for this group |

## Identities and access

| Identity | Signs in from | Can do |
| --- | --- | --- |
| `id-moonshot-github-<team>` | GitHub Actions on `main` or `release` of this repository (OIDC) | Contributor on its own resource group; read and write its own state container |
| `id-moonshot-storefront-api` | `app-moonshot-storefront` | Call the data-platform-api (app role `DataPlatform.Access`) |
| `id-moonshot-dataplatform-api` | `app-moonshot-dataplatform-api` | Cosmos DB Data Contributor; Redis default access policy; assume the AWS role `moonshot-dataplatform-api` (RDS IAM sign-in) |
| Storefront SRE Agent ID (`cb77887d-da97-4726-9fcf-c4fa7aea576a`) | `moonshot-storefront-agent` | Custom settings-reader role on `app-moonshot-storefront` only |
| Data Platform SRE Agent ID (`b8f34722-c8ce-49a8-9018-67da5a70b0dc`) | `moonshot-dataplatform-agent` | Custom settings-reader role on `app-moonshot-dataplatform-api` only |
| Demo simulator's system-assigned identity (not managed here) | `app-moonshot-demo-simulator` in `rg-moonshot-demo-simulator` | Restock passes with `POST /v1/admin/restock` (app role `DataPlatform.Admin`); nothing else on the data-platform-api |
| Subscription Owner | A person, locally | Bootstrap only |

- **No keys or passwords.** Cosmos DB local auth, Redis access keys and storage shared keys
  are disabled. The API signs in to RDS with short-lived IAM tokens; the RDS administrator
  password is generated and kept by RDS in AWS Secrets Manager.
- **GitHub sign-in uses OIDC federation.** Each GitHub identity has separate
  `github-main` and `github-release` credentials. Their subjects are
  `repo:sanchitmehta@10647778/moonshot-concert@1446262360:ref:refs/heads/main`
  and `repo:sanchitmehta@10647778/moonshot-concert@1446262360:ref:refs/heads/release`.
  Other branches, forks and pull requests are rejected. Deployments run from `main`;
  `release` would need the [bootstrap update](#release-deployment-prerequisites) first.
- **API-to-API sign-in.** The Entra app *Moonshot Fest Data Platform API*
  (`api://<client ID>`) defines the `DataPlatform.Access` app role. Bootstrap grants it to
  the storefront-api's identity only; the data-platform-api rejects any other caller.
  A second role, `DataPlatform.Admin`, allows only `/v1/admin/*` (the demo restock) and is
  granted to the demo simulator's identity when `demo_simulator_principal_id` is set.
  Neither role grants the other's routes.
- **Network.** Azure endpoints are public and protected by Entra. RDS is reachable only from
  the data-platform-api's outbound addresses, requires TLS and accepts IAM sign-in.

[`environment.json`](environment.json) is written by bootstrap and committed. It holds the
tenant, subscription, workload region, resource groups and client IDs, which are not
secrets, so workflows and team roots need no repository secrets or variables.

## AWS (Data Platform)

The Data Platform team's Terraform root also manages its AWS resources
(`infra/data-platform/aws.tf`), deployed by **Deploy data platform**. GitHub Actions signs in to
AWS with OIDC as `moonshot-github-dataplatform`. The Data Platform is multi-cloud: its API, catalog
and cache run in Azure, and its core database runs in AWS (`us-east-1`).

| Resource | Name | Notes |
| --- | --- | --- |
| RDS for PostgreSQL | `rds-moonshot-core` | PostgreSQL 16, `db.t4g.micro`, single AZ; database `core`; TLS and IAM sign-in; logs to CloudWatch `/aws/rds/instance/rds-moonshot-core/postgresql` |
| Security group | `sg-moonshot-core` (group name `moonshot-core`) | PostgreSQL from the data-platform-api's outbound addresses only |
| Network | `vpc-moonshot-dataplatform`, `snet-moonshot-core-1/2` | Public subnets, no NAT gateway |
| Runtime role | `moonshot-dataplatform-api` | Trusts the API's managed identity; `rds-db:connect` as `dataplatform_api` and read of the RDS administrator secret |
| Billing function | `fn-moonshot-billing` | Lambda, Node.js 22, arm64, 256 MB, 10 s; in the VPC's subnets; logs to CloudWatch `/aws/lambda/fn-moonshot-billing` (7 days). Terraform owns its configuration; **Deploy data platform** uploads its code |
| CloudWatch alarms | `fn-moonshot-billing-errors`, `fn-moonshot-billing-throttles`, `rds-moonshot-core-cpu`, `rds-moonshot-core-free-storage` | `monitoring.tf`; no notifications; see [alerts](../docs/service-map.md#alerts) |
| Billing security group | `sg-moonshot-billing` (group name `moonshot-billing`) | PostgreSQL to `sg-moonshot-core` only; `sg-moonshot-core` admits it |
| Billing role | `moonshot-billing-fn` (bootstrap) | Lambda execution role: logs, VPC network interfaces, `rds-db:connect` as `billing_fn` only |
| Deploy role | `moonshot-github-dataplatform` | Trusts GitHub Actions OIDC for `main` and `release` |

The runtime role may also invoke `fn-moonshot-billing` (`lambda:InvokeFunction`); nothing else
can. Billing signs in to the core database as `billing_fn` and creates its `billing` schema
on its first invocation; it has no access to the API's tables, and the API none to billing's.

The API gets an Entra token for `AWS_FEDERATION_RESOURCE` with its managed identity, exchanges it
with AWS STS for the runtime role, and signs an RDS IAM token with it. Manual database setup
creates the IAM database users `dataplatform_api` and `billing_fn` with the RDS-managed
administrator secret, then applies migrations. Normal API startup does neither.

**Set up an AWS account (once).** In the AWS console for the account, open **CloudShell** in the
target region and run:

```bash
curl -fsSL https://raw.githubusercontent.com/sanchitmehta/moonshot-concert/main/infra/aws-bootstrap.yaml -o aws-bootstrap.yaml && aws cloudformation deploy --stack-name moonshot-bootstrap --template-file aws-bootstrap.yaml --capabilities CAPABILITY_NAMED_IAM --region us-east-2 && aws cloudformation describe-stacks --stack-name moonshot-bootstrap --region us-east-2 --query "Stacks[0].Outputs" --output table
```

[`aws-bootstrap.yaml`](aws-bootstrap.yaml) creates the GitHub and Entra OIDC providers, the
deploy and runtime roles, and billing's execution role. IAM stays in bootstrap: the deploy role
can pass `moonshot-billing-fn` to Lambda but cannot create roles. IAM is global, so the stack's region does not matter. Its defaults match
`environment.json`; pass `--parameter-overrides` if they differ (for example
`CreateGitHubProvider=false` when the account already trusts GitHub). `aws cloudformation deploy`
keeps the previous parameter values when a stack is updated, so always pass `AzureAudience`
(the data-platform-api managed identity's client ID) explicitly after the identity changes.

## Deploying

Each team ships its infrastructure and app together from the **Actions** tab.

| Workflow | Trigger | What it does |
| --- | --- | --- |
| **CI** | Every push to `main` | Type-checks, tests and builds both teams' code, and plans every Terraform root. Changes nothing in Azure |
| **Deploy shared** | Manual | Applies `infra/shared` |
| **Deploy data platform** | Manual | Checks the packages, applies `infra/data-platform`, uploads billing's code to `fn-moonshot-billing`, then deploys and verifies the API; database setup is manual |
| **Deploy storefront** | Manual | Builds and checks the package, applies `infra/storefront`, then deploys and verifies it |
| **Terraform** | Manual | Plans or applies a selected root; production app and plan changes require `allow_production_changes` |

The team workflows use the reusable `terraform.yml`. Both app workflows deploy only to `staging`.
They require `/version` to report the expected service and commit and `/health/ready`
to return HTTP 200 before swapping staging into production. They repeat both checks
on production after the swap. ZIP deployment waits for completion and startup before
these checks, including when a workflow deploys the same commit again.
For a new environment, run Deploy shared, provision both app roots through the
Terraform maintenance workflow described below, then run Deploy data platform,
complete the [data-platform setup](#data-platform-database-setup), then Deploy storefront.

Run manual deployments from `main`, the default in **Use workflow from**.
The deployment workflows have no branch guard, but cloud sign-in requires an
explicitly trusted branch, and bootstrap trusts `main`. Publishing source changes
does not update cloud trust.

### Runtime configuration releases

Each app root defines the desired runtime configuration in `local.app_settings`
and `local.startup_command`. Terraform applies those values to staging.
Production receives them only through the health-checked slot swap, together with
the package and language-stack configuration.

Terraform initializes production runtime values when creating an app, but ignores
subsequent changes to its app settings, startup command, and language stack.
Staging reads the desired values directly from the locals, not from production's
current configuration. This also keeps a slot rollback from being immediately
undone by the next Terraform run.

Normal deployment workflows reject any plan that creates, updates, replaces, or
deletes a production web app or App Service plan. They do not restart production
to apply settings before deploying the package. Changes to other infrastructure
still need compatibility review; staging does not isolate shared dependencies.

For intentional infrastructure changes, use **Actions > Terraform** from `main`.
Select the root, review a plan with `apply` disabled, then run with `apply` and
`allow_production_changes` enabled during a maintenance window. This permission
does not bypass runtime ownership: runtime configuration still goes through
staging and a swap. Do not enable it for an ordinary app release.

### Deployment slots and first rollout

Both plans use Linux P1v3 in West US 3, with zone redundancy enabled and two
instances each. This matches the configuration successfully provisioned in the
subscription after South Central US rejected both S1 and P1v3 upgrades. Regional
quota reporting did not match provisioning results, so reported quota alone is
not proof that another configuration will work.

The two production plans bill for four P1v3 instances in total, independently of
any test plan. Slots have no separate charge, but production and staging share
each plan's CPU and memory. Check capacity under demo load before deploying during the demo.

Run the region migration in a maintenance window. It deletes and recreates the
web apps and plans to retain their existing resource names and public URLs.
The apps are unavailable until their replacement packages are deployed. Runtime
identities, Entra audiences, data stores, and AWS resources are retained.

Use the Terraform maintenance workflow for the data-platform root, then the
storefront root, with `apply` and `allow_production_changes` enabled. The reusable
workflow first applies the API and its dependencies when its region changes.
The API's new outbound IP addresses are then known, allowing the full plan to
update the RDS ingress rules before deploying the package. This preparation
refuses any planned deletion other than the API and its App Service plan.
Then run Deploy data platform followed by Deploy storefront to publish the
packages. Do not run database setup as part of this migration.

Returning to South Central US requires another app/plan replacement, restoration
of the former B1 configuration, and an RDS ingress update. Slot rollback cannot
undo a region migration. After the new apps are deployed, subsequent package-only
releases use warmed slot swaps.
Infrastructure changes, dependency outages, incompatible database or billing
changes, and long-running connections are not protected by a slot swap. App Service
recycles the old production instances after a swap; clients must retry interrupted
long-running requests. Keep API, database, and billing changes compatible with both
the current and previous app versions.

Each slot has the same user-assigned runtime identity as its production app.
Managed identities do not swap. Both slots use the live dependencies; staging is
not an isolated test environment. The storefront's `WAITING_ROOM_WORKER_ENABLED`
setting is sticky: `true` in production and `false` in staging. Production settings
apply during swap warm-up, so the existing interval idempotency keys protect
against overlapping admission workers. `LIVE_AVAILABILITY_ENABLED` is also sticky,
so a swap preserves the operator's production choice.

App Service swap warm-up checks `/health/ready` and accepts only HTTP 200.
The data-platform API also serves the same dependency-checked response at `/`
because platform warm-up can request the root path. Both paths return HTTP 503
when a dependency fails; the root is not an unconditional success response.
An unhealthy or stale staging deployment fails without a swap. There is no direct
production deployment fallback. A failed or uncertain swap requires inspection;
the workflow never retries the swap or automatically swaps back.

Production and staging App Service console, HTTP, and platform logs go to the
team's existing Log Analytics workspace, identified by their distinct resource IDs.
When the slot deployment step fails, both workflows collect staging logs, worker
instances, and the last hour of resource-group activity in a diagnostic artifact
with one-day retention. Collection errors produce warnings without retrying the
deployment or swap. These artifacts contain application logs; restrict their
access as you would other operational logs. Inspect the swap result and current
production commit before retrying. Billing is updated before the API deployment
and is not rolled back when an API swap fails.

For rollback, first confirm the current production commit with `/version` and
inspect the swap activity log. Confirm that staging contains the previous healthy,
compatible commit and that `/health/ready` returns HTTP 200. Swap it back with:

```bash
az webapp deployment slot swap --resource-group <team-resource-group> \
  --name <app-name> --slot staging --target-slot production
```

Check production `/version` and `/health/ready` again. The previous package remains
in staging only until the next deployment overwrites it.

### Release deployment prerequisites

Deployments run from `main`, which needs nothing here. The `release` branch is no
longer used. Only if you deploy from `release` again must an authorized operator
first update both bootstrap configurations from that checkout:

1. Apply `infra/bootstrap` using the [bootstrap procedure](#bootstrap).
   This adds `github-release` to each team's deployment identity and keeps
   the existing `github-main` credential. The issuer is
   `https://token.actions.githubusercontent.com`, and the audience is
   `api://AzureADTokenExchange`.
2. Update the existing `moonshot-bootstrap` CloudFormation stack with
   `infra/aws-bootstrap.yaml`, using the stack's region. Keep its existing
   parameter values, including the current `AzureAudience`. The deploy role
   accepts both `GitHubSubject` (`main`) and `GitHubReleaseSubject` (`release`).
   The default release subject is
   `repo:sanchitmehta@10647778/moonshot-concert@1446262360:ref:refs/heads/release`.
   If the repository identity differs, set both subjects to its actual OIDC subjects.

These are administrator operations, not application deployment steps. Existing
environments continue to trust `main`; `release` authentication fails until the
bootstrap updates are applied. Do not retry application deployments as a substitute
for updating the trust configuration.

### Application packages

The storefront deployment bundles the API's application code and keeps production npm
dependencies for OpenTelemetry. App Service mounts the ZIP as a read-only package.
The commit reported by `/version` is included in that package. The Azure CLI still waits
for ZIP deployment; the workflow checks startup separately.

Both apps use package mounting with production `node_modules` already present. The
data-platform package contains no Oryx build manifest or `node_modules.tar.gz`, so startup
does not extract an Oryx dependency archive. The API starts directly with
`node --import ./src/instrumentation.ts src/server.ts`, keeping telemetry without launching
npm or running database setup. Certificate updates and authentication can still take time;
measure the next deployment's startup logs before considering a custom container image.

Changing production package-mounting settings can restart the existing app. Make
these infrastructure changes before the demo, not during a package release. Normal
package releases deploy to staging and use the slot rollback procedure above.

### Data-platform database setup

Run setup once for a new environment, and when a deployment changes migrations or approved
catalog content. Deployments and normal restarts do not run it. Setup keeps existing inventory
and upserts catalog documents; review migrations before running it against production.
For incompatible schema changes, schedule maintenance and prepare the database before
allowing the new API to serve traffic.

Run setup in the **main app container**, not the Kudu container or a GitHub runner. Only the
app has the managed identity and outbound addresses needed to reach the stores. In the
Azure portal, open `app-moonshot-dataplatform-api`, then **Development Tools > SSH > Go**.
Alternatively, open an interactive session:

```powershell
az webapp ssh --resource-group rg-moonshot-dataplatform --name app-moonshot-dataplatform-api
```

In that Linux shell, run:

```bash
cd /home/site/wwwroot
node src/seed.ts
```

Wait for `Seeded <count> offers.` and a zero exit status. Check `/health/ready` before
restoring traffic. Do not treat successful SSH connection or command submission as
successful setup.

In a new environment, an unseeded catalog prevents the API from starting. Temporarily set
the app's startup command to `sleep infinity` in App Service configuration to keep the
main container available for SSH during the startup timeout. Run setup, then restore
`node --import ./src/instrumentation.ts src/server.ts` and restart the app. This temporary
command is not the Terraform default. The initial deployment verification can fail until
setup is complete; rerun **Deploy data platform** after restoring the startup command.

Operational settings that may change without a Terraform run (for example
`LIVE_AVAILABILITY_ENABLED` during an incident) are listed in each root's
`ignore_changes`.

## Bootstrap

Bootstrap creates what GitHub Actions cannot create for itself: the resource groups,
state storage, all managed identities, the federated credentials, role assignments, the
Entra app roles and resource provider registrations. It needs a subscription Owner who can
create Entra applications. Rerun it only when those change, for example to add a team.

For the existing environment, first [import the SRE Agent settings-reader grants](#sre-agent-app-settings-access)
once before using the apply command below. For an initial bootstrap in a new environment,
omit `-var-file=sre-agents.tfvars` until its agents and web apps exist.

```powershell
az login --tenant <tenant ID>
cd infra\bootstrap
terraform init `
  -backend-config="storage_account_name=stmoonshottfstate" `
  -backend-config="container_name=tfstate-bootstrap" `
  -backend-config="key=bootstrap.tfstate" `
  -backend-config="use_azuread_auth=true"
terraform apply -var subscription_id=<subscription ID> `
  -var demo_simulator_principal_id=c823492e-ea80-4aeb-a017-3d6b1b423af1 `
  -var-file=sre-agents.tfvars
```

Commit any change to `environment.json` afterwards.

### SRE Agent app-settings access

`bootstrap/sre-agent-rbac.tf` owns the custom `SRE Agent App Service Settings Reader`
role and its app-scoped assignments. The role adds only
`Microsoft.Web/sites/config/list/action`: it can expose app-setting and connection-string
values, but cannot change them. It does not grant the separate staging-slot
`Microsoft.Web/sites/slots/config/list/action` permission.

`bootstrap/sre-agents.tfvars` references the two existing Entra Agent IDs, not their agent
users, runtime managed identities, or the App Services' managed identities. Each Agent ID
gets the role only on its own web app. The role's two resource-group assignable scopes
describe where it can be assigned; they are not resource-group-level grants. These
declarations do not create Agent IDs or change their other role assignments.

The role and both assignments already exist in the current subscription. Before the
first bootstrap plan or apply containing this configuration, initialize the existing
bootstrap backend as above and import them once from `infra/bootstrap`:

```bash
subscription_scope=/subscriptions/cb47277e-5e03-40e1-a7b1-3db3d3940eab
bootstrap_args=(
  -var subscription_id=cb47277e-5e03-40e1-a7b1-3db3d3940eab
  -var demo_simulator_principal_id=c823492e-ea80-4aeb-a017-3d6b1b423af1
  -var-file=sre-agents.tfvars
)
terraform import "${bootstrap_args[@]}" azurerm_role_definition.sre_agent_app_settings \
  "$subscription_scope/providers/Microsoft.Authorization/roleDefinitions/a232b207-4786-5e2a-becf-9f8c78999ead|$subscription_scope"
terraform import "${bootstrap_args[@]}" 'azurerm_role_assignment.sre_agent_app_settings["storefront"]' \
  "$subscription_scope/resourceGroups/rg-moonshot-storefront/providers/Microsoft.Web/sites/app-moonshot-storefront/providers/Microsoft.Authorization/roleAssignments/2023586a-91e7-5a64-ae5f-18664ec4119e"
terraform import "${bootstrap_args[@]}" 'azurerm_role_assignment.sre_agent_app_settings["dataplatform"]' \
  "$subscription_scope/resourceGroups/rg-moonshot-dataplatform/providers/Microsoft.Web/sites/app-moonshot-dataplatform-api/providers/Microsoft.Authorization/roleAssignments/a654ba1a-fe7b-5fa0-b2b5-ebbd6cd7ee26"
terraform plan "${bootstrap_args[@]}"
```

Review the plan before applying; do not recreate or duplicate the existing grants.
Keep passing `-var-file=sre-agents.tfvars` on subsequent bootstrap runs: omitting it
defaults to no agent assignments and would plan their removal.

For a new environment, omit that file on the initial bootstrap. Deploy the web apps and
provision the SRE Agent IDs first, update the principal IDs in the file, then rerun
bootstrap with it to grant access. The import commands above are only for the existing
subscription, not a new environment.

### Demo simulator

`demo_simulator_principal_id` is the object ID of the system-assigned
identity of `app-moonshot-demo-simulator` (`rg-moonshot-demo-simulator`, not managed here).
Bootstrap grants it the `DataPlatform.Admin` app role, which allows only
`POST /v1/admin/restock`; leave the variable out to grant it to nobody. Pass the same value
on every rerun, or the assignment is removed. The simulator requests a token for
`api://<data-platform client ID>/.default`; a newly granted role reaches its tokens once its
cached token expires. Then run **Deploy data platform**, so the API knows the role
(`ENTRA_ADMIN_ROLE`).

### New subscription

The state storage does not exist yet. Add a `backend_override.tf`
(ignored by git) with a local backend:

```hcl
terraform {
  backend "local" {}
}
```

Run `terraform init` and `terraform apply`, delete the override, then run the
`terraform init` above with `-migrate-state`.

## Change the AWS account

1. **Azure bootstrap.** Set `aws_account_id` (and `aws_region` if needed) in
   `infra/bootstrap/variables.tf`, rerun bootstrap (below), and commit `environment.json`.
2. **New AWS account.** Run the CloudShell command from [AWS](#aws-data-platform) in that account
   and region. If the region changed, replace `us-east-2` in the command.
3. **Old account.** Remove the Data Platform's resources from `aws.tf` and run **Deploy data
   platform** before switching, so Terraform state no longer references the old account.
4. **Deploy data platform** in GitHub Actions to create the AWS resources in the new account.
5. **Verify:** `https://app-moonshot-dataplatform-api.azurewebsites.net/health/ready` reports
   ready, then book a pass on the website.

## Change the Azure subscription

1. Sign in: `az login --tenant <tenant>`.
2. Set `subscription_id` (command line), `location`, `workload_location` and
   `state_storage_account_name` (globally unique) for the new subscription; check App Service
   quota for the workload region (see [Troubleshooting](#troubleshooting)).
3. Run bootstrap for a [new subscription](#bootstrap) (local state first, then migrate) and commit
   `environment.json`.
4. If the tenant changed, redeploy the AWS template so it trusts the new tenant and managed
   identity: pass `AzureIssuerHostPath`, `AzureAudience`, `AzureOriginalAudience` and `AzureRuntimePrincipalId` from
   `environment.json` as `--parameter-overrides`.
5. Run **Deploy shared**, **Deploy data platform**, then **Deploy storefront**.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `AADSTS700213: No matching federated identity record` | The OIDC subject changed (GitHub uses owner and repository IDs) | Update `github_repository` in `bootstrap/variables.tf` and rerun bootstrap |
| `Operation cannot be completed without additional quota` on an App Service plan | No App Service quota for that tier and region | Check with `az quota list --scope /subscriptions/<id>/providers/Microsoft.Web/locations/<region>`; change `workload_location` or request quota |
| `SkuNotAvailable` creating PostgreSQL | No capacity for the SKU in that region for this subscription | Use another region or SKU |
| Team plan fails with `Unsupported attribute` | A root read outputs that do not exist yet | Apply roots in order: shared, data platform, storefront |
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` in GitHub Actions | The AWS account has not run `aws-bootstrap.yaml`, or the GitHub subject changed | Run the CloudShell command; check `GitHubSubject` |