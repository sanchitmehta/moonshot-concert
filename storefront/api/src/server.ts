import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DefaultAzureCredential } from "@azure/identity";
import { z } from "zod";
import { createDataPlatformClient } from "./data-platform/client.ts";
import { buildApp } from "./http/app.ts";
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
    { queue: "waitingroom-standard", saleType: "STANDARD", admitCount: 10, everySeconds: 5 },
    { queue: "waitingroom-drops", saleType: "LIMITED_DROP", admitCount: 5, everySeconds: 10 },
  ])),
  WEB_DIST_DIR: z.string().optional(),
  BUILD_COMMIT: z.string().default("local"),
}).parse(process.env);

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

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
    version: { service: "storefront-api", version, commit: config.BUILD_COMMIT },
  },
  { logger: { level: process.env.LOG_LEVEL ?? "info" } },
);

await app.listen({ port: config.PORT, host: config.HOST });

const worker = startAdmissionWorker(waitingRoomPolicy, dataPlatform.admit, app.log);
const shutdown = async () => {
  await worker.stop();
  await app.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
