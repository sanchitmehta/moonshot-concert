# Ignite demo traffic generator

Send bounded, sequential `GET` requests to API paths as rotating demo users. The `X-Demo-User` header identifies each simulated user; it does not authenticate users.

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

Use only with systems you are authorized to test. The tool sends one request at a time, requires at least one second between requests, stops after five minutes, and does not follow redirects. Local HTTP targets are allowed; other targets must use HTTPS.

## Planned demo architecture

The scenario combines flash-sale traffic, cross-cloud investigation, and approval-based remediation. This diagram describes the planned demo, not components already implemented in this repository.

```mermaid
flowchart TB
    Traffic["Traffic generator<br/>Simulated users"]

    subgraph App["Demo application"]
        Frontend["Front end"]
        Backend["Back-end API<br/>Availability: live or snapshot"]
    end

    subgraph Data["Data-access layer - Azure / AWS"]
        Cache["Redis cache"]
        Database["Database"]
    end

    Traffic --> Frontend
    Traffic --> Backend
    Frontend --> Backend
    Backend -->|"Snapshot checks"| Cache
    Backend -->|"Live checks bypass cache"| Database

    subgraph Telemetry["Cross-cloud telemetry"]
        Monitor["Azure Monitor<br/>Logs and metrics"]
        CloudWatch["AWS CloudWatch<br/>Logs and metrics"]
    end

    App -.-> Monitor
    Data -.-> Monitor
    Data -.-> CloudWatch

    subgraph Agents["Azure SRE Agent investigation"]
        PlatformAgent["Platform agent<br/>Investigates application symptoms"]
        DataAgent["Data-access agent<br/>Finds cache / database cause"]
        AWSConnector["AWS connector"]
    end

    Monitor --> PlatformAgent
    PlatformAgent -->|"Hands off investigation"| DataAgent
    Monitor --> DataAgent
    CloudWatch --> AWSConnector
    AWSConnector --> DataAgent

    subgraph Operator["Native Teams experience"]
        Findings["Findings and remediation proposal"]
        Approval["Operator approval"]
        Report["Live monitoring report"]
    end

    DataAgent --> Findings
    Findings --> Approval
    Approval -->|"Approved operational change"| Setting["App Service setting<br/>Restore snapshot behavior"]
    Setting --> Backend
    Findings -->|"Long-term fix option"| CodeFix["Code fix / pull request<br/>Correct live-flag logic"]
    PlatformAgent --> Report
    DataAgent --> Report
```

**Primary failure:** code sets the live flag for all offers. Requests bypass Redis, increase database load, and raise API latency. An App Service setting provides immediate mitigation.

**Alternative failure:** an injected Redis fault. Exact Azure/AWS resource placement remains open. AWS telemetry uses the planned connector, not A2A.
