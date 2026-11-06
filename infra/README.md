# Moonshot Fest infrastructure

Everything in Azure is defined here in Terraform and deployed by GitHub Actions. Each team
owns one resource group and one Terraform root, and can change nothing outside it.

[Topology](#topology) |
[Resource groups](#resource-groups) |
[Identities and access](#identities-and-access) |
[Deploying](#deploying) |
[Bootstrap](#bootstrap) |
[Troubleshooting](#troubleshooting)

## Topology

```text
                         Festival attendee (browser)
                                    │ HTTPS
                                    ▼
┌─ rg-moonshot-storefront ─────────────── Storefront team ──────────────┐
│                                                                       │
│   app-moonshot-storefront  (App Service, asp-moonshot-storefront B1)  │
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
│   app-moonshot-dataplatform-api  (App Service, asp-…-dataplatform B1) │
│        signs in as id-moonshot-dataplatform-api                       │
│        │                  │                     │                     │
│        │ Entra token      │ Entra token         │ Entra token         │
│        ▼                  ▼                     ▼                     │
│   cosmos-moonshot-   psql-moonshot-        redis-moonshot-cache       │
│   catalog            inventory             (availability snapshots)   │
│   (festival, passes) (prices, stock,                                  │
│                       reservations)                                   │
│                                                                       │
│   log-moonshot-dataplatform ◄── appi-moonshot-dataplatform            │
│   id-moonshot-github-dataplatform  (GitHub deploys this RG only)      │
└───────────────────────────────────────────────────────────────────────┘

┌─ rg-moonshot-shared ────────────────── both teams ────────────────────┐
│   stmoonshottfstate      Terraform state (one container per root)     │
│   ag-moonshot-oncall     on-call action group                         │
│   id-moonshot-github-shared                                           │
│   (later) SRE Agents                                                  │
└───────────────────────────────────────────────────────────────────────┘

 GitHub Actions (OIDC, no secrets)          Owner, locally (rarely)
 ├─ CI: tests + Terraform plans on push     └─ bootstrap: RGs, identities,
 ├─ Deploy shared                              state storage, Entra app role
 ├─ Deploy data platform (infra + api)
 └─ Deploy storefront (infra + web/api)

 Workloads: South Central US · RGs, identities, state: East US 2
 No keys or passwords anywhere: every hop uses Microsoft Entra.
```

Workloads run in **South Central US**: this subscription has no App Service quota in
East US 2. Resource groups, identities and state stay in **East US 2**; a resource
group's region only records where its metadata lives.

## Resource groups

Each resource group is a team boundary. Monitoring is per team, so each team and,
later, its SRE Agent reads only its own telemetry.

### `rg-moonshot-storefront`: Storefront team

| Resource | Name | Notes |
| --- | --- | --- |
| App Service plan | `asp-moonshot-storefront` | Linux, B1 |
| Web app | `app-moonshot-storefront` | Website and storefront-api on one origin, Node 24, health check `/health/ready` |
| Managed identity | `id-moonshot-storefront-api` | The app's identity; holds the `DataPlatform.Access` app role |
| Log Analytics | `log-moonshot-storefront` | App Service console, HTTP and platform logs |
| Application Insights | `appi-moonshot-storefront` | Traces, metrics and logs from the storefront-api |
| Managed identity | `id-moonshot-github-storefront` | GitHub Actions deployments for this group |

### `rg-moonshot-dataplatform`: Data Platform team

| Resource | Name | Notes |
| --- | --- | --- |
| App Service plan | `asp-moonshot-dataplatform` | Linux, B1 |
| Web app | `app-moonshot-dataplatform-api` | Applies migrations and catalog content on every start |
| Cosmos DB | `cosmos-moonshot-catalog` | Serverless; database `moonshot`, container `catalog`; key access disabled |
| PostgreSQL flexible server | `psql-moonshot-inventory` | PostgreSQL 16, Burstable B1ms; database `inventory`; Entra sign-in only |
| Managed Redis | `redis-moonshot-cache` | Balanced B0, non-clustered endpoint on port 10000; access keys disabled |
| Managed identity | `id-moonshot-dataplatform-api` | The app's identity; the only identity allowed into the three stores |
| Log Analytics | `log-moonshot-dataplatform` | App Service and PostgreSQL logs |
| Application Insights | `appi-moonshot-dataplatform` | Traces, metrics and logs from the data-platform-api |
| Managed identity | `id-moonshot-github-dataplatform` | GitHub Actions deployments for this group |

### `rg-moonshot-shared`: both teams

| Resource | Name | Notes |
| --- | --- | --- |
| Storage account | `stmoonshottfstate` | Terraform state, one container per root, shared keys disabled, versioned |
| Action group | `ag-moonshot-oncall` | On-call notifications; receivers added with alerting |
| Managed identity | `id-moonshot-github-shared` | GitHub Actions deployments for this group |

Later: the SRE Agents.

## Identities and access

| Identity | Signs in from | Can do |
| --- | --- | --- |
| `id-moonshot-github-<team>` | GitHub Actions on `main` of this repository (OIDC) | Contributor on its own resource group; read and write its own state container |
| `id-moonshot-storefront-api` | `app-moonshot-storefront` | Call the data-platform-api (app role `DataPlatform.Access`) |
| `id-moonshot-dataplatform-api` | `app-moonshot-dataplatform-api` | Cosmos DB Data Contributor; PostgreSQL Entra administrator; Redis default access policy |
| Subscription Owner | A person, locally | Bootstrap only |

- **No keys or passwords.** Cosmos DB local auth, Redis access keys, PostgreSQL password
  auth and storage shared keys are disabled.
- **GitHub sign-in uses OIDC federation.** Each GitHub identity trusts tokens whose
  subject is `repo:sanchitmehta@10647778/moonshot-concert@1446262360:ref:refs/heads/main`.
  Other branches, forks and pull requests are rejected.
- **API-to-API sign-in.** The Entra app *Moonshot Fest Data Platform API*
  (`api://<client ID>`) defines the `DataPlatform.Access` app role. Bootstrap grants it to
  the storefront-api's identity only; the data-platform-api rejects any other caller.
- **Network.** Endpoints are public and protected by Entra; PostgreSQL accepts Azure
  services only.

[`environment.json`](environment.json) is written by bootstrap and committed. It holds the
tenant, subscription, workload region, resource groups and client IDs, which are not
secrets, so workflows and team roots need no repository secrets or variables.

## Deploying

Each team ships its infrastructure and app together from the **Actions** tab.

| Workflow | Trigger | What it does |
| --- | --- | --- |
| **CI** | Every push to `main` | Type-checks, tests and builds both teams' code, and plans every Terraform root. Changes nothing in Azure |
| **Deploy shared** | Manual | Applies `infra/shared` |
| **Deploy data platform** | Manual | Applies `infra/data-platform`, then tests, deploys and verifies the data-platform-api |
| **Deploy storefront** | Manual | Applies `infra/storefront`, then builds, deploys and verifies the website and storefront-api |

All four use the reusable `terraform.yml`. A deployment is verified when the app's
`/version` reports the deployed commit. For a new environment, run Deploy shared, then
Deploy data platform, then Deploy storefront.

Operational settings that may change without a Terraform run (for example
`LIVE_AVAILABILITY_ENABLED` during an incident) are listed in each root's
`ignore_changes`.

## Bootstrap

Bootstrap creates what GitHub Actions cannot create for itself: the resource groups,
state storage, all managed identities, the federated credentials, role assignments, the
Entra app role and resource provider registrations. It needs a subscription Owner who can
create Entra applications. Rerun it only when those change, for example to add a team.

```powershell
az login --tenant sreagenttest2.onmicrosoft.com
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

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `AADSTS700213: No matching federated identity record` | The OIDC subject changed (GitHub uses owner and repository IDs) | Update `github_repository` in `bootstrap/variables.tf` and rerun bootstrap |
| `Operation cannot be completed without additional quota` on an App Service plan | No App Service quota for that tier and region | Check with `az quota list --scope /subscriptions/<id>/providers/Microsoft.Web/locations/<region>`; change `workload_location` or request quota |
| `SkuNotAvailable` creating PostgreSQL | No capacity for the SKU in that region for this subscription | Use another region or SKU |
| Team plan fails with `Unsupported attribute` | A root read outputs that do not exist yet | Apply roots in order: shared, data platform, storefront |
