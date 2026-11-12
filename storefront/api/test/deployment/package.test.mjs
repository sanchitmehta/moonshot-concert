import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

const packageDir = process.env.STOREFRONT_PACKAGE_DIR;
const commit = process.env.GITHUB_SHA;

async function startApp(env) {
  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  const [command, ...args] = manifest.scripts.start.split(" ");
  assert.equal(command, "node");
  const child = spawn(process.execPath, args, { cwd: packageDir, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Storefront did not start:\n${output}`));
    }, 60_000);
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
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", code => {
      clearTimeout(timer);
      reject(new Error(`Storefront exited with ${code}:\n${output}`));
    });
  });

  return {
    url: `http://127.0.0.1:${port}`,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const stopped = new Promise(resolve => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([stopped, delay(5_000, undefined, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await stopped;
      }
    },
  };
}

test("deployment package serves the app and exports HTTP traces", { timeout: 150_000 }, async t => {
  assert.ok(packageDir, "STOREFRONT_PACKAGE_DIR is required");
  assert.match(commit ?? "", /^[a-f0-9]{40}$/, "GITHUB_SHA must be a commit SHA");

  let recordTrace;
  const httpTrace = new Promise(resolve => { recordTrace = resolve; });
  let admissions = 0;
  let recordAdmission;
  const admission = new Promise(resolve => { recordAdmission = resolve; });
  const backend = createServer((request, response) => {
    if (request.url === "/health/ready") {
      response.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
    } else if (request.url === "/v1/festival") {
      response.writeHead(200, { "content-type": "application/json" }).end('{"name":"Festival"}');
    } else if (request.url?.endsWith("/admissions")) {
      admissions += 1;
      recordAdmission();
      response.writeHead(200, { "content-type": "application/json" }).end('{"admitted":[],"waiting":0}');
    } else if (request.url === "/v1/traces") {
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        const trace = JSON.parse(body);
        const spans = trace.resourceSpans?.flatMap(resource => resource.scopeSpans?.flatMap(scope => scope.spans ?? []) ?? []) ?? [];
        if (spans.some(span => span.kind === 2)) recordTrace();
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise(resolve => backend.listen(0, "127.0.0.1", resolve));
  let app;
  t.after(async () => {
    if (app) await app.stop();
    await new Promise(resolve => backend.close(resolve));
  });
  const backendUrl = `http://127.0.0.1:${backend.address().port}`;

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("OTEL_") || key.startsWith("APPLICATIONINSIGHTS_")) delete env[key];
  }
  Object.assign(env, {
    HOST: "127.0.0.1",
    PORT: "0",
    DATA_PLATFORM_API_URL: backendUrl,
    DATA_PLATFORM_API_SCOPE: "",
    WEB_DIST_DIR: "web",
    BUILD_COMMIT: "stale-environment-value",
    LOG_LEVEL: "info",
    OTEL_SERVICE_NAME: "storefront-package-test",
    OTEL_EXPORTER_OTLP_ENDPOINT: backendUrl,
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "none",
    OTEL_LOGS_EXPORTER: "none",
    OTEL_NODE_RESOURCE_DETECTORS: "env,process,os",
    OTEL_BSP_SCHEDULE_DELAY: "100",
    WAITING_ROOM_POLICY: JSON.stringify([
      { queue: "waitingroom-standard", saleType: "STANDARD", admitCount: 5, everySeconds: 5 },
      { queue: "waitingroom-drops", saleType: "LIMITED_DROP", admitCount: 1, everySeconds: 5 },
    ]),
  });
  delete env.WAITING_ROOM_WORKER_ENABLED;

  app = await startApp(env);

  const version = await fetch(`${app.url}/version`);
  assert.equal(version.status, 200);
  const revision = await version.json();
  assert.equal(revision.service, "storefront-api");
  assert.equal(revision.commit, commit);
  const ready = await fetch(`${app.url}/health/ready`);
  assert.equal(ready.status, 200);
  const festival = await fetch(`${app.url}/api/festival`);
  assert.deepEqual(await festival.json(), { name: "Festival" });
  const website = await fetch(app.url);
  assert.equal(website.status, 200);
  assert.match(await website.text(), /<html/i);

  await Promise.race([
    httpTrace,
    delay(20_000, undefined, { ref: false }).then(() => { throw new Error("No HTTP server span was exported"); }),
  ]);
  await Promise.race([
    admission,
    delay(10_000, undefined, { ref: false }).then(() => { throw new Error("Production admission worker did not run"); }),
  ]);

  await app.stop();
  admissions = 0;
  app = await startApp({
    ...env,
    WAITING_ROOM_WORKER_ENABLED: "false",
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://127.0.0.1:9;LiveEndpoint=https://127.0.0.1:9",
    APPLICATION_INSIGHTS_NO_STATSBEAT: "true",
    APPLICATIONINSIGHTS_SDKSTATS_DISABLED: "true",
  });
  assert.equal((await fetch(`${app.url}/health/live`)).status, 200);
  assert.equal((await fetch(`${app.url}/health/ready`)).status, 200);
  await delay(6_000);
  assert.equal(admissions, 0, "Staging must not run the admission worker");
});
