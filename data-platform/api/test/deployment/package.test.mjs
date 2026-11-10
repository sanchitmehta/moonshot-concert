import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

const packageDir = process.env.DATA_PLATFORM_PACKAGE_DIR;
const commit = process.env.GITHUB_SHA;

// Replace only store I/O. Load the real packaged modules, server and telemetry.
const stores = `data:text/javascript,${encodeURIComponent(`
  import { mock } from "node:test";
  import { pathToFileURL } from "node:url";
  import { resolve } from "node:path";
  const load = path => import(pathToFileURL(resolve(path)).href);
  const { CatalogStore } = await load("src/catalog/catalog-store.ts");
  const { InventoryStore } = await load("src/inventory/inventory-store.ts");
  const { AvailabilityService } = await load("src/availability/availability-service.ts");
  const { QueueStore } = await load("src/waiting-room/queue-store.ts");
  const noSetup = async () => { throw new Error("Database setup must not run during startup"); };
  mock.method(CatalogStore, "connect", async () => ({
    festival: async () => ({ name: "Festival" }),
    ping: async () => {},
    seed: noSetup,
  }));
  for (const method of ["migrate", "seed", "canCreateTables"]) {
    mock.method(InventoryStore.prototype, method, noSetup);
  }
  mock.method(InventoryStore.prototype, "ping", async () => {});
  for (const Store of [AvailabilityService, QueueStore]) {
    for (const method of ["connect", "ping", "close"]) {
      mock.method(Store.prototype, method, async () => {});
    }
  }
`)}`;

async function startApp(env, t) {
  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  const [command, ...args] = manifest.scripts.start.split(" ");
  assert.equal(command, "node");
  args.splice(args.length - 1, 0, "--import", stores);
  const child = spawn(process.execPath, args, { cwd: packageDir, env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const stopped = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([stopped, delay(5_000, undefined, { ref: false })]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await stopped;
    }
  });
  let output = "";
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`API did not start:\n${output}`)), 60_000);
    const record = data => {
      output += data.toString();
      const match = output.match(/Server listening at http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    };
    child.stdout.on("data", record);
    child.stderr.on("data", record);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => {
      clearTimeout(timer);
      reject(new Error(`API exited with ${code}:\n${output}`));
    });
  });
  return `http://127.0.0.1:${port}`;
}

test("production package starts without database setup and preserves telemetry", { timeout: 150_000 }, async t => {
  assert.ok(packageDir, "DATA_PLATFORM_PACKAGE_DIR is required");
  assert.match(commit ?? "", /^[a-f0-9]{40}$/, "GITHUB_SHA must be a commit SHA");
  for (const file of ["oryx-manifest.toml", "node_modules.tar.gz"]) {
    await assert.rejects(access(join(packageDir, file)), { code: "ENOENT" });
  }
  for (const file of ["src/seed.ts", "db/migrations", "certs/rds-global-bundle.pem"]) {
    await access(join(packageDir, file));
  }

  let recordTrace;
  const httpTrace = new Promise(resolve => { recordTrace = resolve; });
  const collector = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      if (request.url === "/v1/traces") {
        const trace = JSON.parse(body);
        const spans = trace.resourceSpans?.flatMap(resource => resource.scopeSpans?.flatMap(scope => scope.spans ?? []) ?? []) ?? [];
        if (spans.some(span => span.kind === 2)) recordTrace();
      }
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise(resolve => collector.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => collector.close(resolve)));

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("OTEL_") || key.startsWith("APPLICATIONINSIGHTS_")) delete env[key];
  }
  delete env.COSMOS_ENDPOINT;
  Object.assign(env, {
    HOST: "127.0.0.1",
    PORT: "0",
    AUTH_MODE: "none",
    DATABASE_URL: "postgres://test@127.0.0.1:1/test",
    DATABASE_AUTH: "password",
    COSMOS_CONNECTION_STRING: "AccountEndpoint=https://127.0.0.1:1/;AccountKey=dGVzdA==;",
    REDIS_URL: "redis://127.0.0.1:1",
    REDIS_AUTH: "password",
    BILLING_URL: "http://127.0.0.1:1",
    BUILD_COMMIT: "stale-environment-value",
    LOG_LEVEL: "info",
    OTEL_SERVICE_NAME: "data-platform-package-test",
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collector.address().port}`,
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "none",
    OTEL_LOGS_EXPORTER: "none",
    OTEL_NODE_RESOURCE_DETECTORS: "env,process,os",
    OTEL_BSP_SCHEDULE_DELAY: "100",
  });
  const url = await startApp(env, t);
  const version = await fetch(`${url}/version`);
  assert.equal(version.status, 200);
  const revision = await version.json();
  assert.equal(revision.service, "data-platform-api");
  assert.equal(revision.commit, commit);
  assert.equal((await fetch(`${url}/health/ready`)).status, 200);
  assert.deepEqual(await (await fetch(`${url}/v1/festival`)).json(), { name: "Festival" });
  await Promise.race([
    httpTrace,
    delay(20_000, undefined, { ref: false }).then(() => { throw new Error("No HTTP server span was exported"); }),
  ]);

  const azureUrl = await startApp({
    ...env,
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://127.0.0.1:9;LiveEndpoint=https://127.0.0.1:9",
    APPLICATION_INSIGHTS_NO_STATSBEAT: "true",
    APPLICATIONINSIGHTS_SDKSTATS_DISABLED: "true",
  }, t);
  assert.equal((await fetch(`${azureUrl}/health/live`)).status, 200);
});
