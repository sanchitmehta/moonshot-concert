import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DefaultAzureCredential } from "@azure/identity";
import { z } from "zod";
import { createDataPlatformClient } from "./data-platform/client.ts";
import { buildApp } from "./http/app.ts";
import { saleSummary } from "./offers/sale-summary.ts";
import { startAdmissionWorker } from "./waiting-room/admission-worker.ts";
import { parsePolicy } from "./waiting-room/policy.ts";

const config = z.object({
  PORT: z.coerce.number().int().default(5000),
  HOST: z.string().default("127.0.0.1"),
  DATA_PLATFORM_API_URL: z.string().url(),
  // In Azure: the data-platform-api scope, for example api://<client-id>/.default. Unset locally.
  DATA_PLATFORM_API_SCOPE: z.string().optional(),
  LIVE_AVAILABILITY_ENABLED: z.enum(["true", "false"]).default("true"),
  LIVE_AVAILABILITY_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  WAITING_ROOM_POLICY: z.string().default(JSON.stringify([
    { queue: "waitingroom-standard", saleType: "STANDARD", admitCount: 5, everySeconds: 10 },
  ])),
  WEB_DIST_DIR: z.string().optional(),
  BUILD_COMMIT: z.string().default("local"),
}).parse(process.env);

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const buildInfo = new URL("../build-info.json", import.meta.url);
const buildCommit = existsSync(buildInfo)
  ? z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/) }).parse(JSON.parse(readFileSync(buildInfo, "utf8"))).commit
  : config.BUILD_COMMIT;

const scope = config.DATA_PLATFORM_API_SCOPE;
// The managed identity selected by AZURE_CLIENT_ID; tokens are cached and refreshed by the credential.
const credential = scope ? new DefaultAzureCredential() : undefined;
const accessToken = credential && scope ? async () => (await credential.getToken(scope)).token : undefined;

const waitingRoomPolicy = parsePolicy(config.WAITING_ROOM_POLICY);
const dataPlatform = createDataPlatformClient(config.DATA_PLATFORM_API_URL, { accessToken });

const app = buildApp(
  dataPlatform,
  {
    liveAvailabilityEnabled: config.LIVE_AVAILABILITY_ENABLED === "true",
    liveAvailabilityConcurrency: config.LIVE_AVAILABILITY_CONCURRENCY,
    waitingRoomPolicy,
    webDistDir: config.WEB_DIST_DIR ? resolve(config.WEB_DIST_DIR) : undefined,
    version: { service: "storefront-api", version, commit: buildCommit },
  },
  { logger: { level: process.env.LOG_LEVEL ?? "info" } },
);

/** Bounds a start-up read that is worth a log line but not worth waiting for. */
const within = <T>(ms: number, work: Promise<T>): Promise<T> => Promise.race([
  work,
  new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`No answer within ${ms} ms`)), ms).unref()),
]);
try {
  const [festival, offers] = await within(5000, Promise.all([dataPlatform.festival(), dataPlatform.offers()]));
  const sale = saleSummary(offers);
  app.log.info({ festival: festival.name, passes: offers.length, ...sale }, sale.onSale > 0 ? "Sale is live" : "No passes are on sale");
} catch (error) {
  // The storefront starts without the data platform; its readiness check reports when the two can talk.
  app.log.warn({ err: error }, "Could not read what is on sale at start-up");
}

await app.listen({ port: config.PORT, host: config.HOST });
app.log.info({
  version,
  commit: buildCommit,
  dataPlatformUrl: config.DATA_PLATFORM_API_URL,
  dataPlatformAuth: scope ? "entra" : "none",
  liveAvailabilityEnabled: config.LIVE_AVAILABILITY_ENABLED === "true",
  liveAvailabilityConcurrency: config.LIVE_AVAILABILITY_CONCURRENCY,
  queues: waitingRoomPolicy.map(entry => entry.queue).join(","),
}, "Service started");

const worker = startAdmissionWorker(waitingRoomPolicy, dataPlatform.admit, app.log);
const shutdown = async () => {
  await worker.stop();
  await app.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
