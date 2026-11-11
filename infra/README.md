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
│   app-moonshot-storefront  (App Service, asp-moonshot-storefront P1v3)│
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
│   app-moonshot-dataplatform-api (App Service, asp-…-dataplatform P1v3)│
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

 Workloads: South Central US · RGs, identities, state: East US 2
 No keys or passwords anywhere: every hop uses Entra or AWS IAM tokens.
```

Workloads run in **South Central US**: this subscription has no App Service quota in
East US 2. Resource groups, identities and state stay in **East US 2**; a resource
group's region only records where its metadata lives.

## Resource groups

Each resource group is a team boundary. Monitoring is per team, so each team
reads its own telemetry.

### `rg-moonshot-storefront`: Storefront team

| Resource | Name | Notes |
| --- | --- | --- |
| App Service plan | `asp-moonshot-storefront` | Linux, P1v3 |
| Web app | `app-moonshot-storefront` | Website and storefront-api on one origin, Node 24, health check `/health/ready` |
| Managed identity | `id-moonshot-storefront-api` | The app's identity; holds the `DataPlatform.Access` app role |
| Log Analytics | `log-moonshot-storefront` | App Service console, HTTP and platform logs |
| Application Insights | `appi-moonshot-storefront` | Traces, metrics and logs from the storefront-api |
| Managed identity | `id-moonshot-github-storefront` | GitHub Actions deployments for this group |

### `rg-moonshot-dataplatform`: Data Platform team

| Resource | Name | Notes |
| --- | --- | --- |
| App Service plan | `asp-moonshot-dataplatform` | Linux, P1v3 |
| Web app | `app-moonshot-dataplatform-api` | Starts the API directly; database setup is a separate manual step |
| Cosmos DB | `cosmos-moonshot-catalog` | Serverless; database `moonshot`, container `catalog`; key access disabled |
| Managed Redis | `redis-moonshot-cache` | Balanced B0, port 10000; availability snapshots and waiting-room queues; access keys disabled |
| Managed identity | `id-moonshot-dataplatform-api` | The app's identity; the only identity allowed into the Data Platform's stores, including RDS through its AWS role |
| Log Analytics | `log-moonshot-dataplatform` | App Service logs |
| Application Insights | `appi-moonshot-dataplatform` | Traces, metrics and logs from the data-platform-api |
| Managed identity | `id-moonshot-github-dataplatform` | GitHub Actions deployments for this group |

### `rg-moonshot-shared`: both teams

| Resource | Name | Notes |
| --- | --- | --- |
| Storage account | `stmoonshottfstate` | Terraform state, one container per root, shared keys disabled, versioned |
| Action group | `ag-moonshot-oncall` | On-call notifications; receivers added with alerting |
| Managed identity | `id-moonshot-github-shared` | GitHub Actions deployments for this group |

## Identities and access

| Identity | Signs in from | Can do |
| --- | --- | --- |
| `id-moonshot-github-<team>` | GitHub Actions on `main` or `release` of this repository (OIDC) | Contributor on its own resource group; read and write its own state container |
| `id-moonshot-storefront-api` | `app-moonshot-storefront` | Call the data-platform-api (app role `DataPlatform.Access`) |
| `id-moonshot-dataplatform-api` | `app-moonshot-dataplatform-api` | Cosmos DB Data Contributor; Redis default access policy; assume the AWS role `moonshot-dataplatform-api` (RDS IAM sign-in) |
| Subscription Owner | A person, locally | Bootstrap only |

- **No keys or passwords.** Cosmos DB local auth, Redis access keys and storage shared keys
  are disabled. The API signs in to RDS with short-lived IAM tokens; the RDS administrator
  password is generated and kept by RDS in AWS Secrets Manager.
- **GitHub sign-in uses OIDC federation.** Each GitHub identity has separate
  `github-main` and `github-release` credentials. Their subjects are
  `repo:sanchitmehta@10647778/moonshot-concert@1446262360:ref:refs/heads/main`
  and `repo:sanchitmehta@10647778/moonshot-concert@1446262360:ref:refs/heads/release`.
  Other branches, forks and pull requests are rejected. Existing environments
  need the [bootstrap update](#release-deployment-prerequisites) before using `release`.
- **API-to-API sign-in.** The Entra app *Moonshot Fest Data Platform API*
  (`api://<client ID>`) defines the `DataPlatform.Access` app role. Bootstrap grants it to
  the storefront-api's identity only; the data-platform-api rejects any other caller.
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
curl -fsSL https://raw.githubusercontent.com/sanchitmehta/moonshot-concert/release/infra/aws-bootstrap.yaml -o aws-bootstrap.yaml && aws cloudformation deploy --stack-name moonshot-bootstrap --template-file aws-bootstrap.yaml --capabilities CAPABILITY_NAMED_IAM --region us-east-2 && aws cloudformation describe-stacks --stack-name moonshot-bootstrap --region us-east-2 --query "Stacks[0].Outputs" --output table
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
| **CI** | Every push to `main` or `release` | Type-checks, tests and builds both teams' code, and plans every Terraform root. Changes nothing in Azure |
| **Deploy shared** | Manual | Applies `infra/shared` |
| **Deploy data platform** | Manual | Checks the packages, applies `infra/data-platform`, uploads billing's code to `fn-moonshot-billing`, then deploys and verifies the API; database setup is manual |
| **Deploy storefront** | Manual | Builds and checks the package, applies `infra/storefront`, then deploys and verifies it |

All four use the reusable `terraform.yml`. A deployment is verified when the app's
`/version` reports the deployed commit. The data-platform deployment also checks
`/health/ready`. For a new environment, run Deploy shared, then Deploy data platform,
complete the [data-platform setup](#data-platform-database-setup), then Deploy storefront.

Select `release` in **Use workflow from** when starting a manual deployment.
The deployment workflows have no branch guard, but cloud sign-in requires an
explicitly trusted branch. Publishing source changes does not update cloud trust.

### Release deployment prerequisites

Before deploying from `release`, an authorized operator must update both bootstrap
configurations from the `release` checkout:

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

The first deployment that enables package mounting restarts the existing app before the
new ZIP is uploaded. The ZIP is built and checked first, but the restart can interrupt
service. To roll back, restore the previous storefront app settings and redeploy the
previous package. The same interruption and rollback procedure apply to the data-platform
app when package mounting is first enabled.

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
Entra app role and resource provider registrations. It needs a subscription Owner who can
create Entra applications. Rerun it only when those change, for example to add a team.

```powershell
az login --tenant <tenant ID>
cd infra\bootstrap
terraform init `
  -backend-config="storage_account_name=stmoonshottfstate" `
  -backend-config="container_name=tfstate-bootstrap" `
  -backend-config="key=bootstrap.tfstate" `
  -backend-config="use_azuread_auth=true"
terraform apply -var subscription_id=<subscription ID>
```

Commit any change to `environment.json` afterwards.

**New subscription.** The state storage does not exist yet. Add a `backend_override.tf`
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
