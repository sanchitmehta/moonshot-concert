# Moonshot Fest infrastructure

Terraform for the Azure environment. Each resource group is a team boundary, and each
team's Terraform root deploys only into its own group.

| Root | Resource group | Contents | Applied by |
| --- | --- | --- | --- |
| `bootstrap` | all | Resource groups, Terraform state storage, GitHub Actions identities, service managed identities, the data-platform-api Entra app and its app role | A subscription Owner, locally, rarely |
| `shared` | `rg-moonshot-shared` | Log Analytics `log-moonshot`, Application Insights `appi-moonshot` | GitHub Actions |
| `data-platform` | `rg-moonshot-dataplatform` | `app-moonshot-dataplatform-api`, Cosmos DB `cosmos-moonshot-catalog`, PostgreSQL `psql-moonshot-inventory`, Managed Redis `redis-moonshot-cache` | GitHub Actions |
| `storefront` | `rg-moonshot-storefront` | `app-moonshot-storefront` (website and storefront-api) | GitHub Actions |

Bootstrap writes [`environment.json`](environment.json): tenant, subscription, workload
region, resource groups and client IDs. Resource groups and identities are in East US 2;
workloads run in South Central US because this subscription has no App Service quota in
East US 2. It holds no secrets, so the workflows and team roots read it
instead of needing repository secrets or variables.

## Security model

- No keys or passwords. Cosmos DB local auth, Redis access keys, PostgreSQL password
  auth and storage shared keys are disabled. Services sign in with their user-assigned
  managed identities; GitHub Actions signs in with OIDC federated credentials trusted
  only for `main`.
- Each GitHub identity is Contributor on its own resource group, owns only its own
  state container, and can read the shared state for monitoring outputs.
- The data-platform-api requires a Microsoft Entra token for
  `api://<data-platform-api client ID>` with the `DataPlatform.Access` app role.
  Bootstrap grants that role to the storefront-api's identity only.
- Endpoints are public; PostgreSQL allows Azure services only.

## Run it

Each team ships its own infrastructure and app together, from the Actions tab:

| Workflow | Trigger | Does |
| --- | --- | --- |
| **CI** | Every push to `main` | Type-checks, tests and builds both teams' code, and plans every Terraform root. Changes nothing in Azure |
| **Deploy shared** | Manual | Applies `shared` |
| **Deploy data platform** | Manual | Applies `data-platform`, then tests, deploys and verifies the data-platform-api |
| **Deploy storefront** | Manual | Applies `storefront`, then builds, deploys and verifies the website and storefront-api |

All of them reuse `terraform.yml`. For a new environment run them in the order shared,
data platform, storefront. A deployment is verified when `/version` reports its commit.
The data-platform-api applies migrations and catalog content on every start.

## Bootstrap (subscription Owner only)

Rerun after changing `bootstrap` (for example to add a team):

```powershell
az login --tenant <tenant>
cd infra\bootstrap
terraform init -backend-config="storage_account_name=stmoonshottfstate" -backend-config="container_name=tfstate-bootstrap" -backend-config="key=bootstrap.tfstate" -backend-config="use_azuread_auth=true"
terraform apply -var subscription_id=<subscription>
```

Then commit any change to `environment.json`.

For a brand-new subscription the state storage does not exist yet. Create
`backend_override.tf` containing `terraform { backend "local" {} }` (on separate lines),
run `terraform init` and `terraform apply`, delete the override, then run the
`terraform init` above with `-migrate-state`.
