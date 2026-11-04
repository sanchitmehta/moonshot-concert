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
