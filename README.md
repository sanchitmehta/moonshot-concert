# moonshot-fest

A fictional three-day music festival on the Moon, built as a standalone
ticket-booking application and an Azure SRE Agent demo.

The product is named **moonshot-fest**; the shared repository is
`sanchitmehta/moonshot-concert`. Application, data platform, and demo operations
live in separate folders, with independently deployable frontend and APIs.

[Product](#customer-experience) |
[Screenshots](#screenshots) |
[Code layout](#repository-structure) |
[Local development](#local-development) |
[Cloud architecture](#cloud-architecture) |
[Incident demo](#planned-incident) |
[Delivery plan](#delivery-plan) |
[Open decisions](#open-design-decisions)

## Current status

| Area | Status |
| --- | --- |
| Product requirements | Agreed; remaining questions listed under [open decisions](#open-design-decisions) |
| Local application | Working end to end: website, storefront-api and data-platform-api with PostgreSQL, Redis and the Cosmos DB emulator, started by Aspire |
| Cloud environment | Terraform in [`infra\`](infra/README.md), deployed by GitHub Actions to Azure; see [cloud architecture](#cloud-architecture) |
| Incident demo | Planned; no defective release or agent integration yet |

The local product is verified in a browser on desktop and mobile: browse, reserve,
reopen the private confirmation, and keep reservations across restarts. The
incident pieces below are still plans.

## Screenshots

The festival landing page and the booking site are one page: hero, lineup, limited
drops, and every pass grouped by day.

![Moonshot Fest home page with the Earthrise hero](docs/screenshots/desktop-home.png)

| Lineup | Limited drops with live counts |
| --- | --- |
| ![Lineup by day](docs/screenshots/desktop-lineup.png) | ![Limited drops](docs/screenshots/desktop-drops.png) |
| **Passes grouped by day** | **Reserve** |
| ![Passes with day and type filters](docs/screenshots/desktop-passes.png) | ![Reserve form](docs/screenshots/desktop-reserve.png) |
| **Private confirmation** | |
| ![Confirmation pass](docs/screenshots/desktop-confirmation.png) | |

On a phone:

<p>
  <img src="docs/screenshots/mobile-home.png" alt="Mobile home" width="250" />
  <img src="docs/screenshots/mobile-passes.png" alt="Mobile passes" width="250" />
  <img src="docs/screenshots/mobile-reserve.png" alt="Mobile reserve" width="250" />
</p>

To refresh these images, run the stack, then in `storefront\web` set `SITE_URL` to the
website URL and run `npm run screenshots`. It uses the installed Microsoft Edge.

## Customer experience

| Screen | Planned features |
| --- | --- |
| Festival home | Festival dates, location, lineup, and countdown |
| Explore packages | Day, access-tier, and shuttle filters; prices and package inclusions |
| Reserve | Enter the lead name, choose one pass offer and a guest quantity, review the total, and confirm a simulated reservation |
| Confirmation | View the lead name and reserved pass details, save a private confirmation link, and print the pass on one page |

```text
Discover the festival -> Compare packages -> Reserve as a guest -> Save confirmation
```

### Agreed V1 scope

- One three-day festival, not a multi-festival marketplace.
- Twelve standard offers: three days, General Admission or VIP, with or without
  an included shuttle.
- Two exclusive-drop packages, each with its own inventory and sale window.
- Three standalone shuttle-only offers, one per day, with no festival admission
  included. The initial catalog therefore contains 17 offers in total.
- Independently preallocated stock per offer, including shuttle bundles.
- Guest booking, with one package per reservation and no shopping cart.
- One lead name covers the reservation; individual guest names and email
  addresses are not required.
- Every offer permits 1-6 passes per reservation, including exclusive drops.
- Protected, read-only confirmation access. A booking reference alone must not
  grant access.
- Dark, festival-first lunar styling.

No payments, customer accounts, three-day passes, cancellations, or booking
changes are included in V1. Reservations are simulated; no real tickets or
travel are sold.

Shuttle is fictional return transport between a lunar arrival hub and the
festival venue, not Earth-to-Moon travel. Customers can buy it with admission or
in a separate shuttle-only reservation. There are no routes, schedules, or seat
selection in V1. Allocate shuttle capacity between bundles and standalone offers
upfront so the same capacity is not sold twice.

### Product vocabulary

| Term | Meaning |
| --- | --- |
| Festival | Dates, venue, the three festival days and the lineup |
| Offer | Anything a guest can buy, shown on the website as a pass: price, sale window, stock and what it includes |
| Limited drop | An exclusive offer with its own small allocation, identified by `saleType = LIMITED_DROP` |
| Reservation | One lead name, one offer and 1-6 passes at the validated price |
| Availability | Remaining stock, sale status, and whether the count is a `SNAPSHOT` or `LIVE` read |

`limitedAvailability` is a merchandising flag that shows the "limited availability"
badge. Standard offers can have it too: it is true for every offer except the three
General Admission ticket-only offers. It does not make an offer a limited drop.

The full contract is in [`data-platform/api/openapi.yaml`](data-platform/api/openapi.yaml);
services, settings and telemetry are in [`docs/service-map.md`](docs/service-map.md).

The UI should distinguish upcoming sales, open sales, sold-out offers, and
closed sales. Snapshot availability must not be presented as a live count.
Unavailable services or rejected reservations should produce an explicit message,
not a false confirmation.

If a live refresh fails, the UI may retain the last available snapshot only with
its observation time, a snapshot label, and a visible refresh warning. If no
snapshot is available, show availability temporarily unavailable rather than a
fabricated zero or sold-out state. The live-read failure must remain observable;
reservation submission still validates authoritative inventory and price.

## Repository structure

```text
moonshot-concert\
  storefront\
    web\                React + TypeScript website (Storefront team)
    api\                Node.js + TypeScript storefront API (Storefront team)
  data-platform\
    api\                Node.js + TypeScript data-platform API: catalog, inventory,
                        availability; owns all storage (Data Platform team)
    insights\           Kusto analytics (later phase)
  apphost\              Aspire AppHost for local development only
  infra\                Terraform: bootstrap, shared, storefront and data-platform roots
  .github\workflows\    Infrastructure plan/apply and per-team deployments
  docs\                 Service map and operational documentation
```

The application does not depend on Aspire. Each service reads standard
environment variables and runs on its own; the AppHost only starts containers and
supplies those variables locally.

These are responsibility boundaries. Keep each API independently runnable and
deployable. Folder separation does not enforce separate repository-read
permissions for agents.

Use this root README as the shared overview. Add folder-level documentation when
there are actual setup commands or implementation details to explain; do not
duplicate the product requirements in each folder.

The traffic generator from PR #1 will move into `traffic-generator\` in
coordination with its author. Demo-only operations live in a separate repository.

## Team ownership

| Storefront team | Data Platform team | Shared |
| --- | --- | --- |
| Website and storefront-api | data-platform-api and its OpenAPI contract | Terraform state and bootstrap identities |
| Customer workflows and offer selection | All persistence and caching logic | On-call action group; later the SRE Agents |
| Selection of offers needing live availability | Snapshot and live-availability reads | Demo traffic and scenarios (separate repository) |
| `infra\storefront`, `rg-moonshot-storefront`, its telemetry | `infra\data-platform`, `rg-moonshot-dataplatform`, its telemetry | `infra\shared`, `rg-moonshot-shared` |

**Only the data-platform-api accesses storage.** The storefront-api never connects directly
to Redis, Cosmos DB, or PostgreSQL and receives no database credentials.
It consumes a pinned version of the data-platform-api contract rather than copying
internal database models.

## Local development

```text
Browser -> storefront-web (Vite) -> storefront-api -> data-platform-api -> PostgreSQL, Redis, Cosmos DB emulator
```

### Prerequisites

- Node.js 24 or later (the APIs run TypeScript directly with Node's type stripping)
- Docker Desktop, running
- [Aspire CLI](https://aspire.dev) 13.5 or later

### Run everything

```powershell
cd storefront\web;      npm install; cd ..\..
cd storefront\api;      npm install; cd ..\..
cd data-platform\api;   npm install; cd ..\..
cd apphost;             npm install; aspire run
```

Aspire starts PostgreSQL (with a data volume), Redis and the Cosmos DB emulator in
containers, seeds the festival, then starts both APIs and the website once their
dependencies are healthy. Open the `storefront-web` URL from the Aspire dashboard.
The dashboard also shows logs, traces and metrics from both APIs.

Reservations persist across restarts in the PostgreSQL volume. Seeding is
idempotent: existing stock and reservations are kept. The first limited drop is on
sale from the first seed; the second opens 24 hours later.

If your network blocks nuget.org, add an untracked `apphost\nuget.config` that points
at your package feed before running `aspire add` or `aspire run`.

### Without Aspire

The application does not depend on Aspire. Each service runs with `npm start` and
the environment variables listed in the [service map](docs/service-map.md), for
example `DATABASE_URL`, `REDIS_URL` and `COSMOS_CONNECTION_STRING` for the
data-platform-api, and `DATA_PLATFORM_API_URL` for the storefront-api. Run
`npm run seed` in `data-platform\api` once against a new database.

### Checks

| Folder | Command | Covers |
| --- | --- | --- |
| `data-platform\api` | `npm run check`, `npm test` | Types; reservation rules against PostgreSQL (set `TEST_DATABASE_URL`), including concurrent bookings that must not oversell |
| `storefront\api` | `npm run check`, `npm test` | Types; which passes get live availability and how a failed live refresh degrades |
| `storefront\web` | `npm run build` | Types and production build |

### Rules the implementation keeps

- Only the data-platform-api touches storage. The storefront-api uses its
  OpenAPI contract and holds no database credentials.
- Reservations check sale window, price, quantity and stock, then save the
  reservation, in one PostgreSQL transaction. Remaining stock is calculated from
  the reservations table.
- Reservation requests carry an `Idempotency-Key`. Retrying returns the original
  reservation; the website keeps the key until it gets an answer.
- The private confirmation link carries an access key in the URL fragment. Only
  its hash is stored; the confirmation code alone opens nothing.
- Local development runs without service-to-service authentication
  (`AUTH_MODE=none`), which the data-platform-api only accepts on a loopback
  address. In Azure (`AUTH_MODE=entra`) it requires a Microsoft Entra token with
  the `DataPlatform.Access` app role, held only by the storefront-api's identity.
- In Azure no service uses keys or passwords: Cosmos DB, PostgreSQL and Redis
  accept only the data-platform-api's managed identity.

## Cloud architecture

Everything in Azure is Terraform in [`infra\`](infra/README.md), deployed by GitHub Actions.
Each team owns one resource group, its own monitoring and its own deployment identity, and
can change nothing outside its group. No service uses keys or passwords: every hop signs
in with Microsoft Entra.

```mermaid
flowchart TB
    Guest["Festival attendee"] -->|HTTPS| Storefront
    subgraph SF["rg-moonshot-storefront: Storefront team"]
        Storefront["app-moonshot-storefront<br/>website + storefront-api"]
        SFMon["appi / log-moonshot-storefront"]
    end
    subgraph DP["rg-moonshot-dataplatform: Data Platform team"]
        DataApi["app-moonshot-dataplatform-api"]
        Cosmos["cosmos-moonshot-catalog<br/>festival and passes"]
        Postgres["psql-moonshot-inventory<br/>prices, stock, reservations"]
        Redis["redis-moonshot-cache<br/>availability snapshots"]
        DPMon["appi / log-moonshot-dataplatform"]
    end
    subgraph SH["rg-moonshot-shared: both teams"]
        State["stmoonshottfstate<br/>Terraform state"]
        OnCall["ag-moonshot-oncall"]
    end
    Storefront -->|"Entra token, role DataPlatform.Access"| DataApi
    DataApi -->|Entra| Cosmos
    DataApi -->|Entra| Postgres
    DataApi -->|Entra| Redis
    Storefront -.-> SFMon
    DataApi -.-> DPMon
```

| Area | Azure resource | Resource group |
| --- | --- | --- |
| Website and storefront-api | App Service `app-moonshot-storefront` (one origin) | `rg-moonshot-storefront` |
| data-platform-api | App Service `app-moonshot-dataplatform-api` | `rg-moonshot-dataplatform` |
| Festival and pass catalog | Cosmos DB `cosmos-moonshot-catalog` (serverless) | `rg-moonshot-dataplatform` |
| Prices, inventory and reservations | PostgreSQL flexible server `psql-moonshot-inventory` | `rg-moonshot-dataplatform` |
| Availability cache | Managed Redis `redis-moonshot-cache` | `rg-moonshot-dataplatform` |
| Storefront telemetry | `log-moonshot-storefront`, `appi-moonshot-storefront` | `rg-moonshot-storefront` |
| Data Platform telemetry | `log-moonshot-dataplatform`, `appi-moonshot-dataplatform` | `rg-moonshot-dataplatform` |
| On-call notifications | Action group `ag-moonshot-oncall` | `rg-moonshot-shared` |
| Terraform state | Storage `stmoonshottfstate`, one container per root | `rg-moonshot-shared` |
| API-to-API sign-in | Entra app role `DataPlatform.Access`, granted only to the storefront-api's identity | Tenant |

Workloads run in South Central US, the closest region with App Service quota in this
subscription; resource groups, identities and state are in East US 2. PostgreSQL runs on
Azure first; an AWS RDS root can replace it later without changing the storefront.

### Deploying

| Workflow | Trigger | What it does |
| --- | --- | --- |
| **CI** | Every push to `main` | Tests and builds both teams' code, plans every Terraform root |
| **Deploy shared** | Manual | Applies the shared root |
| **Deploy data platform** | Manual | Applies the Data Platform root, then deploys and verifies the data-platform-api |
| **Deploy storefront** | Manual | Applies the Storefront root, then deploys and verifies the website and storefront-api |

GitHub Actions signs in with OIDC (no secrets) as each team's own identity. See
[infra/README.md](infra/README.md) for the full topology, identities and runbooks.

## Planned incident

### Primary scenario: wrong availability selection

An application release introduces live availability for exclusive drops.
During offer selection, it mistakenly uses `limitedAvailability` instead of
`saleType === "LIMITED_DROP"`.

Ordinary tickets also have finite inventory. When the live-count feature
activates during a sale, the wrong filter selects ordinary offers as well.
The storefront-api requests too many live checks from the data-platform-api, bypassing its
snapshot cache for those reads and increasing inventory-database load.

Redis and the data-platform-api need not be faulty. The incident is an application-side
request-amplification regression. Database pressure and customer latency must be
demonstrated with real telemetry, not assumed or fabricated. Cosmos load may
remain stable while PostgreSQL reads increase.

### Immediate mitigation and permanent fix

The original team plan uses an operator-approved App Service setting change to
force snapshot browsing as the primary immediate mitigation. A code-fix PR
corrects offer selection for longer-term remediation. These are complementary
actions, not a choice between operational recovery and fixing the defect.

Snapshot responses must be labeled honestly, and reservations must still validate
authoritative inventory and price. The setting affects browsing, not reservation
correctness.

A storefront-api slot rollback was also discussed as an alternative recovery
option. It does not replace the original setting-change plan. Exact setting
semantics, approval scope, and any fallback rollback procedure remain
[open decisions](#open-design-decisions). None is implemented yet.

### Alternative scenario: injected Redis fault

The original proposal also retains an injected Redis fault as an alternative
incident. Keep this as a separate, controlled scenario rather than conflating it
with the application regression, where Redis remains healthy.

The specific fault, expected telemetry, and safe recovery procedure still need
to be defined. Forcing snapshot mode is not automatically a remedy for a Redis
outage; the primary scenario's mitigation must not be assumed to fix this one.

### Presentation flow

The incident can start before the presentation. Creating the Live Report is the
planned live action. The walkthrough should retain the investigation evidence,
agent handoff, proposed operational change, operator approval in native Teams,
and recovery monitoring.

### End-to-end demo workflow

This complements the product architecture above. It shows the planned traffic,
telemetry, investigation, approval, remediation, and reporting flow, not
implemented integrations.

```mermaid
flowchart TB
    Traffic["Traffic generator: simulated users"]

    subgraph App["Storefront team"]
        Frontend["Web frontend"]
        Booking["storefront-api: selects snapshot or live checks"]
        Frontend --> Booking
    end

    subgraph Data["Data platform team"]
        API["data-platform-api: all storage access"]
        Cache["Redis: cached snapshots"]
        Catalog["Azure Cosmos DB: catalog"]
        Inventory["AWS PostgreSQL: inventory and reservations"]
        API -->|"Snapshot cache"| Cache
        API --> Catalog
        API -->|"Live reads and reservation transactions"| Inventory
    end

    Traffic --> Frontend
    Traffic --> Booking
    Booking -->|"Authenticated HTTP"| API

    subgraph Telemetry["Cross-cloud logs and metrics"]
        Monitor["Azure Monitor"]
        CloudWatch["AWS CloudWatch"]
    end

    App -.-> Monitor
    API -.-> Monitor
    Cache -.-> Monitor
    Catalog -.-> Monitor
    Inventory -.-> CloudWatch

    subgraph Agents["Azure SRE Agent investigation"]
        ApplicationAgent["Storefront SRE Agent"]
        DataAgent["Data Platform SRE Agent"]
        AWSConnector["AWS connector"]
    end

    Monitor --> ApplicationAgent
    Monitor --> DataAgent
    ApplicationAgent -->|"Investigation handoff: protocol to confirm"| DataAgent
    CloudWatch --> AWSConnector
    AWSConnector --> DataAgent

    subgraph Teams["Native Teams experience"]
        Findings["Findings and remediation proposal"]
        Approval["Authorized operator approval"]
        Report["Live monitoring report"]
    end

    ApplicationAgent --> Findings
    DataAgent --> Findings
    Findings --> Approval
    Approval -->|"Approved operational change"| Setting["App Service setting: restore snapshot browsing"]
    Setting --> Booking
    Findings -->|"Permanent remediation"| CodeFix["Code-fix PR: correct offer-selection predicate"]
    ApplicationAgent --> Report
    DataAgent --> Report
```

## Azure SRE Agent capabilities showcased

- **Multi-agent investigation:** the Storefront SRE Agent investigates customer
  symptoms and collaborates with the Data Platform SRE Agent. A2A is proposed;
  the meeting recap does not conclusively confirm the handoff protocol.
- **AWS connector:** access AWS CloudWatch telemetry alongside Azure Monitor
  logs and metrics. This is not communication with an AWS agent through A2A.
- **Cross-cloud telemetry correlation:** connect customer-facing latency to
  snapshot/live request modes, cache behavior, and database load using both
  Azure and AWS logs and metrics. Findings and recovery claims need supporting
  evidence from these signals.
- **Native Teams integration:** present findings, remediation proposals, and
  operator approvals in Teams.
- **Approval-based remediation:** require operator approval for operational
  changes and propose a permanent code fix.
- **Live Reports:** generate a monitoring report from investigation evidence and
  telemetry, then verify recovery under continued traffic.
- **Service context:** provide agents with a service map, ownership information,
  source locations, and deployment history without supplying the root cause.

These are planned demo capabilities, not a claim that the scenario is
implemented in this repository.

## Traffic generator

The traffic generator is introduced in
[PR #1](https://github.com/sanchitmehta/moonshot-concert/pull/1). Until that PR is
merged, use its branch to run the command below.

Send bounded, sequential `GET` requests to API paths as rotating demo users.
The `X-Demo-User` header identifies each simulated user; it does not authenticate
users. The paths below are examples, not implemented application endpoints.

```powershell
python traffic_generator.py `
  --base-url https://your-demo-app.example.com `
  --path /api/offers `
  --path /api/availability `
  --users demo-1,demo-2,demo-3 `
  --duration 60 `
  --interval 1 `
  --confirm-authorized-target
```

Use only with systems you are authorized to test. The tool sends one request at
a time, requires at least one second between requests, stops after five minutes,
and does not follow redirects. Local HTTP targets are allowed; other targets
must use HTTPS.

## Delivery plan

Each milestone must produce a working result before the next adds dependencies.

| Milestone | Expected result | Status |
| --- | --- | --- |
| 1. Working local product | Four customer screens, separate APIs, persistent retry-safe reservations, protected confirmations | Done |
| 2. Cloud environment | Both teams deployed to Azure by Terraform and GitHub Actions, Entra-only sign-in, storage reachable only by the data-platform-api | In progress |
| 3. Caching and observability | Redis snapshots, explicit snapshot and live reads, correlated traces and logs per team, measurable request and database activity | Working locally; per-team Application Insights provisioned |
| 4. Repeatable incident | Healthy and defective releases, concurrent load, the approved mitigation path, verified recovery | Planned |
| 5. Agent demonstration | Independently scoped SRE Agents, cross-cloud investigation, Teams approval, evidence-backed Live Report | Planned |
| 6. Business analytics | Reservation events into Kusto with a ticket-sales dashboard, owned by Data Platform | Planned |

Future deployment work must preserve the separate application and data
identities and permissions. Demo-only scenario tooling lives in a separate
repository; demo-specific fault injection must not be mixed into ordinary
customer workflows.

## Open design decisions

| Topic | What remains to be decided |
| --- | --- |
| Mitigation | Exact snapshot-override behavior, approval scope, and any fallback slot-rollback procedure |
| Alternative Redis fault | Controlled fault, expected signals, and a recovery procedure appropriate to that fault |
| Agent handoff | Confirm the collaboration protocol and required configuration |
| Kusto hosting | Azure Data Explorer cluster or Fabric Eventhouse, and SRE Agent connector support |
| AWS inventory | When and how PostgreSQL moves to AWS RDS, and the AWS connector setup |

Keep agreed requirements above stable while these questions are resolved.
